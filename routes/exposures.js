'use strict';

const router    = require('express').Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/* GET /api/exposures — list all for user (optionally filter by profile/status/priority) */
router.get('/', (req, res) => {
  const db   = getDb();
  const { profile_id, status, priority } = req.query;

  let sql  = `
    SELECT e.*, b.name as broker_name, b.url as broker_url, b.priority, b.method,
           b.automation, b.opt_out_url, b.instructions, b.contact_email
    FROM exposures e
    JOIN brokers b ON b.id = e.broker_id
    WHERE e.user_id = ?
  `;
  const args = [req.user.id];

  sql += " AND e.status != 'not_found'";

  if (profile_id)               { sql += ' AND e.profile_id = ?'; args.push(profile_id); }
  if (status)                   { sql += ' AND e.status = ?';     args.push(status); }
  if (priority)                 { sql += ' AND b.priority = ?';   args.push(priority); }
  if (req.query.hide_assumed)   { sql += " AND e.status != 'assumed'"; }

  sql += " ORDER BY CASE b.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, e.detected_at DESC";

  res.json(db.prepare(sql).all(...args));
});

/* GET /api/exposures/stats */
router.get('/stats', (req, res) => {
  const db = getDb();
  const uid = req.user.id;

  const total   = db.prepare("SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status NOT IN ('not_found')").get(uid).c;
  const sent    = db.prepare("SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status IN ('removal_sent','ai_email_sent')").get(uid).c;
  const done    = db.prepare("SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status = 'removal_confirmed'").get(uid).c;
  const manual  = db.prepare("SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status = 'manual_pending'").get(uid).c;
  const reexp   = db.prepare("SELECT COUNT(*) as c FROM exposures WHERE user_id = ? AND status = 're_exposed'").get(uid).c;
  const critical= db.prepare("SELECT COUNT(*) as c FROM exposures e JOIN brokers b ON b.id=e.broker_id WHERE e.user_id = ? AND b.priority='critical' AND e.status NOT IN ('not_found','removal_confirmed')").get(uid).c;
  const high    = db.prepare("SELECT COUNT(*) as c FROM exposures e JOIN brokers b ON b.id=e.broker_id WHERE e.user_id = ? AND b.priority='high' AND e.status NOT IN ('not_found','removal_confirmed')").get(uid).c;

  res.json({ total, sent, done, manual, re_exposed: reexp, critical, high });
});

/* GET /api/exposures/:id */
router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare(`
    SELECT e.*, b.name as broker_name, b.url as broker_url, b.priority, b.method,
           b.automation, b.opt_out_url, b.instructions, b.contact_email
    FROM exposures e JOIN brokers b ON b.id = e.broker_id
    WHERE e.id = ? AND e.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Exposure not found' });
  res.json(row);
});

/* PATCH /api/exposures/:id — update status or notes */
router.patch('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM exposures WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Exposure not found' });

  const { status, notes, profile_url } = req.body || {};
  const allowed = ['detected','assumed','removal_sent','ai_email_sent','removal_confirmed','manual_pending','re_exposed','not_found'];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare(`
    UPDATE exposures SET
      status       = COALESCE(?, status),
      notes        = COALESCE(?, notes),
      profile_url  = COALESCE(?, profile_url),
      last_updated = unixepoch()
    WHERE id = ?
  `).run(status || null, notes || null, profile_url || null, row.id);

  res.json({ ok: true });
});

/* DELETE /api/exposures/:id — dismiss */
router.delete('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM exposures WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Exposure not found' });
  db.prepare('DELETE FROM exposures WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
