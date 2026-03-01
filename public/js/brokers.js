// brokers.js
'use strict';
import { apiFetch, state, escHtml, safeHref } from './app.js';

export async function renderBrokers(container) {
  const isAdmin = state.user && state.user.role === 'admin';

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
        <input id="searchBroker" type="search" placeholder="Search brokers…" style="padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);min-width:200px">
        ${isAdmin ? `<button class="btn-primary btn-sm" id="btnAddBroker">+ Add</button>` : ''}
      </div>
    </div>
    <div id="brokerList"><div class="spinner-wrap"><div class="spinner"></div></div></div>
    ${isAdmin ? `
    <div class="modal-backdrop hidden" id="brokerModal">
      <div class="modal">
        <div class="modal-header"><h3 id="brokerModalTitle">Add Broker</h3><button class="btn-icon" id="closeBrokerModal">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Name</label><input id="bName" type="text" required></div>
          <div class="field"><label>URL</label><input id="bUrl" type="text"></div>
          <div class="field"><label>Opt-Out URL</label><input id="bOptUrl" type="text"></div>
          <div class="field"><label>Contact Email</label><input id="bEmail" type="email"></div>
          <div class="field"><label>Method</label>
            <select id="bMethod"><option value="form">Form</option><option value="email">Email</option><option value="manual">Manual</option></select>
          </div>
          <div class="field"><label>Priority</label>
            <select id="bPriority"><option value="critical">Critical</option><option value="high">High</option><option value="standard" selected>Standard</option></select>
          </div>
          <div class="field"><label>Automation</label>
            <select id="bAuto"><option value="http_form">HTTP Form</option><option value="browser_required">Browser Required</option><option value="email">Email</option><option value="assumes_present">Assumes Present</option></select>
          </div>
          <div class="field"><label>Instructions</label><textarea id="bInstructions" rows="3"></textarea></div>
          <div class="error" id="brokerErr"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="cancelBroker">Cancel</button>
          <button class="btn-primary" id="saveBroker">Save</button>
        </div>
      </div>
    </div>` : ''}
  `;

  let allBrokers = [];
  let editingId  = null;

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
    const list = q ? brokers.filter(b => (b.name||'').toLowerCase().includes(q)) : brokers;
    document.getElementById('brokerCount').textContent = `(${list.length})`;
    const wrap = document.getElementById('brokerList');
    if (!list.length) { wrap.innerHTML = '<div class="empty-state"><h4>No brokers found</h4></div>'; return; }

    wrap.innerHTML = `<div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Priority</th><th>Method</th><th>Automation</th><th>Instructions</th>${isAdmin ? '<th>Actions</th>' : ''}</tr></thead>
        <tbody>${list.map(b => `
          <tr data-id="${escHtml(b.id)}">
            <td><a href="${safeHref(b.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${escHtml(b.name)}</a></td>
            <td>${chipPriority(b.priority)}</td>
            <td><span class="chip chip-manual">${escHtml(b.method)}</span></td>
            <td><small style="color:var(--muted)">${escHtml(b.automation)}</small></td>
            <td style="font-size:.8rem;color:var(--muted2);max-width:280px">${escHtml(b.instructions)}</td>
            ${isAdmin ? `<td>
              <div style="display:flex;gap:6px">
                <button class="btn-secondary btn-sm btn-edit-broker" data-id="${escHtml(b.id)}">Edit</button>
                <button class="btn-danger btn-sm btn-del-broker" data-id="${escHtml(b.id)}">Del</button>
              </div>
            </td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

    if (isAdmin) {
      wrap.querySelectorAll('.btn-edit-broker').forEach(btn => {
        btn.addEventListener('click', () => openEdit(btn.dataset.id));
      });
      wrap.querySelectorAll('.btn-del-broker').forEach(btn => {
        btn.addEventListener('click', () => deleteBroker(btn.dataset.id));
      });
    }
  }

  document.getElementById('filterBrokerPriority').addEventListener('change', loadBrokers);
  document.getElementById('searchBroker').addEventListener('input', () => renderList(allBrokers));

  if (isAdmin) {
    document.getElementById('btnAddBroker').addEventListener('click', () => openModal(null));
    document.getElementById('closeBrokerModal').addEventListener('click', closeModal);
    document.getElementById('cancelBroker').addEventListener('click', closeModal);
    document.getElementById('saveBroker').addEventListener('click', saveBroker);
  }

  function openModal(broker) {
    editingId = broker ? broker.id : null;
    document.getElementById('brokerModalTitle').textContent = broker ? 'Edit Broker' : 'Add Broker';
    document.getElementById('bName').value         = broker ? broker.name        : '';
    document.getElementById('bUrl').value          = broker ? broker.url         : '';
    document.getElementById('bOptUrl').value       = broker ? broker.opt_out_url : '';
    document.getElementById('bEmail').value        = broker ? broker.contact_email : '';
    document.getElementById('bMethod').value       = broker ? broker.method       : 'form';
    document.getElementById('bPriority').value     = broker ? broker.priority     : 'standard';
    document.getElementById('bAuto').value         = broker ? broker.automation   : 'http_form';
    document.getElementById('bInstructions').value = broker ? broker.instructions : '';
    document.getElementById('brokerErr').textContent = '';
    document.getElementById('brokerModal').classList.remove('hidden');
  }

  function closeModal() { document.getElementById('brokerModal').classList.add('hidden'); }

  function openEdit(id) {
    const b = allBrokers.find(x => String(x.id) === String(id));
    if (b) openModal(b);
  }

  async function saveBroker() {
    const payload = {
      name:          document.getElementById('bName').value.trim(),
      url:           document.getElementById('bUrl').value.trim(),
      opt_out_url:   document.getElementById('bOptUrl').value.trim(),
      contact_email: document.getElementById('bEmail').value.trim(),
      method:        document.getElementById('bMethod').value,
      priority:      document.getElementById('bPriority').value,
      automation:    document.getElementById('bAuto').value,
      instructions:  document.getElementById('bInstructions').value.trim(),
    };
    if (!payload.name) { document.getElementById('brokerErr').textContent = 'Name is required.'; return; }
    const btn = document.getElementById('saveBroker');
    btn.disabled = true;
    const url    = editingId ? `/api/brokers/${editingId}` : '/api/brokers';
    const method = editingId ? 'PUT' : 'POST';
    const res    = await apiFetch(url, { method, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    btn.disabled = false;
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { document.getElementById('brokerErr').textContent = data.error || 'Save failed'; return; }
    closeModal();
    loadBrokers();
  }

  async function deleteBroker(id) {
    if (!confirm('Delete this broker entry?')) return;
    await apiFetch(`/api/brokers/${id}`, { method: 'DELETE' });
    loadBrokers();
  }

  await loadBrokers();
}

function chipPriority(p) {
  return `<span class="chip chip-${escHtml(p)}">${escHtml(p)}</span>`;
}
