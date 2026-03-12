'use strict';

/**
 * sysconfig — central runtime configuration store.
 *
 * Priority: system_settings DB table > environment variable > hard-coded default.
 * Sensitive values (smtp_pass, openai_api_key) are AES-256-GCM encrypted at rest
 * using the same crypto service that protects profile data.
 *
 * Public API:
 *   get(key)            → string | null
 *   set(key, value)     → void  (pass null/'' to clear → reverts to env/default)
 *   setMany(obj)        → void  (transactional)
 *   getPublicConfig()   → object  (for admin UI — sensitive values masked)
 */

const SENSITIVE_KEYS = new Set(['smtp_pass', 'openai_api_key']);

/** Maps our canonical key names → process.env variable names */
const ENV_MAP = {
  smtp_host:      'SMTP_HOST',
  smtp_port:      'SMTP_PORT',
  smtp_secure:    'SMTP_SECURE',
  smtp_user:      'SMTP_USER',
  smtp_pass:      'SMTP_PASS',
  smtp_from:      'SMTP_FROM',
  openai_api_key: 'OPENAI_API_KEY',
  app_url:        'APP_URL',
  scan_delay_ms:  'SCAN_DELAY_MS',
};

/** Hard-coded fallback defaults (lowest priority) */
const DEFAULTS = {
  smtp_port:               '587',
  smtp_secure:             'false',
  scan_delay_ms:           '2000',
  openai_model:            'gpt-4o-mini',
  auto_removal_enabled:    'false',
  verify_removals_enabled: 'true',
  removal_verify_days:     '14',
};

/** All valid keys (for validation in setMany) */
const ALL_KEYS = new Set([
  ...Object.keys(ENV_MAP),
  'openai_model',
  'auto_removal_enabled',
  'verify_removals_enabled',
  'removal_verify_days',
]);

/* ── Internal helpers ─────────────────────────────────────── */

function getDb() {
  try { return require('../db/database').getDb(); }
  catch { return null; }
}

function _readRow(db, key) {
  try {
    return db.prepare('SELECT value, is_encrypted, updated_at FROM system_settings WHERE key = ?').get(key);
  } catch { return null; }
}

function _encryptValue(value) {
  const { encrypt } = require('./crypto');
  return encrypt(String(value));
}

function _decryptValue(stored) {
  const { safeDecrypt } = require('./crypto');
  return safeDecrypt(stored);
}

/** Called after any write to reset downstream caches */
function _onChanged(key) {
  const emailKeys = new Set(['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from']);
  if (emailKeys.has(key)) {
    try {
      const em = require('./emailRemover');
      if (typeof em.resetTransporter === 'function') em.resetTransporter();
    } catch { /* emailRemover not loaded yet */ }
  }
}

/* ── Public API ───────────────────────────────────────────── */

/**
 * Get a single config value.
 * Returns string | null (never throws).
 */
function get(key) {
  const db = getDb();
  if (db) {
    const row = _readRow(db, key);
    if (row) {
      return row.is_encrypted ? (_decryptValue(row.value) || null) : row.value;
    }
  }

  // env var fallback
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) return process.env[envKey];

  // hard-coded default
  return DEFAULTS[key] || null;
}

/**
 * Persist a single setting.
 * Pass null, undefined, or '' to DELETE the row (reverts to env / default).
 */
function set(key, value) {
  if (!ALL_KEYS.has(key)) throw new Error(`Unknown config key: ${key}`);
  const db = getDb();
  if (!db) throw new Error('Database not initialised — call initDb() first');

  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM system_settings WHERE key = ?').run(key);
    _onChanged(key);
    return;
  }

  const isSensitive = SENSITIVE_KEYS.has(key);
  const stored      = isSensitive ? _encryptValue(value) : String(value);

  db.prepare(`
    INSERT INTO system_settings (key, value, is_encrypted, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE
      SET value        = excluded.value,
          is_encrypted = excluded.is_encrypted,
          updated_at   = excluded.updated_at
  `).run(key, stored, isSensitive ? 1 : 0);

  _onChanged(key);
}

/**
 * Persist multiple settings atomically.
 * Keys not present in ALL_KEYS are silently ignored.
 * Unknown keys raise an error.
 */
function setMany(obj) {
  const db = getDb();
  if (!db) throw new Error('Database not initialised — call initDb() first');

  db.transaction(() => {
    for (const [key, value] of Object.entries(obj)) {
      if (!ALL_KEYS.has(key)) continue; // skip unknown keys gracefully
      set(key, value);
    }
  })();
}

/**
 * Return a safe representation of all config for the admin UI.
 *
 * For sensitive keys the actual value is NEVER returned — only whether
 * it has been configured and from what source.
 *
 * Shape per key:
 * {
 *   configured:   boolean,
 *   source:       'db' | 'env' | 'default' | null,
 *   is_sensitive: boolean,
 *   updated_at:   number | null,   // unix timestamp, null if not in DB
 *   value:        string | null,   // null for sensitive keys
 * }
 */
function getPublicConfig() {
  const db = getDb();

  // Snapshot all DB rows once
  const dbRows = {};
  if (db) {
    try {
      const rows = db.prepare('SELECT key, is_encrypted, updated_at FROM system_settings').all();
      for (const r of rows) dbRows[r.key] = r;
    } catch { /* table may not exist yet on first boot */ }
  }

  const result = {};

  for (const key of ALL_KEYS) {
    const dbRow      = dbRows[key] || null;
    const envKey     = ENV_MAP[key];
    const hasEnv     = !!(envKey && process.env[envKey]);
    const hasDefault = !!DEFAULTS[key];
    const isSens     = SENSITIVE_KEYS.has(key);

    let source = null;
    if      (dbRow)      source = 'db';
    else if (hasEnv)     source = 'env';
    else if (hasDefault) source = 'default';

    result[key] = {
      configured:  !!(dbRow || hasEnv || hasDefault),
      source,
      is_sensitive: isSens,
      updated_at:  dbRow ? dbRow.updated_at : null,
      // For sensitive keys: indicate set/unset but never expose the value.
      // For normal keys: expose the resolved value.
      value: isSens
        ? ((dbRow || hasEnv) ? '••••••••' : null)
        : get(key),
    };
  }

  return result;
}

module.exports = { get, set, setMany, getPublicConfig, ALL_KEYS, SENSITIVE_KEYS };
