// Smart Search proxy (docs/investigation, I-2): opt-in feature key, tenant
// only from the JWT, results scoped to the caller's own cameras.

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/utils/aiTenant', () => ({ aiAuthHeader: (u) => ({ Authorization: `Bearer jwt-for-${u.id}` }) }));
jest.mock('../src/models', () => ({
  Camera: {
    findAll: jest.fn(async ({ where }) => [
      { monitorId: 'm1', name: 'Gate 3', userId: 'u1' },
      { monitorId: 'm2', name: 'Lobby', userId: 'u1' },
      { monitorId: 'm9', name: 'Other', userId: 'u2' },
    ].filter((c) => !where?.userId || [].concat(where.userId).includes(c.userId))),
  },
}));
const mockAi = { post: jest.fn(), get: jest.fn() };
jest.mock('axios', () => ({ create: () => mockAi }));

const { audit } = require('../src/utils/audit');
const ctrl = require('../src/controllers/investigate.controller');
const { isFeatureOn, OPT_IN_KEYS, featureStateOf, storedFeatures, ALL_FEATURE_KEYS } = require('../src/utils/featureCatalog');

const run = (handler, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); },
    set() { return this; },
    send(b) { resolve({ status: this.statusCode, body: b }); },
    end() { resolve({ status: this.statusCode }); },
  };
  handler(req, res, (err) => (err ? reject(err) : resolve({ status: res.statusCode })));
});

beforeEach(() => {
  mockAi.post.mockReset();
  mockAi.get.mockReset();
  audit.mockClear();
});

describe('investigate_search feature key', () => {
  test('is opt-in: off for a full account and for an explicit list without it', () => {
    expect(OPT_IN_KEYS).toContain('investigate_search');
    expect(isFeatureOn(null, 'investigate_search')).toBe(false);
    expect(isFeatureOn([], 'investigate_search')).toBe(false);
    expect(isFeatureOn(['map'], 'investigate_search')).toBe(false);
    expect(isFeatureOn(['investigate_search'], 'investigate_search')).toBe(true);
  });

  test('a full account stays stored as NULL and does not list it', () => {
    expect(featureStateOf(null).enabled).not.toContain('investigate_search');
    const allButOptIn = featureStateOf(null).enabled;
    expect(storedFeatures(allButOptIn)).toBeNull();
    expect(storedFeatures([...allButOptIn, 'investigate_search'])).toContain('investigate_search');
    expect(ALL_FEATURE_KEYS).toContain('investigate_search');
  });
});

describe('POST /api/investigate/search', () => {
  test('sends only the JWT tenant, the caller\'s cameras as scope and names, and audits', async () => {
    mockAi.post.mockResolvedValue({ data: {
      parsed: { chips: [] }, filters: {}, model: 'siglip2',
      results: [{ track_id: 't1', camera_code: 'm1', crop_path: '/investigate/tracks/t1/crop', score: 0.9 }],
    } });
    const req = { user: { id: 'u1' }, body: { q: 'red top gate 3', tenant_id: 'evil', overrides: { tenant_id: 'evil', top_colour: 'red' } } };
    const out = await run(ctrl.search, req);

    const [url, body, opts] = mockAi.post.mock.calls[0];
    expect(url).toBe('/investigate/search');
    expect(opts.headers.Authorization).toBe('Bearer jwt-for-u1');
    expect(JSON.stringify(body)).not.toContain('evil');
    expect(body.scope_codes).toEqual(['m1', 'm2']);
    expect(body.cameras).toEqual([{ code: 'm1', name: 'Gate 3' }, { code: 'm2', name: 'Lobby' }]);
    expect(body.overrides).toEqual({ top_colour: 'red' });

    expect(out.body.results[0]).toMatchObject({ camera_name: 'Gate 3', crop_url: '/api/investigate/tracks/t1/crop' });
    expect(out.body.results[0].crop_path).toBeUndefined();
    expect(audit).toHaveBeenCalledWith('investigate.search', expect.objectContaining({ meta: expect.objectContaining({ q: 'red top gate 3', count: 1 }) }));
  });

  test('refuses an over-long query before calling the AI', async () => {
    await expect(run(ctrl.search, { user: { id: 'u1' }, body: { q: 'x'.repeat(301) } })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAi.post).not.toHaveBeenCalled();
  });

  test('AI index switched off reads as "not switched on yet"', async () => {
    mockAi.post.mockRejectedValue({ response: { status: 404, data: { detail: 'investigation index is not enabled' } } });
    await expect(run(ctrl.search, { user: { id: 'u1' }, body: { q: 'red' } })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('GET /api/investigate/tracks/:id', () => {
  test('a track on someone else\'s camera is a 404', async () => {
    mockAi.get.mockResolvedValue({ data: { track_id: 't9', camera_code: 'm9' } });
    await expect(run(ctrl.getTrack, { user: { id: 'u1' }, params: { id: 't9' } })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('own track comes back with its camera name', async () => {
    mockAi.get.mockResolvedValue({ data: { track_id: 't1', camera_code: 'm2', points: [] } });
    const out = await run(ctrl.getTrack, { user: { id: 'u1' }, params: { id: 't1' } });
    expect(out.body.camera_name).toBe('Lobby');
  });
});

describe('Click to track (I-3)', () => {
  test('track-at refuses a camera the caller does not have, without asking the AI', async () => {
    await expect(run(ctrl.trackAt, { user: { id: 'u1' }, body: { camera_code: 'm9', ts: '2026-11-24T10:00:00Z', x: 1, y: 2 } }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockAi.post).not.toHaveBeenCalled();
  });

  test('journey sends the caller\'s cameras as scope and names the route', async () => {
    mockAi.post.mockResolvedValue({ data: {
      seed: { track_id: 's', camera_code: 'm1', crop_path: 'x' },
      stops: [{ track_id: 's', camera_code: 'm1' }, { track_id: 't', camera_code: 'm2' }],
      candidates: [{ track_id: 'c', camera_code: 'm2' }],
      route_codes: ['m1', 'm2'],
      sightings: [{ sighting_id: 's', camera_code: 'm1' }],
    } });
    const out = await run(ctrl.journey, { user: { id: 'u1' }, body: { track_id: 's', tenant_id: 'evil' } });
    const [url, body, opts] = mockAi.post.mock.calls[0];
    expect(url).toBe('/investigate/journey');
    expect(body).toEqual({ track_id: 's', scope_codes: ['m1', 'm2'] });
    expect(opts.headers.Authorization).toBe('Bearer jwt-for-u1');
    expect(out.body.route).toEqual(['Gate 3', 'Lobby']);
    expect(out.body.candidates[0]).toMatchObject({ camera_name: 'Lobby', crop_url: '/api/investigate/tracks/c/crop' });
    expect(out.body.sightings[0].camera_name).toBe('Gate 3');
  });

  test('a review needs a real verdict and is audited', async () => {
    await expect(run(ctrl.review, { user: { id: 'u1' }, body: { seed_track_id: 's', track_id: 't', verdict: 'maybe' } }))
      .rejects.toMatchObject({ statusCode: 400 });
    mockAi.post.mockResolvedValue({ data: { ok: true } });
    await run(ctrl.review, { user: { id: 'u1' }, body: { seed_track_id: 's', track_id: 't', verdict: 'confirmed', score: 0.93 } });
    expect(audit).toHaveBeenCalledWith('investigate.journey_confirmed', expect.objectContaining({ targetId: 't' }));
  });
});
