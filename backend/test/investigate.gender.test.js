// Smart Search's man/woman filter is decided by the BACKEND from the account's
// own opt-in switch (investigate_gender, sensitive attribute). The browser can
// ask for "man" (a chip), but can never switch the filter on.
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/utils/aiTenant', () => ({ aiAuthHeader: (u) => ({ Authorization: `Bearer jwt-for-${u.id}` }) }));
jest.mock('../src/models', () => ({
  Camera: { findAll: jest.fn(async () => [{ monitorId: 'm1', name: 'Camera Gate2', userId: 'u1' }]) },
}));
const mockEnt = { features: null, aiEnabled: true, fail: false };
jest.mock('../src/services/entitlements.service', () => {
  const { isFeatureOn } = jest.requireActual('../src/utils/featureCatalog');
  return {
    getEntitlements: jest.fn(async () => {
      if (mockEnt.fail) throw new Error('db down');
      return { features: mockEnt.features, aiEnabled: mockEnt.aiEnabled };
    }),
    allowsAny: (ent, keys) => keys.some((k) => ent.aiEnabled && isFeatureOn(ent.features, k)),
  };
});
const mockAi = { post: jest.fn(), get: jest.fn() };
jest.mock('axios', () => ({ create: () => mockAi }));

const ctrl = require('../src/controllers/investigate.controller');
const { OPT_IN_KEYS, isFeatureOn } = require('../src/utils/featureCatalog');

const run = (handler, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  handler(req, res, (err) => (err ? reject(err) : resolve({})));
});
const sent = () => mockAi.post.mock.calls[0][1];

beforeEach(() => {
  mockAi.post.mockReset();
  mockAi.post.mockResolvedValue({ data: { parsed: { chips: [] }, results: [], notices: [] } });
  Object.assign(mockEnt, { features: null, aiEnabled: true, fail: false });
});

test('investigate_gender is an opt-in key: off for a full account', () => {
  expect(OPT_IN_KEYS).toContain('investigate_gender');
  expect(isFeatureOn(null, 'investigate_gender')).toBe(false);
  expect(isFeatureOn(['investigate_search'], 'investigate_gender')).toBe(false);
  expect(isFeatureOn(['investigate_gender'], 'investigate_gender')).toBe(true);
});

test('switched off: allow_gender is false even when the browser sends true', async () => {
  mockEnt.features = ['investigate_search'];
  await run(ctrl.search, { user: { id: 'u1' }, body: { q: 'man', allow_gender: true, overrides: { allow_gender: true } } });
  expect(sent().allow_gender).toBe(false);
  expect(sent().overrides).not.toHaveProperty('allow_gender');
});

test('switched on for the account: allow_gender is true', async () => {
  mockEnt.features = ['investigate_search', 'investigate_gender'];
  await run(ctrl.search, { user: { id: 'u1' }, body: { q: 'man' } });
  expect(sent().allow_gender).toBe(true);
});

test('switched on but the plan has no AI: false', async () => {
  mockEnt.features = ['investigate_search', 'investigate_gender'];
  mockEnt.aiEnabled = false;
  await run(ctrl.search, { user: { id: 'u1' }, body: { q: 'man' } });
  expect(sent().allow_gender).toBe(false);
});

test('an entitlement error fails closed (no sensitive filter)', async () => {
  mockEnt.features = ['investigate_gender'];
  mockEnt.fail = true;
  await run(ctrl.search, { user: { id: 'u1' }, body: { q: 'man' } });
  expect(sent().allow_gender).toBe(false);
});

test('the gender chip, its removal and "show unread colours" pass through; nothing else does', async () => {
  await run(ctrl.search, { user: { id: 'u1' }, body: { q: 'man', overrides: {
    gender: 'male', include_unknown_colour: true, clear: ['gender'], tenant_id: 'evil', allow_gender: true,
  } } });
  expect(sent().overrides).toEqual({ gender: 'male', include_unknown_colour: true, clear: ['gender'] });
});

test('notices from the AI reach the page', async () => {
  mockAi.post.mockResolvedValue({ data: { parsed: { chips: [] }, results: [], notices: [{ kind: 'unknown_place', place: 'gate 7' }] } });
  const out = await run(ctrl.search, { user: { id: 'u1' }, body: { q: 'movement at gate 7' } });
  expect(out.body.notices).toEqual([{ kind: 'unknown_place', place: 'gate 7' }]);
});
