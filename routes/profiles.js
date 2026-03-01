'use strict';

const router  = require('express').Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { encrypt, safeDecrypt } = require('../services/crypto');

router.use(requireAuth);

function decodeProfile(row) {
  const raw = safeDecrypt(row.data_enc);
  const data = raw ? JSON.parse(raw) : {};
  return { id: row.id, label: row.label, name: row.label, created_at: row.created_at, updated_at: row.updated_at, ...data };
}

/* GET /api/profiles */
router.get('/', (req, res) => {
  const db   = getDb();
  const rows = db.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC').all(req.user.id);
  res.json(rows.map(decodeProfile));
});

/* GET /api/profiles/:id */
router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });
  res.json(decodeProfile(row));
});

/* POST /api/profiles */
router.post('/', (req, res) => {
  const { label, full_name, aliases, dob, addresses, phones, emails } = req.body || {};
  if (!full_name) return res.status(400).json({ error: 'full_name is required' });
  const profileLabel = (label || full_name).trim();

  const data    = { full_name, aliases: aliases || [], dob: dob || '', addresses: addresses || [], phones: phones || [], emails: emails || [] };
  const enc     = encrypt(JSON.stringify(data));
  const db      = getDb();
  const result  = db.prepare('INSERT INTO profiles (user_id, label, data_enc) VALUES (?, ?, ?)').run(req.user.id, profileLabel, enc);

  res.status(201).json({ id: result.lastInsertRowid, label: profileLabel, name: profileLabel, ...data });
});

/* PUT /api/profiles/:id */
router.put('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });

  const oldData    = safeDecrypt(row.data_enc) ? JSON.parse(safeDecrypt(row.data_enc)) : {};
  const { label, full_name, aliases, dob, addresses, phones, emails } = req.body || {};
  const newData = {
    full_name: full_name  || oldData.full_name,
    aliases:   aliases    ?? oldData.aliases,
    dob:       dob        ?? oldData.dob,
    addresses: addresses  ?? oldData.addresses,
    phones:    phones     ?? oldData.phones,
    emails:    emails     ?? oldData.emails,
  };

  const enc = encrypt(JSON.stringify(newData));
  db.prepare(
    'UPDATE profiles SET label = ?, data_enc = ?, updated_at = unixepoch() WHERE id = ?'
  ).run(label ? label.trim() : row.label, enc, row.id);

  res.json({ id: row.id, label: label ? label.trim() : row.label, ...newData });
});

/* DELETE /api/profiles/:id */
router.delete('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM profiles WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Profile not found' });
  db.prepare('DELETE FROM profiles WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
