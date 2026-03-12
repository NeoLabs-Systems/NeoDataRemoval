"use strict";

const { enrichExposure } = require("./brokerCatalog");

/**
 * scheduler.js — background job runner
 *
 * Jobs:
 *   ┌─ runReScanCheck()       — re-scan profiles with active exposures past their broker's rescan_days
 *   ├─ runVerificationCheck() — re-check pending removals to detect confirmed/re-exposed status
 *   ├─ runMonthlyScans()      — trigger a full scan for every profile once per 30 days
 *   └─ runMonthlyReports()    — email the user their monthly summary after scans settle
 *
 * Intervals:
 *   • All jobs: every 30 minutes (was hourly — catches things faster)
 *   • First run: 15 seconds after boot (let the server fully start up first)
 */

const MONTHLY_INTERVAL_S = 30 * 24 * 60 * 60; // 30 days in seconds
const REPORT_GRACE_S = 2 * 60 * 60; // wait 2 hours after scan before sending report

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // run all checks every 30 minutes
const BOOT_DELAY_MS = 15 * 1000; // first run 15 s after boot

let _interval = null;
let _running = false; // prevent overlapping runs

/* ── Public API ───────────────────────────────────────────── */

function startScheduler() {
  if (_interval) return;
  console.log(
    "[Scheduler] Started — checks every 30 minutes, first run in 15 s",
  );
  _interval = setInterval(_safeRunAll, CHECK_INTERVAL_MS);
  setTimeout(_safeRunAll, BOOT_DELAY_MS);
}

function stopScheduler() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log("[Scheduler] Stopped");
  }
}

/** Exposed for manual trigger from routes / tests */
async function runReScanCheck() {
  return _runReScanCheck();
}

/* ── Orchestrator ─────────────────────────────────────────── */

async function _safeRunAll() {
  if (_running) {
    console.log(
      "[Scheduler] Previous run still in progress — skipping this tick",
    );
    return;
  }
  _running = true;
  try {
    await _runReScanCheck();
    await _runVerificationCheck();
    await _runMonthlyScans();
    await _runMonthlyReports();
  } catch (err) {
    console.error("[Scheduler] Unexpected top-level error:", err.message);
  } finally {
    _running = false;
  }
}

/* ── Job: Re-scan profiles with active exposures ──────────── */

async function _runReScanCheck() {
  try {
    const db = _db();

    // Find unique profile+user combos that have active exposures on brokers
    // whose rescan window has elapsed since the last scan of that profile.
    const candidates = db
      .prepare(
        `
      SELECT e.profile_id, e.user_id, e.broker_id, e.broker_key
      FROM exposures e
      WHERE e.status IN ('detected', 'assumed', 're_exposed', 'removal_sent', 'manual_pending')
    `,
      )
      .all()
      .map(enrichExposure)
      .filter((row) => row.enabled !== false && (row.rescan_days || 0) > 0)
      .reduce((acc, row) => {
        const key = `${row.profile_id}:${row.user_id}`;
        const current = acc.get(key);
        if (!current || row.rescan_days < current.rescan_days) {
          acc.set(key, {
            profile_id: row.profile_id,
            user_id: row.user_id,
            rescan_days: row.rescan_days,
          });
        }
        return acc;
      }, new Map());

    const candidateRows = [...candidates.values()];

    if (!candidateRows.length) return;

    let triggered = 0;
    for (const row of candidateRows) {
      const lastScan = db
        .prepare(
          `
        SELECT started_at FROM scans
        WHERE profile_id = ? AND user_id = ? AND status IN ('done','error')
        ORDER BY started_at DESC LIMIT 1
      `,
        )
        .get(row.profile_id, row.user_id);

      const rescanMs = row.rescan_days * 24 * 60 * 60 * 1000;
      const lastMs = lastScan ? lastScan.started_at * 1000 : 0;
      const overdue = Date.now() - lastMs > rescanMs;
      if (!overdue) continue;

      const alreadyRunning = db
        .prepare(
          "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1",
        )
        .get(row.profile_id);
      if (alreadyRunning) continue;

      console.log(
        `[Scheduler] Re-scan due — profile ${row.profile_id} (user ${row.user_id})`,
      );
      await _triggerScan(row.profile_id, row.user_id).catch((err) => {
        console.error(
          `[Scheduler] Re-scan failed for profile ${row.profile_id}:`,
          err.message,
        );
      });
      triggered++;
    }

    if (triggered > 0) {
      console.log(`[Scheduler] Triggered ${triggered} re-scan(s)`);
    }
  } catch (err) {
    console.error("[Scheduler] runReScanCheck error:", err.message);
  }
}

/* ── Job: Verify pending removals ─────────────────────────── */

async function _runVerificationCheck() {
  try {
    const sysconfig = require("./sysconfig");
    if (sysconfig.get("verify_removals_enabled") === "false") return;

    const verifyDays = parseInt(sysconfig.get("removal_verify_days"), 10) || 14;
    const db = _db();
    const cutoff = Math.floor(Date.now() / 1000) - verifyDays * 24 * 60 * 60;

    // Exposures awaiting removal verification (sent > verifyDays ago, not yet re-checked)
    const pending = db
      .prepare(
        `
      SELECT DISTINCT e.profile_id, e.user_id
      FROM exposures e
      WHERE e.status IN ('removal_sent', 'manual_pending')
        AND e.last_updated <= ?
    `,
      )
      .all(cutoff);

    if (!pending.length) return;

    let triggered = 0;
    for (const row of pending) {
      const alreadyRunning = db
        .prepare(
          "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1",
        )
        .get(row.profile_id);
      if (alreadyRunning) continue;

      console.log(
        `[Scheduler] Verification scan — profile ${row.profile_id} (user ${row.user_id})`,
      );
      await _triggerScan(row.profile_id, row.user_id).catch((err) => {
        console.error(
          `[Scheduler] Verification scan failed for profile ${row.profile_id}:`,
          err.message,
        );
      });
      triggered++;
    }

    if (triggered > 0) {
      console.log(
        `[Scheduler] Triggered ${triggered} verification scan(s) for pending removals`,
      );
    }
  } catch (err) {
    console.error("[Scheduler] runVerificationCheck error:", err.message);
  }
}

/* ── Job: Monthly full scans ──────────────────────────────── */

async function _runMonthlyScans() {
  try {
    const db = _db();
    const now = Math.floor(Date.now() / 1000);

    // Users who have had at least one completed scan but haven't had a monthly
    // scan triggered in the last 30 days
    const users = db
      .prepare(
        `
      SELECT DISTINCT u.id, u.email
      FROM users u
      WHERE u.active = 1
        AND (
          u.monthly_scan_triggered_at IS NULL
          OR u.monthly_scan_triggered_at < ? - ?
        )
        AND EXISTS (
          SELECT 1 FROM scans s
          WHERE s.user_id = u.id AND s.status = 'done'
        )
    `,
      )
      .all(now, MONTHLY_INTERVAL_S);

    for (const user of users) {
      const profiles = db
        .prepare("SELECT id FROM profiles WHERE user_id = ?")
        .all(user.id);

      let launched = 0;
      for (const p of profiles) {
        const running = db
          .prepare(
            "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1",
          )
          .get(p.id);
        if (running) continue;

        await _triggerScan(p.id, user.id).catch((err) => {
          console.error(
            `[Scheduler] Monthly scan failed for profile ${p.id}:`,
            err.message,
          );
        });
        launched++;
      }

      // Mark triggered even if all profiles had running scans (prevent tight retry loop)
      if (launched > 0 || profiles.length === 0) {
        db.prepare(
          "UPDATE users SET monthly_scan_triggered_at = ? WHERE id = ?",
        ).run(now, user.id);
        console.log(
          `[Scheduler] Monthly scan triggered for user ${user.id} (${launched} profile(s))`,
        );
      }
    }
  } catch (err) {
    console.error("[Scheduler] runMonthlyScans error:", err.message);
  }
}

/* ── Job: Monthly email reports ───────────────────────────── */

async function _runMonthlyReports() {
  const sysconfig = require("./sysconfig");
  if (!sysconfig.get("smtp_host")) return; // email not configured — skip silently

  try {
    const db = _db();
    const now = Math.floor(Date.now() / 1000);

    // Users where the monthly scan was triggered ≥ REPORT_GRACE_S ago
    // and we haven't sent a report for this cycle yet
    const users = db
      .prepare(
        `
      SELECT u.*
      FROM users u
      WHERE u.active = 1
        AND u.email IS NOT NULL
        AND u.monthly_scan_triggered_at IS NOT NULL
        AND u.monthly_scan_triggered_at <= ? - ?
        AND (
          u.last_monthly_report_at IS NULL
          OR u.last_monthly_report_at < u.monthly_scan_triggered_at
        )
    `,
      )
      .all(now, REPORT_GRACE_S);

    for (const user of users) {
      // Skip if any scan is still running for this user
      const running = db
        .prepare(
          "SELECT id FROM scans WHERE user_id = ? AND status = 'running' LIMIT 1",
        )
        .get(user.id);
      if (running) continue;

      const { sendMonthlyReport } = require("./monthlyReport");
      try {
        await sendMonthlyReport(user, db);
        db.prepare(
          "UPDATE users SET last_monthly_report_at = ? WHERE id = ?",
        ).run(now, user.id);
      } catch (err) {
        console.error(
          `[Scheduler] Monthly report failed for user ${user.id}:`,
          err.message,
        );
      }
    }
  } catch (err) {
    console.error("[Scheduler] runMonthlyReports error:", err.message);
  }
}

/* ── Helpers ──────────────────────────────────────────────── */

function _db() {
  return require("../db/database").getDb();
}

/**
 * Insert a scan row and fire runScan in the background.
 * Respects the auto_removal_enabled sysconfig flag.
 */
async function _triggerScan(profileId, userId) {
  const db = _db();

  // Guard: never start a second scan for the same profile
  const running = db
    .prepare(
      "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1",
    )
    .get(profileId);
  if (running) return;

  const sysconfig = require("./sysconfig");
  const autoRemoval = sysconfig.get("auto_removal_enabled") === "true";

  const r = db
    .prepare(
      "INSERT INTO scans (profile_id, user_id, auto_removal) VALUES (?, ?, ?)",
    )
    .run(profileId, userId, autoRemoval ? 1 : 0);
  const scanId = r.lastInsertRowid;

  const { runScan } = require("./scanner");

  // Fire and forget — errors are handled inside runScan and logged below
  runScan(scanId, profileId, userId, null, { autoRemoval }).catch((err) => {
    console.error(`[Scheduler] Scan ${scanId} error:`, err.message);
    try {
      db.prepare(
        "UPDATE scans SET status = 'error', error_msg = ?, completed_at = unixepoch() WHERE id = ?",
      ).run(err.message, scanId);
    } catch {
      /* DB might be shutting down */
    }
  });
}

module.exports = { startScheduler, stopScheduler, runReScanCheck };
