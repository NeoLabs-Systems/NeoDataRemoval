// settings.js — renders tabbed settings panels into the settings modal content area
'use strict';
import { apiFetch } from './app.js';

export async function renderSettings(contentEl) {
  contentEl.innerHTML = `
    <div class="settings-panel active" data-panel="scanning">
      <h3>Scanning</h3>
      <div class="field">
        <label>Scan Delay (ms between requests)</label>
        <input id="settingScanDelay" type="number" min="500" max="10000" step="100">
      </div>
      <div class="toggle-row" style="margin-bottom:16px">
        <span>Enable automatic re-scanning</span>
        <input id="settingAutoRescan" type="checkbox" class="toggle">
      </div>
      <button class="btn-primary btn-sm" id="saveScan">Save</button>
      <span class="error" id="scanMsg" style="display:inline;margin-left:10px;background:none;border:none;padding:0;color:var(--success)"></span>
    </div>

    <div class="settings-panel" data-panel="ai">
      <h3>AI Assistance</h3>
      <p class="helper">When enabled, NeoDataRemoval can use OpenAI to draft personalised opt-out emails on your behalf.</p>
      <div class="toggle-row" style="margin-bottom:16px">
        <span>Allow AI to draft opt-out emails</span>
        <input id="settingAiOptIn" type="checkbox" class="toggle">
      </div>
      <button class="btn-primary btn-sm" id="saveAi">Save</button>
      <span class="error" id="aiMsg" style="display:inline;margin-left:10px;background:none;border:none;padding:0;color:var(--success)"></span>
    </div>

    <div class="settings-panel" data-panel="account">
      <h3>Change Password</h3>
      <div class="field"><label>Current Password</label><input id="curPass" type="password" placeholder="your current password" autocomplete="current-password"></div>
      <div class="field"><label>New Password</label><input id="newPass" type="password" placeholder="min 10 characters" autocomplete="new-password"></div>
      <div class="field"><label>Confirm New Password</label><input id="confPass" type="password" placeholder="repeat new password" autocomplete="new-password"></div>
      <div class="error" id="passErr" style="margin-bottom:8px"></div>
      <button class="btn-primary btn-sm" id="btnChangePass">Change Password</button>
    </div>

    <div class="settings-panel" data-panel="security">
      <h3>Two-Factor Authentication</h3>
      <p class="helper" id="twofa-status-text">Loading…</p>
      <div id="twofa-setup" class="hidden">
        <p class="helper">Scan this QR code with your authenticator app, then enter the 6-digit code to activate 2FA.</p>
        <img id="twofa-qr" src="" alt="QR code" style="border-radius:8px;margin-bottom:12px;max-width:180px;">
        <p class="helper" style="font-family:monospace;word-break:break-all" id="twofa-secret"></p>
        <div class="field" style="margin-top:10px">
          <label>Verification Code</label>
          <input id="twofa-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6">
        </div>
        <div class="error" id="twofa-err"></div>
        <button class="btn-primary btn-sm" id="btnEnableTotp" style="margin-top:4px">Activate 2FA</button>
      </div>
      <div id="twofa-disable" class="hidden">
        <div class="field">
          <label>Current Password</label>
          <input id="twofa-dis-pass" type="password" placeholder="your password" autocomplete="current-password">
        </div>
        <div class="field">
          <label>Authenticator Code</label>
          <input id="twofa-dis-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6">
        </div>
        <div class="error" id="twofa-disable-err"></div>
        <button class="btn-danger btn-sm" id="btnDisableTotp" style="margin-top:4px">Disable 2FA</button>
      </div>
      <button class="btn-secondary btn-sm" id="btnSetupTotp" style="margin-top:12px">Set up 2FA</button>
    </div>
  `;

  const res = await apiFetch('/api/settings');
  if (!res) return;
  const prefs = await res.json();

  document.getElementById('settingScanDelay').value    = prefs.scan_delay_ms   || 2000;
  document.getElementById('settingAutoRescan').checked = prefs.auto_rescan     !== false;
  document.getElementById('settingAiOptIn').checked    = prefs.ai_draft_opt_in || false;

  function flash(el, msg, isErr) {
    el.textContent = msg;
    el.style.color = isErr ? 'var(--danger)' : 'var(--success)';
    el.style.display = 'inline';
    setTimeout(() => { el.textContent = ''; }, 2500);
  }

  document.getElementById('saveScan').addEventListener('click', async () => {
    const msg = document.getElementById('scanMsg');
    const r = await apiFetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scan_delay_ms: parseInt(document.getElementById('settingScanDelay').value),
        auto_rescan:   document.getElementById('settingAutoRescan').checked,
      }),
    });
    flash(msg, (!r || !r.ok) ? 'Failed to save.' : 'Saved!', !r || !r.ok);
  });

  document.getElementById('saveAi').addEventListener('click', async () => {
    const msg = document.getElementById('aiMsg');
    const r = await apiFetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_draft_opt_in: document.getElementById('settingAiOptIn').checked }),
    });
    flash(msg, (!r || !r.ok) ? 'Failed to save.' : 'Saved!', !r || !r.ok);
  });

  document.getElementById('btnChangePass').addEventListener('click', async () => {
    const passErr = document.getElementById('passErr');
    const cp = document.getElementById('curPass').value;
    const np = document.getElementById('newPass').value;
    const rp = document.getElementById('confPass').value;
    passErr.textContent = ''; passErr.classList.remove('show');
    if (!cp)            { passErr.textContent = 'Current password is required.'; passErr.classList.add('show'); return; }
    if (np.length < 10) { passErr.textContent = 'New password must be at least 10 characters.'; passErr.classList.add('show'); return; }
    if (np !== rp)      { passErr.textContent = 'Passwords do not match.'; passErr.classList.add('show'); return; }
    const r = await apiFetch('/api/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: cp, password: np }),
    });
    const d = r ? await r.json() : {};
    if (!r || !r.ok) { passErr.textContent = d.error || 'Failed'; passErr.classList.add('show'); return; }
    // Server clears the session cookie — redirect to login
    passErr.style.color = 'var(--success)'; passErr.textContent = 'Password updated! Redirecting to login…'; passErr.classList.add('show');
    setTimeout(() => { window.location.href = '/login.html'; }, 1500);
  });

  // 2FA section
  await load2faStatus();

  async function load2faStatus() {
    const r = await apiFetch('/api/auth/2fa/status');
    if (!r || !r.ok) return;
    const d = await r.json();
    const statusText  = document.getElementById('twofa-status-text');
    const setupDiv    = document.getElementById('twofa-setup');
    const disableDiv  = document.getElementById('twofa-disable');
    const setupBtn    = document.getElementById('btnSetupTotp');
    if (d.enabled) {
      statusText.textContent = '2FA is active on this account.';
      disableDiv.classList.remove('hidden');
      setupBtn.classList.add('hidden');
    } else {
      statusText.textContent = '2FA is not enabled.';
      disableDiv.classList.add('hidden');
      setupDiv.classList.add('hidden');
      setupBtn.classList.remove('hidden');
    }
  }

  document.getElementById('btnSetupTotp').addEventListener('click', async () => {
    const r = await apiFetch('/api/auth/2fa/generate');
    if (!r || !r.ok) return;
    const d = await r.json();
    document.getElementById('twofa-qr').src         = d.qrcode;
    document.getElementById('twofa-secret').textContent = 'Manual key: ' + d.secret;
    document.getElementById('twofa-setup').classList.remove('hidden');
    document.getElementById('btnSetupTotp').classList.add('hidden');
  });

  document.getElementById('btnEnableTotp').addEventListener('click', async () => {
    const errEl = document.getElementById('twofa-err');
    const code  = document.getElementById('twofa-code').value.trim();
    errEl.textContent = '';
    const r = await apiFetch('/api/auth/2fa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: code }),
    });
    const d = r ? await r.json() : {};
    if (!r || !r.ok) { errEl.textContent = d.error || 'Invalid code.'; return; }
    await load2faStatus();
    document.getElementById('twofa-setup').classList.add('hidden');
  });

  document.getElementById('btnDisableTotp').addEventListener('click', async () => {
    const errEl = document.getElementById('twofa-disable-err');
    const pass  = document.getElementById('twofa-dis-pass').value;
    const code  = document.getElementById('twofa-dis-code').value.trim();
    errEl.textContent = '';
    const r = await apiFetch('/api/auth/2fa/disable', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass, token: code }),
    });
    const d = r ? await r.json() : {};
    if (!r || !r.ok) { errEl.textContent = d.error || 'Failed to disable 2FA.'; return; }
    await load2faStatus();
    document.getElementById('twofa-dis-pass').value = '';
    document.getElementById('twofa-dis-code').value = '';
  });
}

