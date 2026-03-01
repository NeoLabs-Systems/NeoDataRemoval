// dashboard.js
'use strict';
import { apiFetch, escHtml } from './app.js';

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="stats-grid" id="statsGrid">
      <div class="stat-card"><div class="stat-label">Total Exposures</div><div class="stat-value accent" id="stTotal">—</div></div>
      <div class="stat-card"><div class="stat-label">Critical / High</div><div class="stat-value danger" id="stCritical">—</div></div>
      <div class="stat-card"><div class="stat-label">Removals Sent</div><div class="stat-value accent" id="stSent">—</div></div>
      <div class="stat-card"><div class="stat-label">Confirmed Removed</div><div class="stat-value success" id="stDone">—</div></div>
      <div class="stat-card"><div class="stat-label">Manual Pending</div><div class="stat-value warning" id="stManual">—</div></div>
    </div>

    <div class="section-header"><h3>Recent Exposures</h3><a href="#exposures" class="btn-secondary btn-sm">View All</a></div>
    <div id="recentExposures"><div class="spinner-wrap"><div class="spinner"></div></div></div>
  `;

  const [statsRes, expRes] = await Promise.all([
    apiFetch('/api/exposures/stats'),
    apiFetch('/api/exposures?limit=8&sort=severity'),
  ]);
  if (!statsRes || !expRes) return;

  const stats = await statsRes.json();
  const exps  = await expRes.json();

  document.getElementById('stTotal').textContent   = stats.total    || 0;
  document.getElementById('stCritical').textContent= (stats.critical || 0) + ' / ' + (stats.high || 0);
  document.getElementById('stSent').textContent    = stats.sent     || 0;
  document.getElementById('stDone').textContent    = stats.done     || 0;
  document.getElementById('stManual').textContent  = stats.manual   || 0;

  const wrap = document.getElementById('recentExposures');
  if (!exps.length) {
    wrap.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 15s1.5-2 4-2 4 2 4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      <h4>No exposures found</h4><p>Run a scan to discover where your data appears online.</p></div>`;
    return;
  }

  wrap.innerHTML = `<div class="table-wrap">
    <table>
      <thead><tr><th>Broker</th><th>Priority</th><th>Status</th><th>Detected</th><th></th></tr></thead>
      <tbody>${exps.map(e => `
        <tr>
          <td>${escHtml(e.broker_name)}</td>
          <td>${chipPriority(e.priority)}</td>
          <td>${chipStatus(e.status)}</td>
          <td>${fmtDate(e.detected_at)}</td>
          <td><a href="#exposures" class="btn-secondary btn-sm">View</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function chipStatus(s) {
  const map = { detected:'detected', assumed:'assumed', removal_sent:'sent', ai_email_sent:'sent', removal_confirmed:'confirmed', manual_pending:'manual', re_exposed:'reexposed' };
  const cls = escHtml(map[s] || 'manual');
  return `<span class="chip chip-${cls}">${escHtml((s||'').replace(/_/g,' '))}</span>`;
}
function chipPriority(p) {
  return `<span class="chip chip-${escHtml(p)}">${escHtml(p)}</span>`;
}
function fmtDate(d) {
  if (!d) return '—';
  const ms = typeof d === 'number' ? d * 1000 : Date.parse(d);
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}
