'use strict';

/* ---------------------------------------------------------------------------
   Stato applicazione
   --------------------------------------------------------------------------- */
let devices = [];
let commandGroups = [];
let timers = [];
let selectedHost = localStorage.getItem('selectedHost') || '';
let uiMode = localStorage.getItem('uiMode') || 'user';

const $ = id => document.getElementById(id);
const RING_CIRC = 2 * Math.PI * 52; // raggio 52 nel viewBox 120x120

/* ---------------------------------------------------------------------------
   Icone (SVG inline, stroke = currentColor)
   --------------------------------------------------------------------------- */
const ICONS = {
  power: '<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  snow: '<path d="M12 2v20M3.5 7 20.5 17M20.5 7 3.5 17"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2"/>',
  flame: '<path d="M12 22a6 6 0 0 0 6-6c0-4.5-4-6-3.2-10C12 7 8 9.5 8 14.5A4 4 0 0 0 12 22z"/>',
  drop: '<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h16a3 3 0 1 1-3 3"/><path d="M3 18h8"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  leaf: '<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14z"/><path d="M5 19c4-4 7-6 10-7"/>',
  moon: '<path d="M21 12.8A8 8 0 1 1 11.2 3 6.4 6.4 0 0 0 21 12.8z"/>',
  swapV: '<path d="M7 4v16M7 4 4 7M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/>',
  swapH: '<path d="M4 7h16M20 7l-3-3M20 7l-3 3M4 17h16M4 17l3-3M4 17l3 3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* ---------------------------------------------------------------------------
   Definizioni controlli
   --------------------------------------------------------------------------- */
const MODE_BUTTONS = [
  {command: 'mode_cool', label: 'Freddo', icon: 'snow', values: [2]},
  {command: 'mode_heat', label: 'Caldo', icon: 'flame', values: [4]},
  {command: 'mode_dry', label: 'Dry', icon: 'drop', values: [6]},
  {command: 'mode_fan', label: 'Ventola', icon: 'wind', values: [0]},
];

// Rispecchia la tabella FAN_SPEEDS del backend (aeh_lan_control.py):
// `values` sono i wind_status attesi in lettura. Tenere allineato.
const FAN_BUTTONS = [
  {command: 'speed_auto', label: 'Auto', values: [0]},
  {command: 'speed_1', label: '1', values: [4]},
  {command: 'speed_2', label: '2', values: [5]},
  {command: 'speed_3', label: '3', values: [6]},
  {command: 'speed_4', label: '4', values: [7]},
  {command: 'speed_5', label: '5', values: [8]},
  {command: 'speed_mute', label: 'Mute', values: [2]},
];

const QUICK_ACTIONS = [
  {command: 'turbo_on', label: 'Turbo', icon: 'bolt'},
  {command: 'energysave_on', label: 'Eco', icon: 'leaf'},
  {command: 'sleep_off', label: 'Sleep off', icon: 'moon'},
  {command: 'vert_swing', label: 'Swing ↕', icon: 'swapV'},
  {command: 'hor_swing', label: 'Swing ↔', icon: 'swapH'},
  {command: 'display_off', label: 'Display', icon: 'sun'},
];

const MODE_KEYS = {0: 'fan', 2: 'cool', 4: 'heat', 6: 'dry'};

/* ---------------------------------------------------------------------------
   Helper
   --------------------------------------------------------------------------- */
async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('non autenticato');
  }
  return res;
}

function setBusy(value) {
  document.querySelectorAll('button, select, input').forEach(el => { el.disabled = value; });
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function clampTemp(value) {
  const temp = Number.parseInt(value, 10);
  if (Number.isNaN(temp)) return 24;
  return Math.min(32, Math.max(16, temp));
}

function selectedDevice() {
  return devices.find(d => d.ip === selectedHost) || devices[0] || null;
}

function stateClass(device) {
  const power = device?.status?.fields?.power;
  if (power === 'ON') return 'on';
  if (power === 'OFF') return 'off';
  return device?.status?.ok ? 'online' : 'err';
}

function stateLabel(device) {
  const power = device?.status?.fields?.power;
  if (power) return power;
  return device?.status?.ok ? 'ONLINE' : 'OFFLINE';
}

function modeLabel(value) {
  return {0: 'Ventola', 2: 'Freddo', 4: 'Caldo', 6: 'Dry'}[value] || rawStatusLabel(value);
}

function fanLabel(value) {
  const match = FAN_BUTTONS.find(b => (b.values || []).includes(value));
  return match ? match.label : rawStatusLabel(value);
}

function rawStatusLabel(value) {
  return value === undefined || value === null ? '-' : `Valore ${value}`;
}

/* ---------------------------------------------------------------------------
   Caricamento stato
   --------------------------------------------------------------------------- */
async function loadState() {
  const res = await request('/api/status');
  applyState(await res.json());
}

// Forza la lettura SOLO del condizionatore selezionato.
async function refreshSelected() {
  const device = selectedDevice();
  if (!device) return;
  setBusy(true);
  $('status').textContent = `Lettura ${device.location || device.ip}...`;
  try {
    const res = await request(`/api/status?refresh=1&host=${encodeURIComponent(device.ip)}`);
    applyState(await res.json());
    $('status').textContent = `${device.location || device.ip}: stato aggiornato`;
  } catch (err) {
    $('status').textContent = 'Aggiornamento non riuscito';
  } finally {
    setBusy(false);
  }
}

function applyState(state) {
  devices = state.devices || [];
  commandGroups = state.commands || [];
  timers = state.timers || [];
  if (!devices.some(d => d.ip === selectedHost)) {
    selectedHost = devices[0]?.ip || '';
  }
  if (selectedHost) localStorage.setItem('selectedHost', selectedHost);

  renderDeviceRail();
  renderDeviceDetail();
  renderTimers();

  const online = devices.filter(d => d.status && d.status.ok).length;
  if (!$('status').textContent.includes('...')) {
    $('status').textContent = `${online}/${devices.length} online`;
  }
  $('lastPoll').textContent = fmtDate(state.last_poll);
  $('lastTimeSync').textContent = fmtDate(state.last_time_sync);
  $('lastTimer').textContent = fmtDate(state.last_timer_run);
  $('serverTime').textContent = fmtDate(state.server_time);
  $('backendState').textContent = state.busy ? `in corso: ${state.last_action || ''}` : (state.last_action || 'idle');
  $('footNote').textContent = `Ora server ${state.server_hhmm || ''}`;
}

/* ---------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------- */
function renderDeviceRail() {
  const rail = $('deviceList');
  if (!devices.length) {
    rail.innerHTML = '<div class="empty">Nessun condizionatore configurato.</div>';
    return;
  }
  rail.innerHTML = devices.map(d => {
    const f = d.status?.fields || {};
    const active = d.ip === selectedHost ? ' active' : '';
    const ambient = f.indoor_temperature_status ?? '–';
    return `
      <button class="chip${active}" type="button" onclick="selectDevice('${esc(d.ip)}')">
        <span class="chip-dot ${stateClass(d)}"></span>
        <span class="chip-body">
          <strong>${esc(d.location || d.name)}</strong>
          <small>${ambient}° · ${esc(stateLabel(d))}</small>
        </span>
      </button>`;
  }).join('');
}

function selectDevice(host) {
  selectedHost = host;
  localStorage.setItem('selectedHost', host);
  renderDeviceRail();
  renderDeviceDetail();
  renderTimers();
}

function renderDeviceDetail() {
  const c = $('deviceDetail');
  const device = selectedDevice();
  if (!device) {
    c.innerHTML = '<div class="empty">Nessun condizionatore configurato.</div>';
    return;
  }

  const f = device.status?.fields || {};
  const isOn = f.power === 'ON';
  const setTemp = clampTemp(f.indoor_temperature_setting ?? 24);
  const ambient = f.indoor_temperature_status ?? '–';
  const modeKey = MODE_KEYS[f.mode_status] || 'cool';
  const host = device.ip;
  const offset = RING_CIRC * (1 - (setTemp - 16) / 16);
  const sc = stateClass(device);

  c.innerHTML = `
    <article class="climate" data-climate="${modeKey}" data-power="${isOn ? 'on' : 'off'}">
      <div class="climate-top">
        <div>
          <span class="eyebrow">${esc(device.location || 'Ambiente')}</span>
          <h2>${esc(device.name)}</h2>
          <div class="sub monospace">${esc(device.ip)}</div>
        </div>
        <button class="icon-btn" type="button" title="Aggiorna questo condizionatore" onclick="refreshSelected()">${icon('refresh')}</button>
      </div>

      <div class="dial-wrap">
        <svg class="ring" viewBox="0 0 120 120">
          <defs>
            <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="var(--ring-a)"/>
              <stop offset="1" stop-color="var(--ring-b)"/>
            </linearGradient>
          </defs>
          <circle class="ring-track" cx="60" cy="60" r="52"/>
          <circle class="ring-fill" id="ringFill" cx="60" cy="60" r="52"
            stroke="url(#ringGrad)" stroke-dasharray="${RING_CIRC.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
        </svg>
        <div class="dial-center">
          <span class="dial-chip ${sc}">${esc(stateLabel(device))}</span>
          <strong class="dial-temp"><span id="tempValue">${setTemp}</span><sup>°C</sup></strong>
          <span class="dial-sub">Ambiente ${ambient}°</span>
        </div>
      </div>

      <div class="stepper">
        <button class="round-btn" type="button" aria-label="Riduci" onclick="adjustTemp('${host}', -1)">${icon('minus')}</button>
        <input id="tempRange" type="range" min="16" max="32" step="1" value="${setTemp}"
          aria-label="Temperatura"
          oninput="previewTemperature(this.value)" onchange="setTemperature('${host}', this.value)">
        <button class="round-btn" type="button" aria-label="Aumenta" onclick="adjustTemp('${host}', 1)">${icon('plus')}</button>
      </div>

      <button class="power-toggle ${isOn ? 'is-on' : ''}" type="button" onclick="lanCmd('${host}', '${isOn ? 'off' : 'on'}')">
        ${icon('power')}<span>${isOn ? 'Spegni' : 'Accendi'}</span>
      </button>
    </article>

    <article class="block">
      <div class="block-head"><h3>Modalità</h3><span>${esc(f.mode_label || modeLabel(f.mode_status))}</span></div>
      <div class="seg seg-mode">
        ${MODE_BUTTONS.map(b => `
          <button type="button" class="${b.values.includes(f.mode_status) ? 'active' : ''}" onclick="lanCmd('${host}', '${b.command}')">
            ${icon(b.icon)}<span>${b.label}</span>
          </button>`).join('')}
      </div>
    </article>

    <article class="block">
      <div class="block-head"><h3>Ventola</h3><span>${esc(f.wind_label || fanLabel(f.wind_status))}</span></div>
      <div class="seg seg-fan">
        ${FAN_BUTTONS.map(b => `
          <button type="button" class="${b.values.includes(f.wind_status) ? 'active' : ''}" onclick="lanCmd('${host}', '${b.command}')">
            <span>${b.label}</span>
          </button>`).join('')}
      </div>
    </article>

    <article class="block">
      <div class="block-head"><h3>Funzioni rapide</h3></div>
      <div class="quick">
        ${QUICK_ACTIONS.map(b => `
          <button type="button" onclick="lanCmd('${host}', '${b.command}')">
            ${icon(b.icon)}<span>${b.label}</span>
          </button>`).join('')}
      </div>
    </article>

    <article class="block advanced-only">
      <details class="adv">
        <summary>Comandi avanzati</summary>
        <div class="adv-grid">${renderCommandGroups(host)}</div>
      </details>
    </article>
  `;
}

function updateDial(temp) {
  const value = clampTemp(temp);
  const label = $('tempValue');
  if (label) label.textContent = value;
  const fill = $('ringFill');
  if (fill) fill.style.strokeDashoffset = (RING_CIRC * (1 - (value - 16) / 16)).toFixed(1);
}

function previewTemperature(value) {
  updateDial(value);
}

function setTemperature(host, value) {
  return lanCmd(host, `temp_${clampTemp(value)}_C`);
}

function adjustTemp(host, delta) {
  const range = $('tempRange');
  const current = clampTemp(range ? range.value : 24);
  const next = clampTemp(current + delta);
  if (next === current) return;
  if (range) range.value = next;
  updateDial(next);
  setTemperature(host, next);
}

function renderCommandGroups(host) {
  return commandGroups.map(group => `
    <label>${esc(group.name)}
      <select onchange="if (this.value) lanCmd('${esc(host)}', this.value); this.value=''">
        <option value="">Scegli comando</option>
        ${group.commands.map(item => `<option value="${esc(item.command)}">${esc(item.label)}</option>`).join('')}
      </select>
    </label>`).join('');
}

function renderTimers() {
  const device = selectedDevice();
  const visible = device ? timers.filter(t => t.host === device.ip) : timers;
  const box = $('timers');
  if (!visible.length) {
    box.innerHTML = '<div class="empty">Nessun timer per questo condizionatore.</div>';
    return;
  }
  box.innerHTML = visible.map(t => `
    <div class="timer-card">
      <div class="row">
        <span class="when">${t.command === 'on' ? 'Accendi' : 'Spegni'} · ${esc(t.at)}</span>
        <span class="pill ${t.enabled ? 'on' : 'off'}">${t.enabled ? 'Attivo' : 'In pausa'}</span>
      </div>
      ${t.label ? `<div class="meta">${esc(t.label)}</div>` : ''}
      <div class="meta">Stato: ${timerRuntimeLabel(t.runtime)}</div>
      ${t.last_run_at || t.last_run_date ? `<div class="meta">Ultima esecuzione: ${fmtDate(t.last_run_at || t.last_run_date)}</div>` : ''}
      ${t.last_result && t.last_result.ok === false ? `<div class="timer-error">${esc(t.last_result.error || 'comando non riuscito')}</div>` : ''}
      <div class="actions">
        <button class="btn" type="button" onclick="toggleTimer('${esc(t.id)}', ${t.enabled ? 'false' : 'true'})">${t.enabled ? 'Disattiva' : 'Attiva'}</button>
        <button class="danger" type="button" onclick="deleteTimer('${esc(t.id)}')">Elimina</button>
      </div>
    </div>`).join('');
}

function timerRuntimeLabel(runtime) {
  const labels = {
    'disabled': 'disattivato', 'wrong-day': 'non previsto oggi', 'done-today': 'eseguito oggi',
    'not-yet': 'non ancora scaduto', 'missed-window': 'finestra superata',
    'retry-wait': 'in attesa di ritentare', 'due': 'in scadenza ora',
    'invalid-time': 'orario non valido', 'waiting': 'in attesa',
  };
  if (!runtime) return '-';
  const label = labels[runtime.state] || runtime.state || '-';
  return runtime.due_delta_minutes === undefined ? label : `${label} (${runtime.due_delta_minutes} min)`;
}

/* ---------------------------------------------------------------------------
   Azioni
   --------------------------------------------------------------------------- */
async function lanCmd(host, command) {
  setBusy(true);
  $('status').textContent = `Invio ${command}...`;
  try {
    const res = await request('/api/lan-command', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({host, command}),
    });
    const data = await res.json();
    $('status').textContent = data.ok ? `${command}: ok` : `${command}: errore`;
    $('result').textContent = JSON.stringify(data, null, 2);
    await loadState();
  } catch (err) {
    $('status').textContent = `${command}: errore`;
  } finally {
    setBusy(false);
  }
}

async function createTimer(event) {
  event.preventDefault();
  const device = selectedDevice();
  if (!device) return;
  const form = event.currentTarget;
  const payload = {
    host: device.ip,
    command: form.command.value,
    at: form.at.value,
    label: form.label.value,
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
  };
  try {
    const res = await request('/api/timers', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    $('result').textContent = JSON.stringify(await res.json(), null, 2);
    form.reset();
    await loadState();
  } catch (err) { /* gestito da request */ }
}

async function toggleTimer(id, enabled) {
  const timer = timers.find(t => t.id === id);
  if (!timer) return;
  const res = await request('/api/timers', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...timer, enabled}),
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
  $('status').textContent = 'Scansione rete in corso...';
  try {
    const res = await request('/api/scan');
    const data = await res.json();
    $('status').textContent = `Trovati ${data.hosts.length} host`;
    $('hosts').innerHTML = data.hosts.map(h => `
      <div class="card">
        <strong><code>${esc(h.ip)}</code></strong>
        <div class="muted">${esc(h.mac || '')} ${esc(h.vendor || '')}</div>
        <div>Porte: <code>${esc((h.open_ports || []).join(', '))}</code></div>
        ${h.http_title ? `<div>${esc(h.http_title)}</div>` : ''}
        <div>${(h.classification || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>
      </div>`).join('');
    $('wifi').innerHTML = (data.wifi || []).map(n => `
      <div class="card">
        <strong>${esc(n.ssid || '(nascosta)')}</strong>
        <div class="muted"><code>${esc(n.bssid)}</code></div>
        <div>Canale ${esc(n.channel)} · ${esc(n.security || 'aperta')}</div>
      </div>`).join('');
    $('result').textContent = JSON.stringify(data, null, 2);
  } finally {
    setBusy(false);
  }
}

async function syncTime() {
  setBusy(true);
  $('status').textContent = 'Invio ora ai moduli...';
  try {
    const res = await request('/api/sync-time', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    $('result').textContent = JSON.stringify(await res.json(), null, 2);
    await loadState();
    $('status').textContent = 'Ora inviata';
  } finally {
    setBusy(false);
  }
}

async function logout() {
  await request('/api/logout', {method: 'POST'});
  location.href = '/login';
}

/* ---------------------------------------------------------------------------
   Modalità interfaccia
   --------------------------------------------------------------------------- */
function setUiMode(mode) {
  uiMode = mode === 'advanced' ? 'advanced' : 'user';
  localStorage.setItem('uiMode', uiMode);
  document.body.dataset.mode = uiMode;
  $('modeUser').classList.toggle('active', uiMode === 'user');
  $('modeAdvanced').classList.toggle('active', uiMode === 'advanced');
}

/* ---------------------------------------------------------------------------
   Avvio
   --------------------------------------------------------------------------- */
setUiMode(uiMode);
$('modeUser').addEventListener('click', () => setUiMode('user'));
$('modeAdvanced').addEventListener('click', () => setUiMode('advanced'));
$('timerForm').addEventListener('submit', createTimer);
$('scanBtn').addEventListener('click', scan);
$('syncTimeBtn').addEventListener('click', syncTime);
$('logoutBtn').addEventListener('click', logout);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

loadState();
window.setInterval(loadState, 30000);
