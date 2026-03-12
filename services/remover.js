'use strict';

const { getDb }       = require('../db/database');
const { enrichExposure } = require('./brokerCatalog');
const { safeDecrypt } = require('./crypto');
const emailRemover    = require('./emailRemover');

const UA = 'Mozilla/5.0 (compatible; PrivacyBot/1.0)';
const ACTIONABLE_EXPOSURE_STATUSES = new Set(['detected', 'assumed', 're_exposed']);

/* Build a flat profile object from DB row */
function getProfile(profileId, userId) {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(profileId, userId);
  if (!row) return null;
  const raw = safeDecrypt(row.data_enc);
  return raw ? JSON.parse(raw) : null;
}

/* Attempt automated form-based opt-out */
function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

async function formRemoval(broker, profile) {
  if (!broker.opt_out_url) return { success: false, method: 'form', notes: 'No opt-out URL configured' };
  if (!isSafeUrl(broker.opt_out_url)) return { success: false, method: 'form', notes: 'Invalid opt-out URL scheme' };

  const email   = profile.emails && profile.emails.length > 0 ? (profile.emails[0].address || profile.emails[0]) : '';
  const phone   = profile.phones && profile.phones.length > 0 ? (profile.phones[0].number  || profile.phones[0]) : '';
  const address = profile.addresses && profile.addresses.length > 0 ? profile.addresses[0] : {};

  const body = new URLSearchParams({
    name:       profile.full_name || '',
    first_name: (profile.full_name || '').split(' ')[0] || '',
    last_name:  (profile.full_name || '').split(' ').slice(-1)[0] || '',
    email:      email,
    phone:      phone,
    address:    [address.street, address.city, address.state].filter(Boolean).join(', '),
    city:       address.city || '',
    state:      address.state || '',
    zip:        address.zip || '',
  });

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(broker.opt_out_url, {
      method: 'POST',
      headers: {
        'User-Agent':   UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'text/html,application/json',
        'Referer':      broker.url,
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const respText = await resp.text().catch(() => '');
    const success  = resp.ok || resp.status === 302;

    return {
      success,
      method: 'form',
      response_status: resp.status,
      response_body: respText.slice(0, 500),
      notes: success ? 'Form submitted successfully' : `Form failed: HTTP ${resp.status}`,
    };
  } catch (err) {
    return { success: false, method: 'form', notes: err.message };
  }
}

/* Send email-based opt-out */
async function sendEmailRemoval(broker, profile, aiDraft) {
  if (!broker.contact_email) return { success: false, method: 'email', notes: 'No contact email configured' };

  const result = await emailRemover.sendOptOutEmail(broker, profile, aiDraft);
  return { ...result, method: aiDraft ? 'ai-email' : 'email' };
}

/* Main dispatch: choose removal method based on broker config */
async function sendRemoval(exposureId, userId, useAi, draftBody = null) {
  const db = getDb();

  const exposureRow = db.prepare(`
    SELECT e.*
    FROM exposures e
    WHERE e.id = ? AND e.user_id = ?
  `).get(exposureId, userId);

  const exposure = exposureRow ? enrichExposure(exposureRow) : null;

  if (!exposure) throw new Error('Exposure not found');
  if (!ACTIONABLE_EXPOSURE_STATUSES.has(exposure.status)) {
    throw new Error('Removal is only available for active exposures.');
  }

  const profile = getProfile(exposure.profile_id, userId);
  if (!profile)  throw new Error('Profile not found or decryption failed');

  let result;

  if (exposure.automation === 'http_form' && exposure.opt_out_url) {
    result = await formRemoval(exposure, profile);
  } else if (exposure.method === 'email' || exposure.contact_email) {
    let aiDraft = draftBody || null;
    if (!aiDraft && useAi) {
      try {
        const { draftRemovalEmail } = require('./aiHelper');
        aiDraft = await draftRemovalEmail(exposure.broker_name, profile, exposure.broker_url, userId);
      } catch {}
    }
    result = await sendEmailRemoval(exposure, profile, aiDraft);
  } else {
    // Manual — just mark it as manual_pending
    result = { success: false, method: 'manual', notes: 'Manual removal required — see instructions' };
  }

  // Log removal request
  const reqResult = db.prepare(`
    INSERT INTO removal_requests (exposure_id, user_id, broker_id, method, status, response_status, response_body, success, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    exposureId,
    userId,
    exposure.broker_id || null,
    result.method,
    result.success ? 'sent' : (result.method === 'manual' ? 'manual' : 'failed'),
    result.response_status || null,
    result.response_body   || null,
    result.success ? 1 : 0,
    result.notes   || null,
  );
  db.prepare("UPDATE removal_requests SET broker_key = ? WHERE id = ?").run(
    exposure.broker_key || null,
    reqResult.lastInsertRowid,
  );

  // Update exposure status
  let newStatus;
  if (result.success && result.method === 'form')       newStatus = 'removal_sent';
  else if (result.success && result.method.includes('email')) newStatus = 'removal_sent';
  else if (result.method === 'manual')                  newStatus = 'manual_pending';
  else newStatus = 'removal_sent'; // optimistic even if unsure

  db.prepare("UPDATE exposures SET status = ?, last_updated = unixepoch() WHERE id = ?").run(newStatus, exposureId);

  return { ...result, request_id: reqResult.lastInsertRowid, new_status: newStatus };
}

module.exports = { sendRemoval };
