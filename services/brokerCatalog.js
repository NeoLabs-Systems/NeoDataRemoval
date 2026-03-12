"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BROKERS_PATH = path.join(__dirname, "..", "data", "brokers.json");

let cache = {
  mtimeMs: 0,
  brokers: [],
  byKey: new Map(),
  byLegacyId: new Map(),
};

function makeBrokerKey(name, url) {
  return crypto
    .createHash("sha1")
    .update(`${String(name || "").trim().toLowerCase()}|${String(url || "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

function loadCatalog() {
  const stat = fs.statSync(BROKERS_PATH);
  if (cache.mtimeMs === stat.mtimeMs) return cache;

  const raw = JSON.parse(fs.readFileSync(BROKERS_PATH, "utf8"));
  const brokers = raw.map((broker, index) => {
    const key = makeBrokerKey(broker.name, broker.url);
    return {
      ...broker,
      id: key,
      key,
      legacy_id: index + 1,
      enabled: broker.enabled !== false,
      status: broker.status || null,
      security: broker.security || null,
    };
  });

  cache = {
    mtimeMs: stat.mtimeMs,
    brokers,
    byKey: new Map(brokers.map((broker) => [broker.key, broker])),
    byLegacyId: new Map(brokers.map((broker) => [broker.legacy_id, broker])),
  };

  return cache;
}

function listBrokers() {
  return loadCatalog().brokers;
}

function getBrokerByKey(key) {
  if (!key) return null;
  return loadCatalog().byKey.get(String(key)) || null;
}

function getBrokerByLegacyId(id) {
  const num = Number(id);
  if (!Number.isFinite(num)) return null;
  return loadCatalog().byLegacyId.get(num) || null;
}

function resolveBroker(ref) {
  if (!ref) return null;
  return getBrokerByKey(ref.broker_key) || getBrokerByLegacyId(ref.broker_id) || null;
}

function enrichExposure(row) {
  const broker = resolveBroker(row);
  return {
    ...row,
    broker_name: broker ? broker.name : row.broker_name || "Unknown Broker",
    broker_url: broker ? broker.url : row.broker_url || null,
    priority: broker ? broker.priority : row.priority || "standard",
    method: broker ? broker.method : row.method || "manual",
    automation: broker ? broker.automation : row.automation || "manual",
    enabled: broker ? broker.enabled !== false : row.enabled !== false,
    rescan_days: broker ? broker.rescan_days || 0 : row.rescan_days || 0,
    opt_out_url: broker ? broker.opt_out_url || null : row.opt_out_url || null,
    instructions: broker ? broker.instructions || null : row.instructions || null,
    contact_email: broker ? broker.contact_email || null : row.contact_email || null,
    broker_status: broker ? broker.status || null : null,
    broker_security: broker ? broker.security || null : null,
  };
}

module.exports = {
  BROKERS_PATH,
  enrichExposure,
  getBrokerByKey,
  getBrokerByLegacyId,
  listBrokers,
  loadCatalog,
  makeBrokerKey,
  resolveBroker,
};
