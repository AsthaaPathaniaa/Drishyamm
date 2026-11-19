'use strict';

/**
 * aiEventFilters — the server-side query for restricted-zone breaches.
 *
 * `GET /api/ai/events` caps at 200 rows of EVERY type and lets the browser
 * filter, so "every breach in this week" is unanswerable from it. The
 * zone-breach endpoints ask the database the narrow question instead:
 * `ai_events` rows of one type, for one account, with each filter pushed into
 * SQL so the row count and the paging are the real ones.
 *
 * Shifts are hours of the day in IST, on every day in the range — "night
 * shift, last 7 days" is seven nights — and a shift may wrap midnight. The
 * windows are the ones the page shows (frontend
 * src/modules/occupancy/breaches/breach-model.js); SHIFT_HOURS below is the
 * single copy both the SQL and the in-memory predicate read, so they cannot
 * drift apart.
 *
 * Conditions that need an expression rather than a column (the IST hour, the
 * JSON payload) are returned as `{ sql, test }` pairs and pushed into the
 * where clause as literals with `.test` attached: the same rule, once as SQL
 * for the database and once as a predicate for re-checking a row in memory.
 */

const { Op, literal } = require('sequelize');

const ZONE_BREACH_EVENT_TYPE = 'zone.intrusion';

/** IST is UTC+05:30 with no daylight saving, so a fixed offset is exact. */
const IST_OFFSET_MIN = 330;
const IST_OFFSET_MS = IST_OFFSET_MIN * 60_000;

/**
 * [startHour, endHour) in IST. `end <= start` wraps midnight.
 * Mirrors SHIFTS in frontend/src/modules/occupancy/breaches/breach-model.js.
 */
const SHIFT_HOURS = {
  all: null,
  morning: [6, 14],
  evening: [14, 22],
  night: [22, 6],
};

const SHIFT_LABELS = {
  all: 'All shifts',
  morning: 'Morning (06:00-14:00)',
  evening: 'Evening (14:00-22:00)',
  night: 'Night (22:00-06:00)',
};

// `ts` is stored in UTC. Shifting by 330 minutes beats CONVERT_TZ, which needs
// the MySQL timezone tables loaded — they are not, in the stock image.
const IST_HOUR_SQL = `HOUR(\`ts\` + INTERVAL ${IST_OFFSET_MIN} MINUTE)`;

/** Hour of the day, 0-23, in IST. */
const istHour = (ms) => new Date(ms + IST_OFFSET_MS).getUTCHours();

/** Is `ms` inside `shiftId`? True for an absent or unknown shift. */
function inShiftIst(ms, shiftId) {
  const hours = SHIFT_HOURS[shiftId];
  if (!hours) return true;
  if (!Number.isFinite(ms)) return false;
  const [start, end] = hours;
  const h = istHour(ms);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

const rowField = (row, key) => (row && typeof row.get === 'function' ? row.get(key) : row?.[key]);
const tsMs = (row) => new Date(rowField(row, 'ts') ?? NaN).getTime();

/** The shift as SQL plus the same rule as a predicate, or null for "all". */
function shiftCondition(shiftId) {
  const hours = SHIFT_HOURS[shiftId];
  if (!hours) return null;
  const [start, end] = hours;
  const sql = start < end
    ? `(${IST_HOUR_SQL} >= ${start} AND ${IST_HOUR_SQL} < ${end})`
    : `(${IST_HOUR_SQL} >= ${start} OR ${IST_HOUR_SQL} < ${end})`;
  return { sql, test: (row) => inShiftIst(tsMs(row), shiftId) };
}

const payloadStr = (path) => `JSON_UNQUOTE(JSON_EXTRACT(\`payload\`, '$.${path}'))`;

function readPayload(row) {
  const p = rowField(row, 'payload');
  if (!p) return {};
  if (typeof p === 'string') {
    try { return JSON.parse(p) || {}; } catch { return {}; }
  }
  return p;
}

/** Breaches in one zone. The zone id is in the event payload, not a column. */
function zoneCondition(zoneId, escape) {
  return {
    sql: `${payloadStr('zoneId')} = ${escape(String(zoneId))}`,
    test: (row) => String(readPayload(row).zoneId ?? '') === String(zoneId),
  };
}

// What a free-text search looks at: the zone name, and the person text the
// engines write (a matched watchlist name, or "3 persons").
const SEARCH_PATHS = ['zoneName', 'matchedName', 'names', 'personName', 'person_name'];

/** Free-text match on the zone or the name(s) in the payload. */
function searchCondition(q, escape) {
  const needle = String(q).trim().toLowerCase();
  // Escape LIKE wildcards so a search for "a_b" is text, not a pattern.
  const pattern = escape(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const sql = `(${SEARCH_PATHS.map((p) => `LOWER(${payloadStr(p)}) LIKE ${pattern}`).join(' OR ')})`;
  return {
    sql,
    test: (row) => {
      const p = readPayload(row);
      return SEARCH_PATHS.some((k) => {
        const v = p[k];
        const s = Array.isArray(v) ? v.join(', ') : v;
        return s !== null && s !== undefined && String(s).toLowerCase().includes(needle);
      });
    },
  };
}

/* ───────────────────────── Parameter parsing ──────────────────────────── */

/** ISO 8601 or epoch milliseconds, to epoch ms, or null. */
function parseWhen(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  const ms = /^-?\d+$/.test(s) ? Number(s) : new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const SEVERITIES = new Set(['info', 'warning', 'critical']);
// open → acknowledged (a human has seen it) → resolved (a human has dealt
// with it). The three are exclusive: a resolved breach must not also come
// back under "acknowledged", or an operator working the acknowledged queue
// keeps being handed rows somebody already closed.
const STATUSES = new Set(['open', 'acknowledged', 'resolved']);

// One IN list per request: a site has tens of cameras, not thousands.
const MAX_MONITOR_IDS = 200;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
// A page number is a number from the client, so it is bounded: past the end
// the answer is an empty page either way, and an unbounded one turns into an
// absurd OFFSET. A million pages is 25 million breaches.
const MAX_PAGE = 1_000_000;

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** The filters a request asked for, normalised — what the CSV header prints. */
function parseZoneBreachFilters(query = {}) {
  const since = parseWhen(query.since);
  const until = parseWhen(query.until);
  const severityRaw = String(query.severity || '').trim().toLowerCase();
  // The table chips say "warn"; the column enum says "warning".
  const severity = severityRaw === 'warn' ? 'warning' : severityRaw;
  const shift = String(query.shift || 'all').trim().toLowerCase();
  const status = String(query.status || '').trim().toLowerCase();
  const bothEnds = since !== null && until !== null;

  return {
    // A reversed range is the same range: picking the two days the other way
    // round should not return an empty page.
    since: bothEnds ? Math.min(since, until) : since,
    until: bothEnds ? Math.max(since, until) : until,
    zoneId: String(query.zoneId || '').trim() || null,
    monitorIds: [...new Set(String(query.monitorIds || '')
      .split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_MONITOR_IDS),
    severity: SEVERITIES.has(severity) ? severity : null,
    status: STATUSES.has(status) ? status : null,
    shift: SHIFT_HOURS[shift] ? shift : 'all',
    q: String(query.q || '').trim() || null,
    page: clampInt(query.page, 1, 1, MAX_PAGE),
    pageSize: clampInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

/**
 * The Sequelize where clause for one account of zone breaches.
 *
 * Scoped by `userId` exactly as listEvents is, and pinned to the one event
 * type: no other kind of event can reach these endpoints whatever is asked
 * for, and no other account can see these rows.
 *
 * @param {object}   o
 * @param {string}   o.userId  the caller (req.user.id)
 * @param {object}   o.query   req.query
 * @param {Function} o.escape  sequelize.escape — quotes the literals' values
 */
function buildZoneBreachWhere({ userId, query, escape }) {
  const filters = parseZoneBreachFilters(query);
  const where = { userId, eventType: ZONE_BREACH_EVENT_TYPE };

  if (filters.monitorIds.length) where.monitorId = { [Op.in]: filters.monitorIds };
  if (filters.severity) where.severity = filters.severity;
  if (filters.status === 'open') {
    where.acknowledgedAt = { [Op.is]: null };
    where.resolvedAt = { [Op.is]: null };
  }
  if (filters.status === 'acknowledged') {
    where.acknowledgedAt = { [Op.not]: null };
    where.resolvedAt = { [Op.is]: null };   // seen, but not yet closed out
  }
  if (filters.status === 'resolved') where.resolvedAt = { [Op.not]: null };
  if (filters.since !== null || filters.until !== null) {
    where.ts = {};
    if (filters.since !== null) where.ts[Op.gte] = new Date(filters.since);
    if (filters.until !== null) where.ts[Op.lte] = new Date(filters.until);
  }

  const conditions = [
    shiftCondition(filters.shift),
    filters.zoneId ? zoneCondition(filters.zoneId, escape) : null,
    filters.q ? searchCondition(filters.q, escape) : null,
  ].filter(Boolean);

  if (conditions.length) {
    where[Op.and] = conditions.map((c) => {
      const lit = literal(c.sql);
      // The equivalent in-memory rule, carried with the SQL so a row can be
      // re-checked without another round trip. Sequelize reads only `.val`.
      lit.test = c.test;
      return lit;
    });
  }

  return { where, filters };
}

/**
 * The same where clause, narrowed to the rows after `cursor` in
 * (ts DESC, id DESC).
 *
 * Keyset paging, not OFFSET: the CSV export walks a whole range in batches,
 * and a deep OFFSET re-scans every row before it on each batch. `id` is the
 * primary key, so (ts, id) is unique and nothing is skipped or repeated when
 * several breaches land in the same second.
 */
function withZoneBreachCursor(where, cursor) {
  if (!cursor) return where;
  return {
    ...where,
    [Op.and]: [
      ...(where[Op.and] || []),
      {
        [Op.or]: [
          { ts: { [Op.lt]: cursor.ts } },
          { ts: cursor.ts, id: { [Op.lt]: cursor.id } },
        ],
      },
    ],
  };
}

module.exports = {
  ZONE_BREACH_EVENT_TYPE,
  IST_OFFSET_MS,
  SHIFT_HOURS,
  SHIFT_LABELS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  istHour,
  inShiftIst,
  parseWhen,
  parseZoneBreachFilters,
  buildZoneBreachWhere,
  withZoneBreachCursor,
};
