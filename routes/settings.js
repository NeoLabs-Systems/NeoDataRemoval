'use strict';

const express  = require('express');
const router   = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

const DEFAULTS = {
  scan_delay_ms:          2000,
  auto_rescan:            true,
  notify_on_exposure:     false,
  notify_on_removal:      false,
  ai_draft_opt_in:        false,
  theme:                  'dark',
};

function getDb() { return require('../db/database').getDb(); }

function getUserSettings(userId) {
  const db  = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, 'prefs');
  if (!row) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(row.value) }; } catch { return { ...DEFAULTS }; }
}

// GET /api/settings
router.get('/', requireAuth, (req, res) => {
  res.json(getUserSettings(req.user.id));
});

// PUT /api/settings
router.put('/', requireAuth, (req, res) => {
  const db      = getDb();
  const current = getUserSettings(req.user.id);
  const allowed = Object.keys(DEFAULTS);
  const update  = {};
  for (const k of allowed) {
    if (!(k in req.body)) continue;
    const v = req.body[k];
    if (k === 'scan_delay_ms') {
      const n = parseInt(v);
      if (isNaN(n)) continue;
      update[k] = Math.min(Math.max(500, n), 60000);  // 0.5 s – 60 s
    } else if (k === 'theme') {
      if (!['dark','light'].includes(v)) continue;
      update[k] = v;
    } else if (typeof DEFAULTS[k] === 'boolean') {
      update[k] = Boolean(v);
    } else {
      update[k] = v;
    }
  }
  const merged = { ...current, ...update };
  db.prepare(`INSERT INTO settings (user_id, key, value, updated_at)
              VALUES (?, 'prefs', ?, datetime('now'))
              ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(req.user.id, JSON.stringify(merged));
  res.json(merged);
});

// GET /api/settings/admin — global system settings (admin only)
// Returns environment-level info since global settings are .env-configured
router.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.json({
    admin_registration: process.env.ADMIN_REGISTRATION || 'open',
    port:               process.env.PORT || 3000,
    smtp_configured:    !!(process.env.SMTP_HOST),
    openai_configured:  !!(process.env.OPENAI_API_KEY),
    node_env:           process.env.NODE_ENV || 'development',
  });
});

module.exports = router;
