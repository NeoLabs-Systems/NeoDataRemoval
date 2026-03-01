'use strict';

const MONTHLY_INTERVAL_S  = 30 * 24 * 60 * 60; // 30 days
const REPORT_GRACE_S      = 2 * 60 * 60;        // 2 hours after scans triggered

let schedulerInterval = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check once per hour

function startScheduler() {
  if (schedulerInterval) return;
  console.log('[Scheduler] Started — checking for re-scans every hour');
  schedulerInterval = setInterval(runAllChecks, CHECK_INTERVAL_MS);
  setTimeout(runAllChecks, 10 * 1000);
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

async function runAllChecks() {
  await runReScanCheck();
  await runMonthlyScans();
  await runMonthlyReports();
}

async function runReScanCheck() {
  try {
    const db = require('../db/database').getDb();
    const rows = db.prepare(`
      SELECT DISTINCT e.profile_id, e.user_id, b.rescan_days
      FROM exposures e
      JOIN brokers b ON b.id = e.broker_id
      WHERE e.status IN ('detected', 'assumed', 're_exposed', 'removal_confirmed')
        AND b.rescan_days > 0
        AND b.enabled = 1
    `).all();

    if (!rows.length) return;

    const seen = new Set();
    for (const row of rows) {
      const key = `${row.user_id}:${row.profile_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const lastScan = db.prepare(`
        SELECT started_at FROM scans
        WHERE profile_id = ? AND user_id = ?
        ORDER BY started_at DESC LIMIT 1
      `).get(row.profile_id, row.user_id);

      const rescanMs    = row.rescan_days * 24 * 60 * 60 * 1000;
      const lastMs      = lastScan ? (lastScan.started_at * 1000) : 0;
      const shouldRescan = Date.now() - lastMs > rescanMs;

      if (shouldRescan) {
        const running = db.prepare(
          "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1"
        ).get(row.profile_id);
        if (running) continue;
        console.log(`[Scheduler] Triggering re-scan for profile ${row.profile_id} (user ${row.user_id})`);
        await triggerScan(row.profile_id, row.user_id).catch(e => {
          console.error(`[Scheduler] Re-scan failed for profile ${row.profile_id}:`, e.message);
        });
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error during re-scan check:', err.message);
  }
}

async function runMonthlyScans() {
  try {
    const db  = require('../db/database').getDb();
    const now = Math.floor(Date.now() / 1000);

    // Users who have at least one completed scan and haven't had a monthly scan in 30 days
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.email
      FROM users u
      WHERE u.active = 1
        AND (u.monthly_scan_triggered_at IS NULL OR u.monthly_scan_triggered_at < ? - ?)
        AND EXISTS (
          SELECT 1 FROM scans s
          WHERE s.user_id = u.id AND s.status = 'completed'
        )
    `).all(now, MONTHLY_INTERVAL_S);

    for (const user of users) {
      const profiles = db.prepare(
        'SELECT id FROM profiles WHERE user_id = ?'
      ).all(user.id);

      let triggered = 0;
      for (const p of profiles) {
        const running = db.prepare(
          "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1"
        ).get(p.id);
        if (running) continue;
        await triggerScan(p.id, user.id).catch(e => {
          console.error(`[Scheduler] Monthly scan failed for profile ${p.id}:`, e.message);
        });
        triggered++;
      }

      if (triggered > 0 || profiles.length === 0) {
        db.prepare(
          'UPDATE users SET monthly_scan_triggered_at = ? WHERE id = ?'
        ).run(now, user.id);
        console.log(`[Scheduler] Monthly scans triggered for user ${user.id} (${triggered} profiles)`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error during monthly scan trigger:', err.message);
  }
}

async function runMonthlyReports() {
  if (!process.env.SMTP_HOST) return;
  try {
    const db  = require('../db/database').getDb();
    const now = Math.floor(Date.now() / 1000);

    // Users where scans were triggered 2+ hours ago but report hasn't been sent yet this cycle
    const users = db.prepare(`
      SELECT u.*
      FROM users u
      WHERE u.active = 1
        AND u.email IS NOT NULL
        AND u.monthly_scan_triggered_at IS NOT NULL
        AND u.monthly_scan_triggered_at <= ? - ?
        AND (u.last_monthly_report_at IS NULL OR u.last_monthly_report_at < u.monthly_scan_triggered_at)
    `).all(now, REPORT_GRACE_S);

    for (const user of users) {
      // Skip if any scan is still running for this user
      const running = db.prepare(
        "SELECT id FROM scans WHERE user_id = ? AND status = 'running' LIMIT 1"
      ).get(user.id);
      if (running) continue;

      const { sendMonthlyReport } = require('./monthlyReport');
      await sendMonthlyReport(user, db).catch(e => {
        console.error(`[Scheduler] Report error for user ${user.id}:`, e.message);
      });

      db.prepare(
        'UPDATE users SET last_monthly_report_at = ? WHERE id = ?'
      ).run(now, user.id);
    }
  } catch (err) {
    console.error('[Scheduler] Error during monthly report:', err.message);
  }
}

async function triggerScan(profileId, userId) {
  const db   = require('../db/database').getDb();

  const running = db.prepare(
    "SELECT id FROM scans WHERE profile_id = ? AND status = 'running' LIMIT 1"
  ).get(profileId);
  if (running) return;

  const r = db.prepare(
    `INSERT INTO scans (profile_id, user_id) VALUES (?, ?)`
  ).run(profileId, userId);
  const scanId = r.lastInsertRowid;

  const { runScan } = require('./scanner');
  runScan(scanId, profileId, userId, () => {}).catch(err => {
    console.error('[Scheduler] Scan error:', err.message);
    db.prepare(`UPDATE scans SET status='error', error_msg=? WHERE id=?`).run(err.message, scanId);
  });
}

module.exports = { startScheduler, stopScheduler, runReScanCheck };
