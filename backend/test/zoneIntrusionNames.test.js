/**
 * The zone engine now records WHO it saw.
 *
 * `handleFrame` already read `box.name` to check the zone's allow-list and
 * then discarded it, so a breach could only ever say "1 person". These tests
 * pin the two halves of the change: the names that land in the payload, and
 * the fact that collecting them did not alter when — or how often — an alert
 * fires, which is the anti-flood behaviour the whole engine is built around.
 */

jest.mock('../src/models', () => ({
  RestrictedZone: { findAll: jest.fn() },
  AIEvent: { create: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  getEntitlements: jest.fn(),
  allowsAny: jest.fn(() => true),
}));
jest.mock('../src/services/alertEngine', () => ({ maybeAlert: jest.fn(() => Promise.resolve()) }));

const { RestrictedZone, AIEvent } = require('../src/models');
const { getEntitlements } = require('../src/services/entitlements.service');
const { emit, EVENTS } = require('../src/events/bus');
const zoneIntrusion = require('../src/services/zoneIntrusion.service');

zoneIntrusion.init();   // subscribes handleFrame to AI_LIVE_OVERLAY

// A person's box, bottom-centre inside the zone below. `name` is what the face
// stage matched IN THIS FRAME — absent when it matched nothing.
const box = (name, x = 50) => ({
  bbox: [x * 10 - 20, 100, x * 10 + 20, 500],
  ...(name === undefined ? {} : { name }),
});

const frameOf = (boxes) => ({ monitorId: 'cam-a', frameW: 1000, frameH: 1000, boxes });

// A Sequelize row as the engine reads it: it groups by `row.monitorId` and
// stores `row.toJSON()`, so the mock has to answer both.
const zoneRow = (zone) => ({ ...zone, toJSON: () => zone });

let zoneSeq = 0;
/** A fresh zone and account per test: the engine caches both by id. */
function scenario({ allowed = [], dwellSec = 0, maxOccupancy = 0, rect } = {}) {
  zoneSeq += 1;
  const userId = `user-${zoneSeq}`;
  const zone = {
    id: `zone-${zoneSeq}`,
    monitorId: 'cam-a',
    name: 'Switch room',
    enabled: true,
    schedule: 'always',
    priority: 'critical',
    allowed,
    dwellSec,
    maxOccupancy,
    shape: 'rectangle',
    rect: rect || { x: 0, y: 0, w: 100, h: 100 },
  };
  RestrictedZone.findAll.mockResolvedValue([zoneRow(zone)]);
  return { userId, zone };
}

/** Let the engine's promise chain (zone load → alert → create) settle. */
async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function sendFrame(userId, boxes) {
  emit(EVENTS.AI_LIVE_OVERLAY, { userId, frame: frameOf(boxes) });
  await flush();
}

/**
 * One confirmed entry. The engine needs the people to have been inside for the
 * zone's dwell (at least CONFIRM_MS) before it calls it an entry, so that is
 * two frames with time between them — exactly as it was before this change.
 */
async function enter(userId, boxes) {
  await sendFrame(userId, boxes);
  jest.advanceTimersByTime(1000);
  await sendFrame(userId, boxes);
}

const lastPayload = () => AIEvent.create.mock.calls.at(-1)[0].payload;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  getEntitlements.mockResolvedValue({ aiEnabled: true, features: ['restricted_zone'] });
  AIEvent.create.mockResolvedValue({ toJSON: () => ({ id: 'evt-1' }) });
});

afterEach(() => {
  jest.useRealTimers();
});

/* ──────────────────────────── The names ───────────────────────────────── */

test('one named and one unknown person: one name, unidentified 1', async () => {
  const { userId } = scenario();
  await enter(userId, [box('Asha Patel'), box(undefined, 60)]);

  expect(AIEvent.create).toHaveBeenCalledTimes(1);
  expect(AIEvent.create.mock.calls[0][0].eventType).toBe('zone.intrusion');
  expect(lastPayload()).toMatchObject({ names: ['Asha Patel'], unidentified: 1, count: 2 });
});

test('an authorised person is not listed, and is not an intruder', async () => {
  const { userId } = scenario({ allowed: ['Ravi Kumar'] });
  await enter(userId, [box('Asha Patel'), box('Ravi Kumar', 60)]);

  const payload = lastPayload();
  expect(payload.names).toEqual(['Asha Patel']);
  expect(payload.names).not.toContain('Ravi Kumar');
  expect(payload.unidentified).toBe(0);
  // The allowed person occupies the space but is not counted as an intruder.
  expect(payload.count).toBe(1);
});

test('the allow-list is matched without regard to case', async () => {
  const { userId } = scenario({ allowed: ['ravi kumar'] });
  await enter(userId, [box('Ravi Kumar'), box('Asha Patel', 60)]);
  expect(lastPayload().names).toEqual(['Asha Patel']);
});

test('nobody recognised: no names, and every intruder counted as unidentified', async () => {
  const { userId } = scenario();
  await enter(userId, [box(undefined, 40), box(undefined, 60)]);
  expect(lastPayload()).toMatchObject({ names: [], unidentified: 2, count: 2 });
});

test('"Unknown" is the face stage\'s label for no match, not a name', async () => {
  const { userId } = scenario();
  await enter(userId, [box('Unknown'), box('Asha Patel', 60)]);
  expect(lastPayload()).toMatchObject({ names: ['Asha Patel'], unidentified: 1 });
});

test('the same person in two boxes is named once', async () => {
  const { userId } = scenario();
  await enter(userId, [box('Asha Patel', 40), box('Asha Patel', 60)]);
  expect(lastPayload().names).toEqual(['Asha Patel']);
  expect(lastPayload().count).toBe(2);
});

test('a blank name is unidentified, not an empty entry in the list', async () => {
  const { userId } = scenario();
  await enter(userId, [box('   '), box('Asha Patel', 60)]);
  expect(lastPayload()).toMatchObject({ names: ['Asha Patel'], unidentified: 1 });
});

test('a person outside the zone is neither counted nor named', async () => {
  // The zone covers the left 40% of the frame: x=20% is inside, x=80% is not.
  const { userId } = scenario({ rect: { x: 0, y: 0, w: 40, h: 100 } });
  await enter(userId, [box('Asha Patel', 20), box('Ravi Kumar', 80)]);
  expect(lastPayload()).toMatchObject({ names: ['Asha Patel'], unidentified: 0, count: 1 });
});

/* ───────────────── What must NOT have changed ─────────────────────────── */

test('the dedup subject and the alert sentence are untouched', async () => {
  const { userId, zone } = scenario();
  await enter(userId, [box('Asha Patel'), box(undefined, 60)]);
  const payload = lastPayload();
  // The alert engine dedups on personId and prints matchedName; changing
  // either would either flood or re-word every existing notification.
  expect(payload.personId).toBe(`zone:${zone.id}`);
  expect(payload.matchedName).toBe('2 persons');
});

test('a capacity zone is unchanged: no names, because allowed people are not collected', async () => {
  const { userId } = scenario({ maxOccupancy: 1 });
  // Three polls to confirm the breach (OCCUPANCY_CONFIRM_POLLS), as before.
  for (let i = 0; i < 3; i += 1) await sendFrame(userId, [box('Asha Patel'), box('Ravi Kumar', 60)]);

  expect(AIEvent.create).toHaveBeenCalledTimes(1);
  const payload = lastPayload();
  expect(payload.capacity).toBe(1);
  // Absent, not empty: the count is everyone inside, and the authorised
  // people among them were never named, so a list here would be partial.
  expect(payload.names).toBeUndefined();
  expect(payload.unidentified).toBeUndefined();
});

test('one confirmed entry is still one alert, named or not', async () => {
  const named = scenario();
  await enter(named.userId, [box('Asha Patel')]);
  expect(AIEvent.create).toHaveBeenCalledTimes(1);

  AIEvent.create.mockClear();
  const anonymous = scenario();
  await enter(anonymous.userId, [box(undefined)]);
  expect(AIEvent.create).toHaveBeenCalledTimes(1);
});

test('staying in the zone does not re-alert, however many names arrive', async () => {
  const { userId } = scenario();
  await enter(userId, [box('Asha Patel')]);
  expect(AIEvent.create).toHaveBeenCalledTimes(1);

  // Four more minutes of frames, the cast changing each time: still quiet,
  // because the zone is already occupied (ZONE_REALERT_MS is five minutes).
  for (const who of ['Asha Patel', 'Ravi Kumar', undefined, 'Meera Shah']) {
    jest.advanceTimersByTime(60_000);
    await sendFrame(userId, [box(who)]);
  }
  expect(AIEvent.create).toHaveBeenCalledTimes(1);
});

test('an unarmed zone still fires nothing', async () => {
  const { userId, zone } = scenario();
  RestrictedZone.findAll.mockResolvedValue([zoneRow({ ...zone, enabled: false })]);
  await enter(userId, [box('Asha Patel')]);
  expect(AIEvent.create).not.toHaveBeenCalled();
});

test('only authorised people inside is not a breach at all', async () => {
  const { userId } = scenario({ allowed: ['Asha Patel'] });
  await enter(userId, [box('Asha Patel')]);
  expect(AIEvent.create).not.toHaveBeenCalled();
});

test('the dwell is still required before an entry is confirmed', async () => {
  const { userId } = scenario({ dwellSec: 5 });
  await sendFrame(userId, [box('Asha Patel')]);
  jest.advanceTimersByTime(1000);
  await sendFrame(userId, [box('Asha Patel')]);
  expect(AIEvent.create).not.toHaveBeenCalled();   // 1s < 5s dwell

  jest.advanceTimersByTime(5000);
  await sendFrame(userId, [box('Asha Patel')]);
  expect(AIEvent.create).toHaveBeenCalledTimes(1);
  expect(lastPayload().names).toEqual(['Asha Patel']);
});
