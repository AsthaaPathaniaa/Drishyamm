/**
 * An in-memory `ai_events` table that really evaluates the Sequelize where
 * clause it is handed.
 *
 * The zone-breach endpoints exist because filtering in the browser cannot see
 * past a 200-row page, so a test that only asserted on the query object would
 * check nothing that matters. This stands in for the three models the
 * controller touches and answers findAll / findAndCountAll by applying the
 * clause — operators, nested Op.and/Op.or, and the expression literals, which
 * carry the equivalent JS predicate as `.test`.
 *
 * Supports exactly what buildZoneBreachWhere emits. An unknown operator throws
 * rather than passing silently, so a new filter cannot slip past untested.
 */

'use strict';

const { Op } = require('sequelize');

const num = (v) => (v instanceof Date ? v.getTime() : v);

function matchField(actual, spec) {
  if (spec && typeof spec === 'object' && !(spec instanceof Date) && !Array.isArray(spec)) {
    const ops = Object.getOwnPropertySymbols(spec);
    if (ops.length) {
      return ops.every((op) => {
        const want = spec[op];
        switch (op) {
          case Op.in:  return want.includes(actual);
          case Op.is:  return want === null ? actual === null || actual === undefined : actual === want;
          case Op.not: return want === null ? !(actual === null || actual === undefined) : actual !== want;
          case Op.gte: return num(actual) >= num(want);
          case Op.lte: return num(actual) <= num(want);
          case Op.gt:  return num(actual) > num(want);
          case Op.lt:  return num(actual) < num(want);
          default: throw new Error(`aiEventStore: unsupported operator ${String(op)}`);
        }
      });
    }
  }
  if (Array.isArray(spec)) return spec.includes(actual);
  return num(actual) === num(spec);
}

function matchClause(row, clause) {
  // A literal from buildZoneBreachWhere carries the equivalent JS predicate,
  // so the rule the database would apply is the rule applied here.
  if (typeof clause?.test === 'function') return clause.test(row);
  for (const key of [...Object.keys(clause), ...Object.getOwnPropertySymbols(clause)]) {
    const v = clause[key];
    if (key === Op.and) { if (!v.every((c) => matchClause(row, c))) return false; continue; }
    if (key === Op.or) { if (!v.some((c) => matchClause(row, c))) return false; continue; }
    if (!matchField(row[key], v)) return false;
  }
  return true;
}

/** ORDER BY ts DESC, id DESC — what both endpoints ask for. */
const newestFirst = (a, b) => (num(b.ts) - num(a.ts))
  || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const asModel = (r) => ({ ...r, toJSON: () => ({ ...r }) });

/**
 * A row the caller can `update()`, writing through to the store — what
 * resolving a breach does. The returned object mutates in place, so a read
 * after the write (another session listing the same range) sees it.
 */
function asRecord(row) {
  const rec = {
    ...row,
    toJSON: () => { const { ...plain } = rec; delete plain.toJSON; delete plain.update; return plain; },
    async update(patch) {
      Object.assign(row, patch);
      Object.assign(rec, patch);
      return rec;
    },
  };
  return rec;
}

const store = { events: [], cameras: [], zones: [] };
const stats = { queries: 0 };

function select(where) {
  stats.queries += 1;
  return store.events.filter((r) => matchClause(r, where)).sort(newestFirst);
}

// The aggregates the trends endpoint asks for, keyed by what it groups on.
// `attributes` carries a literal for the IST hour and a COUNT; rather than
// parse SQL, the shape of the group is enough to pick the right rollup.
function aggregate(rows, { attributes = [], group = [], limit }) {
  const isHour = String(group[0]?.val || '').includes('INTERVAL');
  if (isHour) {
    const by = new Map();
    for (const r of rows) {
      const h = new Date(new Date(r.ts).getTime() + 330 * 60_000).getUTCHours();
      by.set(h, (by.get(h) || 0) + 1);
    }
    return [...by].map(([hour, count]) => ({ hour, count }));
  }
  const field = group[0];
  if (field !== 'monitorId') throw new Error(`aiEventStore: cannot group by ${String(field)}`);
  const by = new Map();
  for (const r of rows) by.set(r.monitorId, (by.get(r.monitorId) || 0) + 1);
  const out = [...by]
    .map(([monitorId, count]) => ({ monitorId, count }))
    .sort((a, b) => b.count - a.count);
  void attributes;
  return limit ? out.slice(0, limit) : out;
}

const models = {
  AIEvent: {
    // Good enough for the literals the controller builds, and it keeps the
    // quoting visible in the generated SQL if a test ever prints it.
    sequelize: { escape: (v) => `'${String(v).replace(/'/g, "''")}'` },
    async findAndCountAll({ where, limit, offset = 0 }) {
      const rows = select(where);
      return { count: rows.length, rows: rows.slice(offset, offset + limit).map(asModel) };
    },
    async findAll(opts) {
      const rows = select(opts.where);
      if (opts.group) return aggregate(rows, opts);
      return (opts.limit ? rows.slice(0, opts.limit) : rows).map(asModel);
    },
    async findOne({ where }) {
      const row = store.events.find((r) => matchClause(r, where));
      return row ? asRecord(row) : null;
    },
    async count({ where }) {
      return select(where).length;
    },
  },
  Camera: {
    async findAll({ where }) {
      return store.cameras.filter((c) => c.userId === where.userId
        && (!where.monitorId || where.monitorId.includes(c.monitorId)));
    },
  },
  CameraGroup: {},
  RestrictedZone: {
    async findOne({ where }) {
      return store.zones.find((z) => z.id === where.id && z.userId === where.userId) || null;
    },
  },
};

function reset() {
  store.events = [];
  store.cameras = [];
  store.zones = [];
  stats.queries = 0;
}

module.exports = { models, store, stats, reset, matchClause };
