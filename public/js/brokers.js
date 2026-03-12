// brokers.js
'use strict';
import { apiFetch, escHtml, safeHref } from './app.js';

export async function renderBrokers(container) {
  container.innerHTML = `
    <div class="section-header">
      <h3>Data Brokers <span id="brokerCount" style="color:var(--muted);font-weight:400"></span></h3>
      <div class="section-filters">
        <select id="filterBrokerPriority" style="padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);">
          <option value="">All Priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="standard">Standard</option>
        </select>
        <select id="filterSafetyLevel" style="padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);">
          <option value="">All Safety Levels</option>
          <option value="risky">Risky</option>
          <option value="caution">Caution</option>
          <option value="trusted">Trusted</option>
        </select>
        <input id="searchBroker" type="search" placeholder="Search brokers…" style="padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);min-width:200px">
      </div>
    </div>
    <div id="brokerList"><div class="spinner-wrap"><div class="spinner"></div></div></div>
  `;

  let allBrokers = [];

  async function loadBrokers() {
    const priority = document.getElementById('filterBrokerPriority').value;
    let url = '/api/brokers?limit=500';
    if (priority) url += `&priority=${priority}`;
    const res = await apiFetch(url);
    if (!res) return;
    allBrokers = await res.json();
    renderList(allBrokers);
  }

  function renderList(brokers) {
    const q    = (document.getElementById('searchBroker').value || '').toLowerCase();
    const safety = document.getElementById('filterSafetyLevel').value;
    const list = brokers.filter((b) => {
      const matchesQuery = !q || [b.name, b.url, b.instructions, ...(b.security?.safety_notes || [])]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(q));
      const matchesSafety = !safety || (b.security?.safety_level || '') === safety;
      return matchesQuery && matchesSafety;
    });
    document.getElementById('brokerCount').textContent = `(${list.length})`;
    const wrap = document.getElementById('brokerList');
    if (!list.length) { wrap.innerHTML = '<div class="empty-state"><h4>No brokers found</h4></div>'; return; }

    wrap.innerHTML = `<div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Priority</th><th>Safety</th><th>Status</th><th>Method</th><th>Instructions</th></tr></thead>
        <tbody>${list.map(b => `
          <tr data-id="${escHtml(b.id)}">
            <td>
              <a href="${safeHref(b.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${escHtml(b.name)}</a>
              ${renderBrokerLinks(b)}
            </td>
            <td>${chipPriority(b.priority)}</td>
            <td>${chipSafety(b.security?.safety_level)}</td>
            <td>${renderStatus(b)}</td>
            <td>
              <span class="chip chip-manual">${escHtml(b.method)}</span>
              <div><small style="color:var(--muted)">${escHtml(b.automation)}</small></div>
            </td>
            <td style="font-size:.8rem;color:var(--muted2);max-width:320px">
              ${renderInstructions(b)}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  document.getElementById('filterBrokerPriority').addEventListener('change', loadBrokers);
  document.getElementById('filterSafetyLevel').addEventListener('change', () => renderList(allBrokers));
  document.getElementById('searchBroker').addEventListener('input', () => renderList(allBrokers));

  await loadBrokers();
}

function chipPriority(p) {
  return `<span class="chip chip-${escHtml(p)}">${escHtml(p)}</span>`;
}

function chipSafety(level) {
  if (!level) return '<span style="color:var(--muted)">-</span>';
  const color = level === 'risky'
    ? 'var(--danger)'
    : level === 'caution'
      ? 'var(--warning,#f59e0b)'
      : 'var(--success)';
  return `<span class="chip" style="border-color:${color};color:${color};text-transform:capitalize">${escHtml(level)}</span>`;
}

function renderStatus(broker) {
  const status = broker.status || {};
  const bits = [];
  if (typeof status.alive === 'boolean') {
    bits.push(`<span style="color:${status.alive ? 'var(--success)' : 'var(--danger)'}">${status.alive ? 'Live' : 'Offline'}</span>`);
  }
  if (status.http_status) bits.push(`HTTP ${escHtml(status.http_status)}`);
  if (typeof status.is_new === 'boolean' && status.is_new) bits.push('New');
  if (typeof status.safe_to_fetch === 'boolean') bits.push(status.safe_to_fetch ? 'Safe to fetch' : 'Fetch blocked');
  if (typeof status.checked_at === 'string') bits.push(`Checked ${fmtDate(status.checked_at)}`);
  return bits.length
    ? `<div style="display:flex;flex-direction:column;gap:4px;font-size:.8rem;color:var(--muted2)">${bits.map(bit => `<span>${bit}</span>`).join('')}</div>`
    : '<span style="color:var(--muted)">-</span>';
}

function renderInstructions(broker) {
  const notes = Array.isArray(broker.security?.safety_notes) ? broker.security.safety_notes : [];
  const blocks = [];

  if (broker.instructions) {
    blocks.push(`<div>${escHtml(broker.instructions)}</div>`);
  }
  if (notes.length) {
    blocks.push(`<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">${notes
      .slice(0, 3)
      .map(note => `<span style="color:var(--text)">• ${escHtml(note)}</span>`)
      .join('')}</div>`);
  }

  return blocks.join('') || '<span style="color:var(--muted)">No guidance</span>';
}

function renderBrokerLinks(broker) {
  const links = [];
  if (broker.opt_out_url) {
    const secureLabel = broker.security?.opt_out_https === false ? 'Opt-out link' : 'Secure opt-out';
    links.push(`<a href="${safeHref(broker.opt_out_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--muted);font-size:.8rem;">${escHtml(secureLabel)} ↗</a>`);
  }
  if (broker.contact_email) {
    links.push(`<span style="color:var(--muted2);font-size:.8rem;">${escHtml(broker.contact_email)}</span>`);
  }
  return links.length
    ? `<div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">${links.join('')}</div>`
    : '';
}

function fmtDate(value) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return escHtml(value);
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
