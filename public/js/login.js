'use strict';

const tabSwitcher  = document.getElementById('tab-switcher');
const tabLogin     = document.getElementById('tab-login');
const tabRegister  = document.getElementById('tab-register');
const loginForm    = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginErr     = document.getElementById('login-error');
const regErr       = document.getElementById('reg-error');
const totpGroup    = document.getElementById('totp-group');

let pendingCredentials = null;

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}
function clearErr(el) {
  el.textContent = '';
  el.classList.remove('show');
}

async function checkRegAllowed() {
  try {
    const r = await fetch('/api/auth/can-register');
    if (r.ok) {
      const d = await r.json();
      if (!d.allowed) tabRegister.style.display = 'none';
    }
  } catch {}
}
checkRegAllowed();

tabSwitcher.addEventListener('click', e => {
  const tab = e.target.closest('.login-tab');
  if (!tab) return;
  const isLogin = tab === tabLogin;
  tabLogin.classList.toggle('active', isLogin);
  tabRegister.classList.toggle('active', !isLogin);
  loginForm.style.display    = isLogin ? '' : 'none';
  registerForm.style.display = isLogin ? 'none' : '';
  clearErr(loginErr);
  clearErr(regErr);
  totpGroup.style.display = 'none';
  pendingCredentials = null;
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  clearErr(loginErr);
  const btn = loginForm.querySelector('button');
  btn.disabled = true;

  try {
    let body;
    if (pendingCredentials) {
      const totpCode = document.getElementById('login-totp').value.trim();
      if (!totpCode) { showErr(loginErr, 'Enter your authenticator code.'); return; }
      body = { ...pendingCredentials, totp: totpCode };
    } else {
      body = {
        username: document.getElementById('login-id').value.trim(),
        password: document.getElementById('login-pass').value,
      };
    }

    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (res.status === 403 && data['2fa_required']) {
      pendingCredentials = { username: body.username, password: body.password };
      totpGroup.style.display = '';
      document.getElementById('login-totp').focus();
      document.querySelector('#login-form button').textContent = 'Verify';
      return;
    }

    if (!res.ok) { showErr(loginErr, data.error || 'Login failed'); return; }
    window.location.href = '/';
  } catch {
    showErr(loginErr, 'Network error — please try again.');
  } finally {
    btn.disabled = false;
  }
});

registerForm.addEventListener('submit', async e => {
  e.preventDefault();
  clearErr(regErr);
  const pass = document.getElementById('reg-pass').value;
  if (pass.length < 10) { showErr(regErr, 'Password must be at least 10 characters.'); return; }
  const btn = registerForm.querySelector('button');
  btn.disabled = true;
  try {
    const res  = await fetch('/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        username: document.getElementById('reg-username').value.trim(),
        email:    document.getElementById('reg-email').value.trim(),
        password: pass,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showErr(regErr, data.error || 'Registration failed'); return; }
    window.location.href = '/';
  } catch {
    showErr(regErr, 'Network error — please try again.');
  } finally {
    btn.disabled = false;
  }
});
