'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY || '';
  if (keyHex.length !== 64) throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  return Buffer.from(keyHex, 'hex');
}

function encrypt(text) {
  const key = getKey();
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':');
  const key     = getKey();
  const iv      = Buffer.from(ivHex, 'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const encData = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encData), decipher.final()]).toString('utf8');
}

/* Safe decrypt — returns null on failure instead of throwing */
function safeDecrypt(stored) {
  try { return decrypt(stored); } catch { return null; }
}

module.exports = { encrypt, decrypt, safeDecrypt };
