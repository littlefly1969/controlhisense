let devices = [];
let commandGroups = [];
let timers = [];
let selectedHost = localStorage.getItem('selectedHost') || '';

const $ = id => document.getElementById(id);

const modeButtons = [
  {command: 'mode_cool', label: 'Freddo', values: [4]},
  {command: 'mode_heat', label: 'Caldo', values: [2]},
  {command: 'mode_dry', label: 'Dry', values: [6]},
  {command: 'mode_fan', label: 'Ventilatore', values: [0]},
];

const fanButtons = [
  {command: 'speed_auto', label: 'Auto', values: [0]},
  {command: 'speed_low', label: 'Bassa', values: [4]},
  {command: 'speed_med', label: 'Media', values: [6]},
  {command: 'speed_max', label: 'Alta', values: [8]},
  {command: 'speed_mute', label: 'Mute', values: [2]},
];

const featureButtons = [
  {command: 'turbo_on', label: 'Turbo'},
  {command: 'energysave_on', label: 'Eco'},
  {command: 'display_off', label: 'Display off'},
  {command: 'sleep_off', label: 'Sleep off'},
  {command: 'vert_swing', label: 'Swing vert.'},
  {command: 'hor_swing', label: 'Swing orizz.'},
];

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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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
  if (selectedHost) localStorage.setItem('selectedHost', selectedHost);
  renderDeviceList();
  renderDeviceDetail();
  renderTimers();
  const ok = devices.filter(d => d.status && d.status.ok).length;
  $('status').textContent = `${ok}/${devices.length} online nella cache`;
  $('lastPoll').textContent = fmtDate(state.last_poll);
  $('lastTimeSync').textContent = fmtDate(state.last_time_sync);
  $('lastTimer').textContent = fmtDate(state.last_timer_run);
  $('serverTime').textContent = fmtDate(state.server_time);
  $('backendState').textContent = state.busy ? `in corso: ${state.last_action || ''}` : (state.last_action || 'idle');
}

function powerInfo(device) {
  const fields = device?.status?.fields || {};
  const label = fields.power || (device?.status?.ok ? 'ONLINE' : 'OFFLINE');
  const stateClass = fields.power === 'ON' ? 'on' : fields.power === 'OFF' ? 'off' : (device?.status?.ok ? 'online' : 'err');
  return {fields, label, stateClass};
}

function renderDeviceList() {
  if (!devices.length) {
    $('deviceList').innerHTML = '<div class="empty">Nessun condizionatore configurato.</div>';
    return;
  }
  $('deviceList').innerHTML = devices.map(device => {
    const info = powerInfo(device);
    const fields = info.fields;
    const active = device.ip === selectedHost ? ' active' : '';
    return `
      <button class="device-choice${active}" onclick="selectDevice('${escapeHtml(device.ip)}')">
        <span class="device-main">
          <strong>${escapeHtml(device.location || device.name)}</strong>
          <small>${escapeHtml(device.name)} · ${escapeHtml(device.ip)}</small>
        </span>
        <span class="device-meta">
          <span>${fields.indoor_temperature_status ?? '-'}°</span>
          <span class="state ${info.stateClass}">${escapeHtml(info.label)}</span>
        </span>
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
  const currentTemp = clampTemp(fields.indoor_temperature_setting ?? 24);
  const ambientTemp = fields.indoor_temperature_status ?? '-';
  const host = escapeHtml(device.ip);

  $('deviceDetail').innerHTML = `
    <section class="climate-hero">
      <div class="hero-copy">
        <span class="eyebrow">${escapeHtml(device.location || 'Ambiente')}</span>
        <h2>${escapeHtml(device.name)}</h2>
        <div class="muted monospace">${escapeHtml(device.ip)} · ${escapeHtml(device.mac)}</div>
      </div>
      <div class="hero-status">
        <span class="state ${info.stateClass}">${escapeHtml(info.label)}</span>
        <strong>${ambientTemp}°</strong>
        <small>temperatura ambiente</small>
      </div>
    </section>

    <section class="control-board">
      <article class="temperature-card">
        <div class="section-title">
          <span>Temperatura</span>
          <strong><span id="tempValue">${currentTemp}</span>°C</strong>
        </div>
        <input
          class="temperature-slider"
          type="range"
          min="16"
          max="32"
          step="1"
          value="${currentTemp}"
          oninput="previewTemperature(this.value)"
          onchange="setTemperature('${host}', this.value)"
        >
        <div class="slider-scale"><span>16°</span><span>24°</span><span>32°</span></div>
      </article>

      <article class="power-card">
        <button class="power-button on" onclick="lanCmd('${host}', 'on')">
          <span>Accendi</span>
          <strong>ON</strong>
        </button>
        <button class="power-button off" onclick="lanCmd('${host}', 'off')">
          <span>Spegni</span>
          <strong>OFF</strong>
        </button>
      </article>

      <article class="panel mode-panel">
        <div class="section-title"><span>Modalità</span><strong>${fields.mode_label || modeLabel(fields.mode_status)}</strong></div>
        <div class="segmented">
          ${modeButtons.map(item => `
            <button
              class="${item.values.includes(fields.mode_status) ? 'active' : ''}"
              onclick="lanCmd('${host}', '${item.command}')"
            >${item.label}</button>
          `).join('')}
        </div>
      </article>

      <article class="panel fan-panel">
        <div class="section-title"><span>Velocità ventola</span><strong>${fields.wind_label || fanLabel(fields.wind_status)}</strong></div>
        <div class="segmented compact">
          ${fanButtons.map(item => `
            <button
              class="${item.values.includes(fields.wind_status) ? 'active' : ''}"
              onclick="lanCmd('${host}', '${item.command}')"
            >${item.label}</button>
          `).join('')}
        </div>
      </article>
    </section>

    <section class="panel quick-panel">
      <div class="section-title"><span>Funzioni rapide</span><strong>Comandi</strong></div>
      <div class="quick-grid">
        ${featureButtons.map(item => `<button onclick="lanCmd('${host}', '${item.command}')">${item.label}</button>`).join('')}
      </div>
    </section>

    <section class="panel data-panel">
      <div class="metric-grid">
        <div class="metric"><span>Set</span><strong>${fields.indoor_temperature_setting ?? '-'}°</strong></div>
        <div class="metric"><span>Ambiente</span><strong>${ambientTemp}°</strong></div>
        <div class="metric"><span>Ora modulo</span><strong>${fields.clock || '-'}</strong></div>
        <div class="metric"><span>Ventola</span><strong>${fields.wind_label || fanLabel(fields.wind_status)}</strong></div>
      </div>
    </section>

    <details class="panel advanced-panel">
      <summary>Comandi avanzati</summary>
      <div class="control-grid">${renderCommandGroups(device.ip)}</div>
    </details>

    <form class="timer-form selected" onsubmit="createTimer(event, '${host}')">
      <select name="command" aria-label="Comando timer">
        <option value="on">Accensione</option>
        <option value="off">Spegnimento</option>
      </select>
      <input name="at" type="time" required aria-label="Ora timer">
      <input name="label" placeholder="Etichetta" aria-label="Etichetta timer">
      <button type="submit">Aggiungi timer</button>
    </form>
  `;
}

function clampTemp(value) {
  const temp = Number.parseInt(value, 10);
  if (Number.isNaN(temp)) return 24;
  return Math.min(32, Math.max(16, temp));
}

function previewTemperature(value) {
  const target = $('tempValue');
  if (target) target.textContent = clampTemp(value);
}

function setTemperature(host, value) {
  const temp = clampTemp(value);
  return lanCmd(host, `temp_${temp}_C`);
}

function modeLabel(value) {
  const modes = {0: 'Ventilatore', 2: 'Caldo', 4: 'Freddo', 6: 'Dry'};
  return modes[value] || rawStatusLabel(value);
}

function fanLabel(value) {
  const values = {0: 'Auto', 2: 'Mute', 4: 'Bassa', 6: 'Media', 8: 'Alta'};
  return values[value] || rawStatusLabel(value);
}

function rawStatusLabel(value) {
  return value === undefined || value === null ? '-' : `Valore ${value}`;
}

function renderCommandGroups(host) {
  return commandGroups.map(group => `
    <label>
      ${escapeHtml(group.name)}
      <select onchange="if (this.value) lanCmd('${escapeHtml(host)}', this.value); this.value=''">
        <option value="">Scegli comando</option>
        ${group.commands.map(item => `<option value="${escapeHtml(item.command)}">${escapeHtml(item.label)}</option>`).join('')}
      </select>
    </label>
  `).join('');
}

function renderTimers() {
  const device = selectedDevice();
  const visibleTimers = device ? timers.filter(timer => timer.host === device.ip) : timers;
  if (!visibleTimers.length) {
    $('timers').innerHTML = '<div class="empty compact-empty">Nessun timer per il condizionatore selezionato.</div>';
    return;
  }
  $('timers').innerHTML = visibleTimers.map(timer => `
    <div class="timer-row">
      <div>
        <strong>${timer.command === 'on' ? 'Accensione' : 'Spegnimento'} ${escapeHtml(timer.at)}</strong>
        <div class="muted">${escapeHtml(timer.label || device?.name || timer.host)}</div>
        <div class="muted">Stato: ${timerRuntimeLabel(timer.runtime)}</div>
        <div class="muted">Ultimo tentativo: ${fmtDate(timer.last_attempt_at)}</div>
        <div class="muted">Ultima esecuzione riuscita: ${fmtDate(timer.last_run_at || timer.last_run_date)}</div>
        ${timer.last_result && timer.last_result.ok === false ? `<div class="timer-error">${escapeHtml(timer.last_result.error || 'comando non riuscito')}</div>` : ''}
      </div>
      <button onclick="toggleTimer('${escapeHtml(timer.id)}', ${timer.enabled ? 'false' : 'true'})">${timer.enabled ? 'Disattiva' : 'Attiva'}</button>
      <button class="danger" onclick="deleteTimer('${escapeHtml(timer.id)}')">Elimina</button>
      <span class="state ${timer.enabled ? 'on' : 'off'}">${timer.enabled ? 'ATTIVO' : 'PAUSA'}</span>
    </div>
  `).join('');
}

function timerRuntimeLabel(runtime) {
  const labels = {
    'disabled': 'disattivato',
    'wrong-day': 'non previsto oggi',
    'done-today': 'eseguito oggi',
    'not-yet': 'non ancora scaduto',
    'missed-window': 'finestra oraria superata',
    'retry-wait': 'in attesa di ritentare',
    'due': 'in scadenza ora',
    'invalid-time': 'orario non valido',
    'waiting': 'in attesa',
  };
  if (!runtime) return '-';
  const label = labels[runtime.state] || runtime.state || '-';
  if (runtime.due_delta_minutes === undefined) return label;
  return `${label} (${runtime.due_delta_minutes} min)`;
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
        <strong><code>${escapeHtml(h.ip)}</code></strong>
        <div class="muted">${escapeHtml(h.mac || '')} ${escapeHtml(h.vendor || '')}</div>
        <div>Porte: <code>${escapeHtml(h.open_ports.join(', '))}</code></div>
        <div>${escapeHtml(h.http_title || '')}</div>
        <div class="muted">${escapeHtml(h.http_server || '')}</div>
        <div>${h.classification.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join('')}</div>
      </article>
    `).join('');
    $('wifi').innerHTML = (data.wifi || []).map(n => `
      <article class="card">
        <strong>${escapeHtml(n.ssid || '(nascosta)')}</strong>
        <div class="muted"><code>${escapeHtml(n.bssid)}</code></div>
        <div>Canale ${escapeHtml(n.channel)}, segnale ${escapeHtml(n.signal)}, ${escapeHtml(n.security || 'aperta')}</div>
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
