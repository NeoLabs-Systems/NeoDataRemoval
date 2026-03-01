// profiles.js
'use strict';
import { apiFetch, escHtml } from './app.js';

export async function renderProfiles(container) {
  container.innerHTML = `
    <div class="section-header">
      <h3>My Profiles</h3>
      <button class="btn-primary btn-sm" id="btnAddProfile">+ New Profile</button>
    </div>
    <div id="profileList"><div class="spinner-wrap"><div class="spinner"></div></div></div>

    <div class="modal-backdrop hidden" id="profileModal">
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><h3 id="profileModalTitle">New Profile</h3><button class="btn-icon" id="closeProfileModal">✕</button></div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          <div class="field"><label>Full Name *</label><input id="pfName" type="text" required></div>
          <div class="field"><label>Date of Birth</label><input id="pfDob" type="date"></div>
          <div class="field"><label>Aliases (comma-separated)</label><input id="pfAliases" type="text" placeholder="e.g. Nick, Nick Smith"></div>

          <p style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Addresses</p>
          <div id="addressList"></div>
          <button class="btn-secondary btn-sm" id="btnAddAddress" style="margin-bottom:16px">+ Address</button>

          <p style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Phone Numbers</p>
          <div id="phoneList"></div>
          <button class="btn-secondary btn-sm" id="btnAddPhone" style="margin-bottom:16px">+ Phone</button>

          <p style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Email Addresses</p>
          <div id="emailList"></div>
          <button class="btn-secondary btn-sm" id="btnAddEmail">+ Email</button>

          <div class="error" id="profileErr" style="margin-top:12px"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="cancelProfile">Cancel</button>
          <button class="btn-primary" id="saveProfile">Save Profile</button>
        </div>
      </div>
    </div>
  `;

  let editingId = null;

  document.getElementById('btnAddProfile').addEventListener('click', () => openModal());
  document.getElementById('closeProfileModal').addEventListener('click', closeModal);
  document.getElementById('cancelProfile').addEventListener('click', closeModal);
  document.getElementById('saveProfile').addEventListener('click', saveProfile);
  document.getElementById('btnAddAddress').addEventListener('click', () => addAddressRow());
  document.getElementById('btnAddPhone').addEventListener('click', () => addPhoneRow());
  document.getElementById('btnAddEmail').addEventListener('click', () => addEmailRow());

  await loadProfiles();

  async function loadProfiles() {
    const res = await apiFetch('/api/profiles');
    if (!res) return;
    const list = await res.json();
    renderList(list);
  }

  function renderList(profiles) {
    const wrap = document.getElementById('profileList');
    if (!profiles.length) {
      wrap.innerHTML = `<div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <h4>No profiles yet</h4><p>Add a profile to start scanning for your data online.</p></div>`;
      return;
    }
    wrap.innerHTML = `<div class="card-grid">
      ${profiles.map(p => `
        <div class="card">
          <div class="card-title">${escHtml(p.name)}</div>
          <div class="card-meta"></div>
          <div class="card-meta" style="font-size:.75rem;color:var(--muted)">ID: ${escHtml(p.id)}</div>
          <div class="card-actions">
            <button class="btn-danger btn-sm btn-del-profile" data-id="${escHtml(p.id)}">Delete</button>
          </div>
        </div>`).join('')}
    </div>`;

    wrap.querySelectorAll('.btn-del-profile').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this profile and all associated data?')) return;
        await apiFetch(`/api/profiles/${btn.dataset.id}`, { method: 'DELETE' });
        loadProfiles();
      });
    });
  }

  function openModal() {
    editingId = null;
    document.getElementById('profileModalTitle').textContent = 'New Profile';
    document.getElementById('pfName').value    = '';
    document.getElementById('pfDob').value     = '';
    document.getElementById('pfAliases').value = '';
    document.getElementById('profileErr').textContent = '';

    // render empty rows for new profile
    const addrs  = [];
    const phones = [];
    const emails = [];

    document.getElementById('addressList').innerHTML = '';
    document.getElementById('phoneList').innerHTML   = '';
    document.getElementById('emailList').innerHTML   = '';
    if (addrs.length)  addrs.forEach(a => addAddressRow(a));  else addAddressRow();
    if (phones.length) phones.forEach(p => addPhoneRow(p));   else addPhoneRow();
    if (emails.length) emails.forEach(e => addEmailRow(e));   else addEmailRow();

    document.getElementById('profileModal').classList.remove('hidden');
  }

  function closeModal() { document.getElementById('profileModal').classList.add('hidden'); }

  function rowWrap(inputsHtml) {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin-bottom:8px';
    div.innerHTML = inputsHtml + `<button class="btn-danger btn-sm" style="flex-shrink:0;margin-top:0" data-remove>✕</button>`;
    div.querySelector('[data-remove]').addEventListener('click', () => div.remove());
    return div;
  }

  function addAddressRow(a = {}) {
    const div = rowWrap(`
      <input type="text" placeholder="Street" value="${a.street||''}" data-field="street" style="flex:2;padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">
      <input type="text" placeholder="City"   value="${a.city||''}"   data-field="city"   style="flex:1;padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">
      <input type="text" placeholder="State"  value="${a.state||''}"  data-field="state"  style="width:60px;padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">
      <input type="text" placeholder="ZIP"    value="${a.zip||''}"    data-field="zip"    style="width:70px;padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">`);
    document.getElementById('addressList').appendChild(div);
  }

  function addPhoneRow(p = {}) {
    const div = rowWrap(`
      <input type="tel" placeholder="Phone number" value="${(typeof p==='string'?p:p.number)||''}" data-field="number" style="flex:1;padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">`);
    document.getElementById('phoneList').appendChild(div);
  }

  function addEmailRow(e = {}) {
    const div = rowWrap(`
      <input type="email" placeholder="Email address" value="${(typeof e==='string'?e:e.address)||''}" data-field="address" style="flex:1;padding:7px 10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)">`);
    document.getElementById('emailList').appendChild(div);
  }

  function getRows(containerId, singleField) {
    return Array.from(document.getElementById(containerId).querySelectorAll('div'))
      .map(row => {
        if (singleField) {
          const val = row.querySelector(`[data-field="${singleField}"]`)?.value.trim();
          return val ? { [singleField]: val } : null;
        }
        const obj = {};
        row.querySelectorAll('[data-field]').forEach(inp => {
          if (inp.value.trim()) obj[inp.dataset.field] = inp.value.trim();
        });
        return Object.keys(obj).length ? obj : null;
      })
      .filter(Boolean);
  }

  async function saveProfile() {
    const name = document.getElementById('pfName').value.trim();
    if (!name) { document.getElementById('profileErr').textContent = 'Full name is required.'; return; }
    const aliases   = document.getElementById('pfAliases').value.split(',').map(s=>s.trim()).filter(Boolean);
    const addresses = getRows('addressList', null);
    const phones    = getRows('phoneList', 'number');
    const emails    = getRows('emailList', 'address');
    const payload   = {
      full_name: name,
      dob:       document.getElementById('pfDob').value || null,
      aliases, addresses, phones, emails,
    };
    const btn    = document.getElementById('saveProfile');
    btn.disabled = true;
    const res    = await apiFetch('/api/profiles', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    btn.disabled = false;
    if (!res) return;
    const data   = await res.json();
    if (!res.ok) { document.getElementById('profileErr').textContent = data.error || 'Save failed'; return; }
    closeModal();
    loadProfiles();
  }
}
