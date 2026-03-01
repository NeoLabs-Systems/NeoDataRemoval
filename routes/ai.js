'use strict';

const express  = require('express');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');

// POST /api/ai/draft-removal
// Body: { exposure_id }
// Returns: { draft: string } — opt-out email body
router.post('/draft-removal', requireAuth, async (req, res) => {
  const { exposure_id } = req.body;
  if (!exposure_id) return res.status(400).json({ error: 'exposure_id required' });

  const db       = require('../db/database').getDb();
  const exposure = db.prepare(
    `SELECT e.*, b.name AS broker_name, b.url AS broker_url
     FROM exposures e JOIN brokers b ON b.id = e.broker_id
     WHERE e.id = ? AND e.user_id = ?`
  ).get(exposure_id, req.user.id);
  if (!exposure) return res.status(404).json({ error: 'Exposure not found' });

  const profile  = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(exposure.profile_id, req.user.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Decrypt profile data
  const { safeDecrypt } = require('../services/crypto');
  let profileData = {};
  try { profileData = JSON.parse(safeDecrypt(profile.data_enc) || '{}'); } catch {}

  try {
    const { draftRemovalEmail } = require('../services/aiHelper');
    const draft = await draftRemovalEmail(exposure.broker_name, profileData, exposure.broker_url, req.user.id);
    if (!draft) return res.status(503).json({ error: 'AI unavailable — no API key or call failed' });
    res.json({ draft });
  } catch (err) {
    console.error('[ai] draftRemovalEmail error:', err);
    res.status(500).json({ error: 'AI draft failed' });
  }
});

module.exports = router;
