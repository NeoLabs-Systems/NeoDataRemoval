'use strict';

const crypto = require('crypto');

function cacheKey(brokerName, fullName, userId) {
  return crypto.createHash('sha256').update(`${userId}:${brokerName}|${fullName}`).digest('hex');
}

async function draftRemovalEmail(brokerName, profile, brokerUrl, userId) {
  const db      = require('../db/database').getDb();
  const key     = cacheKey(brokerName, profile.full_name || '', userId || 0);
  const cached  = db.prepare('SELECT content, created_at FROM ai_cache WHERE cache_key = ?').get(key);
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  if (cached && Date.now() - new Date(cached.created_at).getTime() < thirtyDaysMs) {
    return cached.content;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  let OpenAI;
  try { OpenAI = require('openai'); } catch { return null; }

  const openai = new OpenAI({ apiKey });

  const name    = profile.full_name || 'Unknown';
  const address = profile.addresses && profile.addresses[0];
  const addrStr = address ? [address.street, address.city, address.state].filter(Boolean).join(', ') : '';

  const prompt = `Write a concise, professional GDPR/CCPA data removal request email to the data broker "${brokerName}" (${brokerUrl || ''}).
Subject: Data Removal Request.
For the individual: ${name}${addrStr ? `, ${addrStr}` : ''}.
Keep it under 200 words. Be direct. Request deletion of all records, no re-adding, written confirmation. Sign as ${name}.`;

  let draft = null;
  try {
    const resp = await openai.chat.completions.create({
      model:                  'gpt-5-mini',
      max_completion_tokens:  400,
      messages:               [{ role: 'user', content: prompt }],
    });
    draft = resp.choices[0].message.content.trim();
  } catch (err) {
    console.error('[AI] OpenAI call failed:', err.message);
    return null;
  }

  if (draft) {
    db.prepare(`INSERT INTO ai_cache (cache_key, content, created_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content, created_at=excluded.created_at`)
      .run(key, draft);
  }
  return draft;
}

module.exports = { draftRemovalEmail };
