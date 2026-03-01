'use strict';

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const profileRoutes  = require('./routes/profiles');
const brokerRoutes   = require('./routes/brokers');
const scanRoutes     = require('./routes/scan');
const exposureRoutes = require('./routes/exposures');
const removalRoutes  = require('./routes/removals');
const settingsRoutes = require('./routes/settings');
const aiRoutes       = require('./routes/ai');

const { initDb }       = require('./db/database');
const { startScheduler } = require('./services/scheduler');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

/* ── Security headers ────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      fontSrc:       ["'self'", 'data:'],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'"],
      objectSrc:     ["'none'"],
      frameAncestors:["'none'"],
      frameSrc:      ["'none'"],
      formAction:    ["'self'"],
      baseUri:       ["'self'"],
      workerSrc:     ["'none'"],
    }
  }
}));

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(cookieParser());
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

/* ── Rate limiting ────────────────────────────────────── */
const rlKey = process.env.TRUST_PROXY === '1'
  ? undefined
  : (req) => req.socket.remoteAddress || 'unknown';

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKey,
}));

/* ── Cache-bust JS/CSS ────────────────────────────────── */
app.use((req, res, next) => {
  if (/\.(js|css)$/.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

/* ── Static files ──────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public')));

/* ── API routes ────────────────────────────────────────── */
app.use('/api/auth',     authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/brokers',  brokerRoutes);
app.use('/api/scan',     scanRoutes);
app.use('/api/exposures',exposureRoutes);
app.use('/api/removals', removalRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai',       aiRoutes);

/* ── SPA fallback ──────────────────────────────────────── */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Error handler ─────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

/* ── Boot ──────────────────────────────────────────────── */
initDb();
startScheduler();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change_me') {
  console.warn('[Security] WARNING: JWT_SECRET is not set or is using the default. Set a strong secret in .env before deploying.');
}

app.listen(PORT, () => {
  console.log(`NeoDataRemoval running on http://localhost:${PORT}`);
});
