'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'db_data');
const DB_PATH = path.join(DB_DIR, 'neodataremoval.db');

let db;

function getDb() {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}

function initDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      totp_enabled  INTEGER DEFAULT 0,
      totp_secret   TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      active        INTEGER DEFAULT 1
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
      found         INTEGER DEFAULT 0,
      error_msg     TEXT
    );

    CREATE TABLE IF NOT EXISTS exposures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      broker_id   INTEGER NOT NULL REFERENCES brokers(id),
      scan_id     INTEGER REFERENCES scans(id),
      status      TEXT NOT NULL DEFAULT 'detected',
      detected_at INTEGER DEFAULT (unixepoch()),
      last_updated INTEGER DEFAULT (unixepoch()),
      profile_url TEXT,
      notes       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_exposures_user    ON exposures(user_id);
    CREATE INDEX IF NOT EXISTS idx_exposures_profile ON exposures(profile_id);
    CREATE INDEX IF NOT EXISTS idx_exposures_broker  ON exposures(broker_id);

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

    CREATE TABLE IF NOT EXISTS settings (
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      key         TEXT NOT NULL DEFAULT 'prefs',
      value       TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS ai_cache (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key   TEXT UNIQUE NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER DEFAULT (unixepoch())
    );
  `);

  seedBrokers();

  // Add TOTP columns for existing databases (migration)
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('totp_enabled'))             db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
  if (!cols.includes('totp_secret'))              db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  if (!cols.includes('monthly_scan_triggered_at')) db.exec('ALTER TABLE users ADD COLUMN monthly_scan_triggered_at INTEGER');
  if (!cols.includes('last_monthly_report_at'))    db.exec('ALTER TABLE users ADD COLUMN last_monthly_report_at INTEGER');

  // Reset any scans that were left running when the server last shut down
  db.prepare("UPDATE scans SET status='error', error_msg='Server restarted', completed_at=unixepoch() WHERE status='running'").run();

  console.log('Database initialised at', DB_PATH);
}

function seedBrokers() {
  const brokersPath = path.join(__dirname, '..', 'data', 'brokers.json');
  if (!fs.existsSync(brokersPath)) return;

  const brokers = JSON.parse(fs.readFileSync(brokersPath, 'utf8'));
  const existing = db.prepare('SELECT COUNT(*) as c FROM brokers').get().c;

  // On first run insert all; on subsequent runs only insert new entries (by URL)
  const insertOne = db.prepare(`
    INSERT INTO brokers (name, url, opt_out_url, method, priority, automation, contact_email, instructions, rescan_days)
    SELECT @name, @url, @opt_out_url, @method, @priority, @automation, @contact_email, @instructions, @rescan_days
    WHERE NOT EXISTS (SELECT 1 FROM brokers WHERE lower(name) = lower(@name) OR url = @url)
  `);

  const upsertMany = db.transaction((rows) => {
    let added = 0;
    for (const row of rows) {
      const res = insertOne.run({
        name:          row.name         || '',
        url:           row.url          || '',
        opt_out_url:   row.opt_out_url  || null,
        method:        row.method       || 'manual',
        priority:      row.priority     || 'standard',
        automation:    row.automation   || 'browser_required',
        contact_email: row.contact_email|| null,
        instructions:  row.instructions || null,
        rescan_days:   row.rescan_days  || 90,
      });
      if (res.changes > 0) added++;
    }
    return added;
  });

  const added = upsertMany(brokers);
  if (existing === 0) {
    console.log(`Seeded ${added} brokers`);
  } else if (added > 0) {
    console.log(`Added ${added} new brokers from brokers.json`);
  }
}

module.exports = { initDb, getDb };
