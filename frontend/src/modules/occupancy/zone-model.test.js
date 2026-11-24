/**
 * Tests for the zone <-> camera model.
 *
 * Runs on Node's built-in test runner (`npm test`). The model is pure so the
 * rules that decide a zone's count, what each camera is told, and when a save
 * is refused can be checked as plain tables, without the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROKEN_NO_CAMERA, cameraPayload, colorsOnCamera, countOn, normalizeZone, normalizeZones,
  notCountingText, zoneProblems, zonesNotCounting, zonesOnCamera,
} from './zone-model.js';
import { buildMacro, buildRegionZones } from './occupancy-data.js';

const BOX = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];
const BOX2 = [[0.5, 0.5], [0.9, 0.5], [0.9, 0.9], [0.5, 0.9]];

test('a record saved before the model keeps its key, its shape, and only the camera it was counted from', () => {
  const z = normalizeZone('cam-a', { monitorId: 'cam-a', cameras: ['cam-a', 'cam-b'], boundary: BOX, name: 'Lobby' });
  assert.equal(z.id, 'cam-a');
  assert.deepEqual(z.cameras, ['cam-a']);
  assert.deepEqual(z.boundaries, { 'cam-a': BOX });
});

test('a new-model record is kept as stored', () => {
  const z = normalizeZone('zone-1', { id: 'zone-1', cameras: ['a', 'b'], boundaries: { a: BOX, b: BOX2 } });
  assert.deepEqual(z.cameras, ['a', 'b']);
  assert.equal(z.monitorId, 'a');
  assert.deepEqual(z.boundary, BOX);
});

test('zones on a camera come back in a stable order, so colours do not move on rename', () => {
  const zones = normalizeZones({
    'zone-b': { id: 'zone-b', name: 'Aaa', cameras: ['m'], boundaries: { m: BOX } },
    'zone-a': { id: 'zone-a', name: 'Zzz', cameras: ['m'], boundaries: { m: BOX2 } },
  });
  assert.deepEqual(zonesOnCamera(zones, 'm').map((z) => z.id), ['zone-a', 'zone-b']);
  const c = colorsOnCamera(zones, 'm');
  assert.notEqual(c['zone-a'], c['zone-b']);
});

test('camera payload: a lone single-camera zone arms the camera limit; shared cameras do not', () => {
  const solo = normalizeZones({ z: { id: 'z', name: 'Z', maxCapacity: 12, cameras: ['m'], boundaries: { m: BOX } } });
  assert.equal(cameraPayload(solo, 'm').threshold, 12);
  assert.equal(cameraPayload(solo, 'm').zones.length, 1);

  const shared = normalizeZones({
    z1: { id: 'z1', name: 'Queue', maxCapacity: 12, cameras: ['m'], boundaries: { m: BOX } },
    z2: { id: 'z2', name: 'Desk', maxCapacity: 4, cameras: ['m'], boundaries: { m: BOX2 } },
  });
  const p = cameraPayload(shared, 'm');
  assert.equal(p.threshold, 0);
  assert.deepEqual(p.zones.map((z) => z.name), ['Queue', 'Desk']);

  const spanning = normalizeZones({ h: { id: 'h', name: 'Hall', maxCapacity: 200, cameras: ['a', 'b'], boundaries: { a: BOX, b: BOX2 } } });
  assert.equal(cameraPayload(spanning, 'a').threshold, 0);
  assert.equal(cameraPayload(spanning, 'b').zones[0].points, BOX2);
});

test('count: whole view, per-zone breakdown by id or name, and no double counting on a shared camera', () => {
  const stream = { id: 'm', counts: { heads: 9 }, zone_counts: { z1: 3, Desk: 2 } };
  const solo = normalizeZones({ z: { id: 'z', name: 'Z', cameras: ['m'], boundaries: { m: [] } } });
  assert.equal(countOn(stream, solo.z, solo), 9);

  const shared = normalizeZones({
    z1: { id: 'z1', name: 'Queue', cameras: ['m'], boundaries: { m: BOX } },
    z2: { id: 'z2', name: 'Desk', cameras: ['m'], boundaries: { m: BOX2 } },
    z3: { id: 'z3', name: 'Lost', cameras: ['m'], boundaries: { m: BOX2 } },
  });
  assert.equal(countOn(stream, shared.z1, shared), 3);
  assert.equal(countOn(stream, shared.z2, shared), 2);
  assert.equal(countOn(stream, shared.z3, shared), 0);
});

test('a zone spanning two cameras sums its slices; cameras in a zone lose their whole-view card', () => {
  const streams = [
    { id: 'a', status: 'online', counts: { heads: 5 }, zone_counts: { hall: 4 } },
    { id: 'b', status: 'online', counts: { heads: 7 }, zone_counts: { hall: 6 } },
    { id: 'c', status: 'online', counts: { heads: 2 } },
  ];
  const rooms = { hall: { id: 'hall', name: 'Hall', maxCapacity: 20, cameras: ['a', 'b'], boundaries: { a: BOX, b: BOX2 } } };
  const zones = buildRegionZones(streams, {}, rooms);
  const hall = zones.find((z) => z.id === 'hall');
  assert.equal(hall.count, 10);
  assert.deepEqual(hall.cameraIds, ['a', 'b']);
  assert.deepEqual(zones.map((z) => z.id).sort(), ['c', 'hall']);
});

test('save is refused for the cases that would count wrong', () => {
  const saved = normalizeZones({
    whole: { id: 'whole', name: 'Lobby', cameras: ['m'], boundaries: { m: [] } },
  });
  const draft = { id: 'new', name: 'lobby', cameras: ['m'], boundaries: { m: [] } };
  const problems = zoneProblems(draft, saved);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /already called/);
  assert.match(problems[1], /draw this zone's boundary/);
  assert.match(problems[2], /covers the whole of m/);

  const fine = zoneProblems({ id: 'new', name: 'Queue', cameras: ['m'], boundaries: { m: BOX } },
    normalizeZones({ z: { id: 'z', name: 'Lobby', cameras: ['m'], boundaries: { m: BOX2 } } }));
  assert.deepEqual(fine, []);
});

// ── A zone with no camera left on it ────────────────────────────────────────
// It used to be deleted from every surface at once by `return null` here, with
// nothing anywhere to say so -- the shape of "I created zones and I see none".

test('a record with no camera is kept and marked, not dropped', () => {
  const z = normalizeZone('zone-x', { id: 'zone-x', name: 'Server room', cameras: [], boundaries: {} });
  // A record with NO `boundaries` field is the pre-model shape, and its key is
  // its camera -- that one is not broken, and must not start reading as such.
  assert.equal(normalizeZone('cam-a', { name: 'Lobby', cameras: [] }).broken, null);
  assert.deepEqual(normalizeZone('cam-a', { name: 'Lobby', cameras: [] }).cameras, ['cam-a']);
  assert.equal(z.broken, BROKEN_NO_CAMERA);
  assert.equal(z.name, 'Server room');
  assert.deepEqual(z.cameras, []);
  // '' rather than undefined, which JSON.stringify would drop from the cache.
  assert.equal(z.monitorId, '');
  assert.deepEqual(z.boundary, []);

  // And it survives the map every reader loads.
  const zones = normalizeZones({ 'zone-x': { id: 'zone-x', name: 'Server room', cameras: [], boundaries: {} } });
  assert.deepEqual(Object.keys(zones), ['zone-x']);
  assert.equal(zones['zone-x'].broken, BROKEN_NO_CAMERA);

  // Input that is not a record at all is still nothing.
  assert.equal(normalizeZone('k', null), null);
  assert.equal(normalizeZone('k', 'nope'), null);
});

test('a working zone carries no broken mark', () => {
  const z = normalizeZone('zone-1', { id: 'zone-1', cameras: ['a'], boundaries: { a: BOX } });
  assert.equal(z.broken, null);
  assert.equal(z.monitorId, 'a');
});

test('a broken zone reaches no camera, is drawn nowhere, and counts nothing', () => {
  const rooms = {
    // `boundaries` present, `cameras` empty: a new-model record that lost its
    // camera. (Without a `boundaries` field at all it would be read as a
    // pre-model record keyed BY its camera, which is a different thing.)
    'zone-x': { id: 'zone-x', name: 'Server room', maxCapacity: 4, cameras: [], boundaries: {} },
    lobby: { id: 'lobby', name: 'Lobby', maxCapacity: 50, cameras: ['m1'], boundaries: { m1: BOX } },
  };
  const zones = normalizeZones(rooms);

  // Not on any camera: so not in the payload pushed to one, and never drawn.
  assert.deepEqual(zonesOnCamera(zones, 'm1').map((z) => z.id), ['lobby']);
  assert.deepEqual(cameraPayload(zones, 'm1').zones.map((z) => z.id), ['lobby']);
  assert.equal(cameraPayload(zones, 'm1').zoneCount, 1);
  assert.equal(colorsOnCamera(zones, 'm1')['zone-x'], undefined);
  // Nor on a camera of its own, whatever id is asked for.
  assert.deepEqual(zonesOnCamera(zones, 'zone-x'), []);
  assert.deepEqual(cameraPayload(zones, 'zone-x').zones, []);

  // And no count, no capacity, nowhere in the site totals.
  const streams = [{ id: 'm1', status: 'online', counts: { heads: 3 } }];
  const regionZones = buildRegionZones(streams, {}, rooms);
  assert.deepEqual(regionZones.map((z) => z.id), ['lobby']);
  const macro = buildMacro({ lineZones: [], regionZones, congestion: [], footfall: null });
  assert.equal(macro.live, 3);
  assert.equal(macro.capacity, 50);
});

test('saving a zone with no camera is refused, and says why', () => {
  const problems = zoneProblems({ id: 'zone-x', name: 'Server room', cameras: [], boundaries: {} }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Add a camera to this zone/);
  // A normal draft is unaffected.
  assert.deepEqual(zoneProblems({ id: 'z', name: 'Queue', cameras: ['m'], boundaries: { m: BOX } }, {}), []);
});

// ── Zones that exist but nothing is counting ────────────────────────────────

test('the zones nothing is counting are the saved ones the live list lost', () => {
  const rooms = {
    lobby: { id: 'lobby', name: 'Lobby', cameras: ['m1'], boundaries: { m1: BOX } },
    server: { id: 'server', name: 'Server room', cameras: ['m9'], boundaries: { m9: BOX } },
    store: { id: 'store', name: 'Store', cameras: ['m8'], boundaries: { m8: BOX } },
    'zone-x': { id: 'zone-x', name: 'Orphan', cameras: [], boundaries: {} },
  };
  const live = buildRegionZones([{ id: 'm1', status: 'online', counts: { heads: 2 } }], {}, rooms);
  const out = zonesNotCounting(rooms, live);
  // The lobby is counting, so it is not one of these. The orphan has no camera
  // to switch on, so it is not one either -- it is broken, and the rail says so.
  assert.deepEqual(out.map((z) => z.id).sort(), ['server', 'store']);

  // Nothing counting at all: every camera-bearing zone is one.
  assert.deepEqual(zonesNotCounting(rooms, []).map((z) => z.id).sort(), ['lobby', 'server', 'store']);
  // Everything counting: none.
  assert.deepEqual(zonesNotCounting(rooms, [{ id: 'lobby' }, { id: 'server' }, { id: 'store' }]), []);
  assert.deepEqual(zonesNotCounting({}, []), []);
});

test('the empty state names how many, and says nothing at all when there are none', () => {
  // Word for word: this line is what the panel adds beneath "No space is
  // counting yet", and null is what keeps that empty state untouched.
  assert.equal(notCountingText(3), '3 zones are set up on cameras that are not counting.');
  assert.equal(notCountingText(1), '1 zone is set up on a camera that is not counting.');
  assert.equal(notCountingText(0), null);
  assert.equal(notCountingText(), null);
  assert.equal(notCountingText(-1), null);
});

/* ── the contract with the detector ──────────────────────────────────────────
 *
 * Every bug found in this feature has been a BOUNDARY bug -- two correct
 * components disagreeing -- and a unit test on either side of a boundary
 * cannot see the boundary. A zone saved here reached the camera registry and
 * was never applied by the detector, while this file's tests and the
 * detector's tests were both green.
 *
 * So contracts/headcount-camera-row.json holds one camera row as the whole
 * chain produces it, and three tests read it:
 *
 *   this one                                  the editor BUILDS these zones
 *   backend/test/headcountChain.test.js       the backend EMITS this row
 *   ai/head-count/tests/test_vms_contract.py  the detector PARSES it
 *
 * None of them can pass alone. Editing the file to make one pass defeats it.
 */
import { readFileSync } from 'node:fs';

const CONTRACT = JSON.parse(readFileSync(
  new URL('../../../../contracts/headcount-camera-row.json', import.meta.url), 'utf8',
));

/** The two zones of the contract camera, as they are SAVED in this module. */
const contractSaved = () => ({
  'zone-reception': {
    id: 'zone-reception',
    name: 'Reception',
    cameras: ['7'],
    boundaries: { 7: CONTRACT.camera.settings.headcount.zones[0].points },
  },
  'zone-waiting': {
    id: 'zone-waiting',
    name: 'Waiting area',
    cameras: ['7'],
    boundaries: { 7: CONTRACT.camera.settings.headcount.zones[1].points },
  },
});

test('cameraPayload builds exactly the zones the detector is given', () => {
  const payload = cameraPayload(normalizeZones(contractSaved()), '7');
  assert.deepEqual(payload.zones, CONTRACT.camera.settings.headcount.zones);
});

test('and the camera-level limit it sends is the contract\'s', () => {
  // 0, because two zones share this view: a camera-level limit only means
  // something when one zone IS the camera. The contract records why.
  const payload = cameraPayload(normalizeZones(contractSaved()), '7');
  assert.equal(payload.threshold, CONTRACT.expect.threshold);
  assert.equal(payload.zoneCount, CONTRACT.expect.zoneCount);
});

test('one zone alone on one camera DOES push its capacity as the limit', () => {
  // The other half of the same rule, kept out of the contract because the
  // contract camera is the two-zone case.
  const solo = {
    'zone-reception': {
      id: 'zone-reception',
      name: 'Reception',
      cameras: ['7'],
      maxCapacity: 12,
      boundaries: { 7: CONTRACT.camera.settings.headcount.zones[0].points },
    },
  };
  const payload = cameraPayload(normalizeZones(solo), '7');
  assert.equal(payload.threshold, 12);
  assert.equal(payload.zoneCount, 1);
});

test('the zone names the detector keys its breakdown by are these ones', () => {
  // zone_counts comes back keyed by NAME, so a name that does not survive the
  // push is a chip the wall can never match to a zone.
  const payload = cameraPayload(normalizeZones(contractSaved()), '7');
  assert.deepEqual(payload.zones.map((z) => z.name), CONTRACT.expect.zoneNames);
});
