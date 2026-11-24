// Cases (investigation toolkit I-4): who may see and change a case, what can be
// pinned, and that everything is written to the case's audit trail.
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/aiTenant', () => ({ aiAuthHeader: () => ({}), aiTenantId: () => 'tenant-1' }));
const mockPost = jest.fn(async () => ({ data: {} }));
jest.mock('axios', () => ({ create: () => ({ post: mockPost }) }));

const mockCases = {};
const mockMembers = [];
const mockItems = [];
const mockAudit = [];
jest.mock('../src/models', () => ({
  Case: { findByPk: async (id) => mockCases[id] || null },
  CaseMember: { findOne: async ({ where }) => mockMembers.find((m) => m.caseId === where.caseId && m.userId === where.userId) || null },
  CaseItem: {
    create: async (row) => { const it = { id: `i${mockItems.length + 1}`, createdAt: new Date(), preservedStatus: 'none', ...row, update: async () => {} }; mockItems.push(it); return it; },
  },
  CaseAudit: { create: async (row) => { mockAudit.push(row); } },
  Camera: { findOne: async ({ where }) => (where.monitorId === 'm1' && where.userId === 'owner' ? { monitorId: 'm1', name: 'Gate 3' } : null) },
}));

const cases = require('../src/services/cases');

const OWNER = { id: 'owner' };
const EDITOR = { id: 'ed', parentUserId: 'owner', name: 'Asha' };
const VIEWER = { id: 'vw', parentUserId: 'owner', name: 'Ravi' };
const STRANGER = { id: 'x', parentUserId: 'other-owner' };
const OUTSIDER_SUB = { id: 'nobody', parentUserId: 'owner' };

beforeEach(() => {
  for (const k of Object.keys(mockCases)) delete mockCases[k];
  mockMembers.length = 0;
  mockItems.length = 0;
  mockAudit.length = 0;
  mockCases.c1 = { id: 'c1', userId: 'owner', legalHold: false, changed: () => {}, save: async () => {} };
  mockMembers.push({ caseId: 'c1', userId: 'ed', role: 'editor' }, { caseId: 'c1', userId: 'vw', role: 'viewer' });
});

describe('who can open a case', () => {
  test('the account owner and members can; another account and non-members get 404', async () => {
    await expect(cases._internals.access(OWNER, 'c1')).resolves.toMatchObject({ role: 'owner' });
    await expect(cases._internals.access(VIEWER, 'c1')).resolves.toMatchObject({ role: 'viewer' });
    await expect(cases._internals.access(STRANGER, 'c1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(cases._internals.access(OUTSIDER_SUB, 'c1')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a viewer cannot change it; an editor cannot manage members', async () => {
    await expect(cases._internals.access(VIEWER, 'c1', 'editor')).rejects.toMatchObject({ statusCode: 403 });
    await expect(cases._internals.access(EDITOR, 'c1', 'editor')).resolves.toMatchObject({ role: 'editor' });
    await expect(cases._internals.access(EDITOR, 'c1', 'owner')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('pinning items', () => {
  test('a person on the account\'s camera is pinned and audited with who did it', async () => {
    const it = await cases.addItem(EDITOR, 'c1', { type: 'track', trackId: 't1', monitorId: 'm1', from: '2026-11-24T10:00:00Z', to: '2026-11-24T10:00:20Z' });
    expect(it).toMatchObject({ type: 'track', cameraName: 'Gate 3', ref: { trackId: 't1' }, addedBy: 'Asha' });
    expect(mockAudit.at(-1)).toMatchObject({ caseId: 'c1', userId: 'ed', action: 'item_added' });
    expect(mockPost).not.toHaveBeenCalled();                  // no legal hold: nothing held in the AI
  });

  test('legal hold holds the person in the AI index right away', async () => {
    mockCases.c1.legalHold = true;
    await cases.addItem(OWNER, 'c1', { type: 'track', trackId: 't9', monitorId: 'm1', from: '2026-11-24T10:00:00Z' });
    expect(mockPost).toHaveBeenCalledWith('/investigate/tracks/t9/hold', { case_id: 'c1' }, expect.anything());
  });

  test('bad items are refused', async () => {
    await expect(cases.addItem(EDITOR, 'c1', { type: 'virus' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(cases.addItem(EDITOR, 'c1', { type: 'note', note: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(cases.addItem(EDITOR, 'c1', { type: 'clip', monitorId: 'not-ours', from: '2026-11-24T10:00:00Z' }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(cases.addItem(EDITOR, 'c1', { type: 'clip', monitorId: 'm1', from: '2026-11-24T10:00:00Z', to: '2026-11-24T09:00:00Z' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(cases.addItem(VIEWER, 'c1', { type: 'note', note: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
  });
});
