'use strict';

/**
 * secrets.js — bootstrap cryptographic app secrets.
 *
 * Priority for each secret:
 *   1. process.env  (already set by an env var — takes precedence over everything)
 *   2. db_data/app-secrets.json  (persisted from a previous auto-generation)
 *   3. Auto-generate a fresh random value + save to db_data/app-secrets.json
 *
 * After bootstrap() returns, BOTH of these are guaranteed to be set:
 *   process.env.ENCRYPTION_KEY   — 64-char hex, 32-byte AES-256 key
 *   process.env.JWT_SECRET       — 96-char hex, 48-byte signing secret
 *
 * ⚠️  IMPORTANT — db_data/app-secrets.json is the source of truth when
 *     no env vars are set. Back it up alongside db_data/neodataremoval.db.
 *     Losing ENCRYPTION_KEY means ALL encrypted profile data is unrecoverable.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SECRETS_DIR  = path.join(__dirname, '..', 'db_data');
const SECRETS_FILE = path.join(SECRETS_DIR, 'app-secrets.json');

/* ── Internal helpers ──────────────────────────────────────── */

function loadPersistedSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    console.error('[Secrets] Could not parse app-secrets.json:', err.message);
  }
  return {};
}

function savePersistedSecrets(secrets) {
  if (!fs.existsSync(SECRETS_DIR)) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
  }
  try {
    fs.writeFileSync(
      SECRETS_FILE,
      JSON.stringify(secrets, null, 2),
      { encoding: 'utf8', mode: 0o600 }, // owner read/write only
    );
    console.log('[Secrets] Secrets saved to', SECRETS_FILE);
    console.warn(
      '[Secrets] ⚠️  Back up db_data/app-secrets.json alongside your database.\n' +
      '           Losing it means all encrypted profile data becomes unrecoverable.',
    );
  } catch (err) {
    // Non-fatal: secrets are in process.env for this session, but will be
    // regenerated on next restart if we couldn't persist them.
    console.error('[Secrets] Failed to write app-secrets.json:', err.message);
    console.error('[Secrets] Set ENCRYPTION_KEY and JWT_SECRET as env vars to avoid this.');
  }
}

function isValidHex(str, expectedLength) {
  return typeof str === 'string' && str.length === expectedLength && /^[0-9a-f]+$/i.test(str);
}

/* ── Public API ────────────────────────────────────────────── */

/**
 * Ensure process.env.ENCRYPTION_KEY and process.env.JWT_SECRET are set.
 * Call this once, as early as possible in server.js, before requiring any
 * module that reads from process.env (routes, middleware, db, crypto, etc.).
 */
function bootstrap() {
  const persisted = loadPersistedSecrets();
  let dirty = false;

  /* ── ENCRYPTION_KEY ─────────────────────────────────────── */

  if (process.env.ENCRYPTION_KEY) {
    // Env var is set — validate it and trust it
    if (!isValidHex(process.env.ENCRYPTION_KEY, 64)) {
      throw new Error(
        '[Secrets] ENCRYPTION_KEY must be a 64-character hex string (32 bytes).\n' +
        '          Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    // If the env-provided key differs from what's on disk, update the file
    // so they stay in sync (useful when deliberately rotating the key).
    if (persisted.ENCRYPTION_KEY !== process.env.ENCRYPTION_KEY) {
      persisted.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
      dirty = true;
    }
  } else if (isValidHex(persisted.ENCRYPTION_KEY, 64)) {
    // Load from file
    process.env.ENCRYPTION_KEY = persisted.ENCRYPTION_KEY;
    console.log('[Secrets] ENCRYPTION_KEY loaded from app-secrets.json');
  } else {
    // Generate fresh
    const key = crypto.randomBytes(32).toString('hex');
    process.env.ENCRYPTION_KEY  = key;
    persisted.ENCRYPTION_KEY    = key;
    dirty = true;
    console.log('[Secrets] Generated new ENCRYPTION_KEY');
  }

  /* ── JWT_SECRET ─────────────────────────────────────────── */

  const PLACEHOLDER = 'change_me';

  if (process.env.JWT_SECRET && process.env.JWT_SECRET !== PLACEHOLDER) {
    // Env var is set and not the insecure placeholder
    if (process.env.JWT_SECRET.length < 32) {
      console.warn(
        '[Secrets] JWT_SECRET is very short (< 32 chars). ' +
        'Use a long random string for production.',
      );
    }
    if (persisted.JWT_SECRET !== process.env.JWT_SECRET) {
      persisted.JWT_SECRET = process.env.JWT_SECRET;
      dirty = true;
    }
  } else if (
    typeof persisted.JWT_SECRET === 'string' &&
    persisted.JWT_SECRET.length >= 32
  ) {
    // Load from file
    process.env.JWT_SECRET = persisted.JWT_SECRET;
    console.log('[Secrets] JWT_SECRET loaded from app-secrets.json');
  } else {
    // Generate fresh — 48 bytes = 96-char hex, well above any brute-force threshold
    const secret = crypto.randomBytes(48).toString('hex');
    process.env.JWT_SECRET  = secret;
    persisted.JWT_SECRET    = secret;
    dirty = true;
    console.log('[Secrets] Generated new JWT_SECRET');
  }

  /* ── Persist if anything changed ──────────────────────────── */

  if (dirty) {
    savePersistedSecrets(persisted);
  }
}

/**
 * Print a summary of where each secret came from.
 * Called by server.js after bootstrap() for visibility in logs.
 */
function printStatus() {
  const encSource = fs.existsSync(SECRETS_FILE) ? 'app-secrets.json / env' : 'env';
  console.log(
    `[Secrets] ENCRYPTION_KEY ✓  JWT_SECRET ✓  (source: ${encSource})`,
  );
}

module.exports = { bootstrap, printStatus };
