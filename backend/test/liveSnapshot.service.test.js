// Stills for the Monitor Wall editor must never become a recorder flood: a
// live path is reused for free, a direct grab is one-at-a-time per NVR host,
// and a cached still is shared instead of re-grabbed. The saved reference
// picture outlives restarts and offline spells without costing the NVR more.

const mockSpawned = [];
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    mockSpawned.push(proc);
    return proc;
  }),
}));

const mockReady = new Set();
jest.mock('../src/services/drishyamStreaming.service', () => ({
  api: {
    get: jest.fn(async (url) => ({ data: { ready: mockReady.has(url.split('/').pop()) } })),
  },
  listPaths: jest.fn(async () => [...mockReady].map((name) => ({ name, ready: true }))),
  pathName: (id) => `cam_${id}`,
  subPathName: (id) => `cam_${id}_sub`,
  getRtspEgressUrl: (id, sub) => `rtsp://stream-service:8554/cam_${id}${sub ? '_sub' : ''}`,
  deriveSubPath: (p) => (p === '/Streaming/Channels/101' ? '/Streaming/Channels/102' : null),
  buildRtspUrl: ({ host, port, path, username, password }) => `rtsp://${username}:${password}@${host}:${port}${path}`,
}));

const mockS3 = new Map();
jest.mock('../src/services/s3.service', () => ({
  putObject: jest.fn(async (key, body) => { mockS3.set(key, body); return key; }),
  getReadStream: jest.fn(async (key) => {
    if (!mockS3.has(key)) throw new Error('NoSuchKey');
    return { stream: require('stream').Readable.from([mockS3.get(key)]) };
  }),
  deleteRecording: jest.fn(async (key) => { mockS3.delete(key); }),
}));

let mockSegment = null;
jest.mock('../src/services/localRecordings.service', () => ({
  latestSegment: jest.fn(async () => mockSegment),
}));

let mockNvrCams = [];
const mockRows = new Map();    // camera id → row, as the DB has it
jest.mock('../src/models', () => ({
  Camera: {
    findAll: jest.fn(async ({ where }) => (where.host ? mockNvrCams : where.id.map((id) => mockRows.get(id)).filter(Boolean))),
    findByPk: jest.fn(async (id) => mockRows.get(id) || null),
  },
  sequelize: {
    query: jest.fn(async (sql, { replacements } = {}) => {
      if (/^\s*SELECT/.test(sql)) {
        return [...mockRows.values()]
          .filter((c) => c.settings?.lastSnapshot?.capturedAt < replacements.cutoff)
          .slice(0, replacements.limit)
          .map((c) => ({ id: c.id }));
      }
      if (/JSON_REMOVE/.test(sql)) {
        const row = mockRows.get(replacements.id);
        const hit = row?.settings?.lastSnapshot?.capturedAt === replacements.capturedAt;
        if (hit) delete row.settings.lastSnapshot;
        return [undefined, hit ? 1 : 0];
      }
      return [[], {}];
    }),
  },
}));

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const s3 = require('../src/services/s3.service');
const { sequelize } = require('../src/models');
const logger = require('../src/config/logger');
const snapshots = require('../src/services/liveSnapshot.service');
const { Camera } = require('../src/models');
const { pickSource, scrub, jpegSize, cache, saved, queued } = snapshots._internals;

const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const due = async () => { await new Promise((r) => setTimeout(r, 5)); await flush(); };  // a job queued with no delay
const finish = (proc, body = 'jpeg') => { proc.stdout.emit('data', Buffer.from(body)); proc.emit('close', 0); };
const saves = () => sequelize.query.mock.calls.filter(([sql]) => /JSON_SET/.test(sql));
const lastSaved = () => JSON.parse(saves().at(-1)[1].replacements.meta);
const atBudget = () => {
  mockNvrCams = 'bcdefghij'.split('').map((id) => ({ monitorId: id }));
  mockNvrCams.forEach(({ monitorId }) => mockReady.add(`cam_${monitorId}`));
};
const savedPicture = (ageMs, extra = {}) => ({
  lastSnapshot: { key: 'snapshots/u1/a/latest.jpg', capturedAt: new Date(Date.now() - ageMs).toISOString(), ...extra },
});

const cam = (id, extra = {}) => ({
  id: `id-${id}`, userId: 'u1', monitorId: id, host: '10.0.0.9', port: 554, path: '/Streaming/Channels/101',
  username: 'admin', password: 'p@ss', status: 'online', lastSeenAt: new Date('2026-11-01T10:00:00Z'),
  settings: null, ...extra,
});

beforeEach(() => {
  mockSpawned.length = 0; mockReady.clear(); mockS3.clear(); mockRows.clear();
  cache.clear(); saved.clear();
  for (const job of queued.values()) clearTimeout(job.timer);
  queued.clear();
  mockSegment = null; mockNvrCams = [];
});
afterEach(() => jest.useRealTimers());

describe('pickSource', () => {
  test('reads the live sub-stream from Stream Service when someone is already watching', async () => {
    mockReady.add('cam_a_sub');
    expect(await pickSource(cam('a'))).toEqual({ kind: 'live', url: 'rtsp://stream-service:8554/cam_a_sub' });
  });

  test('falls back to the live main path when only that is ready', async () => {
    mockReady.add('cam_a');
    expect((await pickSource(cam('a'))).url).toBe('rtsp://stream-service:8554/cam_a');
  });

  test('otherwise goes direct to the camera sub-stream, not through Stream Service', async () => {
    const src = await pickSource(cam('a'));
    expect(src.kind).toBe('direct');
    expect(src.host).toBe('10.0.0.9');
    expect(src.url).toBe('rtsp://admin:p@ss@10.0.0.9:554/Streaming/Channels/102');
  });

  test('uses the main path when the vendor has no sub-stream', async () => {
    const src = await pickSource(cam('a', { path: '/live' }));
    expect(src.url).toMatch(/\/live$/);
  });

  test('a grab to be saved goes live > recording > direct', async () => {
    mockSegment = { file: '/recordings/cam_a/2026-11-11/10-00-00-000000.mp4', mtimeMs: Date.now() - 60 * 1000, startedAtMs: Date.now() - 5 * 60 * 1000 };
    mockReady.add('cam_a_sub');
    expect((await pickSource(cam('a'), { persist: true })).kind).toBe('live');

    mockReady.clear();
    const rec = await pickSource(cam('a'), { persist: true });
    expect(rec).toMatchObject({ kind: 'recording', file: mockSegment.file, at: mockSegment.startedAtMs });

    mockSegment.mtimeMs = Date.now() - 11 * 60 * 1000;   // older than 10 min
    expect((await pickSource(cam('a'), { persist: true })).kind).toBe('direct');
  });

  test('an ordinary viewer grab never reads a recording', async () => {
    mockSegment = { file: '/x.mp4', mtimeMs: Date.now(), startedAtMs: Date.now() };
    expect((await pickSource(cam('a'))).kind).toBe('direct');
  });

  test('a direct grab to be saved is deferred when the NVR already serves 9 ready paths', async () => {
    mockNvrCams = 'bcdefghij'.split('').map((id) => ({ monitorId: id }));
    mockNvrCams.forEach(({ monitorId }) => mockReady.add(`cam_${monitorId}`));
    expect(await pickSource(cam('a'), { persist: true })).toEqual({ kind: 'deferred', readyPaths: 9 });

    mockReady.delete('cam_j');
    expect((await pickSource(cam('a'), { persist: true })).kind).toBe('direct');
  });

  test('ready paths of cameras on other NVRs do not count', async () => {
    mockNvrCams = [{ monitorId: 'b' }];
    'bcdefghijk'.split('').forEach((id) => mockReady.add(`cam_${id}`));
    expect((await pickSource(cam('a'), { persist: true })).kind).toBe('direct');
  });
});

test('scrub removes credentials from anything headed for a log, even a raw @ in the password', () => {
  expect(scrub('rtsp://admin:p@ss@10.0.0.9:554/x: Connection refused')).toBe('rtsp://***@10.0.0.9:554/x: Connection refused');
  expect(scrub('rtsp://admin:p%40ss@10.0.0.9:554/Streaming/Channels/102')).toBe('rtsp://***@10.0.0.9:554/Streaming/Channels/102');
});

test('jpegSize reads width and height from the start-of-frame marker', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  expect(jpegSize(jpeg)).toEqual({ width: 640, height: 360 });
  expect(jpegSize(Buffer.from('jpeg'))).toEqual({ width: null, height: null });
});

describe('getSnapshot', () => {
  test('shares one grab between simultaneous requests and serves the cache after', async () => {
    const first = snapshots.getSnapshot(cam('a'));
    const second = snapshots.getSnapshot(cam('a'));
    await flush();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0]);
    const [a, b] = await Promise.all([first, second]);
    expect(a.jpeg.toString()).toBe('jpeg');
    expect(b.stale).toBe(false);

    await snapshots.getSnapshot(cam('a'));
    expect(mockSpawned).toHaveLength(1);
  });

  test('decodes from a keyframe, so a still is never a grey half-frame', async () => {
    const p = snapshots.getSnapshot(cam('k'));
    await flush();
    const args = require('child_process').spawn.mock.calls.at(-1)[1];
    const beforeInput = args.slice(0, args.indexOf('-i'));
    expect(beforeInput).toEqual(expect.arrayContaining(['-skip_frame', 'nokey']));
    finish(mockSpawned.at(-1));
    await p;
  });

  test('never runs two direct grabs against the same recorder at once', async () => {
    const one = snapshots.getSnapshot(cam('a'));
    const two = snapshots.getSnapshot(cam('b'));
    await flush();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0]);
    await one;
    await flush();
    expect(mockSpawned).toHaveLength(2);
    finish(mockSpawned[1]);
    await two;
  });

  test('grabs from different recorders in parallel', async () => {
    const one = snapshots.getSnapshot(cam('a'));
    const two = snapshots.getSnapshot(cam('b', { host: '10.0.0.10' }));
    await flush();
    expect(mockSpawned).toHaveLength(2);
    mockSpawned.forEach((p) => finish(p));
    await Promise.all([one, two]);
  });

  test('does not try an offline camera, and serves an older still when it has one', async () => {
    await expect(snapshots.getSnapshot(cam('a', { status: 'offline' }))).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(mockSpawned).toHaveLength(0);

    cache.set('a', { jpeg: Buffer.from('old'), at: Date.now() - 5 * 60 * 1000, source: 'direct' });
    const shot = await snapshots.getSnapshot(cam('a', { status: 'offline' }));
    expect(shot.stale).toBe(true);
    expect(shot.jpeg.toString()).toBe('old');
  });

  test('falls back to the older still when a grab fails', async () => {
    cache.set('a', { jpeg: Buffer.from('old'), at: Date.now() - 5 * 60 * 1000, source: 'direct' });
    const p = snapshots.getSnapshot(cam('a'));
    await flush();
    mockSpawned[0].emit('close', 1);
    const shot = await p;
    expect(shot.stale).toBe(true);
  });
});

describe('saved picture', () => {
  test('the first grab of a camera is saved to its one S3 object', async () => {
    const p = snapshots.getSnapshot(cam('a'));
    await flush();
    finish(mockSpawned[0], 'first');
    await p;

    expect(s3.putObject).toHaveBeenCalledWith('snapshots/u1/a/latest.jpg', Buffer.from('first'), 'image/jpeg');
    const [sql, { replacements }] = sequelize.query.mock.calls.at(-1);
    expect(sql).toMatch(/JSON_SET\(.*'\$\.lastSnapshot'/);
    expect(replacements.id).toBe('id-a');
    expect(lastSaved()).toMatchObject({ key: 'snapshots/u1/a/latest.jpg', source: 'direct', manualAt: null });
    expect(logger.info).toHaveBeenCalledWith('snapshot saved', { monitorId: 'a', source: 'direct', reason: 'first' });
  });

  test('ordinary viewer grabs do not overwrite a saved picture', async () => {
    const p = snapshots.getSnapshot(cam('a', { settings: savedPicture(DAY) }));
    await flush();
    finish(mockSpawned[0]);
    const shot = await p;
    expect(shot.stale).toBe(false);
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('a grab asked for by prompt B overwrites it, from the cheapest source', async () => {
    mockSegment = { file: '/recordings/cam_a/d/s.mp4', mtimeMs: Date.now() - 30 * 1000, startedAtMs: Date.now() - 4 * 60 * 1000 };
    const p = snapshots.refresh(cam('a', { settings: savedPicture(DAY) }), { reason: 'online' });
    await flush();
    const args = require('child_process').spawn.mock.calls.at(-1)[1];
    expect(args[args.indexOf('-i') + 1]).toBe(mockSegment.file);
    expect(args).not.toContain('-rtsp_transport');
    finish(mockSpawned[0]);
    const entry = await p;
    expect(entry.at).toBe(mockSegment.startedAtMs);
    expect(lastSaved()).toMatchObject({ source: 'recording', capturedAt: new Date(mockSegment.startedAtMs).toISOString() });
  });

  test('an unreadable recording segment falls through to the next source', async () => {
    mockSegment = { file: '/rec.mp4', mtimeMs: Date.now(), startedAtMs: Date.now() };
    const p = snapshots.refresh(cam('a'), { reason: 'expired' });
    await flush();
    mockSpawned[0].emit('close', 1);
    await flush();
    expect(mockSpawned).toHaveLength(2);
    finish(mockSpawned[1]);
    await p;
    expect(lastSaved().source).toBe('direct');
  });

  test('a grab deferred at the NVR budget opens no session and goes on the queue', async () => {
    mockNvrCams = 'bcdefghij'.split('').map((id) => ({ monitorId: id }));
    mockNvrCams.forEach(({ monitorId }) => mockReady.add(`cam_${monitorId}_sub`));
    const result = await snapshots.refresh(cam('a'), { reason: 'online' });
    expect(result).toEqual({ deferred: true, readyPaths: 9 });
    expect(mockSpawned).toHaveLength(0);
    expect(queued.get('a')).toMatchObject({ cameraId: 'id-a', reason: 'online', tries: 1 });
  });

  test("a viewer's deferred first grab is queued to fill in only a missing picture", async () => {
    atBudget();
    await expect(snapshots.getSnapshot(cam('a'))).rejects.toMatchObject({ code: 'DEFERRED' });
    expect(queued.get('a')).toMatchObject({ reason: 'first', onlyIfMissing: true });
  });

  test('an offline camera is shown its saved picture, flagged stale, with its saved time', async () => {
    mockS3.set('snapshots/u1/a/latest.jpg', Buffer.from('saved'));
    const settings = savedPicture(3 * DAY);
    const shot = await snapshots.getSnapshot(cam('a', { status: 'offline', settings }));
    expect(shot).toMatchObject({ stale: true, source: 'saved', at: Date.parse(settings.lastSnapshot.capturedAt) });
    expect(shot.jpeg.toString()).toBe('saved');
    expect(mockSpawned).toHaveLength(0);
  });

  test('the saved picture survives a cleared memory cache (a restart)', async () => {
    const p = snapshots.getSnapshot(cam('a'));
    await flush();
    finish(mockSpawned[0], 'before-restart');
    await p;
    const settings = { lastSnapshot: lastSaved() };

    cache.clear(); saved.clear();
    const shot = await snapshots.getSnapshot(cam('a', { status: 'offline', settings }));
    expect(shot.jpeg.toString()).toBe('before-restart');
    expect(shot.stale).toBe(true);
    expect(s3.getReadStream).toHaveBeenCalledWith('snapshots/u1/a/latest.jpg');
  });

  test('a picture older than 14 days is never served', async () => {
    mockS3.set('snapshots/u1/a/latest.jpg', Buffer.from('ancient'));
    await expect(snapshots.getSnapshot(cam('a', { status: 'offline', settings: savedPicture(15 * DAY) })))
      .rejects.toMatchObject({ code: 'OFFLINE', reason: 'expired', lastSeenAt: '2026-11-01T10:00:00.000Z' });
    expect(s3.getReadStream).not.toHaveBeenCalled();
  });

  test('with no saved picture, an offline camera shows a frame from its latest recording', async () => {
    mockSegment = { file: '/recordings/cam_a/d/s.mp4', mtimeMs: Date.now() - 2 * DAY, startedAtMs: Date.now() - 2 * DAY - 600000 };
    const p = snapshots.getSnapshot(cam('a', { status: 'offline' }));
    await flush();
    finish(mockSpawned[0], 'from-recording');
    const shot = await p;
    expect(shot).toMatchObject({ stale: true, source: 'recording', at: mockSegment.startedAtMs });
    expect(lastSaved().source).toBe('recording');
  });

  test('a recording older than 14 days is not used', async () => {
    mockSegment = { file: '/old.mp4', mtimeMs: Date.now() - 15 * DAY, startedAtMs: Date.now() - 15 * DAY };
    await expect(snapshots.getSnapshot(cam('a', { status: 'offline' }))).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(mockSpawned).toHaveLength(0);
  });

  test('a camera that never connected says so', async () => {
    await expect(snapshots.getSnapshot(cam('a', { status: 'offline', lastSeenAt: null })))
      .rejects.toMatchObject({ code: 'OFFLINE', reason: 'never_connected', neverConnected: true, lastSeenAt: null });
  });
});

describe('cached only (an editor opening)', () => {
  test('an online camera with a saved picture gets it at once, without a grab', async () => {
    mockS3.set('snapshots/u1/a/latest.jpg', Buffer.from('saved'));
    const shot = await snapshots.getSnapshot(cam('a', { settings: savedPicture(2 * DAY) }), { cachedOnly: true });
    expect(shot).toMatchObject({ stale: true, source: 'saved' });
    expect(shot.jpeg.toString()).toBe('saved');
    expect(mockSpawned).toHaveLength(0);
  });

  test('the memory copy is used even when it is minutes old', async () => {
    cache.set('a', { jpeg: Buffer.from('mem'), at: Date.now() - 10 * MIN, source: 'live' });
    const shot = await snapshots.getSnapshot(cam('a'), { cachedOnly: true });
    expect(shot.jpeg.toString()).toBe('mem');
    expect(shot.stale).toBe(true);
    expect(mockSpawned).toHaveLength(0);
  });

  test('an online camera with nothing held says so instead of grabbing', async () => {
    await expect(snapshots.getSnapshot(cam('a'), { cachedOnly: true })).rejects.toMatchObject({ code: 'NOT_CACHED' });
    expect(mockSpawned).toHaveLength(0);
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  test('an offline camera answers as usual', async () => {
    await expect(snapshots.getSnapshot(cam('a', { status: 'offline', lastSeenAt: null }), { cachedOnly: true }))
      .rejects.toMatchObject({ code: 'OFFLINE', reason: 'never_connected' });
  });
});

describe('freshen (live playing in an editor)', () => {
  const spawnArgs = () => require('child_process').spawn.mock.calls.at(-1)[1];

  test('a picture saved within 6 hours is left alone', async () => {
    mockReady.add('cam_a');
    expect(await snapshots.freshen(cam('a', { settings: savedPicture(2 * 60 * MIN) }))).toBe('recent');
    expect(mockSpawned).toHaveLength(0);
  });

  test('an older picture is re-saved from the live main stream, sharp', async () => {
    mockReady.add('cam_a'); mockReady.add('cam_a_sub');
    const p = snapshots.freshen(cam('a', { settings: savedPicture(7 * 60 * MIN) }));
    await flush();
    const args = spawnArgs();
    expect(args[args.indexOf('-i') + 1]).toBe('rtsp://stream-service:8554/cam_a');
    expect(args).toEqual(expect.arrayContaining(["scale='min(1280,iw)':-2", '-q:v', '3']));
    finish(mockSpawned[0], 'fresh');
    expect(await p).toBe('saved');
    expect(logger.info).toHaveBeenCalledWith('snapshot saved', { monitorId: 'a', source: 'live', reason: 'freshen' });
  });

  test('never reaches for the NVR or a recording when live is not ready', async () => {
    mockSegment = { file: '/rec.mp4', mtimeMs: Date.now(), startedAtMs: Date.now() };
    expect(await snapshots.freshen(cam('a'))).toBe('not_live');
    expect(mockSpawned).toHaveLength(0);
  });

  test('an offline camera is not touched', async () => {
    expect(await snapshots.freshen(cam('a', { status: 'offline' }))).toBe('offline');
    expect(mockSpawned).toHaveLength(0);
  });
});

describe('picture quality', () => {
  test('a passing viewer still stays small and comes from the sub-stream', async () => {
    mockReady.add('cam_a'); mockReady.add('cam_a_sub');
    const p = snapshots.getSnapshot(cam('a', { settings: savedPicture(DAY) }));
    await flush();
    const args = require('child_process').spawn.mock.calls.at(-1)[1];
    expect(args[args.indexOf('-i') + 1]).toBe('rtsp://stream-service:8554/cam_a_sub');
    expect(args).toEqual(expect.arrayContaining(['scale=640:-2', '-q:v', '5']));
    finish(mockSpawned[0]);
    await p;
  });
});

describe('refreshByHand', () => {
  test('takes and saves a new picture, restarting its clock', async () => {
    const p = snapshots.refreshByHand(cam('a', { settings: savedPicture(10 * DAY) }));
    await flush();
    finish(mockSpawned[0], 'manual');
    const { capturedAt } = await p;
    expect(Date.now() - Date.parse(capturedAt)).toBeLessThan(5000);
    expect(mockS3.get('snapshots/u1/a/latest.jpg').toString()).toBe('manual');
    expect(lastSaved().manualAt).toBeTruthy();
    expect(logger.info).toHaveBeenCalledWith('snapshot saved', { monitorId: 'a', source: 'direct', reason: 'manual' });
  });

  test('is refused within 5 minutes of the last update by hand', async () => {
    const settings = savedPicture(60000, { manualAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() });
    const err = await snapshots.refreshByHand(cam('a', { settings })).catch((e) => e);
    expect(err).toMatchObject({ code: 'TOO_SOON' });
    expect(err.retryAfterSec).toBeGreaterThan(170);
    expect(err.retryAfterSec).toBeLessThanOrEqual(180);
    expect(mockSpawned).toHaveLength(0);
  });

  test('is allowed again after 5 minutes', async () => {
    const settings = savedPicture(60000, { manualAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() });
    const p = snapshots.refreshByHand(cam('a', { settings }));
    await flush();
    finish(mockSpawned[0]);
    await expect(p).resolves.toHaveProperty('capturedAt');
  });

  test('an offline camera answers OFFLINE and its saved picture stays', async () => {
    await expect(snapshots.refreshByHand(cam('a', { status: 'offline', settings: savedPicture(DAY) })))
      .rejects.toMatchObject({ code: 'OFFLINE', reason: 'expired' });
    expect(mockSpawned).toHaveLength(0);
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  test('is queued when the NVR is at its viewing limit', async () => {
    atBudget();
    await expect(snapshots.refreshByHand(cam('a'))).resolves.toEqual({ queued: true });
    expect(queued.get('a')).toMatchObject({ reason: 'manual', tries: 1 });
  });
});

describe('coming online', () => {
  const fake = () => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });

  test('a camera that comes online gets a saved picture 30 s later, from its now-ready path', async () => {
    fake();
    mockRows.set('id-a', cam('a'));
    snapshots.queueOnline(cam('a'));
    mockReady.add('cam_a_sub');                    // path becomes ready meanwhile

    await jest.advanceTimersByTimeAsync(29 * 1000);
    await flush();
    expect(mockSpawned).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(mockSpawned).toHaveLength(1);
    const args = require('child_process').spawn.mock.calls.at(-1)[1];
    expect(args[args.indexOf('-i') + 1]).toBe('rtsp://stream-service:8554/cam_a_sub');
    finish(mockSpawned[0], 'online');
    await flush();
    expect(mockS3.get('snapshots/u1/a/latest.jpg').toString()).toBe('online');
    expect(logger.info).toHaveBeenCalledWith('snapshot saved', { monitorId: 'a', source: 'live', reason: 'online' });
  });

  test('a flap within 60 min of the last picture does not re-grab', async () => {
    fake();
    mockRows.set('id-a', cam('a', { settings: savedPicture(20 * MIN) }));
    snapshots.queueOnline(cam('a'));
    await jest.advanceTimersByTimeAsync(31 * 1000);
    await flush();
    expect(mockSpawned).toHaveLength(0);
    expect(s3.putObject).not.toHaveBeenCalled();

    mockRows.set('id-a', cam('a', { settings: savedPicture(61 * MIN) }));
    snapshots.queueOnline(cam('a'));
    await jest.advanceTimersByTimeAsync(31 * 1000);
    await flush();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0]);
    await flush();
  });

  test('a camera that went offline again before its turn is not grabbed', async () => {
    fake();
    mockRows.set('id-a', cam('a', { status: 'offline' }));
    snapshots.queueOnline(cam('a'));
    await jest.advanceTimersByTimeAsync(31 * 1000);
    await flush();
    expect(mockSpawned).toHaveLength(0);
  });

  test('after a restart only a missing picture is filled in', async () => {
    fake();
    mockRows.set('id-a', cam('a', { settings: savedPicture(3 * DAY) }));
    snapshots.queueOnline(cam('a'), { onlyIfMissing: true });
    await jest.advanceTimersByTimeAsync(31 * 1000);
    await flush();
    expect(mockSpawned).toHaveLength(0);
  });

  test('one job per camera: repeated transitions merge', () => {
    expect(snapshots.queueOnline(cam('a'))).toBe(true);
    expect(snapshots.queueOnline(cam('a'))).toBe(false);
    expect(queued.size).toBe(1);
  });

  test('a deferred request retries every 10 min and gives up after 6 tries', async () => {
    fake();
    atBudget();
    mockRows.set('id-a', cam('a'));
    snapshots.queueOnline(cam('a'));

    await jest.advanceTimersByTimeAsync(30 * 1000);
    await flush();
    expect(Camera.findByPk).toHaveBeenCalledTimes(1);
    expect(queued.get('a')).toMatchObject({ tries: 1 });

    for (let tries = 2; tries <= 6; tries++) {
      await jest.advanceTimersByTimeAsync(10 * MIN);
      await flush();
      expect(Camera.findByPk).toHaveBeenCalledTimes(tries);
    }
    expect(queued.has('a')).toBe(false);
    expect(logger.info).toHaveBeenCalledWith('snapshot gave up', { monitorId: 'a', reason: 'online', tries: 6 });

    await jest.advanceTimersByTimeAsync(60 * MIN);
    await flush();
    expect(Camera.findByPk).toHaveBeenCalledTimes(6);
    expect(mockSpawned).toHaveLength(0);
  });

  test('a deferred request that frees up on a retry is saved', async () => {
    fake();
    atBudget();
    mockRows.set('id-a', cam('a'));
    snapshots.queueOnline(cam('a'));
    await jest.advanceTimersByTimeAsync(30 * 1000);
    await flush();

    mockReady.delete('cam_j');                     // a viewer left
    await jest.advanceTimersByTimeAsync(10 * MIN);
    await flush();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0]);
    await flush();
    expect(lastSaved().source).toBe('direct');
  });

  test('background grabs run at most two at a time', async () => {
    fake();
    'abc'.split('').forEach((id, i) => {
      mockRows.set(`id-${id}`, cam(id, { host: `10.0.1.${i}` }));
      snapshots.queueOnline(cam(id));
    });
    await jest.advanceTimersByTimeAsync(30 * 1000);
    await flush();
    expect(mockSpawned).toHaveLength(2);
    finish(mockSpawned[0]);
    await flush();
    expect(mockSpawned).toHaveLength(3);
    mockSpawned.slice(1).forEach((p) => finish(p));
    await flush();
  });
});

describe('expiry sweep', () => {
  test('an expired picture on an online camera is replaced', async () => {
    mockRows.set('id-a', cam('a', { settings: savedPicture(15 * DAY) }));
    mockS3.set('snapshots/u1/a/latest.jpg', Buffer.from('old'));
    mockReady.add('cam_a');

    const stats = await snapshots.sweep();
    expect(stats).toEqual({ expired: 1, queued: 1, deleted: 0 });
    await due();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0], 'fresh');
    await flush();
    expect(mockS3.get('snapshots/u1/a/latest.jpg').toString()).toBe('fresh');
    expect(lastSaved()).toMatchObject({ source: 'live' });
    expect(s3.deleteRecording).not.toHaveBeenCalled();
  });

  test('an expired picture on an offline camera is deleted', async () => {
    mockRows.set('id-a', cam('a', { status: 'offline', settings: savedPicture(15 * DAY) }));
    mockS3.set('snapshots/u1/a/latest.jpg', Buffer.from('old'));

    expect(await snapshots.sweep()).toEqual({ expired: 1, queued: 0, deleted: 1 });
    expect(s3.deleteRecording).toHaveBeenCalledWith('snapshots/u1/a/latest.jpg');
    expect(mockS3.has('snapshots/u1/a/latest.jpg')).toBe(false);
    expect(mockRows.get('id-a').settings.lastSnapshot).toBeUndefined();
    expect(mockSpawned).toHaveLength(0);
  });

  test('when the replacement grab fails, the expired picture is deleted', async () => {
    mockRows.set('id-a', cam('a', { settings: savedPicture(15 * DAY) }));
    mockS3.set('snapshots/u1/a/latest.jpg', Buffer.from('old'));
    await snapshots.sweep();
    await due();
    mockSpawned[0].emit('close', 1);
    await flush();
    expect(s3.deleteRecording).toHaveBeenCalledWith('snapshots/u1/a/latest.jpg');
    expect(mockRows.get('id-a').settings.lastSnapshot).toBeUndefined();
  });

  test('pictures within 14 days are left alone', async () => {
    mockRows.set('id-a', cam('a', { status: 'offline', settings: savedPicture(13 * DAY) }));
    expect(await snapshots.sweep()).toEqual({ expired: 0, queued: 0, deleted: 0 });
    expect(s3.deleteRecording).not.toHaveBeenCalled();
  });

  test('a picture replaced since the sweep read it is not deleted', async () => {
    const stale = cam('a', { status: 'offline', settings: savedPicture(15 * DAY) });
    mockRows.set('id-a', cam('a', { status: 'offline', settings: savedPicture(MIN) }));
    const { expire } = snapshots._internals;
    expect(await expire(stale)).toBe(false);
    expect(s3.deleteRecording).not.toHaveBeenCalled();
  });
});
