// A direct relay nobody is watching (a warm-keeper pin) whose NVR stalls is
// released, not restarted: on a saturated recorder each restart is one more
// session on the same uplink (2026-11-21, lab NVR at 15% of real time while
// the watchdog restarted 8 unwatched sub relays every ~30 s). A relay with a
// viewer still restarts as before.

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/config/env', () => ({ streamService: { rtspHost: 'stream-service', rtspPort: 8554 } }));
jest.mock('../src/services/transcoder.service', () => ({
  paceNvrOpen: jest.fn(async () => {}), OPEN_PRIORITY: { main: 0, view: 1, warm: 2 }, isRunning: () => false,
}));
jest.mock('../src/services/drishyamStreaming.service', () => ({ api: { get: jest.fn(async () => ({ data: { ready: false } })) } }));
const mockProcs = [];
jest.mock('node:child_process', () => ({
  spawn: jest.fn(() => {
    const { EventEmitter } = require('node:events');
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = jest.fn();
    mockProcs.push(p);
    return p;
  }),
}));

const relay = require('../src/services/liveRelay.service');
const { relays } = relay._internals;
const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => { for (const p of [...relays.keys()]) relay.stopRelay(p); mockProcs.length = 0; jest.useRealTimers(); });

async function startPinned(path) {
  relay.pin(path, { monitorId: 'm1', variant: 'sub', nvrUrl: `rtsp://u:p@10.0.0.1:554/${path}` }, Date.now() + 60_000);
  await flush(); await flush();
  expect(mockProcs).toHaveLength(1);
  return relays.get(path);
}

test('an unwatched direct relay that stalls is released, not restarted', async () => {
  const r = await startPinned('cam_a_sub');
  expect(r.direct).toBe(true);
  r.killReason = 'no video for 11 s while connected (watchdog)';
  mockProcs[0].emit('exit', null);
  expect(relays.has('cam_a_sub')).toBe(false);
  expect(relay.sessionsOnHost('10.0.0.1')).toBe(0);
});

test('a watched relay that stalls is restarted', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const r = await startPinned('cam_b_sub');
  r.viewers.add({ close: () => {}, send: () => {}, readyState: 1, bufferedAmount: 0 });
  r.killReason = 'no video for 11 s while connected (watchdog)';
  mockProcs[0].emit('exit', null);
  expect(relays.has('cam_b_sub')).toBe(true);
  jest.advanceTimersByTime(20_000);
  await flush(); await flush();
  expect(mockProcs).toHaveLength(2);
});
