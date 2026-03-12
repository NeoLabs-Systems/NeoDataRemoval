"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { makeBrokerKey } = require("../services/brokerCatalog");

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
      broker_id    INTEGER,
      broker_key   TEXT,
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
      broker_id       INTEGER,
      broker_key      TEXT,
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

  _ensureBrokerKeyMigration();

  // Backfill total_brokers from total_checked for old scans where it's 0
  db.prepare(
    `
    UPDATE scans SET total_brokers = total_checked
    WHERE total_brokers = 0 AND total_checked > 0
  `,
  ).run();
}

function _ensureBrokerKeyMigration() {
  const exposureCols = db.prepare("PRAGMA table_info(exposures)").all();
  const removalCols = db.prepare("PRAGMA table_info(removal_requests)").all();
  const exposureNames = exposureCols.map((col) => col.name);
  const removalNames = removalCols.map((col) => col.name);

  if (!exposureNames.includes("broker_key")) {
    db.exec("ALTER TABLE exposures ADD COLUMN broker_key TEXT");
  }
  if (!removalNames.includes("broker_key")) {
    db.exec("ALTER TABLE removal_requests ADD COLUMN broker_key TEXT");
  }

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_exposures_broker_key ON exposures(broker_key)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_removals_broker_key ON removal_requests(broker_key)",
  );

  _backfillBrokerKeys();

  const exposureBrokerId = db
    .prepare("PRAGMA table_info(exposures)")
    .all()
    .find((col) => col.name === "broker_id");
  const removalBrokerId = db
    .prepare("PRAGMA table_info(removal_requests)")
    .all()
    .find((col) => col.name === "broker_id");

  if (exposureBrokerId && exposureBrokerId.notnull) {
    _rebuildExposuresTable();
  }
  if (removalBrokerId && removalBrokerId.notnull) {
    _rebuildRemovalRequestsTable();
  }
}

function _backfillBrokerKeys() {
  const hasBrokersTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brokers'",
    )
    .get();
  if (!hasBrokersTable) return;

  const brokerRows = db.prepare("SELECT id, name, url FROM brokers").all();
  if (!brokerRows.length) return;

  const updateExposure = db.prepare(
    "UPDATE exposures SET broker_key = ? WHERE broker_id = ? AND (broker_key IS NULL OR broker_key = '')",
  );
  const updateRemoval = db.prepare(
    "UPDATE removal_requests SET broker_key = ? WHERE broker_id = ? AND (broker_key IS NULL OR broker_key = '')",
  );

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const brokerKey = makeBrokerKey(row.name, row.url);
      updateExposure.run(brokerKey, row.id);
      updateRemoval.run(brokerKey, row.id);
    }
  });

  tx(brokerRows);
}

function _rebuildExposuresTable() {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE exposures_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        broker_id    INTEGER,
        broker_key   TEXT,
        scan_id      INTEGER REFERENCES scans(id),
        status       TEXT NOT NULL DEFAULT 'detected',
        detected_at  INTEGER DEFAULT (unixepoch()),
        last_updated INTEGER DEFAULT (unixepoch()),
        profile_url  TEXT,
        notes        TEXT
      );

      INSERT INTO exposures_new (
        id, profile_id, user_id, broker_id, broker_key, scan_id, status,
        detected_at, last_updated, profile_url, notes
      )
      SELECT
        id, profile_id, user_id, broker_id, broker_key, scan_id, status,
        detected_at, last_updated, profile_url, notes
      FROM exposures;

      DROP TABLE exposures;
      ALTER TABLE exposures_new RENAME TO exposures;

      CREATE INDEX IF NOT EXISTS idx_exposures_user    ON exposures(user_id);
      CREATE INDEX IF NOT EXISTS idx_exposures_profile ON exposures(profile_id);
      CREATE INDEX IF NOT EXISTS idx_exposures_broker  ON exposures(broker_id);
      CREATE INDEX IF NOT EXISTS idx_exposures_broker_key ON exposures(broker_key);
      CREATE INDEX IF NOT EXISTS idx_exposures_status  ON exposures(status);
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function _rebuildRemovalRequestsTable() {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE removal_requests_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        exposure_id     INTEGER NOT NULL REFERENCES exposures(id) ON DELETE CASCADE,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        broker_id       INTEGER,
        broker_key      TEXT,
        sent_at         INTEGER DEFAULT (unixepoch()),
        method          TEXT NOT NULL,
        status          TEXT DEFAULT 'sent',
        response_status INTEGER,
        response_body   TEXT,
        success         INTEGER DEFAULT 0,
        notes           TEXT
      );

      INSERT INTO removal_requests_new (
        id, exposure_id, user_id, broker_id, broker_key, sent_at, method,
        status, response_status, response_body, success, notes
      )
      SELECT
        id, exposure_id, user_id, broker_id, broker_key, sent_at, method,
        status, response_status, response_body, success, notes
      FROM removal_requests;

      DROP TABLE removal_requests;
      ALTER TABLE removal_requests_new RENAME TO removal_requests;

      CREATE INDEX IF NOT EXISTS idx_removals_user     ON removal_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_removals_exposure ON removal_requests(exposure_id);
      CREATE INDEX IF NOT EXISTS idx_removals_broker_key ON removal_requests(broker_key);
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

module.exports = { initDb, getDb };
