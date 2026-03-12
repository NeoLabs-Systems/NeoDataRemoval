'use strict';

const express  = require('express');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');
const { enrichExposure, resolveBroker }  = require('../services/brokerCatalog');
const { sendRemoval }  = require('../services/remover');
const ACTIONABLE_EXPOSURE_STATUSES = new Set(['detected', 'assumed', 're_exposed']);

// POST /api/removals/:exposureId  — trigger a removal attempt
router.post('/:exposureId', requireAuth, async (req, res) => {
  const useAi    = req.body && req.body.use_ai === true;
  const draftBody = (req.body && req.body.draft_body) || null;
  try {
    const result = await sendRemoval(req.params.exposureId, req.user.id, useAi, draftBody);
    if (!result.success) return res.status(400).json({ error: result.notes });
    res.json({ ok: true, method: result.method, notes: result.notes });
  } catch (err) {
    console.error('[removals] sendRemoval error:', err);
    const statusCode = err.message === 'Removal is only available for active exposures.' ? 400 : 500;
    res.status(statusCode).json({ error: statusCode === 400 ? err.message : 'Internal server error' });
  }
});

// GET /api/removals  — list removal requests for current user
router.get('/', requireAuth, (req, res) => {
  const db     = require('../db/database').getDb();
  const { status, profile_id, limit = 100, offset = 0 } = req.query;
  const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 100), 500);
  const safeOffset = Math.max(0, parseInt(offset) || 0);
  let sql    = `SELECT rr.*, e.profile_url
                FROM removal_requests rr
                JOIN exposures e ON e.id = rr.exposure_id
                WHERE rr.user_id = ?`;
  const args = [req.user.id];
  if (status)     { sql += ' AND rr.status = ?';     args.push(status); }
  if (profile_id) { sql += ' AND e.profile_id = ?';  args.push(profile_id); }
  sql += ` ORDER BY rr.sent_at DESC LIMIT ? OFFSET ?`;
  args.push(safeLimit, safeOffset);
  const rows = db.prepare(sql).all(...args).map((row) => {
    const broker = resolveBroker(row);
    return {
      ...row,
      broker_name: broker ? broker.name : 'Unknown Broker',
    };
  });
  res.json(rows);
});

// GET /api/removals/stats  — summary counts
router.get('/stats', requireAuth, (req, res) => {
  const db = require('../db/database').getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*)                                    AS total,
      SUM(CASE WHEN status='sent'      THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='manual'    THEN 1 ELSE 0 END) AS manual
    FROM removal_requests WHERE user_id = ?`).get(req.user.id);
  res.json(row);
});

// GET /api/removals/:id — single request
router.get('/:id', requireAuth, (req, res) => {
  const db = require('../db/database').getDb();
  const row = db.prepare(`SELECT rr.*
                           FROM removal_requests rr
                           WHERE rr.id = ? AND rr.user_id = ?`)
               .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const broker = resolveBroker(row);
  res.json({ ...row, broker_name: broker ? broker.name : 'Unknown Broker' });
});

// GET /api/removals/:exposureId/draft — generate AI draft without sending
router.get('/:exposureId/draft', requireAuth, async (req, res) => {
  const useAi = req.query.ai !== '0';
  const db = require('../db/database').getDb();
  const { safeDecrypt } = require('../services/crypto');

  const exposureRow = db.prepare(`
    SELECT e.*
    FROM exposures e
    WHERE e.id = ? AND e.user_id = ?
  `).get(req.params.exposureId, req.user.id);

  const exposure = exposureRow ? enrichExposure(exposureRow) : null;

  if (!exposure) return res.status(404).json({ error: 'Exposure not found' });
  if (!ACTIONABLE_EXPOSURE_STATUSES.has(exposure.status)) {
    return res.status(400).json({ error: 'Removal draft is only available for active exposures.' });
  }

  const row = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(exposure.profile_id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });
  const raw = safeDecrypt(row.data_enc);
  if (!raw) return res.status(400).json({ error: 'Profile decryption failed' });
  const profile = JSON.parse(raw);

  const brokerName = exposure.broker_name;
  const subject    = `Data Removal Request \u2014 ${brokerName}`;

  let body = null;
  try {
    if (useAi) {
      const { draftRemovalEmail } = require('../services/aiHelper');
      body = await draftRemovalEmail(brokerName, profile, exposure.broker_url, req.user.id);
    }
  } catch (e) { console.error('[draft]', e.message); }

  if (!body) {
    const { buildEmailBody } = require('../services/emailRemover');
    body = buildEmailBody(brokerName, profile, null);
  }

  res.json({ to: exposure.contact_email || null, subject, body });
});

module.exports = router;
