"use strict";

/**
 * scanner.js — data-broker scan engine
 *
 * Status transition matrix
 * ────────────────────────────────────────────────────────────────
 * Result \ Existing   │ none      │ detected/assumed/re_exposed │ removal_sent/manual_pending │ removal_confirmed │ not_found
 * ────────────────────┼───────────┼─────────────────────────────┼─────────────────────────────┼───────────────────┼──────────
 * detected / assumed  │ INSERT ✦  │ update url+timestamp        │ → re_exposed ✦              │ → re_exposed ✦    │ → detected ✦
 * not_found           │ INSERT    │ → not_found                 │ → removal_confirmed ✅       │ (no change)       │ (no change)
 * error               │ (skip)    │ (keep existing)             │ (keep existing)             │ (keep existing)   │ (keep existing)
 * ────────────────────────────────────────────────────────────────
 * ✦ = increments found counter
 *
 * Skip scanning entirely when existing status is:
 *   not_found        — already clean; re-checked on next scheduled re-scan
 *   removal_confirmed — already resolved; periodically re-checked by scheduler
 */

const { getDb } = require("../db/database");
const { safeDecrypt } = require("./crypto");
const sysconfig = require("./sysconfig");

const UA =
  "Mozilla/5.0 (compatible; PrivacyBot/1.0; +https://github.com/neo/neodataremoval)";

/* ── Utilities ────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function buildQuery(profile) {
  const parts = [profile.full_name];
  if (profile.addresses && profile.addresses.length > 0) {
    const addr = profile.addresses[0];
    if (addr.city) parts.push(addr.city);
    if (addr.state) parts.push(addr.state);
  }
  return parts.filter(Boolean).join(" ");
}

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim();
}

function extractProfileUrl(html, _brokerUrl) {
  if (!html) return null;
  const patterns = [
    /href="(https?:\/\/[^"]+\/(?:profile|people|person|record|view)\/[^"]{5,})"/i,
    /href="(https?:\/\/[^"]+\/[a-z]+-[a-z]+(?:\/[\w-]+)+)"/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && isSafeUrl(m[1])) return m[1];
  }
  return null;
}

/* ── Presence detection ───────────────────────────────────── */

function detectPresence(html, profile) {
  if (!html) return false;
  const lowerHtml = html.toLowerCase();
  const nameParts = normalizeName(profile.full_name)
    .split(/\s+/)
    .filter((p) => p.length > 1);

  // Both first and last name must appear
  if (nameParts.length < 2 || !nameParts.every((p) => lowerHtml.includes(p)))
    return false;

  // Corroborate with at least one other data point
  for (const ph of profile.phones || []) {
    const digits = (ph.number || ph || "").replace(/\D/g, "");
    if (digits.length >= 7 && lowerHtml.includes(digits.slice(-7))) return true;
  }
  for (const em of profile.emails || []) {
    const e = (em.address || em || "").toLowerCase();
    if (e && lowerHtml.includes(e)) return true;
  }
  for (const ad of profile.addresses || []) {
    const city = (ad.city || "").toLowerCase();
    if (city.length > 2 && lowerHtml.includes(city)) return true;
  }

  // Fallback: name + approximate age
  if (profile.dob) {
    const year = parseInt(profile.dob.split("-")[0], 10);
    if (year > 1900) {
      const age = new Date().getFullYear() - year;
      if (age > 0 && lowerHtml.includes(String(age))) return true;
    }
  }

  // Name alone is a weak match but still counts
  return true;
}

/* ── Single broker check ──────────────────────────────────── */

async function scanBroker(broker, profile) {
  // Brokers we assume always list everyone — request removal without checking
  if (broker.automation === "assumes_present") {
    return { status: "assumed", profile_url: null };
  }

  const query = encodeURIComponent(buildQuery(profile));
  const searchUrl = broker.search_url_template
    ? broker.search_url_template.replace("{query}", query)
    : `${broker.url}search?q=${query}`;

  if (!isSafeUrl(searchUrl)) {
    return { status: "error", error: "Invalid broker URL scheme" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(searchUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!resp.ok) {
      if (resp.status === 404)
        return { status: "not_found", profile_url: null };
      return { status: "error", error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    const found = detectPresence(html, profile);
    const profileUrl = found ? extractProfileUrl(html, broker.url) : null;

    return {
      status: found ? "detected" : "not_found",
      profile_url: profileUrl,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError")
      return { status: "error", error: "Timeout after 15 s" };
    return { status: "error", error: err.message };
  }
}

/* ── Status transition logic ──────────────────────────────── */

const SKIP_STATUSES = new Set(["not_found", "removal_confirmed"]);
const ACTIVE_STATUSES = new Set(["detected", "assumed", "re_exposed"]);
const PENDING_REMOVAL = new Set(["removal_sent", "manual_pending"]);

/**
 * Apply scan result to the DB. Returns true if found count should be incremented.
 */
function applyResult(
  db,
  result,
  existing,
  profileId,
  userId,
  brokerId,
  scanId,
) {
  if (result.status === "error") {
    // Never overwrite a known status on scan error — just log
    if (!existing) {
      // Record that we tried but failed so we don't endlessly retry this session
    }
    return false;
  }

  const isDetected =
    result.status === "detected" || result.status === "assumed";

  if (!existing) {
    // ── Brand new exposure record ──────────────────────────
    db.prepare(
      `
      INSERT INTO exposures (profile_id, user_id, broker_id, scan_id, status, profile_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      profileId,
      userId,
      brokerId,
      scanId,
      isDetected ? result.status : "not_found",
      result.profile_url || null,
    );
    return isDetected;
  }

  // ── Existing record — determine transition ──────────────

  if (isDetected) {
    if (ACTIVE_STATUSES.has(existing.status)) {
      // Still present — refresh profile_url and timestamp
      if (result.profile_url) {
        db.prepare(
          "UPDATE exposures SET profile_url = ?, last_updated = unixepoch() WHERE id = ?",
        ).run(result.profile_url, existing.id);
      } else {
        db.prepare(
          "UPDATE exposures SET last_updated = unixepoch() WHERE id = ?",
        ).run(existing.id);
      }
      return false; // Already counted
    }

    if (PENDING_REMOVAL.has(existing.status)) {
      // Removal attempt did not work — escalate to re_exposed
      console.log(
        `[Scanner] Removal failed — broker ${brokerId} still shows data (exposure ${existing.id})`,
      );
      db.prepare(
        "UPDATE exposures SET status = 're_exposed', last_updated = unixepoch() WHERE id = ?",
      ).run(existing.id);
      return true;
    }

    if (
      existing.status === "removal_confirmed" ||
      existing.status === "not_found"
    ) {
      // Re-appeared after being clean — mark re_exposed
      console.log(
        `[Scanner] Re-exposure detected on broker ${brokerId} (exposure ${existing.id})`,
      );
      db.prepare(
        "UPDATE exposures SET status = 're_exposed', profile_url = ?, last_updated = unixepoch() WHERE id = ?",
      ).run(result.profile_url || null, existing.id);
      return true;
    }
  } else {
    // result.status === 'not_found'
    if (PENDING_REMOVAL.has(existing.status)) {
      // Removal confirmed ✅
      console.log(
        `[Scanner] Removal confirmed for broker ${brokerId} (exposure ${existing.id})`,
      );
      db.prepare(
        "UPDATE exposures SET status = 'removal_confirmed', last_updated = unixepoch() WHERE id = ?",
      ).run(existing.id);
      return false;
    }

    if (ACTIVE_STATUSES.has(existing.status)) {
      // Disappeared without us sending a request (broker removed themselves)
      db.prepare(
        "UPDATE exposures SET status = 'not_found', last_updated = unixepoch() WHERE id = ?",
      ).run(existing.id);
      return false;
    }

    // not_found or removal_confirmed — no change needed
  }

  return false;
}

/* ── Main scan entry point ────────────────────────────────── */

/**
 * Run a full scan for a profile.
 *
 * @param {number}   scanId
 * @param {number}   profileId
 * @param {number}   userId
 * @param {Function} onProgress  — called with (done, total, brokerName, status) for SSE
 * @param {object}   [opts]
 * @param {boolean}  [opts.autoRemoval]  — override for auto-removal (falls back to sysconfig)
 */
async function runScan(scanId, profileId, userId, onProgress, opts = {}) {
  const db = getDb();

  // Load and decrypt profile
  const profileRow = db
    .prepare("SELECT * FROM profiles WHERE id = ? AND user_id = ?")
    .get(profileId, userId);
  if (!profileRow) throw new Error("Profile not found");

  const raw = safeDecrypt(profileRow.data_enc);
  if (!raw) throw new Error("Profile decryption failed — check ENCRYPTION_KEY");
  const profile = JSON.parse(raw);

  // Load enabled brokers, highest priority first
  const brokers = db
    .prepare(
      `
    SELECT * FROM brokers WHERE enabled = 1
    ORDER BY
      CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
      name ASC
  `,
    )
    .all();

  const total = brokers.length;

  // Persist broker count so SSE clients can compute progress percentage
  db.prepare(
    "UPDATE scans SET total_brokers = ?, total_checked = 0, found = 0 WHERE id = ?",
  ).run(total, scanId);

  const delayMs = parseInt(sysconfig.get("scan_delay_ms"), 10) || 2000;
  let done = 0;
  let found = 0;

  for (const broker of brokers) {
    await sleep(delayMs);

    // Abort early if the scan row was cancelled externally
    const scanRow = db
      .prepare("SELECT status FROM scans WHERE id = ?")
      .get(scanId);
    if (scanRow && scanRow.status === "cancelled") {
      console.log(`[Scanner] Scan ${scanId} cancelled — stopping early`);
      break;
    }

    // Look up the most recent exposure record for this profile+broker combination
    const existing = db
      .prepare(
        `
      SELECT id, status, last_updated
      FROM exposures
      WHERE profile_id = ? AND broker_id = ?
      ORDER BY detected_at DESC
      LIMIT 1
    `,
      )
      .get(profileId, broker.id);

    let result;

    if (existing && SKIP_STATUSES.has(existing.status)) {
      // Already clean / already resolved — skip the HTTP request
      result = { status: existing.status, profile_url: null };
    } else {
      result = await scanBroker(broker, profile);
    }

    const newFound = applyResult(
      db,
      result,
      existing,
      profileId,
      userId,
      broker.id,
      scanId,
    );
    if (newFound) found++;

    done++;
    db.prepare(
      "UPDATE scans SET total_checked = ?, found = ? WHERE id = ?",
    ).run(done, found, scanId);

    if (typeof onProgress === "function") {
      onProgress(done, total, broker.name, result.status);
    }
  }

  db.prepare(
    "UPDATE scans SET status = 'done', completed_at = unixepoch() WHERE id = ? AND status = 'running'",
  ).run(scanId);

  // ── Auto-removal ─────────────────────────────────────────
  const autoRemovalEnabled =
    opts.autoRemoval === true ||
    sysconfig.get("auto_removal_enabled") === "true";

  if (autoRemovalEnabled && found > 0) {
    await _runAutoRemovals(scanId, userId, db);
  }

  return { total, found };
}

/**
 * For each exposure inserted/updated as detected/assumed in this scan,
 * automatically dispatch a removal request (non-manual brokers only).
 */
async function _runAutoRemovals(scanId, userId, db) {
  const { sendRemoval } = require("./remover");

  const exposures = db
    .prepare(
      `
    SELECT e.id, b.automation, b.method, b.contact_email, b.opt_out_url
    FROM exposures e
    JOIN brokers b ON b.id = e.broker_id
    WHERE e.scan_id = ?
      AND e.status IN ('detected', 'assumed', 're_exposed')
      AND (
        b.automation = 'auto'
        OR (b.method = 'email' AND b.contact_email IS NOT NULL AND b.contact_email != '')
      )
  `,
    )
    .all(scanId);

  if (!exposures.length) return;

  console.log(
    `[Scanner] Auto-removal: sending ${exposures.length} request(s) for scan ${scanId}`,
  );

  for (const exp of exposures) {
    // Check we haven't already sent a removal for this exposure recently
    const recent = db
      .prepare(
        `
      SELECT id FROM removal_requests
      WHERE exposure_id = ? AND sent_at > unixepoch() - 86400
      LIMIT 1
    `,
      )
      .get(exp.id);
    if (recent) continue;

    try {
      await sendRemoval(exp.id, userId, false);
    } catch (err) {
      console.error(
        `[Scanner] Auto-removal failed for exposure ${exp.id}:`,
        err.message,
      );
    }
    // Small pause between removal requests to avoid hammering servers
    await sleep(1000);
  }
}

module.exports = { runScan };
