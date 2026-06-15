let devices = [];
let commandGroups = [];
let timers = [];
let selectedHost = localStorage.getItem('selectedHost') || '';

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

function selectedDevice() {
  return devices.find(device => device.ip === selectedHost) || devices[0] || null;
}

async function loadState() {
  const res = await request('/api/status');
  applyState(await res.json());
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
  if (!devices.some(device => device.ip === selectedHost)) {
    selectedHost = devices[0]?.ip || '';
  }
  localStorage.setItem('selectedHost', selectedHost);
  renderDeviceList();
  renderDeviceDetail();
  renderTimers();
  const ok = devices.filter(d => d.status && d.status.ok).length;
  $('status').textContent = `Stato cache: ${ok}/${devices.length}`;
  $('lastPoll').textContent = fmtDate(state.last_poll);
  $('lastTimeSync').textContent = fmtDate(state.last_time_sync);
  $('lastTimer').textContent = fmtDate(state.last_timer_run);
  $('backendState').textContent = state.busy ? `in corso: ${state.last_action || ''}` : (state.last_action || 'idle');
}

function powerInfo(device) {
  const fields = device?.status?.fields || {};
  const label = fields.power || (device?.status?.ok ? 'OK' : 'NON RISPONDE');
  const stateClass = fields.power === 'ON' ? 'on' : fields.power === 'OFF' ? 'off' : 'err';
  return {fields, label, stateClass};
}

function renderDeviceList() {
  $('deviceList').innerHTML = devices.map(device => {
    const info = powerInfo(device);
    const active = device.ip === selectedHost ? ' active' : '';
    return `
      <button class="device-choice${active}" onclick="selectDevice('${device.ip}')">
        <span>
          <strong>${device.location || device.name}</strong>
          <small>${device.name}</small>
        </span>
        <span class="state ${info.stateClass}">${info.label}</span>
      </button>
    `;
  }).join('');
}

function selectDevice(host) {
  selectedHost = host;
  localStorage.setItem('selectedHost', host);
  renderDeviceList();
  renderDeviceDetail();
  renderTimers();
}

function renderDeviceDetail() {
  const device = selectedDevice();
  if (!device) {
    $('deviceDetail').innerHTML = '<div class="empty">Nessun condizionatore configurato.</div>';
    return;
  }
  const info = powerInfo(device);
  const fields = info.fields;
  $('deviceDetail').innerHTML = `
    <div class="hero-card">
      <div>
        <div class="eyebrow">${device.location || 'Ambiente'}</div>
        <h2>${device.name}</h2>
        <div class="muted"><code>${device.ip}</code> · <code>${device.mac}</code></div>
      </div>
      <div class="big-state ${info.stateClass}">${info.label}</div>
    </div>

    <div class="metric-grid">
      <div class="metric"><span>Set</span><strong>${fields.indoor_temperature_setting ?? '-'}</strong></div>
      <div class="metric"><span>Ambiente</span><strong>${fields.indoor_temperature_status ?? '-'}</strong></div>
      <div class="metric"><span>Modo</span><strong>${modeLabel(fields.mode_status)}</strong></div>
      <div class="metric"><span>Ora modulo</span><strong>${fields.clock || '-'}</strong></div>
    </div>

    <div class="command-surface">
      <div class="quick-actions">
        <button class="primary" onclick="lanCmd('${device.ip}', 'on')">Accendi</button>
        <button class="danger" onclick="lanCmd('${device.ip}', 'off')">Spegni</button>
        <button onclick="lanCmd('${device.ip}', 'status_102_0')">Leggi stato</button>
        <button onclick="lanCmd('${device.ip}', 'version')">Firmware</button>
      </div>
      <div class="control-grid">${renderCommandGroups(device.ip)}</div>
    </div>

    <form class="timer-form selected" onsubmit="createTimer(event, '${device.ip}')">
      <select name="command">
        <option value="on">Accensione</option>
        <option value="off">Spegnimento</option>
      </select>
      <input name="at" type="time" required>
      <input name="label" placeholder="Etichetta">
      <button type="submit">Aggiungi timer</button>
    </form>
  `;
}

function modeLabel(value) {
  const modes = {1: 'Auto', 2: 'Freddo', 3: 'Deum.', 4: 'Vent.', 5: 'Caldo'};
  return modes[value] || '-';
}

function renderCommandGroups(host) {
  return commandGroups.map(group => `
    <label>
      ${group.name}
      <select onchange="if (this.value) lanCmd('${host}', this.value); this.value=''">
        <option value="">Scegli</option>
        ${group.commands.map(item => `<option value="${item.command}">${item.label}</option>`).join('')}
      </select>
    </label>
  `).join('');
}

function renderTimers() {
  const device = selectedDevice();
  const visibleTimers = device ? timers.filter(timer => timer.host === device.ip) : timers;
  if (!visibleTimers.length) {
    $('timers').innerHTML = '<div class="muted">Nessun timer server per il condizionatore selezionato.</div>';
    return;
  }
  $('timers').innerHTML = visibleTimers.map(timer => `
    <div class="timer-row">
      <div>
        <strong>${timer.command === 'on' ? 'Accensione' : 'Spegnimento'} ${timer.at}</strong>
        <div class="muted">${timer.label || device?.name || timer.host}</div>
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
