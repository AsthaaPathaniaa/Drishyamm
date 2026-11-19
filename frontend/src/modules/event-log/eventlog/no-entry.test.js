/**
 * Tests for the No-entry mode of the Event Log (no-entry.js).
 *
 * Runs on Node's built-in test runner (`npm test`), so what is checked here is
 * the logic that decides WHAT IS ASKED FOR — the locked event type, the
 * translation from this page's filter vocabulary into the server's, the camera
 * scope, and the paging arithmetic the two exports depend on. Those are the
 * parts a wrong answer would show as missing rows, a count that disagrees with
 * the table, or an export that does not match the filters on screen.
 *
 * The route gate is checked against core/nav/entitlements.js, which is the
 * thing that actually decides whether this page opens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_ENTRY_MODE, NO_ENTRY_TYPE, PDF_ROW_LIMIT, SERVER_PAGE_MAX, SHIFT_OPTIONS, STATUS_OPTIONS,
  exportName, exportParams, isNoEntry, monitorIdsFor, pdfOverflowNote, pdfPagePlan, scopeIsEmpty,
  zoneBreachParams,
} from './no-entry.js';
import { SHIFTS } from '../../occupancy/breaches/breach-model.js';
import { routeAllowed } from '../../../core/nav/entitlements.js';

const SINCE = '2026-11-10T00:00:00.000Z';
const UNTIL = '2026-11-10T23:59:59.999Z';
const range = (over = {}) => zoneBreachParams({ since: SINCE, until: UNTIL, ...over });

/* ─────────────────────────── The locked type ──────────────────────────── */

test('the mode shows restricted-zone entries and nothing else', () => {
  assert.equal(NO_ENTRY_TYPE, 'zone.intrusion');
  assert.ok(isNoEntry(NO_ENTRY_MODE));
  assert.ok(!isNoEntry(null));
  assert.ok(!isNoEntry('event-log'));
});

test('an unrecognised face is a different type, so it can never be asked for', () => {
  // The old page filtered client-side over a mixed feed and let
  // person.unknown, loitering and watchlist hits in beside real intrusions.
  // Here the type is not a parameter at all: nothing a caller passes can
  // widen it, because the request carries no event type and the endpoint
  // answers only zone.intrusion (see backend/test/zoneBreaches.test.js).
  for (const type of ['person.unknown', 'loitering', 'person.alert', 'alert', 'unknown']) {
    assert.notEqual(NO_ENTRY_TYPE, type);
  }
  const params = zoneBreachParams({ eventType: 'person.unknown', type: 'loitering' });
  assert.ok(!('eventType' in params));
  assert.ok(!('type' in params));
});

/* ───────────────────────── Filters → the server ───────────────────────── */

test('the date range goes to the server untouched', () => {
  assert.equal(range().since, SINCE);
  assert.equal(range().until, UNTIL);
});

test('an unset filter is omitted rather than sent as "all"', () => {
  const p = range({ zoneId: 'all', severity: 'all', status: 'all', shift: 'all', query: '  ' });
  assert.deepEqual(Object.keys(p).sort(), ['page', 'pageSize', 'since', 'until']);
});

test('severity: the page grades high/medium/info, the column stores critical/warning/info', () => {
  assert.equal(range({ severity: 'high' }).severity, 'critical');
  assert.equal(range({ severity: 'medium' }).severity, 'warning');
  assert.equal(range({ severity: 'info' }).severity, 'info');
  // Nonsense is dropped, so a bad value widens the view rather than emptying it.
  assert.ok(!('severity' in range({ severity: 'spicy' })));
});

test('status: the log says new, the server says open', () => {
  assert.equal(range({ status: 'new' }).status, 'open');
  assert.equal(range({ status: 'acknowledged' }).status, 'acknowledged');
  // A real server state now (resolved_at on the event), so every operator
  // filtering by it gets the same rows.
  assert.equal(range({ status: 'resolved' }).status, 'resolved');
  assert.ok(!('status' in range({ status: 'all' })));
  assert.ok(!('status' in range({ status: 'invented' })));
});

test('the page offers all three states, in the order they happen', () => {
  assert.deepEqual(STATUS_OPTIONS.map((s) => s.id), ['all', 'new', 'acknowledged', 'resolved']);
  // Each one the page can offer is one the server understands.
  for (const { id } of STATUS_OPTIONS.filter((o) => o.id !== 'all')) {
    assert.ok('status' in range({ status: id }), `${id} must reach the server`);
  }
});

test('zone goes by id, not by name', () => {
  assert.equal(range({ zoneId: 'zone-7' }).zoneId, 'zone-7');
  assert.ok(!('zoneId' in range({ zoneId: '' })));
});

test('the search box is trimmed and sent as q', () => {
  assert.equal(range({ query: '  loading bay ' }).q, 'loading bay');
  assert.ok(!('q' in range({ query: '' })));
});

test('the shift is sent by id, for the server to apply in IST', () => {
  assert.equal(range({ shift: 'night' }).shift, 'night');
  assert.ok(!('shift' in range({ shift: 'all' })));
});

test('the shift choices are breach-model\'s, so the page and the server agree', () => {
  assert.deepEqual(SHIFT_OPTIONS.map((s) => s.id), SHIFTS.map((s) => s.id));
  assert.deepEqual(SHIFT_OPTIONS.map((s) => s.id), ['all', 'morning', 'evening', 'night']);
});

test('every filter travels together', () => {
  const p = range({
    monitorIds: ['cam-a', 'cam-b'],
    zoneId: 'zone-1',
    severity: 'high',
    status: 'new',
    shift: 'night',
    query: 'dock',
    page: 3,
    pageSize: 50,
  });
  assert.deepEqual(p, {
    since: SINCE,
    until: UNTIL,
    monitorIds: 'cam-a,cam-b',
    zoneId: 'zone-1',
    severity: 'critical',
    status: 'open',
    shift: 'night',
    q: 'dock',
    page: 3,
    pageSize: 50,
  });
});

/* ──────────────────────────── Camera scope ────────────────────────────── */

test('a chosen camera wins over the site it is in', () => {
  const ids = monitorIdsFor({ camera: 'cam-b', siteCodes: new Set(['cam-a', 'cam-b', 'cam-c']) });
  assert.deepEqual(ids, ['cam-b']);
});

test('a site contributes every camera in it', () => {
  assert.deepEqual(monitorIdsFor({ camera: 'all', siteCodes: new Set(['cam-a', 'cam-b']) }), ['cam-a', 'cam-b']);
});

test('no site and no camera is no camera filter at all', () => {
  assert.equal(monitorIdsFor({ camera: 'all', siteCodes: null }), null);
  assert.equal(monitorIdsFor({}), null);
  assert.ok(!('monitorIds' in range({ monitorIds: null })));
});

test('a site with no cameras can match nothing — and is not the same as no filter', () => {
  const ids = monitorIdsFor({ camera: 'all', siteCodes: new Set() });
  assert.deepEqual(ids, []);
  assert.ok(scopeIsEmpty(ids));
  // Not the same as "no constraint": sending nothing would show the estate.
  assert.ok(!scopeIsEmpty(null));
  assert.ok(!scopeIsEmpty(['cam-a']));
});

/* ───────────────────────────── Paging ─────────────────────────────────── */

test('page and page size default to the first 25 and are bounded', () => {
  assert.equal(range().page, 1);
  assert.equal(range().pageSize, 25);
  assert.equal(range({ page: 0 }).page, 1);
  assert.equal(range({ page: -4 }).page, 1);
  // The endpoint refuses a bigger page than this.
  assert.equal(range({ pageSize: 5000 }).pageSize, SERVER_PAGE_MAX);
  assert.equal(range({ pageSize: 0 }).pageSize, 25);
});

test('a 500-breach range can be walked to the end, one page at a time', () => {
  const total = 500;
  const size = 25;
  const pages = Math.ceil(total / size);
  assert.equal(pages, 20);

  // Every page is a distinct request for a distinct slice, and the last one
  // lands exactly on the end: no page asks past the range, and none repeats.
  const asked = [];
  for (let page = 1; page <= pages; page += 1) {
    const p = range({ page, pageSize: size });
    asked.push(p.page);
    // The filters do not drift as the pages advance — only the page number.
    assert.equal(p.pageSize, size);
    assert.equal(p.since, SINCE);
  }
  assert.deepEqual(asked, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((pages - 1) * size + size, total);
});

/* ───────────────────────────── Exports ───────────────────────────────── */

test('the CSV export carries the filters on screen and no page of its own', () => {
  // The export covers the whole filtered range, so the page the operator
  // happens to be on is stripped rather than sent.
  const onScreen = range({
    monitorIds: ['cam-a'], severity: 'high', shift: 'night', query: 'dock', page: 7,
  });
  assert.equal(onScreen.page, 7);
  assert.deepEqual(exportParams(onScreen), {
    since: SINCE, until: UNTIL, monitorIds: 'cam-a', severity: 'critical', shift: 'night', q: 'dock',
  });
});

test('the PDF loads the whole range in 100-row pages, up to its ceiling', () => {
  assert.deepEqual(pdfPagePlan(0), []);
  assert.deepEqual(pdfPagePlan(30), [1]);
  assert.deepEqual(pdfPagePlan(100), [1]);
  assert.deepEqual(pdfPagePlan(101), [1, 2]);
  assert.deepEqual(pdfPagePlan(500), [1, 2, 3, 4, 5]);
  assert.equal(pdfPagePlan(PDF_ROW_LIMIT).length, 10);
  // Past the ceiling it stops at the ceiling rather than fetching forever.
  assert.equal(pdfPagePlan(25_000).length, 10);
});

test('a PDF cut short says so and points at the CSV', () => {
  assert.equal(pdfOverflowNote(500, 500), null);
  assert.equal(pdfOverflowNote(120, 1000), null);
  const note = pdfOverflowNote(4812, 1000);
  assert.match(note, /1,000/);
  assert.match(note, /4,812/);
  assert.match(note, /CSV/);
});

test('the saved file is named for the range it covers', () => {
  assert.equal(exportName('2026-11-10', '2026-11-10'), 'zone-breaches-2026-11-10');
  assert.equal(exportName('2026-11-10', '2026-11-17'), 'zone-breaches-2026-11-10_to_2026-11-17');
});

/* ──────────────────────── Who may open the page ───────────────────────── */

test('restricted_zone opens No-entry areas without event_log', () => {
  // The two pages are now one component, but the gate is per PATH. An account
  // licensed for restricted zones whose admin has switched the full log off
  // ('!event_log' — event_log is a DEFAULT_ON key, so off is explicit) must
  // still reach /occupancy/breaches, and must still not reach /event-logs.
  const user = { aiEnabled: true, features: ['restricted_zone', '!event_log'] };
  assert.equal(routeAllowed('/occupancy/breaches', user), true);
  assert.equal(routeAllowed('/event-logs', user), false);
});

test('a curated account keeps the log it was not switched off', () => {
  const user = { aiEnabled: true, features: ['restricted_zone'] };
  assert.equal(routeAllowed('/occupancy/breaches', user), true);
  assert.equal(routeAllowed('/event-logs', user), true);
});

test('event_log alone does not open No-entry areas', () => {
  const user = { aiEnabled: true, features: ['event_log'] };
  assert.equal(routeAllowed('/event-logs', user), true);
  assert.equal(routeAllowed('/occupancy/breaches', user), false);
});

test('restricted zones are an AI feature, so a Basic VMS plan cannot open the page', () => {
  const user = { aiEnabled: false, features: ['restricted_zone'] };
  assert.equal(routeAllowed('/occupancy/breaches', user), false);
});
