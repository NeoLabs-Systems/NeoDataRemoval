'use strict';

const router  = require('express').Router();
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

/* GET /api/brokers  — paginated, filterable */
router.get('/', (req, res) => {
  const db = getDb();
  const { priority, method, enabled, q } = req.query;
  let sql    = 'SELECT * FROM brokers WHERE 1=1';
  const args = [];

  if (priority) { sql += ' AND priority = ?'; args.push(priority); }
  if (method)   { sql += ' AND method = ?';   args.push(method); }
  if (enabled !== undefined) { sql += ' AND enabled = ?'; args.push(enabled === 'true' ? 1 : 0); }
  if (q)        { sql += ' AND (name LIKE ? OR url LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }

  sql += " ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, name ASC LIMIT 1000";

  const rows = db.prepare(sql).all(...args);
  res.json(rows);
});

/* GET /api/brokers/:id */
router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM brokers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Broker not found' });
  res.json(row);
});

/* Validate that a URL uses only http/https — used for broker url fields */
function isSafeUrl(urlStr) {
  if (!urlStr) return true; // optional fields are allowed to be null/undefined
  try {
    const u = new URL(urlStr);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/* POST /api/brokers — admin only */
router.post('/', requireAdmin, (req, res) => {
  const { name, url, opt_out_url, method, priority, automation, contact_email, instructions, rescan_days } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'url must use http or https' });
  if (!isSafeUrl(opt_out_url)) return res.status(400).json({ error: 'opt_out_url must use http or https' });

  const db     = getDb();
  const result = db.prepare(`
    INSERT INTO brokers (name, url, opt_out_url, method, priority, automation, contact_email, instructions, rescan_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, url, opt_out_url || null, method || 'manual', priority || 'standard',
         automation || 'manual', contact_email || null, instructions || null, rescan_days || 60);

  res.status(201).json({ id: result.lastInsertRowid, name, url });
});

/* PUT /api/brokers/:id — admin only */
router.put('/:id', requireAdmin, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM brokers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Broker not found' });

  const { name, url, opt_out_url, method, priority, automation, contact_email, instructions, rescan_days, enabled } = req.body || {};
  if (url !== undefined && !isSafeUrl(url)) return res.status(400).json({ error: 'url must use http or https' });
  if (opt_out_url !== undefined && !isSafeUrl(opt_out_url)) return res.status(400).json({ error: 'opt_out_url must use http or https' });
  db.prepare(`
    UPDATE brokers SET
      name = ?, url = ?, opt_out_url = ?, method = ?, priority = ?,
      automation = ?, contact_email = ?, instructions = ?, rescan_days = ?, enabled = ?
    WHERE id = ?
  `).run(
    name ?? row.name, url ?? row.url, opt_out_url ?? row.opt_out_url,
    method ?? row.method, priority ?? row.priority, automation ?? row.automation,
    contact_email ?? row.contact_email, instructions ?? row.instructions,
    rescan_days ?? row.rescan_days, enabled !== undefined ? (enabled ? 1 : 0) : row.enabled,
    row.id
  );

  res.json({ ok: true });
});

/* DELETE /api/brokers/:id — admin only */
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM brokers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
