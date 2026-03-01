'use strict';

const { getDb }       = require('../db/database');
const { safeDecrypt } = require('./crypto');

const DELAY_MS  = parseInt(process.env.SCAN_DELAY_MS) || 2000;
const UA        = 'Mozilla/5.0 (compatible; PrivacyBot/1.0; +https://github.com/neo/neodataremoval)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Build a plain-text search query from profile data */
function buildQuery(profile) {
  const parts = [profile.full_name];
  if (profile.addresses && profile.addresses.length > 0) {
    const addr = profile.addresses[0];
    if (addr.city)  parts.push(addr.city);
    if (addr.state) parts.push(addr.state);
  }
  return parts.join(' ');
}

/* Normalize name for fuzzy matching */
function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
}

/* Check if response HTML likely contains the person's info */
function detectPresence(html, profile) {
  if (!html) return false;
  const lowerHtml  = html.toLowerCase();
  const nameParts  = normalizeName(profile.full_name).split(/\s+/);

  // First + last name both appearing near each other
  const namePresent = nameParts.length >= 2 && nameParts.every(p => p.length > 1 && lowerHtml.includes(p));
  if (!namePresent) return false;

  // Corroborate with phone, email, or address
  const phones = profile.phones || [];
  const emails = profile.emails || [];
  const addresses = profile.addresses || [];

  for (const ph of phones) {
    const digits = (ph.number || ph).replace(/\D/g, '');
    if (digits.length >= 7 && lowerHtml.includes(digits.slice(-7))) return true;
  }
  for (const em of emails) {
    const e = (em.address || em || '').toLowerCase();
    if (e && lowerHtml.includes(e)) return true;
  }
  for (const ad of addresses) {
    const city = (ad.city || '').toLowerCase();
    if (city && lowerHtml.includes(city)) return true;
  }

  // Fallback: just name + age proximity
  if (profile.dob) {
    const year  = profile.dob.split('-')[0];
    const age   = new Date().getFullYear() - parseInt(year);
    if (age > 0 && lowerHtml.includes(String(age))) return true;
  }

  return namePresent; // name alone considered a weak match
}

/* Validate that a URL uses only http/https */
function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/* Try to extract personal profile URL from HTML */
function extractProfileUrl(html, brokerUrl) {
  if (!html) return null;
  // Look for links containing "profile", "people", "person" etc.
  const patterns = [
    /href="(https?:\/\/[^"]+\/(?:profile|people|person|record)\/[^"]{5,})"/i,
    /href="(https?:\/\/[^"]+\/[a-z]+-[a-z]+(?:\/[\w-]+)+)"/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && isSafeUrl(m[1])) return m[1];
  }
  return null;
}

/* Perform a single broker scan for a profile */
async function scanBroker(broker, profile) {
  // Passive brokers — we cannot search them publicly, assume present and request removal
  if (broker.automation === 'assumes_present') {
    return { status: 'assumed', profile_url: null };
  }

  const query      = encodeURIComponent(buildQuery(profile));
  const searchUrl  = broker.search_url_template
    ? broker.search_url_template.replace('{query}', query)
    : `${broker.url}search?q=${query}`;

  // SSRF guard — only allow http/https
  if (!isSafeUrl(searchUrl)) {
    return { status: 'error', error: 'Invalid broker URL scheme' };
  }

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      if (resp.status === 404) return { status: 'not_found', profile_url: null };
      return { status: 'error', error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    const found = detectPresence(html, profile);
    const profileUrl = found ? extractProfileUrl(html, broker.url) : null;

    return { status: found ? 'detected' : 'not_found', profile_url: profileUrl };
  } catch (err) {
    if (err.name === 'AbortError') return { status: 'error', error: 'Timeout' };
    return { status: 'error', error: err.message };
  }
}

/**
 * Run a full scan for a profile.
 * Updates DB in real time; calls onProgress(done, total, brokerName, status) for SSE.
 */
async function runScan(scanId, profileId, userId, onProgress) {
  const db = getDb();

  // Decrypt profile
  const profileRow = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(profileId, userId);
  if (!profileRow) throw new Error('Profile not found');

  const raw     = safeDecrypt(profileRow.data_enc);
  const profile = raw ? JSON.parse(raw) : {};

  // Get enabled brokers
  const brokers = db.prepare("SELECT * FROM brokers WHERE enabled = 1 ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END").all();

  db.prepare('UPDATE scans SET total_checked = ? WHERE id = ?').run(brokers.length, scanId);

  let done  = 0;
  let found = 0;

  for (const broker of brokers) {
    await sleep(DELAY_MS);

    // Check if we already have a recent exposure that is still active
    const existing = db.prepare(`
      SELECT id, status FROM exposures
      WHERE profile_id = ? AND broker_id = ? AND status NOT IN ('not_found', 'removal_confirmed')
    `).get(profileId, broker.id);

    let result;
    if (existing) {
      // Skip re-scan if already tracked and not yet resolved
      result = { status: existing.status, profile_url: null };
    } else {
      result = await scanBroker(broker, profile);
    }

    done++;

    if (result.status === 'detected' || result.status === 'assumed') {
      found++;

      if (!existing) {
        db.prepare(`
          INSERT INTO exposures (profile_id, user_id, broker_id, scan_id, status, profile_url)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(profileId, userId, broker.id, scanId, result.status === 'assumed' ? 'assumed' : 'detected', result.profile_url || null);
      }
    } else if (result.status === 'not_found' && !existing) {
      // Record not_found so we don't re-scan too soon
      db.prepare(`
        INSERT INTO exposures (profile_id, user_id, broker_id, scan_id, status)
        VALUES (?, ?, ?, ?, 'not_found')
      `).run(profileId, userId, broker.id, scanId);
    }

    db.prepare('UPDATE scans SET total_checked = ?, found = ? WHERE id = ?').run(done, found, scanId);

    if (onProgress) onProgress(done, brokers.length, broker.name, result.status);
  }

  db.prepare("UPDATE scans SET status = 'done', completed_at = unixepoch() WHERE id = ?").run(scanId);
  return { total: brokers.length, found };
}

module.exports = { runScan };
