'use strict';

const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

const SECRET = process.env.JWT_SECRET || 'change_me';

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token
    || (req.headers.authorization || '').replace('Bearer ', '');

  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const db   = getDb();
  const user = db.prepare('SELECT id, username, email, role, active FROM users WHERE id = ?').get(payload.id);

  if (!user || !user.active) {
    return res.status(401).json({ error: 'Account not found or deactivated' });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function signToken(userId) {
  return jwt.sign({ id: userId }, SECRET, { expiresIn: '30d' });
}

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

module.exports = { requireAuth, requireAdmin, signToken, setTokenCookie };
