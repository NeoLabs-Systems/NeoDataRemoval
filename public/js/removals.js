// removals.js
'use strict';
import { apiFetch } from './app.js';

export async function renderRemovals(container) {
  container.innerHTML = `
    <div class="stats-grid" id="remStatsGrid"></div>
    <div class="section-header"><h3>Removal History</h3></div>
    <div id="remList"><div class="spinner-wrap"><div class="spinner"></div></div></div>
  `;

  const [statsRes, listRes] = await Promise.all([
    apiFetch('/api/removals/stats'),
    apiFetch('/api/removals?limit=200'),
  ]);
  if (!statsRes || !listRes) return;

  const stats = await statsRes.json();
  const rows  = await listRes.json();

  document.getElementById('remStatsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total Requests</div><div class="stat-value accent">${stats.total || 0}</div></div>
    <div class="stat-card"><div class="stat-label">Sent</div><div class="stat-value accent">${stats.sent || 0}</div></div>
    <div class="stat-card"><div class="stat-label">Confirmed</div><div class="stat-value success">${stats.confirmed || 0}</div></div>
    <div class="stat-card"><div class="stat-label">Manual</div><div class="stat-value warning">${stats.manual || 0}</div></div>
    <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value danger">${stats.failed || 0}</div></div>
  `;

  const wrap = document.getElementById('remList');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <h4>No removal requests yet</h4><p>Go to Exposures and click "Send Removal" to get started.</p></div>`;
    return;
  }

  wrap.innerHTML = `<div class="table-wrap">
    <table>
      <thead><tr><th>Broker</th><th>Method</th><th>Status</th><th>Notes</th><th>Sent At</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td><strong>${r.broker_name || '—'}</strong></td>
          <td><span class="chip chip-manual">${r.method || '—'}</span></td>
          <td>${chipStatus(r.status)}</td>
          <td style="font-size:.8rem;color:var(--muted);max-width:260px;word-break:break-word">${r.notes || '—'}</td>
          <td>${fmtDate(r.sent_at)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function chipStatus(s) {
  const map = { sent:'sent', confirmed:'confirmed', failed:'assumed', manual:'manual' };
  const cls = map[s] || 'manual';
  return `<span class="chip chip-${cls}">${s || '—'}</span>`;
}
function fmtDate(d) {
  if (!d) return '—';
  const ms = typeof d === 'number' ? d * 1000 : Date.parse(d);
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}
