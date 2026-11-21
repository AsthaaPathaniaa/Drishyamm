// The NVR session budget: every pull on a recorder is counted in one place,
// interactive playback claims the NVR, and background work only gets what is
// left below the limit minus the reserve (2026-11-21: 14 uncoordinated
// sessions starved the lab NVR to 15% of real time).

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockSessionsOnHost = jest.fn(() => 0);
jest.mock('../src/services/liveRelay.service', () => ({ sessionsOnHost: (h) => mockSessionsOnHost(h) }));

process.env.NVR_MAX_SESSIONS = '6';
process.env.NVR_INTERACTIVE_RESERVE = '2';
process.env.NVR_SESSION_LIMITS = '10.0.0.9=3, bad, 10.0.0.8 = 12';
process.env.NVR_LOAD_REFRESH_MS = '0';
process.env.NVR_CLAIM_GRACE_MS = '0';   // no Stream Service polling in tests

const nvrLoad = require('../src/services/nvrLoad.service');

const HOST = '10.0.0.1';
beforeEach(() => { nvrLoad._internals.reset(); mockSessionsOnHost.mockReturnValue(0); });

test('per-NVR limits override the default; malformed entries are ignored', () => {
  expect(nvrLoad.limitFor(HOST)).toBe(6);
  expect(nvrLoad.limitFor('10.0.0.9')).toBe(3);
  expect(nvrLoad.limitFor('10.0.0.8')).toBe(12);
  expect(nvrLoad._internals.parseLimits('a=1,b,c=x,=2').size).toBe(1);
});

test('usage adds direct relays, Stream Service pulls and our own leases', () => {
  mockSessionsOnHost.mockReturnValue(2);
  nvrLoad._internals.media.set(HOST, 3);
  const release = nvrLoad.track(HOST, 'backfill');
  nvrLoad.track(HOST, 'export');
  expect(nvrLoad.usage(HOST)).toMatchObject({
    total: 7, limit: 6, full: true, byKind: { relay: 2, media: 3, backfill: 1, export: 1 },
  });
  release();
  release();   // idempotent
  expect(nvrLoad.usage(HOST).total).toBe(6);
});

test('background work only gets the room below limit minus reserve', () => {
  expect(nvrLoad.backgroundRoom(HOST)).toBe(4);       // 6 - 2 reserve
  nvrLoad._internals.media.set(HOST, 3);
  expect(nvrLoad.backgroundRoom(HOST)).toBe(1);
  nvrLoad.track(HOST, 'backfill');
  expect(nvrLoad.backgroundRoom(HOST)).toBe(0);       // the last 2 are for playback
  nvrLoad.track(HOST, 'playback');
  expect(nvrLoad.backgroundRoom(HOST)).toBe(0);       // never negative
});

test("a claim pauses only that user's background work on that NVR, and announces itself", () => {
  const seen = [];
  nvrLoad.events.on('interactive', (h, u) => seen.push([h, u]));
  const release = nvrLoad.claim(HOST, 'u1');
  expect(seen).toEqual([[HOST, 'u1']]);
  expect(nvrLoad.interactiveActive(HOST, 'u1')).toBe(true);
  expect(nvrLoad.interactiveActive(HOST, 'u2')).toBe(false);
  expect(nvrLoad.interactiveActive(HOST)).toBe(true);           // anyone
  expect(nvrLoad.backgroundRoom(HOST, 'u1')).toBe(0);
  expect(nvrLoad.backgroundRoom(HOST, 'u2')).toBe(4);           // other users carry on
  expect(nvrLoad.backgroundRoom('10.0.0.2', 'u1')).toBe(4);
  release();
  release();   // a double release must not free someone else's claim
  expect(nvrLoad.interactiveActive(HOST, 'u1')).toBe(false);
});

test('claims are counted: the NVR stays claimed until the last one ends', () => {
  const a = nvrLoad.claim(HOST, 'u1');
  const b = nvrLoad.claim(HOST, 'u1');
  const other = nvrLoad.claim(HOST, 'u2');
  a();
  expect(nvrLoad.interactiveActive(HOST, 'u1')).toBe(true);
  b();
  expect(nvrLoad.interactiveActive(HOST, 'u1')).toBe(false);
  expect(nvrLoad.interactiveActive(HOST, 'u2')).toBe(true);
  other();
});

test('no host means nothing to count or claim', () => {
  expect(nvrLoad.backgroundRoom(null)).toBe(0);
  expect(() => nvrLoad.track(null, 'x')()).not.toThrow();
  expect(() => nvrLoad.claim(undefined)()).not.toThrow();
});

test('after the last claim ends the NVR stays claimed for the grace period', () => {
  jest.isolateModules(() => {
    jest.useFakeTimers();
    process.env.NVR_CLAIM_GRACE_MS = '20000';
    const load = require('../src/services/nvrLoad.service');
    const seen = [];
    load.events.on('released', (h) => seen.push(h));
    load.claim(HOST, 'u1')();
    expect(load.interactiveActive(HOST, 'u1')).toBe(true);   // a seek lands in here
    const again = load.claim(HOST, 'u1');                    // new replay: grace cancelled
    again();
    jest.advanceTimersByTime(19_999);
    expect(seen).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(seen).toEqual([HOST]);
    expect(load.interactiveActive(HOST, 'u1')).toBe(false);
    process.env.NVR_CLAIM_GRACE_MS = '0';
    jest.useRealTimers();
  });
});
