// A camera coming back online queues its reference picture; a backend restart
// re-discovering cameras that were already online must not re-grab the fleet.

jest.mock('ioredis', () => jest.fn());
jest.mock('../src/services/streamBus.service', () => ({ publish: jest.fn(async () => {}) }));
jest.mock('../src/services/streamQuality.service', () => ({ observe: jest.fn(() => ({})) }));
jest.mock('../src/services/cameraReachability.service', () => ({ isReachable: jest.fn(() => true), start: jest.fn(), stop: jest.fn() }));
jest.mock('../src/services/liveSnapshot.service', () => ({ queueOnline: jest.fn() }));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const liveSnapshot = require('../src/services/liveSnapshot.service');
const { S, _internals: { queueReferencePictures } } = require('../src/services/streamSupervisor.service');

const t = (fromState, toState, status) => ({ camera: { id: 'id-a', monitorId: 'a', status }, fromState, toState });

test('offline → online queues a picture', () => {
  queueReferencePictures([t(S.OFFLINE, S.STREAMING, 'offline')]);
  expect(liveSnapshot.queueOnline).toHaveBeenCalledWith(expect.objectContaining({ monitorId: 'a' }), { onlyIfMissing: false });
});

test('reachable-but-idle (standby) counts as coming online', () => {
  queueReferencePictures([t(S.OFFLINE, S.STANDBY, 'offline')]);
  expect(liveSnapshot.queueOnline).toHaveBeenCalledTimes(1);
});

test('after a restart (row already online) only a missing picture is filled in', () => {
  queueReferencePictures([t(S.PENDING, S.STREAMING, 'online')]);
  expect(liveSnapshot.queueOnline).toHaveBeenCalledWith(expect.anything(), { onlyIfMissing: true });
});

test('going offline, or online → online, queues nothing', () => {
  queueReferencePictures([
    t(S.STREAMING, S.OFFLINE, 'online'),
    t(S.STREAMING, S.DEGRADED, 'online'),
    t(S.STANDBY, S.STREAMING, 'online'),
  ]);
  expect(liveSnapshot.queueOnline).not.toHaveBeenCalled();
});
