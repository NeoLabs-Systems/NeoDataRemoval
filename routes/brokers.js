'use strict';

const router  = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { getBrokerByKey, listBrokers } = require('../services/brokerCatalog');

router.use(requireAuth);

/* GET /api/brokers  — read-only catalog from data/brokers.json */
router.get('/', (req, res) => {
  const { priority, method, enabled, q } = req.query;
  const search = String(q || '').trim().toLowerCase();

  const rows = listBrokers()
    .filter((broker) => !priority || broker.priority === priority)
    .filter((broker) => !method || broker.method === method)
    .filter((broker) => enabled === undefined || broker.enabled === (enabled === 'true'))
    .filter((broker) => {
      if (!search) return true;
      return [broker.name, broker.url, broker.instructions, ...(broker.security?.safety_notes || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    })
    .sort((a, b) => {
      const rank = { critical: 1, high: 2, standard: 3 };
      return (rank[a.priority] || 9) - (rank[b.priority] || 9) || a.name.localeCompare(b.name);
    })
    .slice(0, 1000);

  res.json(rows);
});

/* GET /api/brokers/:id */
router.get('/:id', (req, res) => {
  const row = getBrokerByKey(req.params.id);
  if (!row) return res.status(404).json({ error: 'Broker not found' });
  res.json(row);
});

module.exports = router;
