/**
 * Resolving a breach, and the trends behind the table — both now on the
 * server, because both used to be per-browser.
 *
 * A resolution lived in the operator's own localStorage, so the day shift
 * could not see what the night shift had closed out. Trends were computed
 * over the rows the browser happened to be holding, which after server-side
 * paging is one page of a range that may be five hundred.
 */

jest.mock('../src/models', () => require('./helpers/aiEventStore').models);
jest.mock('../src/services/entitlements.service', () => ({
  assertAiLicence: jest.fn(),
  assertFeature: jest.fn(),
}));
jest.mock('../src/config/redis', () => ({ getClient: () => null }));

const { store, reset } = require('./helpers/aiEventStore');
const ctrl = require('../src/controllers/ai.controller');

const ME = 'user-1';
const OTHER = 'user-2';
const IST = 330 * 60_000;

const at = (ymd, hhmm) => new Date(Date.parse(`${ymd}T${hhmm}:00Z`) - IST);

let seq = 0;
function breach(over = {}) {
  seq += 1;
  const row = {
    id: `evt-${String(seq).padStart(4, '0')}`,
    userId: ME,
    eventType: 'zone.intrusion',
    severity: 'critical',
    monitorId: 'cam-a',
    ts: at('2026-11-10', '10:00'),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    snapshotKey: null,
    payload: { zoneId: 'zone-1', zoneName: 'Server room', count: 1 },
    ...over,
  };
  store.events.push(row);
  return row;
}

/** Run a handler; resolves with the JSON body or the error it passed on. */
function call(handler, { query = {}, params = {}, user = { id: ME } } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader() {},
    json(b) { this.body = b; return this; },
  };
  return new Promise((resolve, reject) => {
    res.json = (b) => { res.body = b; resolve({ res }); return res; };
    Promise.resolve(handler({ query, params, user }, res, (err) => resolve({ res, err })))
      .catch(reject);
  });
}

beforeEach(() => {
  reset();
  store.cameras = [
    { userId: ME, monitorId: 'cam-a', name: 'Server room door' },
    { userId: ME, monitorId: 'cam-b', name: 'Loading bay' },
    { userId: OTHER, monitorId: 'cam-z', name: 'Not yours' },
  ];
  seq = 0;
});

/* ───────────────────────────── Resolving ─────────────────────────────── */

describe('POST /zone-breaches/:id/resolve', () => {
  test('resolving in one session is what the next session reads', async () => {
    const row = breach();

    // Session A closes it out.
    const { res } = await call(ctrl.resolveZoneBreach, { params: { id: row.id } });
    expect(res.body.data.status).toBe('resolved');

    // Session B — a different browser, a fresh list request — sees the same.
    const list = await call(ctrl.listZoneBreaches);
    expect(list.res.body.data[0]).toMatchObject({
      id: row.id,
      status: 'resolved',
      resolvedBy: ME,
    });
    expect(list.res.body.data[0].resolvedAt).toBeTruthy();
  });

  test('an unseen breach is acknowledged on the way to resolved', async () => {
    const row = breach({ acknowledgedAt: null });
    await call(ctrl.resolveZoneBreach, { params: { id: row.id } });
    // "Resolved, but nobody ever looked at it" is not a state the log shows.
    expect(row.acknowledgedAt).toBeTruthy();
    expect(row.acknowledgedBy).toBe(ME);
    expect(row.resolvedAt).toBeTruthy();
  });

  test('an acknowledgement already recorded keeps its own name and time', async () => {
    const acked = at('2026-11-10', '10:30');
    const row = breach({ acknowledgedAt: acked, acknowledgedBy: 'someone-else' });
    await call(ctrl.resolveZoneBreach, { params: { id: row.id } });
    expect(row.acknowledgedBy).toBe('someone-else');
    expect(row.acknowledgedAt).toBe(acked);
    expect(row.resolvedBy).toBe(ME);
  });

  test('resolving twice does not overwrite who resolved it', async () => {
    const row = breach();
    await call(ctrl.resolveZoneBreach, { params: { id: row.id } });
    const firstAt = row.resolvedAt;

    // The second click — the other operator's browser was showing a stale
    // row, or the first response was lost. Not an error, and not a reason to
    // restamp it: the record keeps who actually closed it and when.
    const { res } = await call(ctrl.resolveZoneBreach, { params: { id: row.id } });
    expect(res.body.data.status).toBe('resolved');
    expect(row.resolvedBy).toBe(ME);
    expect(row.resolvedAt).toBe(firstAt);
  });

  test("another organisation's row is a 404, not a 403", async () => {
    const theirs = breach({ userId: OTHER, monitorId: 'cam-z' });
    const { err } = await call(ctrl.resolveZoneBreach, { params: { id: theirs.id } });
    // 404, because there is nothing to tell them about: a 403 would confirm
    // the id exists.
    expect(err).toMatchObject({ statusCode: 404 });
    expect(theirs.resolvedAt).toBeNull();
  });

  test('an id that is not a zone breach is a 404', async () => {
    const face = breach({ eventType: 'person.unknown' });
    const { err } = await call(ctrl.resolveZoneBreach, { params: { id: face.id } });
    expect(err).toMatchObject({ statusCode: 404 });
    expect(face.resolvedAt).toBeNull();

    const missing = await call(ctrl.resolveZoneBreach, { params: { id: 'nope' } });
    expect(missing.err).toMatchObject({ statusCode: 404 });
  });
});

/* ──────────────────────── Status, list and CSV ───────────────────────── */

describe('the three states', () => {
  const totals = (status) => call(ctrl.listZoneBreaches, { query: { status } })
    .then((r) => r.res.body.pagination.total);

  beforeEach(() => {
    breach();                                                     // open
    breach({ acknowledgedAt: at('2026-11-10', '11:00') });        // acknowledged
    breach({
      acknowledgedAt: at('2026-11-10', '11:00'),
      resolvedAt: at('2026-11-10', '12:00'),
      resolvedBy: ME,
    });                                                           // resolved
  });

  test('each status filter returns only its own rows', async () => {
    await expect(totals('open')).resolves.toBe(1);
    await expect(totals('acknowledged')).resolves.toBe(1);
    await expect(totals('resolved')).resolves.toBe(1);
    await expect(totals('all')).resolves.toBe(3);
  });

  test('a resolved breach is not still in the acknowledged queue', async () => {
    const { res } = await call(ctrl.listZoneBreaches, { query: { status: 'acknowledged' } });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('acknowledged');
    expect(res.body.data[0].resolvedAt).toBeNull();
  });

  test('the list reports the status of every row', async () => {
    const { res } = await call(ctrl.listZoneBreaches);
    expect(res.body.data.map((r) => r.status).sort())
      .toEqual(['acknowledged', 'open', 'resolved']);
  });
});

/* ───────────────────────────── Trends ────────────────────────────────── */

describe('GET /zone-breaches/trends', () => {
  const trends = (query = {}) => call(ctrl.zoneBreachTrends, { query }).then((r) => r.res.body.data);

  test('only zone intrusions are counted', async () => {
    breach({ ts: at('2026-11-10', '03:00') });
    breach({ ts: at('2026-11-10', '03:30') });
    // Everything else the feed carries, at the same hour, on the same camera.
    breach({ eventType: 'person.unknown', ts: at('2026-11-10', '03:10') });
    breach({ eventType: 'occupancy.threshold', ts: at('2026-11-10', '03:20') });
    breach({ eventType: 'tripwire.entry', ts: at('2026-11-10', '03:40') });

    const t = await trends();
    expect(t.total).toBe(2);
    expect(t.hours[3].count).toBe(2);
    expect(t.topCameras).toEqual([
      { id: 'cam-a', monitorId: 'cam-a', name: 'Server room door', count: 2 },
    ]);
  });

  test('another organisation is not counted either', async () => {
    breach();
    breach({ userId: OTHER, monitorId: 'cam-z' });
    breach({ userId: OTHER, monitorId: 'cam-z' });
    const t = await trends();
    expect(t.total).toBe(1);
    expect(t.topCameras.map((c) => c.monitorId)).toEqual(['cam-a']);
  });

  test('hours are the IST hour of the day, and every hour is present', async () => {
    breach({ ts: at('2026-11-10', '23:30') });   // 23:30 IST
    breach({ ts: at('2026-11-11', '00:15') });   // the next IST day, hour 0
    breach({ ts: at('2026-11-12', '23:45') });   // 23 again, another day

    const t = await trends();
    expect(t.hours).toHaveLength(24);
    expect(t.hours[23].count).toBe(2);
    expect(t.hours[0].count).toBe(1);
    expect(t.hours[9].count).toBe(0);            // a quiet hour is a zero, not a gap
    expect(t.peak).toMatchObject({ hour: 23, count: 2, label: '23:00' });
  });

  test('cameras are named and ranked, most-affected first', async () => {
    for (let i = 0; i < 3; i += 1) breach({ monitorId: 'cam-b' });
    breach({ monitorId: 'cam-a' });

    const t = await trends();
    expect(t.topCameras).toEqual([
      { id: 'cam-b', monitorId: 'cam-b', name: 'Loading bay', count: 3 },
      { id: 'cam-a', monitorId: 'cam-a', name: 'Server room door', count: 1 },
    ]);
  });

  test('it describes the WHOLE filtered range, not a page of it', async () => {
    for (let i = 0; i < 300; i += 1) {
      breach({ ts: new Date(at('2026-11-10', '04:00').getTime() + i * 1000) });
    }
    const t = await trends();
    expect(t.total).toBe(300);
    expect(t.hours[4].count).toBe(300);

    // And the list it sits above shows 25 of them.
    const list = await call(ctrl.listZoneBreaches);
    expect(list.res.body.data).toHaveLength(25);
    expect(list.res.body.pagination.total).toBe(300);
  });

  test('it answers the same filters as the list', async () => {
    breach({ ts: at('2026-11-10', '03:00'), monitorId: 'cam-a', severity: 'critical' });
    breach({ ts: at('2026-11-10', '03:00'), monitorId: 'cam-b', severity: 'critical' });
    breach({ ts: at('2026-11-10', '10:00'), monitorId: 'cam-a', severity: 'warning' });

    await expect(trends({ monitorIds: 'cam-a' }).then((t) => t.total)).resolves.toBe(2);
    await expect(trends({ severity: 'warning' }).then((t) => t.total)).resolves.toBe(1);
    // Night is 22:00–06:00 IST, so only the 03:00 pair.
    await expect(trends({ shift: 'night' }).then((t) => t.total)).resolves.toBe(2);
    await expect(trends({ zoneId: 'zone-1' }).then((t) => t.total)).resolves.toBe(3);
    await expect(trends({ zoneId: 'other' }).then((t) => t.total)).resolves.toBe(0);
  });

  test('an empty range is zeros, not a missing panel', async () => {
    const t = await trends();
    expect(t.total).toBe(0);
    expect(t.peak).toBeNull();
    expect(t.topCameras).toEqual([]);
    expect(t.hours.every((h) => h.count === 0)).toBe(true);
  });
});
