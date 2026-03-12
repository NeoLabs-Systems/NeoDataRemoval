"use strict";

/* ── DOM refs ─────────────────────────────────────────────── */

const tabSwitcher = document.getElementById("tab-switcher");
const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const loginErr = document.getElementById("login-error");
const regErr = document.getElementById("reg-error");
const totpGroup = document.getElementById("totp-group");
const setupBanner = document.getElementById("setup-banner");

let pendingCredentials = null;

/* ── Helpers ──────────────────────────────────────────────── */

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.add("show");
}

function clearErr(el) {
  el.textContent = "";
  el.classList.remove("show");
}

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : label;
}

/* ── Tab switching ────────────────────────────────────────── */

function showLoginTab() {
  tabLogin.classList.add("active");
  tabRegister.classList.remove("active");
  loginForm.style.display = "";
  registerForm.style.display = "none";
  clearErr(loginErr);
  totpGroup.style.display = "none";
  pendingCredentials = null;
}

function showRegisterTab() {
  tabRegister.classList.add("active");
  tabLogin.classList.remove("active");
  registerForm.style.display = "";
  loginForm.style.display = "none";
  clearErr(regErr);
}

tabSwitcher.addEventListener("click", function (e) {
  var tab = e.target.closest(".login-tab");
  if (!tab) return;
  if (tab === tabLogin) showLoginTab();
  if (tab === tabRegister) showRegisterTab();
});

/* ── Registration gate ────────────────────────────────────── */

async function checkRegistration() {
  try {
    var r = await fetch("/api/auth/can-register");
    if (!r.ok) return;
    var d = await r.json();

    if (d.allowed) {
      // First-time setup — show banner and switch to register view
      if (setupBanner) setupBanner.classList.remove("hidden");
      tabRegister.style.display = "";
      showRegisterTab();
    } else {
      // Account already exists — keep register tab hidden
      tabRegister.style.display = "none";
      if (setupBanner) setupBanner.classList.add("hidden");
    }
  } catch (_) {
    // Network error — default to sign-in only
    tabRegister.style.display = "none";
  }
}

/* ── Login form ───────────────────────────────────────────── */

loginForm.addEventListener("submit", async function (e) {
  e.preventDefault();
  clearErr(loginErr);

  var btn = document.getElementById("login-btn");
  setLoading(btn, true, "Sign In");

  try {
    var body;

    if (pendingCredentials) {
      // 2FA step
      var totpCode = document.getElementById("login-totp").value.trim();
      if (!totpCode) {
        showErr(loginErr, "Enter your authenticator code.");
        setLoading(btn, false, "Verify");
        return;
      }
      body = {
        username: pendingCredentials.username,
        password: pendingCredentials.password,
        totp: totpCode,
      };
    } else {
      body = {
        username: document.getElementById("login-id").value.trim(),
        password: document.getElementById("login-pass").value,
      };
    }

    var res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = await res.json();

    if (res.status === 403 && data["2fa_required"]) {
      pendingCredentials = { username: body.username, password: body.password };
      totpGroup.style.display = "";
      document.getElementById("login-totp").focus();
      setLoading(btn, false, "Verify");
      return;
    }

    if (!res.ok) {
      showErr(loginErr, data.error || "Login failed — check your credentials.");
      setLoading(btn, false, pendingCredentials ? "Verify" : "Sign In");
      return;
    }

    window.location.href = "/";
  } catch (_) {
    showErr(loginErr, "Network error — please try again.");
    setLoading(btn, false, pendingCredentials ? "Verify" : "Sign In");
  }
});

/* ── Register form (first-time setup only) ────────────────── */

registerForm.addEventListener("submit", async function (e) {
  e.preventDefault();
  clearErr(regErr);

  var username = document.getElementById("reg-username").value.trim();
  var email = document.getElementById("reg-email").value.trim();
  var pass = document.getElementById("reg-pass").value;
  var pass2 = document.getElementById("reg-pass2").value;

  if (!username) {
    showErr(regErr, "Username is required.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showErr(regErr, "Enter a valid email address.");
    return;
  }
  if (pass.length < 10) {
    showErr(regErr, "Password must be at least 10 characters.");
    return;
  }
  if (pass !== pass2) {
    showErr(regErr, "Passwords do not match.");
    return;
  }

  var btn = document.getElementById("register-btn");
  setLoading(btn, true, "Create Account");

  try {
    var res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username,
        email: email,
        password: pass,
      }),
    });
    var data = await res.json();

    if (!res.ok) {
      showErr(regErr, data.error || "Registration failed.");
      setLoading(btn, false, "Create Account");
      return;
    }

    window.location.href = "/";
  } catch (_) {
    showErr(regErr, "Network error — please try again.");
    setLoading(btn, false, "Create Account");
  }
});

/* ── Boot ─────────────────────────────────────────────────── */

// Register tab is hidden by default in the HTML; checkRegistration
// will reveal it (and switch to it) only on a fresh install.
checkRegistration();
