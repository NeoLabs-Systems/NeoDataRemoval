// settings.js — tabbed settings panels
"use strict";
import { apiFetch, escHtml, state } from "./app.js";

/* ── Helpers ─────────────────────────────────────────────── */

function flash(el, msg, isErr = false) {
  el.textContent = msg;
  el.style.color = isErr ? "var(--danger)" : "var(--success)";
  el.style.display = "inline";
  setTimeout(() => {
    if (el) el.textContent = "";
  }, 3000);
}

function setBtnState(btn, loading, label) {
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : label;
}

function sourceTag(source) {
  if (!source || source === "default")
    return '<span class="chip chip-standard" style="font-size:10px;padding:1px 6px;">default</span>';
  if (source === "env")
    return '<span class="chip chip-high" style="font-size:10px;padding:1px 6px;">env</span>';
  if (source === "db")
    return '<span class="chip chip-confirmed" style="font-size:10px;padding:1px 6px;">saved</span>';
  return "";
}

/* ── Main export ─────────────────────────────────────────── */

export async function renderSettings(contentEl, user) {
  const isAdmin = user && user.role === "admin";

  contentEl.innerHTML = `
    <!-- ── Scanning ─────────────────────────────────────── -->
    <div class="settings-panel active" data-panel="scanning">
      <h3>Scanning</h3>
      <div class="field">
        <label>Delay between broker requests (ms)</label>
        <input id="settingScanDelay" type="number" min="500" max="60000" step="100">
        <p class="helper" style="margin-top:4px">500 – 60 000 ms. Lower is faster but more likely to be blocked.</p>
      </div>
      <div class="toggle-row" style="margin-bottom:16px">
        <span>Enable automatic re-scanning</span>
        <input id="settingAutoRescan" type="checkbox" class="toggle">
      </div>
      <div class="toggle-row" style="margin-bottom:16px">
        <span>Notify on new exposure</span>
        <input id="settingNotifyExposure" type="checkbox" class="toggle">
      </div>
      <button class="btn-primary btn-sm" id="saveScan">Save Scanning Settings</button>
      <span id="scanMsg" style="margin-left:10px;font-size:13px"></span>
    </div>

    <!-- ── AI ─────────────────────────────────────────── -->
    <div class="settings-panel" data-panel="ai">
      <h3>AI Assistance</h3>
      <p class="helper">When enabled, NeoDataRemoval uses OpenAI to draft personalised GDPR/CCPA opt-out emails on your behalf. Drafts are cached for 30 days.</p>
      <div class="toggle-row" style="margin-bottom:16px">
        <span>Allow AI to draft opt-out emails</span>
        <input id="settingAiOptIn" type="checkbox" class="toggle">
      </div>
      <button class="btn-primary btn-sm" id="saveAi">Save AI Settings</button>
      <span id="aiMsg" style="margin-left:10px;font-size:13px"></span>
    </div>

    <!-- ── Account ─────────────────────────────────────────── -->
    <div class="settings-panel" data-panel="account">
      <h3>Change Password</h3>
      <div class="field"><label>Current Password</label><input id="curPass" type="password" placeholder="your current password" autocomplete="current-password"></div>
      <div class="field"><label>New Password</label><input id="newPass" type="password" placeholder="min 10 characters" autocomplete="new-password"></div>
      <div class="field"><label>Confirm New Password</label><input id="confPass" type="password" placeholder="repeat new password" autocomplete="new-password"></div>
      <div class="error" id="passErr" style="margin-bottom:8px"></div>
      <button class="btn-primary btn-sm" id="btnChangePass">Change Password</button>
    </div>

    <!-- ── Security ─────────────────────────────────────────── -->
    <div class="settings-panel" data-panel="security">
      <h3>Two-Factor Authentication</h3>
      <p class="helper" id="twofa-status-text">Loading…</p>
      <div id="twofa-setup" class="hidden">
        <p class="helper">Scan the QR code with your authenticator app, then enter the 6-digit code below to activate 2FA.</p>
        <img id="twofa-qr" src="" alt="2FA QR code" style="border-radius:8px;margin-bottom:12px;max-width:180px;display:block">
        <p class="helper" style="font-family:monospace;word-break:break-all;margin-bottom:12px" id="twofa-secret"></p>
        <div class="field" style="margin-top:10px">
          <label>Verification Code</label>
          <input id="twofa-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6">
        </div>
        <div class="error" id="twofa-err"></div>
        <button class="btn-primary btn-sm" id="btnEnableTotp" style="margin-top:4px">Activate 2FA</button>
      </div>
      <div id="twofa-disable" class="hidden">
        <div class="field"><label>Current Password</label><input id="twofa-dis-pass" type="password" placeholder="your password" autocomplete="current-password"></div>
        <div class="field"><label>Authenticator Code</label><input id="twofa-dis-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6"></div>
        <div class="error" id="twofa-disable-err"></div>
        <button class="btn-danger btn-sm" id="btnDisableTotp" style="margin-top:4px">Disable 2FA</button>
      </div>
      <button class="btn-secondary btn-sm" id="btnSetupTotp" style="margin-top:12px">Set up 2FA</button>
    </div>

    <!-- ── System (admin only) ─────────────────────────────── -->
    ${
      isAdmin
        ? `
    <div class="settings-panel" data-panel="system">
      <div id="system-settings-body">
        <div class="spinner-wrap" style="padding:40px 0"><div class="spinner"></div></div>
      </div>
    </div>
    `
        : ""
    }
  `;

  /* ── Load & wire scanning prefs ───────────────────────── */
  const prefsRes = await apiFetch("/api/settings");
  if (prefsRes && prefsRes.ok) {
    const prefs = await prefsRes.json();
    document.getElementById("settingScanDelay").value =
      prefs.scan_delay_ms || 2000;
    document.getElementById("settingAutoRescan").checked =
      prefs.auto_rescan !== false;
    document.getElementById("settingNotifyExposure").checked =
      prefs.notify_on_exposure || false;
    document.getElementById("settingAiOptIn").checked =
      prefs.ai_draft_opt_in || false;
  }

  document.getElementById("saveScan").addEventListener("click", async () => {
    const msg = document.getElementById("scanMsg");
    const r = await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scan_delay_ms: parseInt(
          document.getElementById("settingScanDelay").value,
          10,
        ),
        auto_rescan: document.getElementById("settingAutoRescan").checked,
        notify_on_exposure: document.getElementById("settingNotifyExposure")
          .checked,
      }),
    });
    flash(msg, !r || !r.ok ? "Failed to save." : "Saved!", !r || !r.ok);
  });

  document.getElementById("saveAi").addEventListener("click", async () => {
    const msg = document.getElementById("aiMsg");
    const r = await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ai_draft_opt_in: document.getElementById("settingAiOptIn").checked,
      }),
    });
    flash(msg, !r || !r.ok ? "Failed to save." : "Saved!", !r || !r.ok);
  });

  /* ── Password change ──────────────────────────────────── */
  document
    .getElementById("btnChangePass")
    .addEventListener("click", async () => {
      const errEl = document.getElementById("passErr");
      const cp = document.getElementById("curPass").value;
      const np = document.getElementById("newPass").value;
      const rp = document.getElementById("confPass").value;
      errEl.textContent = "";
      errEl.classList.remove("show");
      if (!cp) {
        errEl.textContent = "Current password is required.";
        errEl.classList.add("show");
        return;
      }
      if (np.length < 10) {
        errEl.textContent = "New password must be at least 10 characters.";
        errEl.classList.add("show");
        return;
      }
      if (np !== rp) {
        errEl.textContent = "Passwords do not match.";
        errEl.classList.add("show");
        return;
      }

      const btn = document.getElementById("btnChangePass");
      setBtnState(btn, true, "Change Password");
      const r = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: cp, password: np }),
      });
      const d = r ? await r.json() : {};
      if (!r || !r.ok) {
        errEl.textContent = d.error || "Failed to update password.";
        errEl.classList.add("show");
        setBtnState(btn, false, "Change Password");
        return;
      }
      errEl.style.color = "var(--success)";
      errEl.textContent = "Password updated! Redirecting to login…";
      errEl.classList.add("show");
      setTimeout(() => {
        window.location.href = "/login.html";
      }, 1500);
    });

  /* ── 2FA ──────────────────────────────────────────────── */
  await _wire2fa();

  /* ── System settings (admin) ──────────────────────────── */
  if (isAdmin) {
    await _renderSystemPanel();
  }
}

/* ── 2FA wiring (self-contained) ─────────────────────────── */

async function _wire2fa() {
  async function load2faStatus() {
    const r = await apiFetch("/api/auth/2fa/status");
    if (!r || !r.ok) return;
    const d = await r.json();
    const statusText = document.getElementById("twofa-status-text");
    const setupDiv = document.getElementById("twofa-setup");
    const disableDiv = document.getElementById("twofa-disable");
    const setupBtn = document.getElementById("btnSetupTotp");
    if (d.enabled) {
      statusText.textContent =
        "✅ Two-factor authentication is active on this account.";
      disableDiv.classList.remove("hidden");
      setupBtn.classList.add("hidden");
    } else {
      statusText.textContent = "2FA is not enabled.";
      disableDiv.classList.add("hidden");
      setupDiv.classList.add("hidden");
      setupBtn.classList.remove("hidden");
    }
  }

  await load2faStatus();

  document
    .getElementById("btnSetupTotp")
    .addEventListener("click", async () => {
      const r = await apiFetch("/api/auth/2fa/generate");
      if (!r || !r.ok) return;
      const d = await r.json();
      document.getElementById("twofa-qr").src = d.qrcode;
      document.getElementById("twofa-secret").textContent =
        "Manual entry key: " + d.secret;
      document.getElementById("twofa-setup").classList.remove("hidden");
      document.getElementById("btnSetupTotp").classList.add("hidden");
    });

  document
    .getElementById("btnEnableTotp")
    .addEventListener("click", async () => {
      const errEl = document.getElementById("twofa-err");
      const code = document.getElementById("twofa-code").value.trim();
      errEl.textContent = "";
      const r = await apiFetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: code }),
      });
      const d = r ? await r.json() : {};
      if (!r || !r.ok) {
        errEl.textContent = d.error || "Invalid code.";
        return;
      }
      await load2faStatus();
      document.getElementById("twofa-setup").classList.add("hidden");
    });

  document
    .getElementById("btnDisableTotp")
    .addEventListener("click", async () => {
      const errEl = document.getElementById("twofa-disable-err");
      const pass = document.getElementById("twofa-dis-pass").value;
      const code = document.getElementById("twofa-dis-code").value.trim();
      errEl.textContent = "";
      const r = await apiFetch("/api/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass, token: code }),
      });
      const d = r ? await r.json() : {};
      if (!r || !r.ok) {
        errEl.textContent = d.error || "Failed to disable 2FA.";
        return;
      }
      await load2faStatus();
      document.getElementById("twofa-dis-pass").value = "";
      document.getElementById("twofa-dis-code").value = "";
    });
}

/* ── System Settings Panel ───────────────────────────────── */

async function _renderSystemPanel() {
  const bodyEl = document.getElementById("system-settings-body");
  if (!bodyEl) return;

  const r = await apiFetch("/api/settings/system");
  if (!r || !r.ok) {
    bodyEl.innerHTML =
      '<p class="helper" style="color:var(--danger)">Failed to load system settings.</p>';
    return;
  }
  const cfg = await r.json();

  /* Helper: render a config field row */
  function field(
    key,
    label,
    {
      type = "text",
      placeholder = "",
      hint = "",
      options = null, // for <select>
    } = {},
  ) {
    const c = cfg[key] || {};
    const val = c.is_sensitive ? "" : c.value || "";
    const ph =
      c.is_sensitive && c.value
        ? "••••••••  (leave blank to keep)"
        : placeholder;
    const srcTag = sourceTag(c.source);

    if (options) {
      const opts = options
        .map(
          (o) =>
            `<option value="${escHtml(o.value)}" ${val === o.value ? "selected" : ""}>${escHtml(o.label)}</option>`,
        )
        .join("");
      return `
        <div class="field sys-field" data-key="${escHtml(key)}">
          <label>${escHtml(label)} ${srcTag}</label>
          <select id="sys_${key}">${opts}</select>
          ${hint ? `<p class="helper" style="margin-top:4px">${hint}</p>` : ""}
        </div>`;
    }

    if (type === "toggle") {
      const checked = c.value === "true" ? "checked" : "";
      return `
        <div class="toggle-row sys-field" data-key="${escHtml(key)}" style="margin-bottom:12px">
          <span>${escHtml(label)} ${srcTag}</span>
          <input id="sys_${key}" type="checkbox" class="toggle" ${checked}>
        </div>
        ${hint ? `<p class="helper" style="margin-top:-6px;margin-bottom:12px">${hint}</p>` : ""}`;
    }

    if (c.is_sensitive) {
      return `
        <div class="field sys-field" data-key="${escHtml(key)}">
          <label>${escHtml(label)} ${srcTag}</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="sys_${key}" type="password" autocomplete="new-password"
              placeholder="${escHtml(ph)}" style="flex:1">
            <button type="button" class="btn-secondary btn-sm" style="flex-shrink:0;padding:6px 10px"
              onclick="(function(btn){
                const inp = document.getElementById('sys_${key}');
                if(inp.type==='password'){inp.type='text';btn.textContent='🙈';}
                else{inp.type='password';btn.textContent='👁';}
              })(this)">👁</button>
          </div>
          ${hint ? `<p class="helper" style="margin-top:4px">${hint}</p>` : ""}
        </div>`;
    }

    return `
      <div class="field sys-field" data-key="${escHtml(key)}">
        <label>${escHtml(label)} ${srcTag}</label>
        <input id="sys_${key}" type="${type}" value="${escHtml(val)}" placeholder="${escHtml(ph)}">
        ${hint ? `<p class="helper" style="margin-top:4px">${hint}</p>` : ""}
      </div>`;
  }

  bodyEl.innerHTML = `
    <h3>System Configuration</h3>
    <p class="helper" style="margin-bottom:20px">
      These settings override environment variables and are stored encrypted in the database.
      Leave a field blank to revert to the environment variable or default value.
    </p>

    <!-- ── Server Status ─────────────────────────────────── -->
    <div class="sys-section" id="server-status-section">
      <div class="sys-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Server Status
      </div>
      <div id="server-status-body" style="color:var(--text-3);font-size:13px">Loading…</div>
    </div>

    <!-- ── Email / SMTP ─────────────────────────────────── -->
    <div class="sys-section">
      <div class="sys-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,12 2,6"/></svg>
        Email (SMTP)
      </div>
      <p class="helper" style="margin-bottom:14px">Used to send opt-out emails to data brokers and deliver your monthly privacy report.</p>

      ${field("smtp_host", "SMTP Host", { placeholder: "smtp.example.com" })}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${field("smtp_port", "Port", { type: "number", placeholder: "587" })}
        ${field("smtp_secure", "Use TLS", { type: "toggle", hint: "Enable for port 465 (SMTPS). Leave off for STARTTLS (port 587)." })}
      </div>

      ${field("smtp_user", "Username / Login", { placeholder: "you@example.com" })}
      ${field("smtp_pass", "Password / App Password", {})}
      ${field("smtp_from", "From Address", { placeholder: '"NeoDataRemoval" <you@example.com>', hint: "Defaults to the SMTP username if left blank." })}

      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn-primary btn-sm" id="saveSmtp">Save SMTP</button>
        <button class="btn-secondary btn-sm" id="testSmtp">Test Connection</button>
        <button class="btn-secondary btn-sm" id="testSmtpEmail">Send Test Email</button>
        <span id="smtpMsg" style="font-size:13px;align-self:center"></span>
      </div>
    </div>

    <!-- ── OpenAI ─────────────────────────────────────────── -->
    <div class="sys-section">
      <div class="sys-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
        AI (OpenAI)
      </div>
      <p class="helper" style="margin-bottom:14px">Enables AI-drafted opt-out emails. Requires a valid OpenAI API key.</p>

      ${field("openai_api_key", "OpenAI API Key", { hint: "Your key is encrypted before being stored in the database." })}
      ${field("openai_model", "Model", {
        options: [
          {
            value: "gpt-4.1-mini",
            label: "gpt-4.1-mini (recommended — fast & cost-effective)",
          },
          {
            value: "gpt-4.1",
            label: "gpt-4.1 (smarter, great for complex prompts)",
          },
          {
            value: "gpt-4.1-nano",
            label: "gpt-4.1-nano (fastest & cheapest)",
          },
          {
            value: "gpt-5-mini",
            label: "gpt-5-mini (near-frontier quality, low cost)",
          },
          {
            value: "gpt-5.4",
            label: "gpt-5.4 (flagship — highest quality, uses Responses API)",
          },
          {
            value: "gpt-4o-mini",
            label: "gpt-4o-mini (legacy)",
          },
          { value: "gpt-4o", label: "gpt-4o (legacy)" },
          { value: "gpt-3.5-turbo", label: "gpt-3.5-turbo (legacy)" },
        ],
      })}

      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn-primary btn-sm" id="saveAiSystem">Save AI Settings</button>
        <button class="btn-secondary btn-sm" id="testAi">Test Connection</button>
        <span id="aiSystemMsg" style="font-size:13px;align-self:center"></span>
      </div>
    </div>

    <!-- ── Automation ──────────────────────────────────────── -->
    <div class="sys-section">
      <div class="sys-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        Automation
      </div>
      <p class="helper" style="margin-bottom:14px">Control how NeoDataRemoval behaves autonomously in the background.</p>

      ${field("auto_removal_enabled", "Auto-send removal requests after scan", {
        type: "toggle",
        hint: "When enabled, opt-out requests are automatically dispatched for all newly discovered exposures that support email or form-based removal. Manual-only brokers are skipped.",
      })}

      ${field("verify_removals_enabled", "Automatically verify sent removals", {
        type: "toggle",
        hint: "After the verification window, the scheduler re-scans profiles with pending removals to check if they were successful and mark them confirmed.",
      })}

      ${field("removal_verify_days", "Verification window (days)", {
        type: "number",
        placeholder: "14",
        hint: "How many days after sending a removal request before re-checking whether it was actioned. Typical brokers take 7–30 days.",
      })}

      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn-primary btn-sm" id="saveAutomation">Save Automation</button>
        <span id="automationMsg" style="font-size:13px;align-self:center"></span>
      </div>
    </div>

    <!-- ── Application ────────────────────────────────────── -->
    <div class="sys-section">
      <div class="sys-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
        Application
      </div>

      ${field("app_url", "App URL", {
        placeholder: "https://your-domain.com",
        hint: "Used in monthly report emails as the link back to your dashboard.",
      })}

      ${field("scan_delay_ms", "Global scan delay (ms)", {
        type: "number",
        placeholder: "2000",
        hint: "Milliseconds to wait between each broker request. Overrides per-user scan delay settings. Minimum 500 ms.",
      })}

      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-primary btn-sm" id="saveApp">Save App Settings</button>
        <span id="appMsg" style="font-size:13px;align-self:center"></span>
      </div>
    </div>
  `;

  /* ── Server status ────────────────────────────────────── */

  async function loadServerStatus() {
    const bodyEl = document.getElementById("server-status-body");
    if (!bodyEl) return;
    const r = await apiFetch("/api/settings/system/status");
    if (!r || !r.ok) {
      bodyEl.innerHTML =
        '<span style="color:var(--danger)">Failed to load server status.</span>';
      return;
    }
    const s = await r.json();

    function badge(ok, trueLabel, falseLabel) {
      return ok
        ? `<span class="chip chip-confirmed">${trueLabel}</span>`
        : `<span class="chip chip-assumed">${falseLabel}</span>`;
    }

    function srcBadge(src) {
      if (src === "file")
        return '<span class="chip chip-confirmed">auto-generated</span>';
      if (src === "env") return '<span class="chip chip-high">env var</span>';
      return '<span class="chip chip-assumed">missing</span>';
    }

    bodyEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);margin-bottom:6px">Secrets File</div>
          <div style="margin-bottom:4px">${badge(s.secrets_file_exists, "✓ db_data/app-secrets.json", "✗ Not found")}</div>
          ${
            s.secrets_file_exists
              ? '<div style="font-size:12px;color:var(--text-3);margin-top:4px">Back this file up alongside your database.</div>'
              : '<div style="font-size:12px;color:var(--danger);margin-top:4px">Set ENCRYPTION_KEY + JWT_SECRET as env vars, or restart the server to generate the file.</div>'
          }
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);margin-bottom:6px">ENCRYPTION_KEY</div>
          ${srcBadge(s.encryption_key_source)}
          <div style="font-size:12px;color:var(--text-3);margin-top:4px">Protects all profile data at rest.</div>
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);margin-bottom:6px">JWT_SECRET</div>
          ${srcBadge(s.jwt_secret_source)}
          <div style="font-size:12px;color:var(--text-3);margin-top:4px">Signs authentication tokens.</div>
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);margin-bottom:6px">Email (SMTP)</div>
          ${badge(s.smtp_configured, "✓ Configured", "✗ Not configured")}
          <div style="font-size:12px;color:var(--text-3);margin-top:4px">Required for opt-out emails &amp; reports.</div>
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);margin-bottom:6px">AI (OpenAI)</div>
          ${badge(s.openai_configured, "✓ Configured", "— Optional")}
          <div style="font-size:12px;color:var(--text-3);margin-top:4px">Used to draft opt-out emails.</div>
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);margin-bottom:6px">Server</div>
          <div style="font-size:13px;color:var(--text-2)">Port <strong>${escHtml(String(s.port))}</strong></div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">
            ${escHtml(s.node_env)}${s.trust_proxy ? " · reverse proxy" : ""}
          </div>
        </div>

      </div>
      ${
        s.secrets_file_exists
          ? `<p class="helper" style="margin-top:12px;color:var(--success)">
             ✅ No <code>.env</code> file required — all secrets are auto-managed.
             Configure SMTP and OpenAI below, then you&rsquo;re fully set up.
           </p>`
          : `<p class="helper" style="margin-top:12px;color:var(--warning)">
             ⚠️ Secrets file not found. The server will create it on next restart,
             or you can set <code>ENCRYPTION_KEY</code> and <code>JWT_SECRET</code> as environment variables.
           </p>`
      }
    `;
  }

  loadServerStatus();

  /* ── SMTP save & test ─────────────────────────────────── */

  async function saveGroup(keys, msgId) {
    const msgEl = document.getElementById(msgId);
    const updates = {};
    for (const key of keys) {
      const el = document.getElementById(`sys_${key}`);
      if (!el) continue;
      const val = el.type === "checkbox" ? String(el.checked) : el.value;
      updates[key] = val;
    }
    const r = await apiFetch("/api/settings/system", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!r || !r.ok) {
      const d = r ? await r.json().catch(() => ({})) : {};
      flash(msgEl, d.error || "Failed to save.", true);
      return false;
    }
    flash(msgEl, "Saved!");
    // Refresh config display (source tags may change)
    _refreshSourceTags(await r.json().catch(() => ({})));
    return true;
  }

  document
    .getElementById("saveSmtp")
    .addEventListener("click", () =>
      saveGroup(
        [
          "smtp_host",
          "smtp_port",
          "smtp_secure",
          "smtp_user",
          "smtp_pass",
          "smtp_from",
        ],
        "smtpMsg",
      ),
    );

  document.getElementById("testSmtp").addEventListener("click", async () => {
    const msgEl = document.getElementById("smtpMsg");
    const btn = document.getElementById("testSmtp");
    setBtnState(btn, true, "Test Connection");
    // Save first so test uses current form values
    await saveGroup(
      [
        "smtp_host",
        "smtp_port",
        "smtp_secure",
        "smtp_user",
        "smtp_pass",
        "smtp_from",
      ],
      "smtpMsg",
    );
    const r = await apiFetch("/api/settings/system/test-smtp", {
      method: "POST",
    });
    const d = r ? await r.json().catch(() => ({})) : {};
    flash(
      msgEl,
      r && r.ok ? `✅ ${d.message}` : `❌ ${d.error || "Test failed"}`,
      !(r && r.ok),
    );
    setBtnState(btn, false, "Test Connection");
  });

  document
    .getElementById("testSmtpEmail")
    .addEventListener("click", async () => {
      const msgEl = document.getElementById("smtpMsg");
      const btn = document.getElementById("testSmtpEmail");
      setBtnState(btn, true, "Send Test Email");
      await saveGroup(
        [
          "smtp_host",
          "smtp_port",
          "smtp_secure",
          "smtp_user",
          "smtp_pass",
          "smtp_from",
        ],
        "smtpMsg",
      );
      const r = await apiFetch("/api/settings/system/test-removal-email", {
        method: "POST",
      });
      const d = r ? await r.json().catch(() => ({})) : {};
      flash(
        msgEl,
        r && r.ok ? `✅ ${d.message}` : `❌ ${d.error || "Send failed"}`,
        !(r && r.ok),
      );
      setBtnState(btn, false, "Send Test Email");
    });

  /* ── AI save & test ───────────────────────────────────── */

  document
    .getElementById("saveAiSystem")
    .addEventListener("click", () =>
      saveGroup(["openai_api_key", "openai_model"], "aiSystemMsg"),
    );

  document.getElementById("testAi").addEventListener("click", async () => {
    const msgEl = document.getElementById("aiSystemMsg");
    const btn = document.getElementById("testAi");
    setBtnState(btn, true, "Test Connection");
    await saveGroup(["openai_api_key", "openai_model"], "aiSystemMsg");
    const r = await apiFetch("/api/settings/system/test-ai", {
      method: "POST",
    });
    const d = r ? await r.json().catch(() => ({})) : {};
    flash(
      msgEl,
      r && r.ok ? `✅ ${d.message}` : `❌ ${d.error || "Test failed"}`,
      !(r && r.ok),
    );
    setBtnState(btn, false, "Test Connection");
  });

  /* ── Automation save ──────────────────────────────────── */

  document
    .getElementById("saveAutomation")
    .addEventListener("click", () =>
      saveGroup(
        [
          "auto_removal_enabled",
          "verify_removals_enabled",
          "removal_verify_days",
        ],
        "automationMsg",
      ),
    );

  /* ── App settings save ───────────────────────────────── */

  document
    .getElementById("saveApp")
    .addEventListener("click", () =>
      saveGroup(["app_url", "scan_delay_ms"], "appMsg"),
    );
}

/* ── Refresh source-tag badges after save ────────────────── */

function _refreshSourceTags(/* updated config ignored; just re-fetch */) {
  // Re-fetch and update source badges without full re-render
  apiFetch("/api/settings/system")
    .then(async (r) => {
      if (!r || !r.ok) return;
      const cfg = await r.json();
      document.querySelectorAll(".sys-field[data-key]").forEach((row) => {
        const key = row.dataset.key;
        const c = cfg[key];
        if (!c) return;
        const label = row.querySelector("label");
        if (!label) return;
        // Strip old source tag and re-inject
        const existingTag = label.querySelector(".chip");
        if (existingTag) existingTag.remove();
        const tmp = document.createElement("span");
        tmp.innerHTML = sourceTag(c.source);
        const tag = tmp.firstElementChild;
        if (tag) label.appendChild(tag);
      });
    })
    .catch(() => {});
}
