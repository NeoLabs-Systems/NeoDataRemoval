// app.js — main client-side router and shared state
'use strict';

import { renderDashboard } from './dashboard.js';
import { renderExposures  } from './exposures.js';
import { renderRemovals   } from './removals.js';
import { renderBrokers    } from './brokers.js';
import { renderProfiles   } from './profiles.js';
import { renderSettings   } from './settings.js';

// ── Shared state ──────────────────────────────────────────────
export const state = { user: null };

/** Authenticated fetch — redirects to /login on 401 */
export async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { credentials: 'include', ...opts });
  if (res.status === 401) { window.location.href = '/login.html'; return null; }
  return res;
}

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  const res = await apiFetch('/api/auth/me');
  if (!res) return;
  if (!res.ok) { window.location.href = '/login.html'; return; }
  state.user = await res.json();

  document.getElementById('topbar-user').textContent = state.user.username;

  loadExposureBadge();
  route();
  setupEventListeners();
}

// ── Router ────────────────────────────────────────────────────
const VIEW_MAP = {
  dashboard: { fn: renderDashboard, title: 'Dashboard'     },
  exposures: { fn: renderExposures, title: 'Exposures'     },
  removals:  { fn: renderRemovals,  title: 'Removals'      },
  brokers:   { fn: renderBrokers,   title: 'Data Brokers'  },
  profiles:  { fn: renderProfiles,  title: 'My Profiles'   },
};

function route() {
  const hash = location.hash.replace('#', '').split('/')[0] || 'dashboard';
  const view = VIEW_MAP[hash] || VIEW_MAP.dashboard;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === hash);
  });
  document.getElementById('topbarTitle').textContent = view.title;

  const content = document.getElementById('content');
  content.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  view.fn(content, state);
}

window.addEventListener('hashchange', route);

// ── Scan modal ────────────────────────────────────────────────
async function openScanModal() {
  const modal   = document.getElementById('scanModal');
  const select  = document.getElementById('scanProfileSelect');
  const err     = document.getElementById('scanErr');
  const progress= document.getElementById('scanProgress');
  const fill    = document.getElementById('progressFill');
  const statTxt = document.getElementById('scanStatusText');

  progress.classList.add('hidden');
  err.textContent = '';
  modal.classList.remove('hidden');

  select.innerHTML = '<option value="">Loading…</option>';
  const res = await apiFetch('/api/profiles');
  if (!res) return;
  const profiles = await res.json();
  if (!profiles.length) {
    select.innerHTML = '<option value="">No profiles — create one first</option>';
    return;
  }
  select.innerHTML = profiles.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function startScan() {
  const profileId = document.getElementById('scanProfileSelect').value;
  const err       = document.getElementById('scanErr');
  const btn       = document.getElementById('startScanBtn');
  const progress  = document.getElementById('scanProgress');
  const fill      = document.getElementById('progressFill');
  const statTxt   = document.getElementById('scanStatusText');
  err.textContent = '';
  if (!profileId) { err.textContent = 'Select a profile.'; return; }

  btn.disabled = true; btn.textContent = 'Starting…';
  document.getElementById('scanProfileField').classList.add('hidden');
  progress.classList.remove('hidden');
  fill.style.width = '0%';
  statTxt.textContent = 'Starting scan…';

  const res = await apiFetch(`/api/scan/${profileId}`, { method: 'POST' });
  if (!res) return;
  const data = await res.json();
  if (!res.ok) { err.textContent = data.error || 'Failed to start scan'; btn.disabled = false; btn.textContent = 'Start Scan'; return; }

  const scanId = data.scan_id;
  btn.textContent = 'Scanning…';

  // Poll via SSE
  const evtSource = new EventSource(`/api/scan/${scanId}/stream`);
  evtSource.onmessage = e => {
    const msg = JSON.parse(e.data);
    // DB columns: total_checked = brokers checked so far, found = exposures found
    const pct = msg.total_checked && msg.total_brokers
      ? Math.round(100 * msg.total_checked / msg.total_brokers)
      : Math.min(90, (msg.total_checked || 0) * 2);
    fill.style.width = pct + '%';
    statTxt.textContent = `Checking broker ${msg.total_checked || 0}…`;
    if (msg.status === 'done' || msg.status === 'error') {
      evtSource.close();
      btn.disabled = false; btn.textContent = 'Start Scan';
      if (msg.status === 'done') {
        fill.style.width = '100%';
        statTxt.textContent = `Done — ${msg.found || 0} exposures found.`;
        loadExposureBadge();
        setTimeout(() => {
          document.getElementById('scanModal').classList.add('hidden');
          document.getElementById('scanProfileField').classList.remove('hidden');
          location.hash = 'exposures';
        }, 2400);
      } else {
        err.textContent = 'Scan encountered an error.';
      }
    }
  };
  evtSource.onerror = () => {
    evtSource.close();
    err.textContent = 'Connection lost during scan.';
    btn.disabled = false; btn.textContent = 'Start Scan';
    document.getElementById('scanProfileField').classList.remove('hidden');
  };
}

async function loadExposureBadge() {
  const res = await apiFetch('/api/exposures/stats');
  if (!res) return;
  const stats = await res.json();
  const badge = document.getElementById('badgeExposures');
  const active = (stats.total || 0) - (stats.done || 0);
  badge.textContent = active > 0 ? active : '';
  badge.style.display = active > 0 ? '' : 'none';
}

// ── Event listeners ───────────────────────────────────────────
function setupEventListeners() {
  document.getElementById('btnNewScan').addEventListener('click', openScanModal);
  const _dismissScan = () => {
    document.getElementById('scanModal').classList.add('hidden');
    document.getElementById('scanProfileField').classList.remove('hidden');
    document.getElementById('scanProgress').classList.add('hidden');
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('scanErr').textContent = '';
    const btn = document.getElementById('startScanBtn');
    btn.disabled = false; btn.textContent = 'Start Scan';
  };
  document.getElementById('closeScanModal').addEventListener('click', _dismissScan);
  document.getElementById('cancelScan').addEventListener('click', _dismissScan);
  document.getElementById('startScanBtn').addEventListener('click', startScan);

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // Settings button → open overlay
  const settingsOverlay = document.getElementById('settings-overlay');
  document.getElementById('btn-settings').addEventListener('click', () => {
    settingsOverlay.classList.remove('hidden');
    const contentEl = document.getElementById('settings-content');
    if (!contentEl.dataset.loaded) {
      renderSettings(contentEl);
      contentEl.dataset.loaded = '1';
    }
    // Activate first stab
    document.querySelectorAll('.stab').forEach((s, i) => s.classList.toggle('active', i === 0));
    document.querySelectorAll('.settings-panel').forEach((p, i) => p.classList.toggle('active', i === 0));
  });
  document.getElementById('settings-close').addEventListener('click', () => {
    settingsOverlay.classList.add('hidden');
  });
  settingsOverlay.addEventListener('click', e => {
    if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
  });
  // Stab switching
  document.querySelector('.settings-tabs').addEventListener('click', e => {
    const stab = e.target.closest('.stab');
    if (!stab) return;
    document.querySelectorAll('.stab').forEach(s => s.classList.remove('active'));
    stab.classList.add('active');
    const panel = stab.dataset.panel;
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === panel));
  });

  // Mobile sidebar toggle
  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('mobile-overlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });

  // Close sidebar on nav click (mobile)
  document.querySelector('.sidebar-section').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });
}

boot();
