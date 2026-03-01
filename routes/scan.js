'use strict';

const router    = require('express').Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { runScan }     = require('../services/scanner');

router.use(requireAuth);

/* POST /api/scan/:profileId — start a scan */
router.post('/:profileId', async (req, res) => {
  const db = getDb();

  // Check profile belongs to user
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ? AND user_id = ?').get(req.params.profileId, req.user.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Check no running scan for this profile
  const running = db.prepare("SELECT id FROM scans WHERE profile_id = ? AND status = 'running'").get(profile.id);
  if (running) return res.status(409).json({ error: 'Scan already in progress', scan_id: running.id });

  const result = db.prepare(
    'INSERT INTO scans (profile_id, user_id) VALUES (?, ?)'
  ).run(profile.id, req.user.id);

  const scanId = result.lastInsertRowid;

  // Run scan in background — respond immediately with scan_id
  res.status(202).json({ scan_id: scanId, message: 'Scan started' });

  // Fire and forget
  runScan(scanId, profile.id, req.user.id, null).catch(err => {
    console.error('Scan error:', err);
    db.prepare("UPDATE scans SET status = 'error', error_msg = ?, completed_at = unixepoch() WHERE id = ?")
      .run(err.message, scanId);
  });
});

/* GET /api/scan/:scanId/status */
router.get('/:scanId/status', (req, res) => {
  const db   = getDb();
  const scan = db.prepare('SELECT * FROM scans WHERE id = ? AND user_id = ?').get(req.params.scanId, req.user.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

/* GET /api/scan/:scanId/stream — SSE progress stream */
router.get('/:scanId/stream', (req, res) => {
  const db   = getDb();
  const scan = db.prepare('SELECT * FROM scans WHERE id = ? AND user_id = ?').get(req.params.scanId, req.user.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const interval = setInterval(() => {
    const s = db.prepare('SELECT * FROM scans WHERE id = ?').get(scan.id);
    if (!s) { clearInterval(interval); res.end(); return; }

    res.write(`data: ${JSON.stringify(s)}\n\n`);

    if (s.status !== 'running') {
      clearInterval(interval);
      setTimeout(() => res.end(), 500);
    }
  }, 800);

  const MAX_SSE_MS = 45 * 60 * 1000; // 45 minutes — safety cap
  const maxTimer = setTimeout(() => { clearInterval(interval); res.end(); }, MAX_SSE_MS);

  req.on('close', () => { clearInterval(interval); clearTimeout(maxTimer); });
});

/* GET /api/scan/history — list scans for user */
router.get('/history/all', (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT s.*, p.label as profile_label
    FROM scans s
    JOIN profiles p ON p.id = s.profile_id
    WHERE s.user_id = ?
    ORDER BY s.started_at DESC
    LIMIT 50
  `).all(req.user.id);
  res.json(rows);
});

module.exports = router;
