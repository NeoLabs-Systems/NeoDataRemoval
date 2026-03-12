// app.js — main client-side router and shared state
"use strict";

import { renderDashboard } from "./dashboard.js";
import { renderExposures } from "./exposures.js";
import { renderRemovals } from "./removals.js";
import { renderBrokers } from "./brokers.js";
import { renderProfiles } from "./profiles.js";
import { renderSettings } from "./settings.js";

// ── Shared state ──────────────────────────────────────────────
export const state = { user: null };

/** Authenticated fetch — redirects to /login on 401 */
export async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  if (res.status === 401) {
    window.location.href = "/login.html";
    return null;
  }
  return res;
}

/** Escape a string for safe insertion into HTML (prevents XSS) */
export function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Allow only http/https URLs in href attributes — blocks javascript: and data: injection */
export function safeHref(url) {
  if (!url) return "#";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : "#";
  } catch {
    return "#";
  }
}

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  const res = await apiFetch("/api/auth/me");
  if (!res) return;
  if (!res.ok) {
    window.location.href = "/login.html";
    return;
  }
  state.user = await res.json();

  document.getElementById("topbar-user").textContent = state.user.username;

  // Show System tab for admins
  if (state.user.role === "admin") {
    const stabSystem = document.getElementById("stab-system");
    if (stabSystem) stabSystem.style.display = "";
  }

  loadExposureBadge();
  route();
  setupEventListeners();
}

// ── Router ────────────────────────────────────────────────────
const VIEW_MAP = {
  dashboard: { fn: renderDashboard, title: "Dashboard" },
  exposures: { fn: renderExposures, title: "Exposures" },
  removals: { fn: renderRemovals, title: "Removals" },
  brokers: { fn: renderBrokers, title: "Data Brokers" },
  profiles: { fn: renderProfiles, title: "My Profiles" },
};

function route() {
  const hash = location.hash.replace("#", "").split("/")[0] || "dashboard";
  const view = VIEW_MAP[hash] || VIEW_MAP.dashboard;

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === hash);
  });
  document.getElementById("topbarTitle").textContent = view.title;

  const content = document.getElementById("content");
  content.innerHTML =
    '<div class="spinner-wrap"><div class="spinner"></div></div>';
  view.fn(content, state);
}

window.addEventListener("hashchange", route);

// ── Scan modal ────────────────────────────────────────────────
async function openScanModal() {
  const modal = document.getElementById("scanModal");
  const select = document.getElementById("scanProfileSelect");
  const err = document.getElementById("scanErr");
  const progress = document.getElementById("scanProgress");

  progress.classList.add("hidden");
  err.textContent = "";
  modal.classList.remove("hidden");

  select.innerHTML = '<option value="">Loading…</option>';
  const res = await apiFetch("/api/profiles");
  if (!res) return;
  const profiles = await res.json();
  if (!profiles.length) {
    select.innerHTML =
      '<option value="">No profiles — create one first</option>';
    return;
  }
  select.innerHTML = profiles
    .map(
      (p) =>
        `<option value="${escHtml(p.id)}">${escHtml(p.name || p.label)}</option>`,
    )
    .join("");
}

async function startScan() {
  const profileId = document.getElementById("scanProfileSelect").value;
  const err = document.getElementById("scanErr");
  const btn = document.getElementById("startScanBtn");
  const progress = document.getElementById("scanProgress");
  const fill = document.getElementById("progressFill");
  const statTxt = document.getElementById("scanStatusText");

  err.textContent = "";
  if (!profileId) {
    err.textContent = "Select a profile first.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Starting…";
  document.getElementById("scanProfileField").classList.add("hidden");
  progress.classList.remove("hidden");
  fill.style.width = "0%";
  fill.style.transition = "width 0.4s ease";
  statTxt.textContent = "Starting scan…";

  const res = await apiFetch(`/api/scan/${profileId}`, { method: "POST" });
  if (!res) return;
  const data = await res.json();
  if (!res.ok) {
    err.textContent = data.error || "Failed to start scan";
    btn.disabled = false;
    btn.textContent = "Start Scan";
    document.getElementById("scanProfileField").classList.remove("hidden");
    progress.classList.add("hidden");
    return;
  }

  const scanId = data.scan_id;
  btn.textContent = "Scanning…";

  // Stream progress via SSE
  const evtSource = new EventSource(`/api/scan/${scanId}/stream`);

  evtSource.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    // total_brokers is set at scan start; total_checked increments per broker
    const total = msg.total_brokers || msg.total_checked || 1;
    const checked = msg.total_checked || 0;
    const pct = total > 0 ? Math.round((checked / total) * 100) : 0;

    fill.style.width = pct + "%";

    if (msg.status === "running") {
      statTxt.textContent =
        checked > 0
          ? `Checked ${checked} of ${total} broker${total !== 1 ? "s" : ""}…`
          : "Starting scan…";
    }

    if (msg.status === "done" || msg.status === "error") {
      evtSource.close();
      btn.disabled = false;
      btn.textContent = "Start Scan";

      if (msg.status === "done") {
        fill.style.width = "100%";
        const found = msg.found || 0;
        statTxt.textContent =
          found > 0
            ? `✅ Done — ${found} exposure${found !== 1 ? "s" : ""} found.`
            : "✅ Done — no new exposures found.";
        loadExposureBadge();
        setTimeout(() => {
          _dismissScanModal();
          location.hash = "exposures";
        }, 2600);
      } else {
        err.textContent = msg.error_msg || "Scan encountered an error.";
        document.getElementById("scanProfileField").classList.remove("hidden");
        progress.classList.add("hidden");
      }
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    if (!err.textContent) {
      err.textContent =
        "Connection lost — the scan may still be running in the background.";
    }
    btn.disabled = false;
    btn.textContent = "Start Scan";
    document.getElementById("scanProfileField").classList.remove("hidden");
  };
}

function _dismissScanModal() {
  document.getElementById("scanModal").classList.add("hidden");
  document.getElementById("scanProfileField").classList.remove("hidden");
  document.getElementById("scanProgress").classList.add("hidden");
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("scanErr").textContent = "";
  const btn = document.getElementById("startScanBtn");
  btn.disabled = false;
  btn.textContent = "Start Scan";
}

async function loadExposureBadge() {
  const res = await apiFetch("/api/exposures/stats");
  if (!res || !res.ok) return;
  const stats = await res.json();
  const badge = document.getElementById("badgeExposures");
  if (!badge) return;
  const active = (stats.total || 0) - (stats.done || 0);
  badge.textContent = active > 0 ? String(active) : "";
  badge.style.display = active > 0 ? "" : "none";
}

// ── Event listeners ───────────────────────────────────────────
function setupEventListeners() {
  document
    .getElementById("btnNewScan")
    .addEventListener("click", openScanModal);
  document
    .getElementById("closeScanModal")
    .addEventListener("click", _dismissScanModal);
  document
    .getElementById("cancelScan")
    .addEventListener("click", _dismissScanModal);
  document.getElementById("startScanBtn").addEventListener("click", startScan);

  document.getElementById("btnLogout").addEventListener("click", async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  // Settings button → open overlay
  const settingsOverlay = document.getElementById("settings-overlay");
  document.getElementById("btn-settings").addEventListener("click", () => {
    settingsOverlay.classList.remove("hidden");
    const contentEl = document.getElementById("settings-content");
    if (!contentEl.dataset.loaded) {
      // Pass the current user so the System tab is rendered for admins
      renderSettings(contentEl, state.user);
      contentEl.dataset.loaded = "1";
    }
    // Activate the first visible tab
    const visibleStabs = Array.from(document.querySelectorAll(".stab")).filter(
      (s) => s.style.display !== "none",
    );
    document
      .querySelectorAll(".stab")
      .forEach((s) => s.classList.remove("active"));
    if (visibleStabs[0]) visibleStabs[0].classList.add("active");
    const firstPanel = visibleStabs[0]
      ? visibleStabs[0].dataset.panel
      : "scanning";
    document.querySelectorAll(".settings-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.panel === firstPanel);
    });
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settingsOverlay.classList.add("hidden");
  });
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.add("hidden");
  });

  // Stab (tab) switching
  document.querySelector(".settings-tabs").addEventListener("click", (e) => {
    const stab = e.target.closest(".stab");
    if (!stab) return;
    document
      .querySelectorAll(".stab")
      .forEach((s) => s.classList.remove("active"));
    stab.classList.add("active");
    const panel = stab.dataset.panel;
    document.querySelectorAll(".settings-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.panel === panel);
    });
  });

  // Mobile sidebar toggle
  document.getElementById("mobile-menu-btn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
    document.getElementById("mobile-overlay").classList.toggle("active");
  });
  document.getElementById("mobile-overlay").addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("mobile-overlay").classList.remove("active");
  });

  // Close sidebar on nav click (mobile)
  document.querySelector(".sidebar-section").addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("mobile-overlay").classList.remove("active");
  });
}

boot();
