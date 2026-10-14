/* ============================================================
   QueueAI – Main Application Logic (Dual-Mode: Client + Admin)
   ============================================================ */

const API = window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';
let _centres   = [];
let _chartRefs = {};
let _pollTimer = null;
let _activePage = 'landing';
let _selectedCompare = new Set();
let _monitorInterval = null;
let _isAdminMode = false;
let _adminUser = null;
let _csvRows = [];   // parsed CSV rows pending upload

if (window.location.protocol === 'file:') {
  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.id = 'fileNoticeBanner';
    banner.style.cssText = 'background:#fef3c7;color:#92400e;padding:10px 16px;text-align:center;font-size:13px;font-weight:600;border-bottom:1px solid #fde68a;position:sticky;top:0;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.05);';
    banner.innerHTML = '⚠️ You opened index.html directly from your folder. For best experience, run <code>start.bat</code> and open <a href="http://localhost:8000" target="_blank" style="color:#b45309;text-decoration:underline;margin-left:4px;">http://localhost:8000</a>.';
    document.body.prepend(banner);
  });
}

// ── Utilities ────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(API + path, { credentials: 'include', ...opts });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }
    return res.json();
  } catch (e) {
    console.error('API error', path, e);
    throw e;
  }
}

function showToast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function statusClass(status) {
  const map = { 'Quiet': 'status-quiet', 'Normal': 'status-normal', 'Busy': 'status-busy', 'Very Busy': 'status-very-busy' };
  return map[status] || 'status-unknown';
}

function waitColor(min) {
  if (min === null || min === undefined) return '';
  if (min <= 10) return 'wait-green';
  if (min <= 25) return 'wait-orange';
  return 'wait-red';
}

function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}

function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + fmtTime(ts); }
  catch { return ts; }
}

function destroyChart(id) {
  if (_chartRefs[id]) { _chartRefs[id].destroy(); delete _chartRefs[id]; }
}

// ── Mode Switching ────────────────────────────────────────────
function switchToAdmin() {
  _isAdminMode = true;
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('adminSidebar').classList.remove('hidden');
  document.getElementById('mainContent').classList.add('admin-mode');

  // Hide all client pages, show admin login
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('hidden-admin'));

  // Check if already logged in
  apiFetch('/api/auth/me').then(me => {
    if (me.authenticated) {
      _adminUser = me;
      showAdminPanel(me);
      showAdminPage('admin-overview');
    } else {
      document.getElementById('page-admin-login').classList.add('active');
    }
  }).catch(() => {
    document.getElementById('page-admin-login').classList.add('active');
  });
}

function switchToClient() {
  _isAdminMode = false;
  document.getElementById('sidebar').classList.remove('hidden');
  document.getElementById('adminSidebar').classList.add('hidden');
  document.getElementById('mainContent').classList.remove('admin-mode');

  // Hide admin pages
  document.querySelectorAll('.admin-page').forEach(p => {
    p.classList.remove('active');
    p.classList.add('hidden-admin');
  });

  showPage('landing');
}

// ── Page Navigation (Client) ──────────────────────────────────
function showPage(name) {
  if (_isAdminMode) return;
  document.querySelectorAll('.page:not(.admin-page)').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#clientNav .nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === name);
  });
  const el = document.getElementById(`page-${name}`);
  if (el) el.classList.add('active');
  _activePage = name;

  if (name !== 'monitor' && _monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
  }

  if (name === 'dashboard') loadDashboard();
  if (name === 'compare')   loadCompare();
}

// ── Page Navigation (Admin) ───────────────────────────────────
function showAdminPage(name) {
  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#adminSidebar .nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.adminpage === name);
  });
  const el = document.getElementById(`page-${name}`);
  if (el) el.classList.add('active');

  // Load data for specific pages
  if (name === 'admin-overview') loadAdminData();
  if (name === 'admin-upload') loadBulkUpdateList();
  if (name === 'admin-ml') loadMLStatus();
}

function toggleMobileMenu() {
  document.getElementById('mobileMenu').classList.toggle('open');
}

// ── Landing Page ─────────────────────────────────────────────
function buildMiniChart() {
  const container = document.getElementById('heroMiniChart');
  if (!container) return;
  const vals = [8, 12, 22, 35, 40, 38, 28, 18, 12, 20, 32, 36, 30, 22, 15];
  const max = Math.max(...vals);
  container.innerHTML = vals.map(v => {
    const h = Math.round((v / max) * 54) + 4;
    const col = v < 15 ? '#16a34a' : v < 28 ? '#ea580c' : '#dc2626';
    return `<div class="mini-chart-bar" style="height:${h}px;background:${col};opacity:.8"></div>`;
  }).join('');
}

function doHeroSearch() {
  const q = document.getElementById('heroSearch').value.trim();
  showPage('dashboard');
  if (q) {
    setTimeout(() => {
      document.getElementById('dashSearch').value = q;
      applyFilters();
    }, 300);
  }
}

function filterAndGo(type) {
  showPage('dashboard');
  setTimeout(() => {
    document.getElementById('typeFilter').value = type;
    applyFilters();
  }, 300);
}

// ── Dashboard ────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [summary, centres, alertsData] = await Promise.all([
      apiFetch('/api/dashboard'),
      apiFetch('/api/centres'),
      apiFetch('/api/alerts'),
    ]);
    _centres = centres;
    renderKPIs(summary);
    renderAlerts(alertsData.alerts);
    renderCentreCards(centres);
    populateAllSelects(centres);
  } catch (e) {
    showToast('Failed to load dashboard: ' + e.message, 'error');
  }
}

function renderKPIs(s) {
  const grid = document.getElementById('kpiGrid');
  const accentColors = ['#0F52BA', '#6366f1', '#ea580c', '#dc2626', '#16a34a', '#0ea5e9'];
  grid.innerHTML = [
    { val: s.total_centres,   label: 'Active Centres',  icon: '🏢' },
    { val: s.total_waiting,   label: 'People Waiting',  icon: '👥' },
    { val: s.avg_wait_min !== null ? s.avg_wait_min + ' min' : '—', label: 'Avg Wait Time', icon: '⏱' },
    { val: s.busy_count,      label: 'Busy Centres',    icon: '🔴' },
    { val: s.shortest_queue_min !== null ? s.shortest_queue_min + ' min' : '—', label: 'Shortest Wait', icon: '✅' },
    { val: s.congestion_level, label: 'Congestion Level', icon: '📊' },
  ].map((k, i) => `
    <div class="kpi-card" style="--kpi-color:${accentColors[i]}">
      <div class="kpi-val" style="color:${accentColors[i]}">${k.val ?? '—'}</div>
      <div class="kpi-label">${k.icon} ${k.label}</div>
    </div>`
  ).join('');
}

function renderAlerts(alerts) {
  const bar = document.getElementById('alertsBar');
  if (!alerts || alerts.length === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = alerts.slice(0, 5).map(a => `
    <div class="alert-item ${a.severity}">
      <span>${a.severity === 'critical' ? '🚨' : a.severity === 'high' ? '⚠️' : 'ℹ️'}</span>
      <span>${a.message}</span>
      <span style="margin-left:auto;font-size:.72rem;opacity:.7">${fmtTime(a.timestamp)}</span>
    </div>
  `).join('');
}

function renderCentreCards(centres) {
  const grid = document.getElementById('centresGrid');
  if (!centres.length) {
    grid.innerHTML = '<div class="loading-placeholder">No service centres found matching your filters.</div>';
    return;
  }
  grid.innerHTML = centres.map(c => {
    const wait = c.predicted_wait_min;
    const waitStr = wait !== null && wait !== undefined ? `${wait} min` : 'N/A';
    const wCol = waitColor(wait);
    const sCls = statusClass(c.congestion_status);
    const demoTag = c.is_demo ? '<span class="demo-tag">DEMO</span>' : '';
    return `<div class="centre-card" onclick="openMonitor(${c.id})">
      <div class="cc-header">
        <div>
          <div class="cc-title">${c.name}</div>
          <div class="cc-type">${c.service_type}</div>
        </div>
        <span class="cc-status-badge ${sCls}">${c.congestion_status || 'Unknown'}</span>
      </div>
      <div class="cc-body">
        <div class="cc-location">📍 ${c.location}</div>
        <div class="cc-stats">
          <div class="cc-stat-item"><div class="cc-stat-val">${c.queue_length ?? '—'}</div><div class="cc-stat-label">Waiting</div></div>
          <div class="cc-stat-item"><div class="cc-stat-val">${c.active_counters ?? '—'}</div><div class="cc-stat-label">Counters</div></div>
          <div class="cc-stat-item"><div class="cc-stat-val">${c.people_being_served ?? '—'}</div><div class="cc-stat-label">Being Served</div></div>
          <div class="cc-stat-item"><div class="cc-stat-val cc-wait ${wCol}">${waitStr}</div><div class="cc-stat-label">Est. Wait</div></div>
        </div>
        ${c.lower_bound !== null && c.upper_bound !== null ? `<div style="font-size:.75rem;color:var(--text-muted)">Range: ${c.lower_bound}–${c.upper_bound} min</div>` : ''}
      </div>
      <div class="cc-footer">
        <span>⏰ ${fmtTime(c.last_updated)}</span>
        <span>🕐 ${c.operating_hours || '—'}</span>
        ${demoTag}
      </div>
    </div>`;
  }).join('');
}

function applyFilters() {
  const search = document.getElementById('dashSearch').value.toLowerCase();
  const type   = document.getElementById('typeFilter').value;
  const maxWait = parseFloat(document.getElementById('waitFilter').value) || Infinity;
  const filtered = _centres.filter(c => {
    const matchSearch = !search || c.name.toLowerCase().includes(search) || c.service_type.toLowerCase().includes(search) || c.location.toLowerCase().includes(search);
    const matchType   = !type || c.service_type === type;
    const matchWait   = !isFinite(maxWait) || c.predicted_wait_min === null || c.predicted_wait_min <= maxWait;
    return matchSearch && matchType && matchWait;
  });
  renderCentreCards(filtered);
}

function clearFilters() {
  document.getElementById('dashSearch').value = '';
  document.getElementById('typeFilter').value = '';
  document.getElementById('waitFilter').value = '';
  renderCentreCards(_centres);
}

function populateAllSelects(centres) {
  ['monitorCentreSelect','btCentreSelect','analyticsCentreSelect',
   'updCentre','updCentre2','threshCentre','mlCentre','exportCentre'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = `<option value="">— Choose a centre —</option>` +
      centres.map(c => `<option value="${c.id}" ${c.id == current ? 'selected' : ''}>${c.name}</option>`).join('');
  });
}

// ── Live Monitor ─────────────────────────────────────────────
function openMonitor(id) {
  showPage('monitor');
  const sel = document.getElementById('monitorCentreSelect');
  sel.value = id;
  loadMonitor();
}

async function loadMonitor() {
  const id = document.getElementById('monitorCentreSelect').value;
  const content = document.getElementById('monitorContent');
  if (!id) { content.classList.add('hidden'); return; }
  content.classList.remove('hidden');
  if (_monitorInterval) clearInterval(_monitorInterval);
  await fetchMonitorData(id);
  _monitorInterval = setInterval(() => {
    if (_activePage === 'monitor') fetchMonitorData(id);
  }, 30000);
}

let _monitorHistory = [];

async function fetchMonitorData(id) {
  try {
    const [centre, pred] = await Promise.all([
      apiFetch(`/api/centres/${id}`),
      apiFetch(`/api/centres/${id}/predict`),
    ]);
    renderMonitorKPIs(centre);
    renderPrediction(pred);
    _monitorHistory.push({ ql: centre.queue_length, ts: new Date().toLocaleTimeString() });
    if (_monitorHistory.length > 20) _monitorHistory.shift();
    renderMonitorChart();
  } catch (e) {
    showToast('Monitor update failed: ' + e.message, 'error');
  }
}

function renderMonitorKPIs(c) {
  const kpis = [
    { val: c.queue_length ?? '—', label: 'Waiting', icon: '👥' },
    { val: c.active_counters ?? '—', label: 'Active Counters', icon: '🪟' },
    { val: c.people_being_served ?? '—', label: 'Being Served', icon: '⚙️' },
    { val: c.predicted_wait_min !== null ? c.predicted_wait_min + ' min' : '—', label: 'Est. Wait', icon: '⏱' },
    { val: c.congestion_status || 'Unknown', label: 'Status', icon: '📊' },
  ];
  document.getElementById('monitorKpis').innerHTML = kpis.map(k =>
    `<div class="kpi-card"><div class="kpi-val">${k.val}</div><div class="kpi-label">${k.icon} ${k.label}</div></div>`
  ).join('');
}

function renderPrediction(p) {
  const panel = document.getElementById('predictionPanel');
  if (p.error) {
    panel.innerHTML = `<div class="pred-note">⚠️ ${p.note || 'Cannot generate prediction.'}</div>`;
    return;
  }
  const wCol = waitColor(p.predicted_wait_min);
  const confPct = Math.round((p.confidence || 0) * 100);
  const colClass = { 'wait-green': '#16a34a', 'wait-orange': '#ea580c', 'wait-red': '#dc2626' };
  const waitClr = colClass[wCol] || '#0F52BA';
  panel.innerHTML = `
    <h3 style="font-size:.9rem;font-weight:600;color:var(--text-secondary);margin-bottom:1rem">AI Prediction</h3>
    <div class="pred-method">${p.prediction_method || 'Mathematical Baseline'}</div>
    <div class="pred-wait-big" style="color:${waitClr}">${p.predicted_wait_min !== null ? p.predicted_wait_min + ' min' : '—'}</div>
    ${p.lower_bound !== null ? `<div class="pred-bounds">Range: ${p.lower_bound} – ${p.upper_bound} min</div>` : ''}
    <div class="pred-confidence">
      <span style="font-size:.78rem;color:var(--text-muted)">Confidence</span>
      <div class="conf-bar-wrap"><div class="conf-bar" style="width:${confPct}%"></div></div>
      <span style="font-size:.78rem;font-weight:700">${confPct}%</span>
    </div>
    <div class="pred-note">${p.note || ''}</div>
    <div style="margin-top:.75rem"><span class="cc-status-badge ${statusClass(p.congestion_status)}">${p.congestion_status}</span></div>
  `;
}

function renderMonitorChart() {
  destroyChart('monitorChart');
  const ctx = document.getElementById('monitorChart');
  if (!ctx) return;
  _chartRefs['monitorChart'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: _monitorHistory.map(h => h.ts),
      datasets: [{
        label: 'Queue Length',
        data: _monitorHistory.map(h => h.ql),
        borderColor: '#0F52BA',
        backgroundColor: 'rgba(15,82,186,.08)',
        fill: true, tension: .4, pointRadius: 4, pointBackgroundColor: '#0F52BA',
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'People Waiting' } } },
    },
  });
}

// ── Compare ──────────────────────────────────────────────────
async function loadCompare() {
  if (!_centres.length) {
    try { _centres = await apiFetch('/api/centres'); populateAllSelects(_centres); } catch {}
  }
  const box = document.getElementById('compareCheckboxes');
  box.innerHTML = _centres.map(c =>
    `<label><input type="checkbox" value="${c.id}" ${_selectedCompare.has(c.id) ? 'checked' : ''} onchange="toggleCompare(${c.id},this.checked)"> ${c.name}</label>`
  ).join('');
  if (_selectedCompare.size === 0) {
    _centres.forEach(c => _selectedCompare.add(c.id));
    box.querySelectorAll('input').forEach(i => i.checked = true);
  }
  renderCompare();
}

function toggleCompare(id, checked) {
  checked ? _selectedCompare.add(id) : _selectedCompare.delete(id);
  renderCompare();
}

function renderCompare() {
  const sortBy = document.getElementById('compareSortBy').value;
  let data = _centres.filter(c => _selectedCompare.has(c.id));
  if (sortBy === 'wait')     data.sort((a,b) => (a.predicted_wait_min??999) - (b.predicted_wait_min??999));
  if (sortBy === 'queue')    data.sort((a,b) => (a.queue_length??999) - (b.queue_length??999));
  if (sortBy === 'counters') data.sort((a,b) => (b.active_counters??0) - (a.active_counters??0));
  const tbody = document.getElementById('compareBody');
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:2rem">No centres selected.</td></tr>'; return; }
  tbody.innerHTML = data.map(c => {
    const wait = c.predicted_wait_min;
    return `<tr>
      <td><strong>${c.name}</strong><br><span style="font-size:.75rem;color:var(--text-muted)">${c.location}</span></td>
      <td>${c.service_type}</td>
      <td>${c.queue_length ?? '—'}</td>
      <td>${c.active_counters ?? '—'}</td>
      <td><span class="${waitColor(wait)}" style="font-weight:700">${wait !== null && wait !== undefined ? wait + ' min' : '—'}</span></td>
      <td><span class="cc-status-badge ${statusClass(c.congestion_status)}">${c.congestion_status || '—'}</span></td>
      <td>${c.operating_hours || '—'}</td>
      <td>${fmtTime(c.last_updated)}</td>
    </tr>`;
  }).join('');
}

// ── Best Time ────────────────────────────────────────────────
async function loadBestTime() {
  const id = document.getElementById('btCentreSelect').value;
  const content = document.getElementById('btContent');
  if (!id) { content.classList.add('hidden'); return; }
  try {
    const data = await apiFetch(`/api/centres/${id}/best-time`);
    content.classList.remove('hidden');
    if (!data.available) {
      document.getElementById('btRec').innerHTML = `<div class="bt-rec-title">⚠️ Insufficient Data</div><div class="bt-rec-text">${data.message}</div>`;
      document.getElementById('btHoursGrid').innerHTML = '';
      destroyChart('btChart');
      return;
    }
    document.getElementById('btRec').innerHTML = `<div class="bt-rec-title">🎯 Recommendation</div><div class="bt-rec-text">${data.recommendation}</div>`;
    renderBtChart(data.hourly_avg);
    renderBtHours(data.hourly_avg, data.recommended_hours, data.busy_hours);
  } catch (e) {
    showToast('Failed to load best-time data: ' + e.message, 'error');
  }
}

function renderBtChart(hourly) {
  destroyChart('btChart');
  const ctx = document.getElementById('btChart');
  if (!ctx || !hourly.length) return;
  const labels = hourly.map(h => `${String(h.hour).padStart(2,'0')}:00`);
  const data   = hourly.map(h => h.avg_wait);
  const colors = hourly.map(h => h.label === 'Quiet' ? '#16a34a' : h.label === 'Busy' ? '#dc2626' : '#0F52BA');
  _chartRefs['btChart'] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Avg Wait (min)', data, backgroundColor: colors, borderRadius: 6 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.parsed.y} min avg wait` } } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Avg Wait (minutes)' } }, x: { title: { display: true, text: 'Hour of Day' } } },
    },
  });
}

function renderBtHours(hourly, quietHours, busyHours) {
  const grid = document.getElementById('btHoursGrid');
  grid.innerHTML = hourly.map(h => {
    const cls = h.label === 'Quiet' ? 'bt-quiet' : h.label === 'Busy' ? 'bt-busy' : 'bt-normal';
    return `<div class="bt-hour-cell ${cls}">
      <div style="font-size:1rem">${String(h.hour).padStart(2,'0')}:00</div>
      <div style="margin-top:.2rem">${h.avg_wait} min</div>
      <div style="font-size:.65rem;opacity:.8">${h.label}</div>
    </div>`;
  }).join('');
}

// ── Analytics ────────────────────────────────────────────────
async function loadAnalytics() {
  const id   = document.getElementById('analyticsCentreSelect').value;
  const days = document.getElementById('analyticsDays').value;
  const content = document.getElementById('analyticsContent');
  const empty   = document.getElementById('analyticsEmpty');
  if (!id) { content.classList.add('hidden'); empty.classList.remove('hidden'); return; }
  try {
    const data = await apiFetch(`/api/centres/${id}/analytics?days=${days}`);
    const snaps = data.snapshots;
    if (!snaps.length) {
      content.classList.add('hidden');
      empty.innerHTML = 'No historical data available for this centre and time range.';
      empty.classList.remove('hidden');
      return;
    }
    content.classList.remove('hidden');
    empty.classList.add('hidden');
    const labels = snaps.map(s => fmtDate(s.timestamp));
    const step = Math.max(1, Math.floor(labels.length / 40));
    buildLineChart('chartQueueLen', snaps.map((_,i) => i % step === 0 ? labels[i] : ''), snaps.map(s => s.queue_length), 'Queue Length', '#0F52BA');
    buildLineChart('chartWaitTime', snaps.map((_,i) => i % step === 0 ? labels[i] : ''), snaps.map(s => s.est_wait), 'Est. Wait (min)', '#6366f1');
    const hourMap = {};
    snaps.forEach(s => {
      const h = new Date(s.timestamp).getHours();
      if (!hourMap[h]) hourMap[h] = [];
      hourMap[h].push(s.est_wait);
    });
    const hours = Array.from({length: 24}, (_, i) => i);
    const hourlyAvg = hours.map(h => hourMap[h] ? (hourMap[h].reduce((a,b)=>a+b,0)/hourMap[h].length).toFixed(1) : null);
    buildBarChart('chartHourly', hours.map(h=>`${String(h).padStart(2,'0')}:00`), hourlyAvg, 'Avg Wait (min)', '#16a34a');
    const arrRate = snaps.map(s => s.arrival_rate);
    const svcRate = snaps.map(s => s.active_counters > 0 ? +(s.active_counters / s.avg_service_time).toFixed(2) : 0);
    buildDualLineChart('chartRates', snaps.map((_,i)=>i % step === 0 ? labels[i] : ''), arrRate, svcRate, 'Arrival Rate', 'Service Capacity', '#ea580c', '#16a34a');
  } catch (e) {
    showToast('Failed to load analytics: ' + e.message, 'error');
  }
}

function buildLineChart(id, labels, data, label, color) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  _chartRefs[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '18', fill: true, tension: .3, pointRadius: 1 }] },
    options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } },
  });
}

function buildBarChart(id, labels, data, label, color) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  _chartRefs[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: color + 'cc', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } },
  });
}

function buildDualLineChart(id, labels, d1, d2, l1, l2, c1, c2) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  _chartRefs[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: l1, data: d1, borderColor: c1, backgroundColor: c1 + '18', fill: false, tension: .3, pointRadius: 1 },
        { label: l2, data: d2, borderColor: c2, backgroundColor: c2 + '18', fill: false, tension: .3, pointRadius: 1, borderDash: [5,5] },
      ],
    },
    options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } },
  });
}

// ══════════════════════════════════════════════════════════════
//  ADMIN FUNCTIONS
// ══════════════════════════════════════════════════════════════

async function doLogin() {
  const username = document.getElementById('adminUser').value.trim();
  const password = document.getElementById('adminPass').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    _adminUser = res;
    showAdminPanel(res);
    showAdminPage('admin-overview');
  } catch (e) {
    errEl.textContent = e.message || 'Login failed';
    errEl.classList.remove('hidden');
  } finally {
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Sign In to Admin`;
    btn.disabled = false;
  }
}

function showAdminPanel(user) {
  document.getElementById('adminWelcomeBadge').textContent = `👤 ${user.username} (${user.role})`;
  document.getElementById('adminSidebarWelcome').textContent = `👤 ${user.username}`;
  document.getElementById('page-admin-login').classList.remove('active');
  showToast(`Welcome back, ${user.username}!`, 'success');
}

async function doLogout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
  _adminUser = null;
  showToast('Logged out successfully', 'info');
  switchToClient();
}

async function loadAdminData() {
  try {
    const centres = await apiFetch('/api/admin/centres');
    _centres = centres;
    populateAllSelects(centres);

    // Admin KPIs
    const kpiGrid = document.getElementById('adminKpiGrid');
    if (kpiGrid) {
      const totalWait = centres.reduce((a,c) => a + (c.queue_length || 0), 0);
      const busyCount = centres.filter(c => c.congestion_status === 'Busy' || c.congestion_status === 'Very Busy').length;
      const avgWait = centres.filter(c => c.predicted_wait_min !== null).reduce((a,c,_,arr) => a + c.predicted_wait_min/arr.length, 0);
      kpiGrid.innerHTML = [
        { val: centres.length, label: 'Total Centres', icon: '🏢', color: '#7c3aed' },
        { val: totalWait, label: 'People Waiting', icon: '👥', color: '#0F52BA' },
        { val: busyCount, label: 'Busy Centres', icon: '🔴', color: '#dc2626' },
        { val: centres.length > 0 ? Math.round(avgWait) + ' min' : '—', label: 'Avg Wait', icon: '⏱', color: '#ea580c' },
      ].map(k => `
        <div class="kpi-card" style="--kpi-color:${k.color}">
          <div class="kpi-val" style="color:${k.color}">${k.val}</div>
          <div class="kpi-label">${k.icon} ${k.label}</div>
        </div>`
      ).join('');
    }

    // Overview list
    const listEl = document.getElementById('adminCentresList');
    if (listEl) {
      listEl.innerHTML = centres.map(c => `
        <div class="admin-centre-item">
          <div class="admin-centre-item-header">
            <h4>${c.name} <span class="cc-status-badge ${statusClass(c.congestion_status)}" style="font-size:.65rem">${c.congestion_status || '—'}</span></h4>
            <span class="centre-type-tag">${c.service_type}</span>
          </div>
          <p style="color:var(--text-muted);font-size:.8rem">📍 ${c.location}</p>
          <div class="admin-centre-metrics">
            <span>👥 <strong>${c.queue_length ?? '—'}</strong> waiting</span>
            <span>🪟 <strong>${c.active_counters ?? '—'}</strong> counters</span>
            <span style="font-weight:700;color:${c.predicted_wait_min <= 10 ? '#16a34a' : c.predicted_wait_min <= 25 ? '#ea580c' : '#dc2626'}">${c.predicted_wait_min !== null && c.predicted_wait_min !== undefined ? c.predicted_wait_min + ' min est.' : '—'}</span>
          </div>
          <div class="admin-centre-footer">Updated: ${fmtTime(c.last_updated)} &nbsp;|&nbsp; Hours: ${c.operating_hours || '—'}</div>
        </div>
      `).join('');
    }

    // Bulk update list
    loadBulkUpdateList();
  } catch (e) {
    showToast('Failed to load admin data: ' + e.message, 'error');
  }
}

// ── Upload Tab Switching ──────────────────────────────────────
function switchUploadTab(name) {
  document.querySelectorAll('.umethod-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.upload-tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`utab-${name}`).classList.add('active');
  document.getElementById(`ucontent-${name}`).classList.add('active');
  if (name === 'bulk') loadBulkUpdateList();
}

// ── Manual Queue Update (Upload tab) ─────────────────────────
async function submitQueueUpdate() {
  const id = document.getElementById('updCentre').value;
  if (!id) { showToast('Select a service centre first', 'error'); return; }
  _submitQueueCore(id,
    parseInt(document.getElementById('updQueue').value),
    parseInt(document.getElementById('updCounters').value),
    parseInt(document.getElementById('updServed').value),
    parseFloat(document.getElementById('updServiceTime').value),
    parseFloat(document.getElementById('updArrival').value),
    document.getElementById('updNote').value.trim(),
    'updateResult'
  );
}

async function submitQueueUpdate2() {
  const id = document.getElementById('updCentre2').value;
  if (!id) { showToast('Select a service centre first', 'error'); return; }
  _submitQueueCore(id,
    parseInt(document.getElementById('updQueue2').value),
    parseInt(document.getElementById('updCounters2').value),
    parseInt(document.getElementById('updServed2').value),
    parseFloat(document.getElementById('updServiceTime2').value),
    parseFloat(document.getElementById('updArrival2').value),
    document.getElementById('updNote2').value.trim(),
    'updateResult2'
  );
}

async function _submitQueueCore(id, ql, ac, pbs, ast, ar, note, resultId) {
  if (ql < 0 || ac < 0 || pbs < 0 || ast <= 0 || ar < 0) {
    showToast('Invalid values. All values must be non-negative; service time must be positive.', 'error'); return;
  }
  try {
    const res = await apiFetch(`/api/centres/${id}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_length: ql, active_counters: ac, people_being_served: pbs, avg_service_time: ast, arrival_rate: ar, note }),
    });
    const el = document.getElementById(resultId);
    const p  = res.prediction;
    el.className = 'result-box success';
    el.innerHTML = p.error
      ? `⚠️ Updated but prediction failed: ${p.note}`
      : `✅ Published! Estimated wait: <strong>${p.predicted_wait_min} min</strong> (${p.congestion_status}). ${p.note}`;
    el.classList.remove('hidden');
    showToast('Queue data published — visible to clients now!', 'success');
    loadAdminData();
  } catch (e) {
    const el = document.getElementById(resultId);
    el.className = 'result-box error';
    el.textContent = '❌ Error: ' + e.message;
    el.classList.remove('hidden');
  }
}

// ── CSV Upload ────────────────────────────────────────────────
function handleCsvDrop(event) {
  event.preventDefault();
  document.getElementById('csvDropzone').classList.remove('dragover');
  const file = event.dataTransfer.files[0];
  if (file) parseCsvFile(file);
}

function handleCsvFile(event) {
  const file = event.target.files[0];
  if (file) parseCsvFile(file);
}

function parseCsvFile(file) {
  if (!file.name.endsWith('.csv')) { showToast('Please upload a .csv file', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.trim().split('\n');
    if (lines.length < 2) { showToast('CSV file is empty or has no data rows', 'error'); return; }
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    _csvRows = lines.slice(1).map((line, idx) => {
      const vals = line.split(',').map(v => v.trim());
      const obj = {};
      headers.forEach((h, i) => obj[h] = vals[i] || '');
      obj._row = idx + 2;
      return obj;
    }).filter(r => r.centre_name || r['centre_name']);

    renderCsvPreview(headers, _csvRows.slice(0, 10));
    document.getElementById('csvSubmitBtn').style.display = 'inline-flex';
  };
  reader.readAsText(file);
}

function renderCsvPreview(headers, rows) {
  const preview = document.getElementById('csvPreview');
  preview.classList.remove('hidden');
  preview.innerHTML = `
    <div class="csv-preview-header">
      <span>📋 Preview — ${_csvRows.length} rows loaded ${_csvRows.length > 10 ? '(showing first 10)' : ''}</span>
    </div>
    <div class="csv-table-wrap">
      <table class="csv-table">
        <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${headers.map(h => `<td>${r[h] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
  `;
}

async function submitCsvUpload() {
  if (!_csvRows.length) { showToast('No CSV data to upload', 'error'); return; }
  const resultEl = document.getElementById('csvResult');
  resultEl.className = 'result-box'; resultEl.textContent = `⏳ Publishing ${_csvRows.length} rows...`; resultEl.classList.remove('hidden');

  let success = 0, failed = 0;
  // Find centre IDs by name
  const centreMap = {};
  _centres.forEach(c => { centreMap[c.name.toLowerCase()] = c.id; });

  for (const row of _csvRows) {
    const name = (row.centre_name || '').toLowerCase();
    const centreId = centreMap[name];
    if (!centreId) { failed++; continue; }
    try {
      await apiFetch(`/api/centres/${centreId}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queue_length: parseInt(row.queue_length) || 0,
          active_counters: parseInt(row.active_counters) || 1,
          people_being_served: parseInt(row.people_being_served) || 0,
          avg_service_time: parseFloat(row.avg_service_time) || 5,
          arrival_rate: parseFloat(row.arrival_rate) || 1,
          note: row.note || 'CSV upload',
        }),
      });
      success++;
    } catch { failed++; }
  }

  resultEl.className = failed === 0 ? 'result-box success' : 'result-box';
  resultEl.innerHTML = `✅ Uploaded: <strong>${success}</strong> rows published${failed > 0 ? ` | ❌ Failed: ${failed} (centre name not found)` : ''}`;
  showToast(`Published ${success} queue updates from CSV!`, success > 0 ? 'success' : 'error');
  loadAdminData();
}

// ── Bulk Update ───────────────────────────────────────────────
function loadBulkUpdateList() {
  const listEl = document.getElementById('bulkUpdateList');
  if (!listEl) return;
  if (!_centres.length) { listEl.innerHTML = '<div class="loading-placeholder">Loading centres...</div>'; return; }
  listEl.innerHTML = _centres.map(c => `
    <div class="bulk-row">
      <div class="bulk-row-name">
        <strong>${c.name}</strong>
        <span class="cc-status-badge ${statusClass(c.congestion_status)}" style="font-size:.65rem">${c.congestion_status || '—'}</span>
      </div>
      <div class="bulk-row-fields">
        <label>Waiting
          <input type="number" class="bulk-input" id="bq-${c.id}" min="0" value="${c.queue_length ?? 0}" />
        </label>
        <label>Counters
          <input type="number" class="bulk-input" id="bc-${c.id}" min="1" value="${c.active_counters ?? 1}" />
        </label>
        <label>Svc Time
          <input type="number" class="bulk-input" id="bt-${c.id}" min="0.5" step="0.5" value="${c.avg_service_time ?? 5}" />
        </label>
      </div>
    </div>
  `).join('');
}

async function submitBulkUpdate() {
  const resultEl = document.getElementById('bulkResult');
  resultEl.className = 'result-box'; resultEl.textContent = '⏳ Publishing all updates...'; resultEl.classList.remove('hidden');
  let success = 0, failed = 0;
  for (const c of _centres) {
    const qlEl = document.getElementById(`bq-${c.id}`);
    const acEl = document.getElementById(`bc-${c.id}`);
    const stEl = document.getElementById(`bt-${c.id}`);
    if (!qlEl) continue;
    try {
      await apiFetch(`/api/centres/${c.id}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queue_length: parseInt(qlEl.value) || 0,
          active_counters: parseInt(acEl.value) || 1,
          people_being_served: Math.min(parseInt(acEl.value) || 1, parseInt(qlEl.value) || 0),
          avg_service_time: parseFloat(stEl.value) || 5,
          arrival_rate: 1.5,
          note: 'Bulk update',
        }),
      });
      success++;
    } catch { failed++; }
  }
  resultEl.className = 'result-box success';
  resultEl.innerHTML = `✅ Bulk update complete — <strong>${success}</strong> centres updated${failed ? ` (${failed} failed)` : ''}. Changes visible to clients now!`;
  showToast(`Bulk update: ${success} centres published`, 'success');
  loadAdminData();
}

// ── Add Centre ────────────────────────────────────────────────
async function addCentre() {
  const name     = document.getElementById('newCentreName').value.trim();
  const type     = document.getElementById('newCentreType').value;
  const location = document.getElementById('newCentreLocation').value.trim();
  const hours    = document.getElementById('newCentreHours').value.trim();
  if (!name || !location) { showToast('Name and location are required', 'error'); return; }
  try {
    const res = await apiFetch('/api/centres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, service_type: type, location, operating_hours: hours }),
    });
    const el = document.getElementById('addCentreResult');
    el.className = 'result-box success';
    el.textContent = `✅ Centre added! ID: ${res.centre_id} — now visible in client dashboard.`;
    el.classList.remove('hidden');
    showToast('Centre added — visible to clients!', 'success');
    loadAdminData();
  } catch (e) {
    const el = document.getElementById('addCentreResult');
    el.className = 'result-box error';
    el.textContent = '❌ Error: ' + e.message;
    el.classList.remove('hidden');
  }
}

// ── Thresholds ────────────────────────────────────────────────
async function saveThresholds() {
  const id = document.getElementById('threshCentre').value;
  if (!id) { showToast('Select a service centre first', 'error'); return; }
  const q = parseFloat(document.getElementById('threshQuiet').value);
  const n = parseFloat(document.getElementById('threshNormal').value);
  const b = parseFloat(document.getElementById('threshBusy').value);
  if (q >= n || n >= b) { showToast('Thresholds must be in ascending order: Quiet < Normal < Busy', 'error'); return; }
  try {
    await apiFetch(`/api/admin/centres/${id}/thresholds`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quiet_max_min: q, normal_max_min: n, busy_max_min: b }),
    });
    const el = document.getElementById('threshResult');
    el.className = 'result-box success';
    el.textContent = '✅ Thresholds saved. Status labels updated for clients.';
    el.classList.remove('hidden');
    showToast('Thresholds updated', 'success');
  } catch (e) {
    const el = document.getElementById('threshResult');
    el.className = 'result-box error';
    el.textContent = '❌ Error: ' + e.message;
    el.classList.remove('hidden');
  }
}

// ── ML Models ─────────────────────────────────────────────────
async function trainModel() {
  const id = document.getElementById('mlCentre').value;
  if (!id) { showToast('Select a service centre first', 'error'); return; }
  const el = document.getElementById('mlResult');
  el.className = 'result-box'; el.textContent = '⏳ Training model...'; el.classList.remove('hidden');
  try {
    const res = await apiFetch(`/api/centres/${id}/train`, { method: 'POST' });
    if (res.success) {
      el.className = 'result-box success';
      el.innerHTML = `✅ Model trained!<br>MAE: <strong>${res.mae_minutes} min</strong> | Train: ${res.train_records} | Test: ${res.test_records}<br><small style="opacity:.7">Version: ${res.model_version}</small>`;
      showToast('ML model trained!', 'success');
      loadMLStatus();
    } else {
      el.className = 'result-box error';
      el.textContent = '❌ Training failed: ' + res.error;
    }
  } catch (e) {
    el.className = 'result-box error';
    el.textContent = '❌ Error: ' + e.message;
  }
}

async function loadMLStatus() {
  try {
    const data = await apiFetch('/api/admin/model-status');
    const el   = document.getElementById('mlStatusList');
    if (!data.models.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">No trained models yet.</p>'; return; }
    el.innerHTML = '<h4 style="margin-bottom:.75rem">Trained Models</h4>' + data.models.map(m => `
      <div class="admin-centre-item" style="margin-bottom:.5rem">
        <h4>Centre #${m.centre_id}</h4>
        <p>MAE: ${m.mae_minutes} min · Train: ${m.train_size} · Test: ${m.test_size}</p>
        <p style="font-size:.72rem">Trained: ${fmtDate(m.trained_at)}</p>
      </div>
    `).join('');
  } catch {}
}

// ── Export / Reset ────────────────────────────────────────────
function exportCSV() {
  const id = document.getElementById('exportCentre').value;
  if (!id) { showToast('Select a service centre first', 'error'); return; }
  window.open(`/api/admin/export/${id}`, '_blank');
}

async function resetDemo() {
  if (!confirm('This will delete all demo snapshots and regenerate fresh demo data. Continue?')) return;
  try {
    await apiFetch('/api/admin/reset-demo', { method: 'POST' });
    showToast('Demo data reset successfully!', 'success');
    loadAdminData();
    _monitorHistory = [];
  } catch (e) {
    showToast('Reset failed: ' + e.message, 'error');
  }
}

// ── Initialise ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildMiniChart();
  showPage('landing');

  // Pre-load centres data for client selects
  apiFetch('/api/centres').then(c => {
    _centres = c;
    populateAllSelects(c);
  }).catch(() => {});
});
