// exposures.js
'use strict';
import { apiFetch, escHtml, safeHref } from './app.js';

export async function renderExposures(container) {
  container.innerHTML = `
    <div class="section-header">
      <h3>Exposures</h3>
      <div class="section-filters">
        <select id="filterStatus" class="field" style="margin:0;padding:7px 10px;min-width:160px">
          <option value="">All Statuses</option>
          <option value="detected">Detected</option>
          <option value="assumed">Assumed</option>
          <option value="removal_sent">Removal Sent</option>
          <option value="ai_email_sent">AI Email Sent</option>
          <option value="removal_confirmed">Confirmed Removed</option>
          <option value="manual_pending">Manual Pending</option>
          <option value="re_exposed">Re-exposed</option>
        </select>
        <label style="display:flex;align-items:center;gap:7px;font-size:.82rem;color:var(--text-2);cursor:pointer;user-select:none;">
          <input type="checkbox" id="toggleAssumed" checked style="accent-color:var(--accent);width:14px;height:14px;cursor:pointer;">
          Show assumed
        </label>
        <select id="filterPriority" class="field" style="margin:0;padding:7px 10px;min-width:130px">
          <option value="">All Priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="standard">Standard</option>
        </select>
      </div>
    </div>
    <div id="expList"><div class="spinner-wrap"><div class="spinner"></div></div></div>
  `;

  container.insertAdjacentHTML('beforeend', `
    <div id="removalPreviewModal" class="modal-backdrop hidden">
      <div class="modal">
        <div class="modal-header">
          <h3 id="previewModalTitle">Review Removal Email</h3>
          <span class="modal-badge hidden" id="previewAiBadge">AI Drafted</span>
          <button class="icon-btn" id="previewClose" style="margin-left:auto">&#x2715;</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>To</label>
            <input id="previewTo" readonly tabindex="-1" style="opacity:.5;cursor:default;">
          </div>
          <div class="field">
            <label>Subject</label>
            <input id="previewSubject">
          </div>
          <div class="field" style="flex:1">
            <label>Message</label>
            <textarea id="previewBody" class="email-body-field"></textarea>
          </div>
          <div class="error" id="previewErr"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="previewCancel">Cancel</button>
          <button class="btn-primary" id="previewSend">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:5px"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send Email
          </button>
        </div>
      </div>
    </div>
  `);

  document.getElementById('filterStatus').addEventListener('change', loadExposures);
  document.getElementById('filterPriority').addEventListener('change', loadExposures);
  document.getElementById('toggleAssumed').addEventListener('change', loadExposures);

  await loadExposures();

  async function loadExposures() {
    const status       = document.getElementById('filterStatus').value;
    const priority     = document.getElementById('filterPriority').value;
    const showAssumed  = document.getElementById('toggleAssumed').checked;
    let url = '/api/exposures?limit=100';
    if (status)        url += `&status=${status}`;
    if (priority)      url += `&priority=${priority}`;
    if (!showAssumed)  url += '&hide_assumed=1';

    document.getElementById('expList').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
    const res = await apiFetch(url);
    if (!res) return;
    const rows = await res.json();
    renderList(rows);
  }

  function renderList(rows) {
    const wrap = document.getElementById('expList');
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
        <h4>No exposures found</h4><p>Run a scan or adjust filters.</p></div>`;
      return;
    }

    wrap.innerHTML = `<div class="table-wrap">
      <table>
        <thead><tr><th>Broker</th><th>Priority</th><th>Status</th><th>How Detected</th><th>Verify</th><th>Detected</th><th>Actions</th></tr></thead>
        <tbody>${rows.map(e => {
          const detectionLabel = e.automation === 'assumes_present'
            ? '<span title="Broker doesn\'t allow public search — your data is typically listed automatically for most people" style="color:var(--muted);font-size:.78rem;cursor:help;">⚠ Assumed present</span>'
            : e.automation === 'browser_required'
              ? '<span title="Broker requires JavaScript rendering — result may be less accurate, verify manually" style="color:var(--warning,#f59e0b);font-size:.78rem;cursor:help;">~ Needs manual check</span>'
              : '<span title="Detected via live name/location match on broker\'s search results" style="color:var(--success);font-size:.78rem;">✓ Live detection</span>';

          const verifyLinks = [];
          if (e.profile_url) {
            verifyLinks.push(`<a href="${safeHref(e.profile_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);white-space:nowrap;">View listing ↗</a>`);
          }
          verifyLinks.push(`<a href="${safeHref(e.broker_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--muted);font-size:.8rem;white-space:nowrap;">Search on site ↗</a>`);
          const verifyCell = verifyLinks.join('<br>');

          return `
          <tr data-id="${escHtml(e.id)}">
            <td><strong>${escHtml(e.broker_name)}</strong></td>
            <td>${chipPriority(e.priority)}</td>
            <td>${chipStatus(e.status)}</td>
            <td>${detectionLabel}</td>
            <td>${verifyCell}</td>
            <td style="white-space:nowrap">${fmtDate(e.detected_at)}</td>
            <td>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn-secondary btn-sm btn-send-removal" data-id="${escHtml(e.id)}" ${['removal_sent','ai_email_sent','removal_confirmed'].includes(e.status) ? 'disabled' : ''}>
                  Send Removal
                </button>
                <button class="btn-secondary btn-sm btn-ai-remove" data-id="${escHtml(e.id)}" title="Use AI to draft opt-out email">AI</button>
                <button class="btn-danger btn-sm btn-del-exp" data-id="${escHtml(e.id)}">✕</button>
              </div>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;

    // Action handlers
    wrap.querySelectorAll('.btn-send-removal').forEach(btn => {
      btn.addEventListener('click', () => openPreview(btn.dataset.id, btn, false));
    });
    wrap.querySelectorAll('.btn-ai-remove').forEach(btn => {
      btn.addEventListener('click', () => openPreview(btn.dataset.id, btn, true));
    });
    wrap.querySelectorAll('.btn-del-exp').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this exposure record?')) return;
        const r = await apiFetch(`/api/exposures/${btn.dataset.id}`, { method: 'DELETE' });
        if (r && r.ok) btn.closest('tr').remove();
      });
    });
  }

  async function sendRemoval(id, useAi, btn) {
    btn.disabled = true; btn.textContent = '…';
    const res = await apiFetch(`/api/removals/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_ai: useAi }),
    });
    if (!res) { btn.disabled = false; return; }
    const data = await res.json();
    if (!res.ok) {
      btn.disabled = false; btn.textContent = useAi ? 'AI' : 'Send Removal';
      alert(data.error || 'Failed to send removal');
      return;
    }
    btn.textContent = '✓ Sent';
    const statusCell = btn.closest('tr').querySelector('td:nth-child(3)');
    if (statusCell) statusCell.innerHTML = chipStatus('removal_sent');
  }

  async function openPreview(id, btn, useAi) {
    const modal   = document.getElementById('removalPreviewModal');
    const sendBtn = document.getElementById('previewSend');
    const errEl   = document.getElementById('previewErr');
    const aiBadge = document.getElementById('previewAiBadge');
    btn.disabled = true; btn.textContent = '\u2026';

    const res = await apiFetch(`/api/removals/${id}/draft?ai=${useAi ? '1' : '0'}`);
    btn.disabled = false; btn.textContent = useAi ? 'AI' : 'Send Removal';
    if (!res || !res.ok) { alert('Could not generate preview.'); return; }
    const draft = await res.json();

    document.getElementById('previewTo').value      = draft.to || '(no contact email on file)';
    document.getElementById('previewSubject').value = draft.subject || '';
    document.getElementById('previewBody').value    = draft.body || '';
    errEl.textContent = '';
    aiBadge.classList.toggle('hidden', !useAi);
    modal.classList.remove('hidden');

    const close = () => modal.classList.add('hidden');
    document.getElementById('previewClose').onclick  = close;
    document.getElementById('previewCancel').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); }, { once: false });

    sendBtn.onclick = async () => {
      sendBtn.disabled = true; sendBtn.innerHTML = 'Sending\u2026';
      errEl.textContent = '';
      const r = await apiFetch(`/api/removals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          use_ai: useAi,
          draft_body: document.getElementById('previewBody').value,
        }),
      });
      sendBtn.disabled = false;
      sendBtn.innerHTML = '\u2713 Send Email';
      if (!r) return;
      const data = await r.json();
      if (!r.ok) { errEl.textContent = data.error || 'Failed to send.'; return; }
      close();
      btn.textContent = '\u2713 Sent'; btn.disabled = true;
      const statusCell = btn.closest('tr').querySelector('td:nth-child(3)');
      if (statusCell) statusCell.innerHTML = chipStatus('removal_sent');
    };
  }
}

function chipStatus(s) {
  const map = { detected:'detected', assumed:'assumed', removal_sent:'sent', ai_email_sent:'sent', removal_confirmed:'confirmed', manual_pending:'manual', re_exposed:'reexposed' };
  const cls = escHtml(map[s] || 'manual');
  return `<span class="chip chip-${cls}">${escHtml((s||'').replace(/_/g,' '))}</span>`;
}
function chipPriority(p) {
  return `<span class="chip chip-${p}">${p}</span>`;
}
function fmtDate(d) {
  if (!d) return '—';
  const ms = typeof d === 'number' ? d * 1000 : Date.parse(d);
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}
