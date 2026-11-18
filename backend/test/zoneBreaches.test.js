/**
 * Restricted-zone breaches — GET /api/ai/zone-breaches and its CSV export.
 *
 * The point of these endpoints is that `GET /api/ai/events` cannot answer the
 * question: it returns at most 200 rows of EVERY type and filters in the
 * browser, so on an account with a thousand newer face detections not one
 * breach survives to the page. So the tests run the controller against an
 * in-memory `ai_events` table that really evaluates the where clause it is
 * given — type, tenancy, every filter, the IST shift and the keyset paging —
 * rather than asserting on a query object nobody executes.
 */

// The models are an in-memory ai_events table that really evaluates the where
// clause the controller builds — see test/helpers/aiEventStore.js.
jest.mock('../src/models', () => require('./helpers/aiEventStore').models);
jest.mock('../src/services/entitlements.service', () => ({
  assertAiLicence: jest.fn(),
  assertFeature: jest.fn(),
}));
jest.mock('../src/config/redis', () => ({ getClient: () => null }));

const { store, stats, reset } = require('./helpers/aiEventStore');
const ctrl = require('../src/controllers/ai.controller');
const { inShiftIst, parseZoneBreachFilters } = require('../src/utils/aiEventFilters');

/* ──────────────────────────── Test plumbing ───────────────────────────── */

const ME = 'user-1';
const OTHER = 'user-2';
const IST = 330 * 60_000;

/** An IST wall-clock time, as the UTC instant the row stores. */
const at = (ymd, hhmm) => new Date(Date.parse(`${ymd}T${hhmm}:00Z`) - IST);

let seq = 0;
function breach(over = {}) {
  seq += 1;
  const row = {
    id: `evt-${String(seq).padStart(5, '0')}`,
    userId: ME,
    eventType: 'zone.intrusion',
    severity: 'critical',
    monitorId: 'cam-a',
    ts: at('2026-11-10', '10:00'),
    acknowledgedAt: null,
    snapshotKey: null,
    payload: { zoneId: 'zone-1', zoneName: 'Server room', count: 2, matchedName: '2 persons' },
    ...over,
  };
  store.events.push(row);
  return row;
}

/** Run a handler and hand back the JSON body, or the error it passed on. */
function call(handler, query = {}, user = { id: ME }) {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(b) { this.body = b; return this; },
  };
  return new Promise((resolve, reject) => {
    res.json = (b) => { res.body = b; resolve({ res }); return res; };
    Promise.resolve(handler({ query, user, params: {} }, res, (err) => resolve({ res, err })))
      .catch(reject);
  });
}

/** Run the export and hand back the CSV text the socket received. */
function exportCsv(query = {}, user = { id: ME }, { highWater = Infinity } = {}) {
  let text = '';
  let pending = 0;
  const listeners = { drain: [], close: [] };
  const res = {
    headers: {}, destroyed: false, writableEnded: false,
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) {
      text += chunk;
      pending += chunk.length;
      // Model a full socket: say "wait" and drain on the next tick, so the
      // backpressure path in writeChunk is the one under test.
      if (pending < highWater) return true;
      pending = 0;
      setImmediate(() => { listeners.drain.splice(0).forEach((f) => f()); });
      return false;
    },
    once(ev, fn) { listeners[ev]?.push(fn); return this; },
    removeListener(ev, fn) {
      const i = listeners[ev]?.indexOf(fn) ?? -1;
      if (i >= 0) listeners[ev].splice(i, 1);
      return this;
    },
    end() { this.writableEnded = true; this.done(); },
    done() {},
  };
  return new Promise((resolve, reject) => {
    res.done = () => resolve({ text, headers: res.headers });
    Promise.resolve(ctrl.exportZoneBreaches({ query, user, params: {} }, res, (err) => {
      if (err) reject(err); else resolve({ text, headers: res.headers });
    })).catch(reject);
  });
}

/**
 * Read the file back the way a spreadsheet would. A real parser, not a split:
 * a cell may legitimately contain a comma, a quote or a newline, and the point
 * of several of these tests is exactly such a cell.
 */
function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (s[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const COLUMN_ROW = ['Time (IST)', 'Zone', 'Camera', 'People count', 'Names', 'Severity', 'Status'];

/** The data rows — past the header block and the column row. */
function csvRows(text) {
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => r[0] === COLUMN_ROW[0]);
  expect(head).toBeGreaterThanOrEqual(0);
  expect(rows[head]).toEqual(COLUMN_ROW);
  return rows.slice(head + 1).filter((r) => r.join('') !== '');
}

beforeEach(() => {
  reset();
  store.cameras = [
    { userId: ME, monitorId: 'cam-a', name: 'Server room door' },
    { userId: ME, monitorId: 'cam-b', name: 'Loading bay' },
    { userId: OTHER, monitorId: 'cam-z', name: 'Not yours' },
  ];
  store.zones = [{ id: 'zone-1', userId: ME, name: 'Server room' }];
  seq = 0;
});

/* ───────────────────────────── The list ───────────────────────────────── */

describe('GET /zone-breaches', () => {
  test('only zone intrusions, never another event type', async () => {
    breach();
    breach({ eventType: 'person.unknown' });
    breach({ eventType: 'occupancy.threshold' });
    breach({ eventType: 'tripwire.entry' });

    const { res } = await call(ctrl.listZoneBreaches);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].eventType).toBe('zone.intrusion');
    expect(res.body.pagination.total).toBe(1);
  });

  test('asking for another type cannot widen it', async () => {
    breach();
    breach({ eventType: 'person.unknown' });
    const { res } = await call(ctrl.listZoneBreaches, { eventType: 'person.unknown' });
    expect(res.body.data.map((r) => r.eventType)).toEqual(['zone.intrusion']);
  });

  test('another organisation never appears, however it is asked for', async () => {
    breach({ userId: OTHER, monitorId: 'cam-z' });
    breach({ userId: OTHER, monitorId: 'cam-z' });
    breach();

    const mine = await call(ctrl.listZoneBreaches);
    expect(mine.res.body.pagination.total).toBe(1);
    expect(mine.res.body.data[0].userId).toBe(ME);

    // Naming their camera returns nothing rather than their rows.
    const theirs = await call(ctrl.listZoneBreaches, { monitorIds: 'cam-z' });
    expect(theirs.res.body.data).toEqual([]);
    expect(theirs.res.body.pagination.total).toBe(0);
  });

  test('newest first, with the camera named and the snapshot lifted', async () => {
    breach({ ts: at('2026-11-10', '08:00'), monitorId: 'cam-b' });
    breach({
      ts: at('2026-11-10', '19:30'),
      payload: {
        zoneId: 'zone-1', zoneName: 'Server room', count: 3,
        snapshotUri: 's3://vms-snapshots/t1/zone/x.jpg', matchedName: '3 persons',
      },
    });

    const { res } = await call(ctrl.listZoneBreaches);
    const [first, second] = res.body.data;
    expect(new Date(first.ts) > new Date(second.ts)).toBe(true);
    expect(first).toMatchObject({
      zoneName: 'Server room',
      cameraName: 'Server room door',
      peopleCount: 3,
      status: 'open',
      snapshot_uri: 's3://vms-snapshots/t1/zone/x.jpg',
    });
    expect(second.cameraName).toBe('Loading bay');
    // "3 persons" is the head count, already its own field — not a name.
    expect(first.names).toEqual([]);
  });

  test('a matched identity is reported under names', async () => {
    breach({ payload: { zoneId: 'zone-1', zoneName: 'Server room', count: 1, names: ['Asha', 'Ravi'] } });
    const { res } = await call(ctrl.listZoneBreaches);
    expect(res.body.data[0].names).toEqual(['Asha', 'Ravi']);
  });
});

/* ───────────────────────────── Paging ────────────────────────────────── */

describe('paging past the 200-row ceiling of /events', () => {
  /** 240 breaches over a day, plus 1,000 newer face events to bury them. */
  function busyAccount(count = 240) {
    for (let i = 0; i < count; i += 1) {
      breach({ ts: new Date(at('2026-11-10', '09:00').getTime() + i * 60_000) });
    }
    for (let i = 0; i < 1000; i += 1) {
      breach({ eventType: 'person.match', ts: new Date(at('2026-11-12', '09:00').getTime() + i * 1000) });
    }
    return count;
  }

  test('the total is the database total, not the page', async () => {
    const total = busyAccount();
    const { res } = await call(ctrl.listZoneBreaches, {
      since: at('2026-11-10', '00:00').toISOString(),
      until: at('2026-11-11', '00:00').toISOString(),
    });
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 25, total, totalPages: 10, hasMore: true });
  });

  test('every row is reachable by paging to the end, none twice', async () => {
    const total = busyAccount();
    const params = {
      since: at('2026-11-10', '00:00').toISOString(),
      until: at('2026-11-11', '00:00').toISOString(),
      pageSize: '100',
    };

    const seen = [];
    for (let page = 1; page <= 3; page += 1) {
      const { res } = await call(ctrl.listZoneBreaches, { ...params, page: String(page) });
      expect(res.body.pagination.total).toBe(total);
      seen.push(...res.body.data.map((r) => r.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    const last = await call(ctrl.listZoneBreaches, { ...params, page: '3' });
    expect(last.res.body.pagination.hasMore).toBe(false);
    const beyond = await call(ctrl.listZoneBreaches, { ...params, page: '4' });
    expect(beyond.res.body.data).toEqual([]);
    expect(beyond.res.body.pagination.total).toBe(total);
  });

  test('pageSize defaults to 25 and is capped at 100', async () => {
    busyAccount(150);
    expect(parseZoneBreachFilters({}).pageSize).toBe(25);
    const { res } = await call(ctrl.listZoneBreaches, { pageSize: '5000' });
    expect(res.body.data).toHaveLength(100);
    expect(res.body.pagination.pageSize).toBe(100);
  });
});

/* ───────────────────────────── Filters ───────────────────────────────── */

describe('each filter', () => {
  const totals = (query) => call(ctrl.listZoneBreaches, query).then((r) => r.res.body.pagination.total);

  test('since / until bound the range inclusively', async () => {
    breach({ ts: at('2026-11-09', '23:59') });
    breach({ ts: at('2026-11-10', '00:00') });
    breach({ ts: at('2026-11-10', '23:59') });
    breach({ ts: at('2026-11-11', '00:01') });

    await expect(totals({
      since: at('2026-11-10', '00:00').toISOString(),
      until: at('2026-11-10', '23:59').toISOString(),
    })).resolves.toBe(2);
  });

  test('a range given back to front is the same range', () => {
    const f = parseZoneBreachFilters({ since: '2026-11-11T00:00:00Z', until: '2026-11-01T00:00:00Z' });
    expect(f.since).toBe(Date.parse('2026-11-01T00:00:00Z'));
    expect(f.until).toBe(Date.parse('2026-11-11T00:00:00Z'));
  });

  test('zoneId picks one zone out of the payload', async () => {
    breach({ payload: { zoneId: 'zone-1', zoneName: 'Server room', count: 1 } });
    breach({ payload: { zoneId: 'zone-2', zoneName: 'Switchgear', count: 1 } });
    breach({ payload: { zoneId: 'zone-2', zoneName: 'Switchgear', count: 4 } });

    await expect(totals({ zoneId: 'zone-2' })).resolves.toBe(2);
    await expect(totals({ zoneId: 'zone-1' })).resolves.toBe(1);
    await expect(totals({ zoneId: 'nope' })).resolves.toBe(0);
  });

  test('monitorIds takes a comma-separated list — the site filter', async () => {
    breach({ monitorId: 'cam-a' });
    breach({ monitorId: 'cam-b' });
    breach({ monitorId: 'cam-c' });

    await expect(totals({ monitorIds: 'cam-a,cam-c' })).resolves.toBe(2);
    await expect(totals({ monitorIds: ' cam-b , , cam-b ' })).resolves.toBe(1);
    await expect(totals({ monitorIds: '' })).resolves.toBe(3);
  });

  test('severity', async () => {
    breach({ severity: 'critical' });
    breach({ severity: 'warning' });
    breach({ severity: 'warning' });

    await expect(totals({ severity: 'warning' })).resolves.toBe(2);
    await expect(totals({ severity: 'critical' })).resolves.toBe(1);
    // The table chips say "warn"; the column enum says "warning".
    await expect(totals({ severity: 'warn' })).resolves.toBe(2);
    // Nonsense is ignored rather than returning an empty page.
    await expect(totals({ severity: 'bogus' })).resolves.toBe(3);
  });

  test('status is open or acknowledged', async () => {
    breach();
    breach();
    breach({ acknowledgedAt: at('2026-11-10', '11:00') });

    await expect(totals({ status: 'open' })).resolves.toBe(2);
    await expect(totals({ status: 'acknowledged' })).resolves.toBe(1);
    const { res } = await call(ctrl.listZoneBreaches, { status: 'acknowledged' });
    expect(res.body.data[0].status).toBe('acknowledged');
  });

  test('q searches the zone and the name in the payload', async () => {
    breach({ payload: { zoneId: 'z1', zoneName: 'Server room', count: 1 } });
    breach({ payload: { zoneId: 'z2', zoneName: 'Switchgear bay', count: 1, names: ['Asha Patel'] } });
    breach({ payload: { zoneId: 'z3', zoneName: 'Cold store', count: 1 } });

    await expect(totals({ q: 'server' })).resolves.toBe(1);   // case-insensitive
    await expect(totals({ q: 'asha' })).resolves.toBe(1);      // a name, not a zone
    await expect(totals({ q: 'bay' })).resolves.toBe(1);       // mid-string
    await expect(totals({ q: 'nothing here' })).resolves.toBe(0);
  });

  test('a wildcard in q is text, not a pattern', async () => {
    breach({ payload: { zoneId: 'z1', zoneName: 'Bay_1', count: 1 } });
    breach({ payload: { zoneId: 'z2', zoneName: 'Bay 2', count: 1 } });
    await expect(totals({ q: 'bay_' })).resolves.toBe(1);
    await expect(totals({ q: '%' })).resolves.toBe(0);
  });

  test('filters combine', async () => {
    breach({ monitorId: 'cam-a', severity: 'critical', payload: { zoneId: 'z1', zoneName: 'Server room', count: 1 } });
    breach({ monitorId: 'cam-a', severity: 'warning', payload: { zoneId: 'z1', zoneName: 'Server room', count: 1 } });
    breach({ monitorId: 'cam-b', severity: 'critical', payload: { zoneId: 'z1', zoneName: 'Server room', count: 1 } });

    await expect(totals({ monitorIds: 'cam-a', severity: 'critical', zoneId: 'z1', q: 'server' })).resolves.toBe(1);
  });
});

/* ───────────────────────────── Shifts ───────────────────────────────── */

describe('shift, as hours of the IST day', () => {
  const totals = (query) => call(ctrl.listZoneBreaches, query).then((r) => r.res.body.pagination.total);

  beforeEach(() => {
    // One breach an hour, all day, on two consecutive IST days.
    for (const day of ['2026-11-10', '2026-11-11']) {
      for (let h = 0; h < 24; h += 1) breach({ ts: at(day, `${String(h).padStart(2, '0')}:30`) });
    }
  });

  test('morning and evening are the hours they say, on every day in the range', async () => {
    await expect(totals({ shift: 'morning' })).resolves.toBe(16);   // 06:00-14:00, twice
    await expect(totals({ shift: 'evening' })).resolves.toBe(16);   // 14:00-22:00, twice
    await expect(totals({ shift: 'all' })).resolves.toBe(48);
    await expect(totals({})).resolves.toBe(48);
  });

  test('night wraps midnight: 22:00-24:00 and 00:00-06:00 of each day', async () => {
    await expect(totals({ shift: 'night' })).resolves.toBe(16);     // 8 hours, twice
    const { res } = await call(ctrl.listZoneBreaches, { shift: 'night', pageSize: '100' });
    const hoursIst = res.body.data.map((r) => new Date(new Date(r.ts).getTime() + IST).getUTCHours());
    expect([...new Set(hoursIst)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 22, 23]);
  });

  test('the three shifts partition the day, with nothing counted twice', async () => {
    const [m, e, n] = await Promise.all(['morning', 'evening', 'night'].map((s) => totals({ shift: s })));
    expect(m + e + n).toBe(48);
  });

  test('a shift narrows a range rather than replacing it', async () => {
    await expect(totals({
      shift: 'night',
      since: at('2026-11-10', '00:00').toISOString(),
      until: at('2026-11-10', '23:59').toISOString(),
    })).resolves.toBe(8);
  });

  test('the shift rule is the hour-of-day rule the page uses', () => {
    expect(inShiftIst(at('2026-11-10', '23:00').getTime(), 'night')).toBe(true);
    expect(inShiftIst(at('2026-11-10', '02:00').getTime(), 'night')).toBe(true);
    expect(inShiftIst(at('2026-11-10', '06:00').getTime(), 'night')).toBe(false);
    expect(inShiftIst(at('2026-11-10', '22:00').getTime(), 'night')).toBe(true);
    expect(inShiftIst(at('2026-11-10', '14:00').getTime(), 'morning')).toBe(false);
    expect(inShiftIst(at('2026-11-10', '13:59').getTime(), 'morning')).toBe(true);
    expect(inShiftIst(at('2026-11-10', '03:00').getTime(), 'bogus')).toBe(true);
  });
});

/* ────────────────────────────── The CSV ──────────────────────────────── */

describe('GET /zone-breaches/export', () => {
  test('every row in the range is in the file, with no cap', async () => {
    for (let i = 0; i < 500; i += 1) {
      breach({ ts: new Date(at('2026-11-10', '00:00').getTime() + i * 90_000) });
    }
    for (let i = 0; i < 1000; i += 1) breach({ eventType: 'person.match', ts: at('2026-11-12', '09:00') });

    const { text, headers } = await exportCsv({
      format: 'csv',
      since: at('2026-11-10', '00:00').toISOString(),
      until: at('2026-11-11', '00:00').toISOString(),
    });

    expect(csvRows(text)).toHaveLength(500);
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(headers['Content-Disposition']).toMatch(/^attachment; filename="zone-breaches_/);
  });

  test('the whole range streams in batches, holding only a batch at a time', async () => {
    for (let i = 0; i < 1200; i += 1) breach({ ts: new Date(at('2026-11-10', '00:00').getTime() + i * 1000) });
    stats.queries = 0;
    // A small socket, so every batch goes through the drain path.
    const { text } = await exportCsv({ format: 'csv' }, { id: ME }, { highWater: 4096 });
    expect(csvRows(text)).toHaveLength(1200);
    // 1200 rows at 500 a batch is three batches; the third comes back short
    // and ends the walk. Never one query per row.
    expect(stats.queries).toBeLessThanOrEqual(4);
  });

  test('starts with a UTF-8 BOM and a header block naming the range and filters', async () => {
    breach();
    const { text } = await exportCsv({
      format: 'csv',
      since: at('2026-11-10', '00:00').toISOString(),
      until: at('2026-11-10', '23:59').toISOString(),
      shift: 'night',
      zoneId: 'zone-1',
      monitorIds: 'cam-a',
      severity: 'critical',
      status: 'open',
      q: 'server',
    });

    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('"Date range (IST)","2026-11-10 00:00:00 to 2026-11-10 23:59:00"');
    expect(text).toContain('"Shift","Night (22:00-06:00)"');
    expect(text).toContain('"Zone","Server room"');        // the name, not the id
    expect(text).toContain('"Cameras","Server room door"');
    expect(text).toContain('"Severity","critical"');
    expect(text).toContain('"Status","open"');
    expect(text).toContain('"Search","server"');
  });

  test('an open-ended range says so in the header', async () => {
    breach();
    const { text } = await exportCsv({ format: 'csv' });
    expect(text).toContain('"Date range (IST)","earliest recorded to now"');
    expect(text).toContain('"Zone","All zones"');
    expect(text).toContain('"Cameras","All cameras"');
  });

  test('the columns are the ones the page shows, with the camera named', async () => {
    breach({
      ts: at('2026-11-10', '14:05'),
      severity: 'warning',
      acknowledgedAt: at('2026-11-10', '15:00'),
      monitorId: 'cam-b',
      payload: {
        zoneId: 'zone-1', zoneName: 'Server room', count: 3,
        names: ['Asha', 'Ravi'], unidentified: 0,
      },
    });

    const { text } = await exportCsv({ format: 'csv' });
    expect(csvRows(text)[0]).toEqual([
      '2026-11-10 14:05:00', 'Server room', 'Loading bay', '3', 'Asha, Ravi', 'warning', 'acknowledged',
    ]);
  });

  describe('the Names column', () => {
    const namesCell = async (payload) => {
      breach({ payload: { zoneId: 'zone-1', zoneName: 'Server room', ...payload } });
      const { text } = await exportCsv({ format: 'csv' });
      return csvRows(text)[0][4];
    };

    test('names the people the engine recognised, and tallies the rest', async () => {
      expect(await namesCell({ count: 2, names: ['Asha Patel'], unidentified: 1 }))
        .toBe('Asha Patel + 1 unidentified');
    });

    test('everyone recognised: just the names', async () => {
      expect(await namesCell({ count: 2, names: ['Asha Patel', 'Ravi Kumar'], unidentified: 0 }))
        .toBe('Asha Patel, Ravi Kumar');
    });

    test('nobody recognised: a tally, not a blank cell', async () => {
      expect(await namesCell({ count: 3, names: [], unidentified: 3 })).toBe('3 unidentified');
    });

    test('a row from before names were recorded still shows its head count', async () => {
      // A blank cell here would read as "nobody was in the zone", which is the
      // opposite of what the row says.
      expect(await namesCell({ count: 3, matchedName: '3 persons' })).toBe('3 people');
      expect(await namesCell({ count: 1, matchedName: '1 person' })).toBe('1 person');
    });

    test('"Unknown" is the face stage label, not a name', async () => {
      expect(await namesCell({ count: 2, names: ['Unknown'], unidentified: 1 })).toBe('1 unidentified');
    });

    test('the list is exposed on the JSON row too, for the table', async () => {
      breach({
        payload: {
          zoneId: 'zone-1', zoneName: 'Server room', count: 3,
          names: ['Asha Patel'], unidentified: 2,
        },
      });
      const { res } = await call(ctrl.listZoneBreaches);
      expect(res.body.data[0]).toMatchObject({
        names: ['Asha Patel'],
        unidentified: 2,
        peopleText: 'Asha Patel + 2 unidentified',
        peopleCount: 3,
      });
    });
  });

  test('a cell a spreadsheet would run as a formula is neutralised', async () => {
    store.cameras.push({ userId: ME, monitorId: 'cam-x', name: '=HYPERLINK("http://evil","Camera")' });
    breach({
      monitorId: 'cam-x',
      payload: {
        zoneId: 'zone-9',
        zoneName: '+Zone',
        count: 1,
        names: ['@SUM(A1:A9)', '-Ravi', '=cmd|calc'],
      },
    });

    const { text } = await exportCsv({ format: 'csv' });
    const [row] = csvRows(text);
    const [, zone, camera, , names] = row;
    expect(zone).toBe("'+Zone");
    expect(camera).toBe('\'=HYPERLINK("http://evil","Camera")');
    // The joined cell leads with @, so the cell is prefixed once.
    expect(names).toBe("'@SUM(A1:A9), -Ravi, =cmd|calc");
    // Nothing a spreadsheet would evaluate reaches the start of any cell.
    for (const cell of row) expect(/^[=+\-@\t\r]/.test(cell)).toBe(false);
    // The quote inside the camera name is doubled on the wire, so the cell is
    // still one cell: the parser above put the comma in it back together.
    expect(text).toContain('""http://evil""');
    expect(row).toHaveLength(COLUMN_ROW.length);
  });

  test('a quote in a name does not break the row', async () => {
    breach({ payload: { zoneId: 'z', zoneName: 'Bay "A"', count: 1 } });
    const { text } = await exportCsv({ format: 'csv' });
    expect(text).toContain('"Bay ""A"""');
    expect(csvRows(text)).toHaveLength(1);
  });

  test('the same filters narrow the file', async () => {
    breach({ ts: at('2026-11-10', '02:00'), monitorId: 'cam-a' });   // night
    breach({ ts: at('2026-11-10', '10:00'), monitorId: 'cam-a' });   // morning
    breach({ ts: at('2026-11-10', '02:30'), monitorId: 'cam-b' });   // night, other camera
    breach({ eventType: 'person.unknown', ts: at('2026-11-10', '02:15'), monitorId: 'cam-a' });

    const { text } = await exportCsv({ format: 'csv', shift: 'night', monitorIds: 'cam-a' });
    expect(csvRows(text)).toHaveLength(1);
    expect(csvRows(text)[0][0]).toBe('2026-11-10 02:00:00');
  });

  test('a format other than csv is refused before anything is written', async () => {
    breach();
    await expect(exportCsv({ format: 'pdf' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('another organisation is not in the file', async () => {
    breach({ userId: OTHER, monitorId: 'cam-z' });
    breach();
    const { text } = await exportCsv({ format: 'csv' });
    expect(csvRows(text)).toHaveLength(1);
    expect(csvRows(text)[0][2]).toBe('Server room door');
  });

  test('an empty range is a file with a header and no rows, not an error', async () => {
    const { text } = await exportCsv({ format: 'csv' });
    expect(text).toContain('"Time (IST)"');
    expect(csvRows(text)).toHaveLength(0);
  });
});

/* ──────────────────── Done when: 500 breaches, all 500 ─────────────────── */

test('a date range with 500 breaches returns all 500, across pages and in the CSV', async () => {
  const start = at('2026-11-10', '00:00').getTime();
  for (let i = 0; i < 500; i += 1) breach({ ts: new Date(start + i * 60_000) });
  // Buried under newer events of every other kind, as on a live account.
  for (let i = 0; i < 1000; i += 1) {
    breach({ eventType: 'person.match', ts: new Date(at('2026-11-15', '09:00').getTime() + i * 1000) });
  }

  const range = {
    since: at('2026-11-10', '00:00').toISOString(),
    until: at('2026-11-11', '00:00').toISOString(),
  };

  const paged = [];
  for (let page = 1; page <= 20; page += 1) {
    const { res } = await call(ctrl.listZoneBreaches, { ...range, pageSize: '25', page: String(page) });
    expect(res.body.pagination.total).toBe(500);
    paged.push(...res.body.data.map((r) => r.id));
  }
  expect(new Set(paged).size).toBe(500);

  const { text } = await exportCsv({ ...range, format: 'csv' });
  expect(csvRows(text)).toHaveLength(500);
  expect(new Set(csvRows(text).map((r) => r[0])).size).toBe(500);
});

/* ─────────────────────── The feature gate (403) ───────────────────────── */

describe('without the restricted_zone feature', () => {
  test('both routes are behind the gate, and the gate answers 403', async () => {
    const requireFeature = require('../src/middleware/requireFeature');
    const { assertFeature } = require('../src/services/entitlements.service');
    const AppError = require('../src/utils/AppError');

    assertFeature.mockRejectedValue(
      new AppError('Restricted zones is not enabled for this account.', 403),
    );

    const gate = requireFeature('restricted_zone');
    const err = await new Promise((resolve) => {
      gate({ user: { id: ME } }, {}, resolve);
    });
    expect(err).toMatchObject({ statusCode: 403 });
    expect(assertFeature).toHaveBeenCalledWith(ME, ['restricted_zone']);
  });

  test('the router mounts both paths and gates them the same way', () => {
    jest.resetModules();
    const gates = [];
    jest.doMock('../src/middleware/requireFeature', () => (...keys) => {
      const mw = (req, res, next) => next();
      mw.featureKeys = keys;
      return mw;
    });
    jest.doMock('../src/middleware/authenticate', () => (req, res, next) => next());
    jest.doMock('../src/middleware/requireAiCapability', () => (req, res, next) => next());

    const router = require('../src/routes/ai.routes');
    for (const layer of router.stack) {
      const path = layer.route?.path;
      if (!path || !path.startsWith('/zone-breaches')) continue;
      gates.push([path, layer.route.stack.map((s) => s.handle.featureKeys).filter(Boolean).flat()]);
    }

    // Asserted as a rule rather than a list, so a route added to this family
    // later cannot ship ungated just because nobody updated the expectation.
    expect(gates.map(([path]) => path).sort()).toEqual([
      '/zone-breaches',
      '/zone-breaches/:id/resolve',
      '/zone-breaches/export',
      '/zone-breaches/trends',
    ]);
    for (const [path, keys] of gates) {
      expect([path, keys]).toEqual([path, ['restricted_zone']]);
    }
  });
});
