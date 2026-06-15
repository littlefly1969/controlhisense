let devices = [];
let commandGroups = [];
let timers = [];

const $ = id => document.getElementById(id);

async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('non autenticato');
  }
  return res;
}

function setBusy(value) {
  document.querySelectorAll('button, select, input').forEach(el => {
    el.disabled = value;
  });
}

function fmtDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

async function loadState() {
  const res = await request('/api/status');
  const state = await res.json();
  applyState(state);
}

async function refreshStatus() {
  setBusy(true);
  $('status').textContent = 'Lettura forzata stato LAN in corso...';
  try {
    const res = await request('/api/status?refresh=1');
    const state = await res.json();
    applyState(state);
    $('result').textContent = JSON.stringify(state, null, 2);
  } finally {
    setBusy(false);
  }
}

function applyState(state) {
  devices = state.devices || [];
  commandGroups = state.commands || [];
  timers = state.timers || [];
  renderDevices();
  renderTimers();
  const ok = devices.filter(d => d.status && d.status.ok).length;
  $('status').textContent = `Cache stato: ${ok}/${devices.length} dispositivi`;
  $('lastPoll').textContent = fmtDate(state.last_poll);
  $('lastTimeSync').textContent = fmtDate(state.last_time_sync);
  $('lastTimer').textContent = fmtDate(state.last_timer_run);
  $('backendState').textContent = state.busy ? `in corso: ${state.last_action || ''}` : (state.last_action || 'idle');
}

function renderDevices() {
  $('devices').innerHTML = devices.map(d => {
    const st = d.status || {};
    const fields = st.fields || {};
    const power = fields.power || (st.ok ? 'OK' : 'NON RISPONDE');
    const stateClass = fields.power === 'ON' ? 'on' : fields.power === 'OFF' ? 'off' : 'err';
    return `
      <article class="card">
        <strong>${d.name}</strong>
        <div class="muted"><code>${d.ip}</code> · <code>${d.mac}</code></div>
        <div class="muted">${d.softap}</div>
        <div class="state ${stateClass}">${power}</div>
        ${fields.indoor_temperature_setting !== undefined ? `<div>Set ${fields.indoor_temperature_setting} C · Ambiente ${fields.indoor_temperature_status} C</div>` : ''}
        ${fields.clock ? `<div>Ora modulo: <code>${fields.clock}</code></div>` : ''}
        ${fields.poweron_time ? `<div>Timer on modulo: <code>${fields.poweron_time}</code></div>` : ''}
        ${fields.poweroff_time ? `<div>Timer off modulo: <code>${fields.poweroff_time}</code></div>` : ''}
        <div class="row">
          <button class="primary" onclick="lanCmd('${d.ip}', 'on')">On</button>
          <button class="danger" onclick="lanCmd('${d.ip}', 'off')">Off</button>
          <button onclick="lanCmd('${d.ip}', 'status_102_0')">Stato</button>
          <button onclick="lanCmd('${d.ip}', 'version')">Versione</button>
        </div>
        <div class="stack">${renderCommandGroups(d.ip)}</div>
        <form class="timer-form" onsubmit="createTimer(event, '${d.ip}')">
          <select name="command">
            <option value="on">Accensione</option>
            <option value="off">Spegnimento</option>
          </select>
          <input name="at" type="time" required>
          <input name="label" placeholder="Etichetta">
          <button type="submit">Aggiungi timer</button>
        </form>
      </article>
    `;
  }).join('');
}

function renderCommandGroups(host) {
  return commandGroups.map(group => `
    <select onchange="if (this.value) lanCmd('${host}', this.value); this.value=''">
      <option value="">${group.name}</option>
      ${group.commands.map(item => `<option value="${item.command}">${item.label}</option>`).join('')}
    </select>
  `).join('');
}

function renderTimers() {
  if (!timers.length) {
    $('timers').innerHTML = '<div class="muted">Nessun timer server configurato.</div>';
    return;
  }
  const names = Object.fromEntries(devices.map(d => [d.ip, d.name]));
  $('timers').innerHTML = timers.map(timer => `
    <div class="timer-row">
      <div>
        <strong>${timer.command === 'on' ? 'Accensione' : 'Spegnimento'} ${timer.at}</strong>
        <div class="muted">${names[timer.host] || timer.host}${timer.label ? ` · ${timer.label}` : ''}</div>
        <div class="muted">Ultima esecuzione: ${fmtDate(timer.last_run_at)}</div>
      </div>
      <button onclick="toggleTimer('${timer.id}', ${timer.enabled ? 'false' : 'true'})">${timer.enabled ? 'Disattiva' : 'Attiva'}</button>
      <button class="danger" onclick="deleteTimer('${timer.id}')">Elimina</button>
      <span class="state ${timer.enabled ? 'on' : 'off'}">${timer.enabled ? 'ATTIVO' : 'PAUSA'}</span>
    </div>
  `).join('');
}

async function lanCmd(host, command) {
  setBusy(true);
  $('status').textContent = `${host}: ${command}...`;
  try {
    const res = await request('/api/lan-command', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({host, command})
    });
    const data = await res.json();
    $('status').textContent = data.ok ? `${host}: ${command} eseguito` : `${host}: errore`;
    $('result').textContent = JSON.stringify(data, null, 2);
    await loadState();
  } finally {
    setBusy(false);
  }
}

async function createTimer(event, host) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    host,
    command: form.command.value,
    at: form.at.value,
    label: form.label.value,
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6]
  };
  const res = await request('/api/timers', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  $('result').textContent = JSON.stringify(await res.json(), null, 2);
  form.reset();
  await loadState();
}

async function toggleTimer(id, enabled) {
  const timer = timers.find(item => item.id === id);
  if (!timer) return;
  const res = await request('/api/timers', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...timer, enabled})
  });
  $('result').textContent = JSON.stringify(await res.json(), null, 2);
  await loadState();
}

async function deleteTimer(id) {
  const res = await request(`/api/timers?id=${encodeURIComponent(id)}`, {method: 'DELETE'});
  $('result').textContent = JSON.stringify(await res.json(), null, 2);
  await loadState();
}

async function scan() {
  setBusy(true);
  $('status').textContent = 'Scansione in corso...';
  try {
    const res = await request('/api/scan');
    const data = await res.json();
    $('status').textContent = `Trovati ${data.hosts.length} host con porte aperte`;
    $('hosts').innerHTML = data.hosts.map(h => `
      <article class="card">
        <strong><code>${h.ip}</code></strong>
        <div class="muted">${h.mac || ''} ${h.vendor || ''}</div>
        <div>Porte: <code>${h.open_ports.join(', ')}</code></div>
        <div>${h.http_title || ''}</div>
        <div class="muted">${h.http_server || ''}</div>
        <div>${h.classification.map(x => `<span class="tag">${x}</span>`).join('')}</div>
      </article>
    `).join('');
    $('wifi').innerHTML = (data.wifi || []).map(n => `
      <article class="card">
        <strong>${n.ssid || '(nascosta)'}</strong>
        <div class="muted"><code>${n.bssid}</code></div>
        <div>Canale ${n.channel}, segnale ${n.signal}, ${n.security || 'aperta'}</div>
      </article>
    `).join('');
    $('result').textContent = JSON.stringify(data, null, 2);
  } finally {
    setBusy(false);
  }
}

async function syncTime() {
  const res = await request('/api/sync-time', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  $('result').textContent = JSON.stringify(await res.json(), null, 2);
  await loadState();
}

async function logout() {
  await request('/api/logout', {method: 'POST'});
  location.href = '/login';
}

$('refreshBtn').addEventListener('click', refreshStatus);
$('scanBtn').addEventListener('click', scan);
$('syncTimeBtn').addEventListener('click', syncTime);
$('logoutBtn').addEventListener('click', logout);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

loadState();
window.setInterval(loadState, 30000);
