"use strict";

const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth");

/* ── Per-user preference defaults ───────────────────────────── */

const PREF_DEFAULTS = {
  scan_delay_ms: 2000,
  auto_rescan: true,
  notify_on_exposure: false,
  notify_on_removal: false,
  ai_draft_opt_in: false,
  theme: "dark",
};

function getDb() {
  return require("../db/database").getDb();
}

function getUserPrefs(userId) {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?")
    .get(userId, "prefs");
  if (!row) return { ...PREF_DEFAULTS };
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(row.value) };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

/* ── User preferences ───────────────────────────────────────── */

// GET /api/settings
router.get("/", requireAuth, (req, res) => {
  res.json(getUserPrefs(req.user.id));
});

// PUT /api/settings
router.put("/", requireAuth, (req, res) => {
  const db = getDb();
  const current = getUserPrefs(req.user.id);
  const allowed = Object.keys(PREF_DEFAULTS);
  const update = {};

  for (const k of allowed) {
    if (!(k in req.body)) continue;
    const v = req.body[k];
    if (k === "scan_delay_ms") {
      const n = parseInt(v, 10);
      if (!isNaN(n)) update[k] = Math.min(Math.max(500, n), 60_000);
    } else if (k === "theme") {
      if (["dark", "light"].includes(v)) update[k] = v;
    } else if (typeof PREF_DEFAULTS[k] === "boolean") {
      update[k] = Boolean(v);
    } else {
      update[k] = v;
    }
  }

  const merged = { ...current, ...update };
  db.prepare(
    `
    INSERT INTO settings (user_id, key, value, updated_at)
    VALUES (?, 'prefs', ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE
      SET value      = excluded.value,
          updated_at = excluded.updated_at
  `,
  ).run(req.user.id, JSON.stringify(merged));

  res.json(merged);
});

/* ── System settings (admin only) ───────────────────────────── */

const ALLOWED_SYSTEM_KEYS = [
  "smtp_host",
  "smtp_port",
  "smtp_secure",
  "smtp_user",
  "smtp_pass",
  "smtp_from",
  "openai_api_key",
  "openai_model",
  "app_url",
  "scan_delay_ms",
  "auto_removal_enabled",
  "verify_removals_enabled",
  "removal_verify_days",
];

// GET /api/settings/system
// Returns the public representation (sensitive values masked).
router.get("/system", requireAuth, requireAdmin, (req, res) => {
  try {
    const sysconfig = require("../services/sysconfig");
    res.json(sysconfig.getPublicConfig());
  } catch (err) {
    console.error("[settings/system GET]", err.message);
    res.status(500).json({ error: "Failed to load system settings" });
  }
});

// PUT /api/settings/system
// Accepts a partial object; unknown keys are ignored.
// Pass an empty string for a key to clear it (revert to env / default).
router.put("/system", requireAuth, requireAdmin, (req, res) => {
  const sysconfig = require("../services/sysconfig");
  const body = req.body || {};

  // Validate scan_delay_ms if present
  if ("scan_delay_ms" in body) {
    const n = parseInt(body.scan_delay_ms, 10);
    if (isNaN(n) || n < 500 || n > 60_000) {
      return res
        .status(400)
        .json({ error: "scan_delay_ms must be between 500 and 60000" });
    }
    body.scan_delay_ms = String(n);
  }

  // Validate smtp_port if present
  if ("smtp_port" in body && body.smtp_port !== "") {
    const p = parseInt(body.smtp_port, 10);
    if (isNaN(p) || p < 1 || p > 65535) {
      return res
        .status(400)
        .json({ error: "smtp_port must be a valid port number (1–65535)" });
    }
    body.smtp_port = String(p);
  }

  // Validate removal_verify_days if present
  if ("removal_verify_days" in body && body.removal_verify_days !== "") {
    const d = parseInt(body.removal_verify_days, 10);
    if (isNaN(d) || d < 1 || d > 365) {
      return res
        .status(400)
        .json({ error: "removal_verify_days must be between 1 and 365" });
    }
    body.removal_verify_days = String(d);
  }

  // Coerce boolean-like strings
  for (const k of [
    "smtp_secure",
    "auto_removal_enabled",
    "verify_removals_enabled",
  ]) {
    if (k in body && body[k] !== "") {
      body[k] = body[k] === true || body[k] === "true" ? "true" : "false";
    }
  }

  // Filter to only allowed keys
  const updates = {};
  for (const key of ALLOWED_SYSTEM_KEYS) {
    if (key in body) updates[key] = body[key];
  }

  try {
    sysconfig.setMany(updates);
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    console.error("[settings/system PUT]", err.message);
    res.status(500).json({ error: "Failed to save system settings" });
  }
});

// POST /api/settings/system/test-smtp
// Verifies that the current SMTP configuration can connect.
router.post(
  "/system/test-smtp",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const sysconfig = require("../services/sysconfig");
    const nodemailer = require("nodemailer");

    const host = sysconfig.get("smtp_host");
    if (!host) {
      return res.status(400).json({ error: "SMTP host is not configured" });
    }

    const transport = nodemailer.createTransport({
      host,
      port: parseInt(sysconfig.get("smtp_port"), 10) || 587,
      secure: sysconfig.get("smtp_secure") === "true",
      auth: {
        user: sysconfig.get("smtp_user") || undefined,
        pass: sysconfig.get("smtp_pass") || undefined,
      },
      connectionTimeout: 8_000,
      greetingTimeout: 5_000,
    });

    try {
      await transport.verify();
      const user = sysconfig.get("smtp_user") || "anonymous";
      res.json({ ok: true, message: `Connected to ${host} as ${user}` });
    } catch (err) {
      res.status(400).json({ error: `SMTP test failed: ${err.message}` });
    } finally {
      transport.close();
    }
  },
);

// POST /api/settings/system/test-ai
// Verifies that the OpenAI API key is valid by listing available models.
router.post("/system/test-ai", requireAuth, requireAdmin, async (req, res) => {
  const sysconfig = require("../services/sysconfig");
  const apiKey = sysconfig.get("openai_api_key");

  if (!apiKey) {
    return res.status(400).json({ error: "OpenAI API key is not configured" });
  }

  let OpenAI;
  try {
    OpenAI = require("openai");
  } catch {
    return res.status(500).json({ error: "openai package is not installed" });
  }

  const openai = new (OpenAI.default || OpenAI)({ apiKey });

  try {
    const list = await openai.models.list();
    const count = list.data ? list.data.length : "?";
    const model = sysconfig.get("openai_model") || "gpt-4o-mini";
    res.json({
      ok: true,
      message: `OpenAI connected — ${count} models available. Active model: ${model}`,
    });
  } catch (err) {
    res.status(400).json({ error: `OpenAI test failed: ${err.message}` });
  }
});

// POST /api/settings/system/test-removal-email
// Sends a test email to the currently logged-in admin's address.
router.post(
  "/system/test-removal-email",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const sysconfig = require("../services/sysconfig");
    const nodemailer = require("nodemailer");

    const host = sysconfig.get("smtp_host");
    if (!host) {
      return res.status(400).json({ error: "SMTP not configured" });
    }

    const db = getDb();
    const user = db
      .prepare("SELECT email, username FROM users WHERE id = ?")
      .get(req.user.id);
    if (!user || !user.email) {
      return res
        .status(400)
        .json({ error: "No email address on your account" });
    }

    const transport = nodemailer.createTransport({
      host,
      port: parseInt(sysconfig.get("smtp_port"), 10) || 587,
      secure: sysconfig.get("smtp_secure") === "true",
      auth: {
        user: sysconfig.get("smtp_user") || undefined,
        pass: sysconfig.get("smtp_pass") || undefined,
      },
    });

    const from =
      sysconfig.get("smtp_from") ||
      sysconfig.get("smtp_user") ||
      "NeoDataRemoval";

    try {
      const info = await transport.sendMail({
        from,
        to: user.email,
        subject: "NeoDataRemoval — SMTP test",
        text: `Hi ${user.username},\n\nThis is a test email from NeoDataRemoval to confirm your SMTP settings are working correctly.\n\nIf you received this, everything is configured properly.\n\n— NeoDataRemoval`,
      });
      res.json({
        ok: true,
        message: `Test email sent to ${user.email} (message ID: ${info.messageId})`,
      });
    } catch (err) {
      res.status(400).json({ error: `Send failed: ${err.message}` });
    } finally {
      transport.close();
    }
  },
);

// GET /api/settings/system/status
// Returns secrets provenance, server info, and a "no .env needed" readiness summary.
router.get("/system/status", requireAuth, requireAdmin, (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const sysconfig = require("../services/sysconfig");

  const secretsFile = path.join(__dirname, "..", "db_data", "app-secrets.json");
  const secretsOnDisk = fs.existsSync(secretsFile);

  // For each critical secret, report where it came from without revealing the value
  function secretSource(envKey, minLen = 32) {
    const val = process.env[envKey];
    if (val && val.length >= minLen && val !== "change_me") {
      // Could be from env var OR from the file (we injected it into process.env)
      return secretsOnDisk ? "file" : "env";
    }
    return "missing";
  }

  res.json({
    // Infrastructure (read-only, requires restart to change)
    node_env: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT, 10) || 3060,
    trust_proxy: process.env.TRUST_PROXY === "1",

    // Secrets
    secrets_file_exists: secretsOnDisk,
    secrets_file_path: secretsOnDisk ? "db_data/app-secrets.json" : null,
    encryption_key_source: secretSource("ENCRYPTION_KEY", 64),
    jwt_secret_source: secretSource("JWT_SECRET", 32),

    // Services configured via Web UI
    smtp_configured: !!sysconfig.get("smtp_host"),
    openai_configured: !!sysconfig.get("openai_api_key"),

    // Convenience: is the app fully configured without any .env file?
    env_free: !process.env.ENCRYPTION_KEY_FROM_ENV && secretsOnDisk,
  });
});

// GET /api/settings/admin  (legacy — kept for backwards-compat)
router.get("/admin", requireAuth, requireAdmin, (req, res) => {
  const sysconfig = require("../services/sysconfig");
  res.json({
    smtp_configured: !!sysconfig.get("smtp_host"),
    openai_configured: !!sysconfig.get("openai_api_key"),
    node_env: process.env.NODE_ENV || "development",
    port: process.env.PORT || 3060,
  });
});

module.exports = router;
