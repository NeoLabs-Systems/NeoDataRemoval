"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "..", "db_data");
const DB_PATH = path.join(DB_DIR, "neodataremoval.db");

let db;

function getDb() {
  if (!db) throw new Error("Database not initialised — call initDb() first");
  return db;
}

function initDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      totp_enabled  INTEGER DEFAULT 0,
      totp_secret   TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      active        INTEGER DEFAULT 1,
      monthly_scan_triggered_at INTEGER,
      last_monthly_report_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      data_enc   TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS brokers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      url           TEXT NOT NULL,
      opt_out_url   TEXT,
      method        TEXT NOT NULL DEFAULT 'manual',
      priority      TEXT NOT NULL DEFAULT 'standard',
      automation    TEXT NOT NULL DEFAULT 'manual',
      contact_email TEXT,
      instructions  TEXT,
      rescan_days   INTEGER DEFAULT 60,
      enabled       INTEGER DEFAULT 1,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS scans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at    INTEGER DEFAULT (unixepoch()),
      completed_at  INTEGER,
      status        TEXT DEFAULT 'running',
      total_checked INTEGER DEFAULT 0,
      total_brokers INTEGER DEFAULT 0,
      found         INTEGER DEFAULT 0,
      auto_removal  INTEGER DEFAULT 0,
      error_msg     TEXT
    );

    CREATE TABLE IF NOT EXISTS exposures (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      broker_id    INTEGER NOT NULL REFERENCES brokers(id),
      scan_id      INTEGER REFERENCES scans(id),
      status       TEXT NOT NULL DEFAULT 'detected',
      detected_at  INTEGER DEFAULT (unixepoch()),
      last_updated INTEGER DEFAULT (unixepoch()),
      profile_url  TEXT,
      notes        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_exposures_user    ON exposures(user_id);
    CREATE INDEX IF NOT EXISTS idx_exposures_profile ON exposures(profile_id);
    CREATE INDEX IF NOT EXISTS idx_exposures_broker  ON exposures(broker_id);
    CREATE INDEX IF NOT EXISTS idx_exposures_status  ON exposures(status);

    CREATE TABLE IF NOT EXISTS removal_requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      exposure_id     INTEGER NOT NULL REFERENCES exposures(id) ON DELETE CASCADE,
      user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
      broker_id       INTEGER REFERENCES brokers(id),
      sent_at         INTEGER DEFAULT (unixepoch()),
      method          TEXT NOT NULL,
      status          TEXT DEFAULT 'sent',
      response_status INTEGER,
      response_body   TEXT,
      success         INTEGER DEFAULT 0,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_removals_user     ON removal_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_removals_exposure ON removal_requests(exposure_id);

    CREATE TABLE IF NOT EXISTS settings (
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      key        TEXT NOT NULL DEFAULT 'prefs',
      value      TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS ai_cache (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key   TEXT UNIQUE NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL,
      is_encrypted INTEGER DEFAULT 0,
      updated_at   INTEGER DEFAULT (unixepoch())
    );
  `);

  _runMigrations();
  seedBrokers();

  // Reset any scans that were left in a running state when the server last stopped
  const stale = db
    .prepare(
      "UPDATE scans SET status='error', error_msg='Server restarted while scan was running', completed_at=unixepoch() WHERE status='running'",
    )
    .run();
  if (stale.changes > 0) {
    console.log(
      `[DB] Reset ${stale.changes} stale running scan(s) to error status`,
    );
  }

  console.log("Database initialised at", DB_PATH);
}

/* ── Migrations — safely add new columns to existing databases ── */
function _runMigrations() {
  function cols(table) {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  }

  // users table
  const userCols = cols("users");
  if (!userCols.includes("totp_enabled"))
    db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0");
  if (!userCols.includes("totp_secret"))
    db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
  if (!userCols.includes("monthly_scan_triggered_at"))
    db.exec("ALTER TABLE users ADD COLUMN monthly_scan_triggered_at INTEGER");
  if (!userCols.includes("last_monthly_report_at"))
    db.exec("ALTER TABLE users ADD COLUMN last_monthly_report_at INTEGER");

  // Ensure single-user: enforce all existing users are role=admin (legacy multi-user dbs)
  db.prepare("UPDATE users SET role = 'admin' WHERE role != 'admin'").run();

  // scans table
  const scanCols = cols("scans");
  if (!scanCols.includes("total_brokers"))
    db.exec("ALTER TABLE scans ADD COLUMN total_brokers INTEGER DEFAULT 0");
  if (!scanCols.includes("auto_removal"))
    db.exec("ALTER TABLE scans ADD COLUMN auto_removal INTEGER DEFAULT 0");

  // Backfill total_brokers from total_checked for old scans where it's 0
  db.prepare(
    `
    UPDATE scans SET total_brokers = total_checked
    WHERE total_brokers = 0 AND total_checked > 0
  `,
  ).run();
}

/* ── Broker seeding ──────────────────────────────────────────── */
function seedBrokers() {
  const brokersPath = path.join(__dirname, "..", "data", "brokers.json");
  if (!fs.existsSync(brokersPath)) return;

  let brokers;
  try {
    brokers = JSON.parse(fs.readFileSync(brokersPath, "utf8"));
  } catch (err) {
    console.error("[DB] Failed to parse brokers.json:", err.message);
    return;
  }

  const existing = db.prepare("SELECT COUNT(*) as c FROM brokers").get().c;

  // Insert new; skip if name OR url already exists
  const insertOne = db.prepare(`
    INSERT INTO brokers (name, url, opt_out_url, method, priority, automation, contact_email, instructions, rescan_days)
    SELECT @name, @url, @opt_out_url, @method, @priority, @automation, @contact_email, @instructions, @rescan_days
    WHERE NOT EXISTS (
      SELECT 1 FROM brokers WHERE lower(name) = lower(@name) OR url = @url
    )
  `);

  const upsertMany = db.transaction((rows) => {
    let added = 0;
    for (const row of rows) {
      const res = insertOne.run({
        name: row.name || "",
        url: row.url || "",
        opt_out_url: row.opt_out_url || null,
        method: row.method || "manual",
        priority: row.priority || "standard",
        automation: row.automation || "browser_required",
        contact_email: row.contact_email || null,
        instructions: row.instructions || null,
        rescan_days: row.rescan_days || 90,
      });
      if (res.changes > 0) added++;
    }
    return added;
  });

  const added = upsertMany(brokers);
  if (existing === 0) {
    console.log(`[DB] Seeded ${added} brokers`);
  } else if (added > 0) {
    console.log(`[DB] Added ${added} new broker(s) from brokers.json`);
  }
}

module.exports = { initDb, getDb };
