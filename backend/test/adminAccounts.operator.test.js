// Platform operators in the admin console's Accounts list.
//
// The operator's email also signs in to the customer console, and new
// features are opt-in (off until switched on per account), so an operator has
// to be listed and opened like any account to switch its features on. It must
// still never be suspended from here: that could lock the platform out of its
// own console.
jest.mock('../src/models', () => {
  const m = (extra = {}) => ({ findAll: jest.fn(async () => []), findByPk: jest.fn(), ...extra });
  return {
    User: m(), Subscription: m(), Plan: m(), Camera: m(), RestrictedZone: m(), License: m(),
    LicenseResource: m(), LicenseFeature: m(), AIEvent: m(), PasswordReset: m(), Role: m(),
    AdminAuditLog: { create: jest.fn(async () => ({})) },
    RefreshToken: m({ update: jest.fn(async () => [0]) }),
  };
});
jest.mock('../src/controllers/cameraHealth.controller', () => ({
  computeHealth: jest.fn(() => ({})), loadHealthContext: jest.fn(async () => ({})), classifyCamera: jest.fn(),
}));
jest.mock('../src/services/entitlements.service', () => ({ countLicenceUsage: jest.fn(), clearEntitlementCache: jest.fn() }));
jest.mock('../src/services/cameraQuota.service', () => ({ getCameraLicence: jest.fn() }));
jest.mock('../src/services/accountStatus.service', () => ({ setBlocked: jest.fn(), reload: jest.fn(async () => {}) }));
jest.mock('../src/services/platformEvents.service', () => ({ record: jest.fn(), plural: (n, w) => `${n} ${w}s` }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));

const { User } = require('../src/models');
const ctrl = require('../src/controllers/adminAccounts.controller');

function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    handler(req, res, (err) => resolve({ error: err }));
  });
}

const owner = (extra) => ({
  id: 'u1', name: 'Owner', email: 'owner@example.com', isActive: true, parentUserId: null,
  isPlatformAdmin: false, save: jest.fn(async () => {}), ...extra,
});

beforeEach(() => jest.clearAllMocks());

test('the accounts list includes platform operators (and says which they are)', async () => {
  await call(ctrl.listAccounts, { user: { id: 'admin' }, query: {} });
  const ownersQuery = User.findAll.mock.calls.find(([q]) => q?.where && 'parentUserId' in q.where && q.where.parentUserId === null);
  expect(ownersQuery).toBeTruthy();
  expect(ownersQuery[0].where).not.toHaveProperty('isPlatformAdmin');
  expect(ownersQuery[0].attributes).toContain('isPlatformAdmin');
});

test('an operator account can be opened (its features are set like anyone else\'s)', async () => {
  User.findByPk.mockResolvedValueOnce(owner({ id: 'op', isPlatformAdmin: true }));
  const r = await call(ctrl.listAccountEvents, { params: { userId: 'op' }, query: {}, user: { id: 'other-admin' } });
  // Whatever the events step does with empty mocks, it is not refused as "not a customer account".
  expect(r.error?.message || '').not.toMatch(/platform operator/i);
  expect(r.status).not.toBe(400);
});

test('suspending a platform operator is refused', async () => {
  const op = owner({ id: 'op', isPlatformAdmin: true });
  User.findByPk.mockResolvedValueOnce(op);
  const r = await call(ctrl.setAccountStatus, { params: { userId: 'op' }, body: { active: false }, user: { id: 'other-admin' }, headers: {} });
  expect(r.error?.statusCode).toBe(403);
  expect(op.save).not.toHaveBeenCalled();
});

test('a customer owner can still be suspended', async () => {
  const o = owner();
  User.findByPk.mockResolvedValueOnce(o);
  const r = await call(ctrl.setAccountStatus, { params: { userId: 'u1' }, body: { active: false }, user: { id: 'admin' }, headers: {} });
  expect(r.error).toBeUndefined();
  expect(o.save).toHaveBeenCalled();
  expect(r.body.account.status).toBe('suspended');
});
