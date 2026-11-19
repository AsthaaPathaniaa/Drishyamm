/**
 * systemAlerts.controller — the customer's own camera / NVR status alerts.
 *
 *   GET /api/alerts/system?since=<ISO>&limit=<n>
 *     → { items: [shaped platform event], total }
 *
 * Reads platform_events rows of the customer-facing types (see
 * platformEvents.CUSTOMER_TYPES) scoped to the caller's account
 * (sub-users see their owner's account). No AI needed: every plan gets these.
 */
const { Op } = require('sequelize');
const models = require('../models');
const { shape, CUSTOMER_TYPES, accountOfUser } = require('../services/platformEvents.service');

const MAX_LIMIT = 500;
const DEFAULT_DAYS = 7;

async function list(req, res, next) {
  try {
    const accountId = await accountOfUser(req.user.id);
    if (!accountId) return res.json({ items: [], total: 0 });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_LIMIT);
    let since = req.query.since ? new Date(req.query.since) : null;
    if (!since || Number.isNaN(since.getTime())) since = new Date(Date.now() - DEFAULT_DAYS * 864e5);

    const rows = await models.PlatformEvent.findAll({
      where: { accountId: String(accountId), type: { [Op.in]: [...CUSTOMER_TYPES] }, createdAt: { [Op.gte]: since } },
      order: [['createdAt', 'DESC']],
      limit,
    });
    const items = rows.map((r) => {
      const e = shape(r.get ? r.get({ plain: true }) : r);
      delete e.ip; delete e.actor;
      return e;
    });
    res.json({ items, total: items.length });
  } catch (err) { next(err); }
}

module.exports = { list };
