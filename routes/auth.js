"use strict";

const router = require("express").Router();
const bcrypt = require("bcryptjs");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const rateLimit = require("express-rate-limit");
const { getDb } = require("../db/database");
const {
  signToken,
  setTokenCookie,
  requireAuth,
} = require("../middleware/auth");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  legacyHeaders: false,
  standardHeaders: true,
});

/* ── Registration gate ──────────────────────────────────────
   This is a single-user application. Registration is only
   permitted when absolutely no user account exists yet.
   ─────────────────────────────────────────────────────────── */

function registrationOpen(db) {
  const any = db.prepare("SELECT id FROM users LIMIT 1").get();
  return !any;
}

/* GET /api/auth/can-register */
router.get("/can-register", (req, res) => {
  const db = getDb();
  res.json({ allowed: registrationOpen(db) });
});

/* POST /api/auth/register */
router.post("/register", authLimiter, async (req, res) => {
  const db = getDb();

  // Hard gate — reject immediately if any account exists
  if (!registrationOpen(db)) {
    return res.status(403).json({
      error:
        "Registration is closed. This application supports only one account.",
    });
  }

  const { username, email, password } = req.body || {};

  if (!username || typeof username !== "string" || !username.trim())
    return res.status(400).json({ error: "username is required" });
  if (!email || typeof email !== "string" || !email.trim())
    return res.status(400).json({ error: "email is required" });
  if (!password || typeof password !== "string")
    return res.status(400).json({ error: "password is required" });
  if (password.length < 10)
    return res
      .status(400)
      .json({ error: "Password must be at least 10 characters" });

  const normalUsername = username.trim();
  const normalEmail = email.trim().toLowerCase();

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail))
    return res.status(400).json({ error: "Invalid email address" });

  // Double-check inside the same tick (race-condition guard)
  const race = db.prepare("SELECT id FROM users LIMIT 1").get();
  if (race) {
    return res.status(403).json({
      error:
        "Registration is closed. This application supports only one account.",
    });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = db
    .prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
    )
    .run(normalUsername, normalEmail, hash, "admin");

  const token = signToken(result.lastInsertRowid);
  setTokenCookie(res, token);

  console.log(
    `[Auth] First-time setup complete — admin account created for "${normalUsername}"`,
  );

  res.status(201).json({
    id: result.lastInsertRowid,
    username: normalUsername,
    role: "admin",
  });
});

/* POST /api/auth/login */
router.post("/login", authLimiter, async (req, res) => {
  const { username, identity, password } = req.body || {};
  const id = (username || identity || "").trim();

  if (!id || !password)
    return res
      .status(400)
      .json({ error: "username and password are required" });

  const db = getDb();
  const user = db
    .prepare(
      "SELECT * FROM users WHERE (username = ? OR email = ?) AND active = 1",
    )
    .get(id, id.toLowerCase());

  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  // 2FA check
  if (user.totp_enabled) {
    const totpToken =
      typeof req.body.totp === "string"
        ? req.body.totp.replace(/\s+/g, "")
        : "";
    if (!totpToken) return res.status(403).json({ "2fa_required": true });

    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: "base32",
      token: totpToken,
      window: 1,
    });
    if (!verified) return res.status(401).json({ error: "Invalid 2FA code." });
  }

  const token = signToken(user.id);
  setTokenCookie(res, token);

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  });
});

/* POST /api/auth/logout */
router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

/* GET /api/auth/me */
router.get("/me", requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    email: req.user.email,
    role: req.user.role,
  });
});

/* POST /api/auth/change-password */
router.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, password } = req.body || {};

  if (!current_password)
    return res.status(400).json({ error: "current_password is required" });
  if (!password || password.length < 10)
    return res
      .status(400)
      .json({ error: "New password must be at least 10 characters" });

  const db = getDb();
  const user = db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(req.user.id);
  const ok = await bcrypt.compare(current_password, user.password_hash);
  if (!ok)
    return res.status(401).json({ error: "Current password is incorrect" });

  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hash,
    req.user.id,
  );

  // Invalidate session — user must log in with the new password
  res.clearCookie("token");
  res.json({ ok: true, relogin: true });
});

/* ── Two-Factor Authentication ────────────────────────────── */

/* GET /api/auth/2fa/status */
router.get("/2fa/status", requireAuth, (req, res) => {
  const db = getDb();
  const user = db
    .prepare("SELECT totp_enabled FROM users WHERE id = ?")
    .get(req.user.id);
  res.json({ enabled: !!user.totp_enabled });
});

/* GET /api/auth/2fa/generate — create secret, store (not yet active), return QR */
router.get("/2fa/generate", requireAuth, async (req, res) => {
  const db = getDb();
  const user = db
    .prepare("SELECT username, email FROM users WHERE id = ?")
    .get(req.user.id);
  const label = user.email || user.username;

  const secret = speakeasy.generateSecret({
    name: `NeoDataRemoval (${label})`,
    length: 20,
  });

  db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(
    secret.base32,
    req.user.id,
  );

  const dataUrl = await qrcode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qrcode: dataUrl });
});

/* POST /api/auth/2fa/verify — verify token and enable 2FA */
router.post("/2fa/verify", requireAuth, (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token required" });

  const db = getDb();
  const user = db
    .prepare("SELECT totp_secret FROM users WHERE id = ?")
    .get(req.user.id);
  if (!user || !user.totp_secret)
    return res.status(400).json({ error: "Generate a 2FA secret first." });

  const verified = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: "base32",
    token: String(token).replace(/\s+/g, ""),
    window: 1,
  });

  if (!verified)
    return res.status(401).json({ error: "Invalid code — try again." });

  db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(req.user.id);
  res.json({ ok: true });
});

/* POST /api/auth/2fa/disable — requires current password + valid TOTP token */
router.post("/2fa/disable", requireAuth, async (req, res) => {
  const { password, token } = req.body || {};
  if (!password || !token)
    return res.status(400).json({ error: "password and token are required" });

  const db = getDb();
  const user = db
    .prepare(
      "SELECT password_hash, totp_secret, totp_enabled FROM users WHERE id = ?",
    )
    .get(req.user.id);

  if (!user.totp_enabled)
    return res.status(400).json({ error: "2FA is not enabled." });

  const passOk = await bcrypt.compare(password, user.password_hash);
  if (!passOk) return res.status(401).json({ error: "Incorrect password." });

  const verified = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: "base32",
    token: String(token).replace(/\s+/g, ""),
    window: 1,
  });
  if (!verified) return res.status(401).json({ error: "Invalid 2FA code." });

  db.prepare(
    "UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?",
  ).run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
