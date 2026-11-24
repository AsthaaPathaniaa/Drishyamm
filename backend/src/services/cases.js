// Cases (investigation toolkit I-4): one workspace per incident.
//
// Access: the account owner sees every case of the account; anyone else sees
// the cases they are a member of. owner / editor change things; viewer reads.
// Every read and change is written to case_audit (who, what, when).
//
// Legal hold: while on, every person (track) pinned to the case is held in the
// AI index (its retention skips them) and every footage item is KEPT: copied
// off the recorder into case storage, SHA-256 hashed while written, before the
// NVR overwrites it. Keeping uses the same NVR pull as Recordings › Export and
// evidence packs (one pull per user at a time, 30 min max per item).
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const logger = require('../config/logger');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const { aiAuthHeader, aiTenantId } = require('../utils/aiTenant');

const CASES_DIR = process.env.CASES_DIR || path.join(config.streamService?.recordingsDir || '/recordings', '_cases');
const ITEM_TYPES = ['track', 'clip', 'journey', 'note', 'evidence'];
const ROLES = ['owner', 'editor', 'viewer'];
const FOOTAGE = new Set(['track', 'clip']);
const PAD_MS = 10_000;

const models = () => require('../models');
const ownerId = (u) => String(u?.parentUserId || u?.id || '');
const nameOf = (u) => u?.name || u?.username || u?.email || String(u?.id || '');
const ai = axios.create({ baseURL: process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001', timeout: 15_000 });

async function record(caseId, user, action, detail = null) {
  try {
    await models().CaseAudit.create({ caseId, userId: user?.id || null, userName: user ? nameOf(user) : 'system', action, detail, at: new Date() });
  } catch (e) {
    logger.warn('cases: audit write failed', { caseId, action, error: e.message });
  }
}

/** The case and the caller's role on it; 404 when they may not see it. */
async function access(user, caseId, need = 'viewer') {
  const { Case, CaseMember } = models();
  const c = await Case.findByPk(caseId);
  if (!c || c.userId !== ownerId(user)) throw new AppError('Case not found.', 404);
  let role = null;
  if (String(user.id) === ownerId(user)) role = 'owner';
  else role = (await CaseMember.findOne({ where: { caseId, userId: user.id } }))?.role || null;
  if (!role) throw new AppError('Case not found.', 404);
  const rank = { viewer: 0, editor: 1, owner: 2 };
  if (rank[role] < rank[need]) throw new AppError(need === 'owner' ? 'Only the case owner can do that.' : 'You can view this case but not change it.', 403);
  return { c, role };
}

function caseView(c, extra = {}) {
  return {
    id: c.id, number: c.number, label: `Case #${String(c.number).padStart(4, '0')}`, title: c.title,
    description: c.description, status: c.status, priority: c.priority, tags: c.tags || [], legalHold: c.legalHold,
    createdBy: c.createdByName, createdAt: c.createdAt, updatedAt: c.updatedAt, closedAt: c.closedAt, ...extra,
  };
}

function itemView(i) {
  return {
    id: i.id, type: i.type, monitorId: i.monitorId, cameraName: i.cameraName, from: i.tsFrom, to: i.tsTo,
    title: i.title, note: i.note, ref: i.ref || {}, addedBy: i.addedByName, addedAt: i.createdAt,
    kept: { status: i.preservedStatus, error: i.preservedError, sha256: i.preservedSha256,
      size: i.preservedSize != null ? Number(i.preservedSize) : null },
  };
}

async function createCase(user, { title, description, priority, tags }) {
  const { Case, CaseMember, sequelize } = models();
  const t = String(title || '').trim();
  if (t.length < 3) throw new AppError('Give the case a title (at least 3 characters).', 400);
  const c = await sequelize.transaction(async (tx) => {
    const max = await Case.max('number', { where: { userId: ownerId(user) }, transaction: tx, lock: tx.LOCK.UPDATE });
    const row = await Case.create({
      tenantId: aiTenantId(user), userId: ownerId(user), number: (max || 0) + 1, title: t.slice(0, 160),
      description: description ? String(description).slice(0, 5000) : null,
      priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 20) : [],
      createdBy: user.id, createdByName: nameOf(user),
    }, { transaction: tx });
    await CaseMember.create({ caseId: row.id, userId: user.id, role: 'owner', userName: nameOf(user), addedBy: user.id }, { transaction: tx });
    return row;
  });
  await record(c.id, user, 'created', { title: c.title });
  return caseView(c, { role: 'owner', items: 0 });
}

async function listCases(user, { status } = {}) {
  const { Case, CaseMember, CaseItem, Sequelize } = models();
  const where = { userId: ownerId(user) };
  if (status === 'open' || status === 'closed') where.status = status;
  if (String(user.id) !== ownerId(user)) {
    const mine = await CaseMember.findAll({ where: { userId: user.id }, attributes: ['caseId'] });
    where.id = mine.map((m) => m.caseId);
  }
  const rows = await Case.findAll({ where, order: [['updated_at', 'DESC']], limit: 500 });
  const counts = rows.length ? await CaseItem.findAll({
    where: { caseId: rows.map((r) => r.id) }, attributes: ['caseId', [Sequelize.fn('COUNT', Sequelize.col('id')), 'n']],
    group: ['caseId'], raw: true,
  }) : [];
  const n = Object.fromEntries(counts.map((r) => [r.caseId, Number(r.n)]));
  return rows.map((r) => caseView(r, { items: n[r.id] || 0 }));
}

async function getCase(user, caseId) {
  const { c, role } = await access(user, caseId);
  const { CaseItem, CaseMember, CaseAudit } = models();
  const [items, members, log] = await Promise.all([
    CaseItem.findAll({ where: { caseId }, order: [['ts_from', 'ASC'], ['created_at', 'ASC']] }),
    CaseMember.findAll({ where: { caseId }, order: [['created_at', 'ASC']] }),
    CaseAudit.findAll({ where: { caseId }, order: [['at', 'DESC']], limit: 200 }),
  ]);
  await record(caseId, user, 'viewed');
  return caseView(c, {
    role,
    items: items.map(itemView),
    members: members.map((m) => ({ userId: m.userId, name: m.userName, role: m.role })),
    audit: log.map((a) => ({ at: a.at, by: a.userName, action: a.action, detail: a.detail })),
  });
}

async function updateCase(user, caseId, patch) {
  const { c } = await access(user, caseId, 'editor');
  const changes = {};
  if (patch.title != null) changes.title = String(patch.title).trim().slice(0, 160) || c.title;
  if (patch.description !== undefined) changes.description = patch.description ? String(patch.description).slice(0, 5000) : null;
  if (['low', 'normal', 'high'].includes(patch.priority)) changes.priority = patch.priority;
  if (Array.isArray(patch.tags)) changes.tags = patch.tags.map(String).slice(0, 20);
  if (patch.status === 'open' || patch.status === 'closed') {
    changes.status = patch.status;
    changes.closedAt = patch.status === 'closed' ? new Date() : null;
  }
  if (typeof patch.legalHold === 'boolean') changes.legalHold = patch.legalHold;
  await c.update(changes);
  await record(caseId, user, 'updated', changes);
  if ('legalHold' in changes) await applyHold(user, c);
  return caseView(c);
}

/** Legal hold on: hold every track in the AI, keep every footage item. Off: release the AI holds. */
async function applyHold(user, c) {
  const { CaseItem } = models();
  const items = await CaseItem.findAll({ where: { caseId: c.id } });
  for (const i of items) {
    // eslint-disable-next-line no-await-in-loop -- a handful of AI calls, in order
    if (i.type === 'track' && i.ref?.trackId) await holdTrack(user, i.ref.trackId, c.legalHold ? c.id : null);
    if (c.legalHold && FOOTAGE.has(i.type) && ['none', 'failed'].includes(i.preservedStatus)) queueKeep(user, i);
  }
  await record(c.id, user, c.legalHold ? 'legal_hold_on' : 'legal_hold_off', { items: items.length });
}

async function holdTrack(user, trackId, caseId) {
  try {
    await ai.post(`/investigate/tracks/${encodeURIComponent(trackId)}/hold`, { case_id: caseId }, { headers: aiAuthHeader(user) });
  } catch (e) {
    logger.warn('cases: AI track hold failed', { trackId, caseId, error: e.message });
  }
}

function parseTime(v, label) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw new AppError(`${label} must be a date and time.`, 400);
  return d;
}

async function addItem(user, caseId, body) {
  const { c } = await access(user, caseId, 'editor');
  const { CaseItem, Camera } = models();
  const type = String(body.type || '');
  if (!ITEM_TYPES.includes(type)) throw new AppError(`type must be one of ${ITEM_TYPES.join(', ')}.`, 400);
  const row = { caseId, type, title: body.title ? String(body.title).slice(0, 200) : null,
    note: body.note ? String(body.note).slice(0, 5000) : null, addedBy: user.id, addedByName: nameOf(user), ref: {} };
  if (type === 'note') {
    if (!row.note) throw new AppError('A note needs some text.', 400);
    row.tsFrom = body.at ? parseTime(body.at, 'at') : new Date();
  } else {
    if (body.monitorId && String(body.monitorId).startsWith('file:')) {
      // An imported video (I-7): the uploaded file is already stored and was
      // hashed on upload, so its footage counts as kept.
      const imp = await models().VideoImport.findByPk(String(body.monitorId).slice(5));
      if (!imp || imp.userId !== ownerId(user)) throw new AppError('Imported video not found.', 404);
      row.monitorId = `file:${imp.id}`;
      row.cameraName = imp.title;
      Object.assign(row, { preservedStatus: 'kept', preservedPath: imp.path, preservedSha256: imp.sha256, preservedSize: imp.size });
    } else if (body.monitorId) {
      const cam = await Camera.findOne({ where: { monitorId: body.monitorId, userId: ownerId(user) }, attributes: ['monitorId', 'name'] })
        || await Camera.findOne({ where: { monitorId: body.monitorId, userId: user.id }, attributes: ['monitorId', 'name'] });
      if (!cam) throw new AppError('Camera not found.', 404);
      row.monitorId = cam.monitorId;
      row.cameraName = cam.name;
    }
    row.tsFrom = parseTime(body.from, 'from');
    row.tsTo = parseTime(body.to || body.from, 'to');
    if (row.tsTo < row.tsFrom) throw new AppError('to must be after from.', 400);
    if (type === 'track') {
      if (!body.trackId) throw new AppError('trackId is required for a person.', 400);
      row.ref = { trackId: String(body.trackId), score: body.score ?? null };
    }
    if (type === 'clip' && !row.monitorId) throw new AppError('A clip needs its camera.', 400);
    if (type === 'journey') {
      const stops = Array.isArray(body.stops) ? body.stops.slice(0, 50) : [];
      if (!stops.length) throw new AppError('A journey needs its stops.', 400);
      row.ref = { seedTrackId: body.seedTrackId || null, route: body.route || [],
        stops: stops.map((s) => ({ trackId: s.track_id, monitorId: s.camera_code, cameraName: s.camera_name, from: s.first_seen, to: s.last_seen })) };
    }
    if (type === 'evidence') row.ref = { evidenceId: String(body.evidenceId || '') };
  }
  const item = await CaseItem.create(row);
  await c.changed('updatedAt', true);
  await c.save();
  await record(caseId, user, 'item_added', { itemId: item.id, type, monitorId: row.monitorId, from: row.tsFrom, to: row.tsTo });
  if (type === 'track' && c.legalHold) await holdTrack(user, row.ref.trackId, c.id);
  if (type === 'journey' && c.legalHold) for (const s of row.ref.stops) if (s.trackId) await holdTrack(user, s.trackId, c.id); // eslint-disable-line no-await-in-loop
  if (c.legalHold && FOOTAGE.has(type)) queueKeep(user, item);
  return itemView(item);
}

async function removeItem(user, caseId, itemId) {
  const { c } = await access(user, caseId, 'editor');
  const { CaseItem } = models();
  const item = await CaseItem.findOne({ where: { id: itemId, caseId } });
  if (!item) throw new AppError('Item not found.', 404);
  if (item.preservedStatus === 'kept' && c.legalHold) {
    throw new AppError('This footage is under legal hold. Lift the hold before removing it.', 409);
  }
  await item.destroy();
  if (item.type === 'track' && item.ref?.trackId) {
    const others = await CaseItem.count({ where: { caseId, type: 'track' } });
    if (!others) await holdTrack(user, item.ref.trackId, null);
  }
  await record(caseId, user, 'item_removed', { itemId, type: item.type });
  return { ok: true };
}

// ── keeping footage ──────────────────────────────────────────────────

const keepQueue = [];
let keeping = false;

function queueKeep(user, item) {
  if (!FOOTAGE.has(item.type) || !item.monitorId || String(item.monitorId).startsWith('file:')) return;
  item.update({ preservedStatus: 'queued', preservedError: null }).catch(() => {});
  keepQueue.push({ user: { id: user.id, parentUserId: user.parentUserId, name: nameOf(user) }, itemId: item.id });
  setImmediate(drainKeeps);
}

async function drainKeeps() {
  if (keeping) return;
  keeping = true;
  try {
    while (keepQueue.length) {
      const job = keepQueue.shift();
      // eslint-disable-next-line no-await-in-loop -- one recorder pull at a time
      await keepOne(job).catch((e) => logger.warn('cases: keep failed', { itemId: job.itemId, error: e.message }));
    }
  } finally {
    keeping = false;
  }
}

async function keepOne({ user, itemId }) {
  const { CaseItem, Case } = models();
  const item = await CaseItem.findByPk(itemId);
  if (!item || item.preservedStatus === 'kept') return;
  const c = await Case.findByPk(item.caseId);
  const { nvrPull } = require('../controllers/playback.controller');
  const { pullOriginal } = require('./evidence/build');
  const pad = item.type === 'track' ? PAD_MS : 0;
  const startMs = new Date(item.tsFrom).getTime() - pad;
  const endMs = Math.min(new Date(item.tsTo).getTime() + pad, startMs + nvrPull.MAX_EXPORT_MS);
  // Wait for the user's other recorder pull (an export or evidence pack) to finish.
  for (let i = 0; i < 120 && nvrPull.exportsByUser.has(user.id); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5000));
  }
  const lock = { caseKeep: itemId };
  nvrPull.exportsByUser.set(user.id, lock);
  await item.update({ preservedStatus: 'keeping', preservedError: null });
  const dir = path.join(CASES_DIR, c.tenantId, c.id);
  const out = path.join(dir, `${item.id}.mp4`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cam = await nvrPull.loadCamera(user.id, item.monitorId);
    nvrPull.assertPlayback(cam);
    const { size, sha256 } = await pullOriginal(cam, startMs, endMs, out);
    await item.update({ preservedStatus: 'kept', preservedPath: out, preservedSha256: sha256, preservedSize: size });
    await record(c.id, user, 'footage_kept', { itemId, sha256, size, from: new Date(startMs), to: new Date(endMs) });
  } catch (e) {
    fs.rm(out, { force: true }, () => {});
    const msg = String(e.message || e).replace(/\/\/[^@\s/]*@/g, '//***@').slice(0, 500);
    await item.update({ preservedStatus: 'failed', preservedError: msg });
    await record(c.id, user, 'footage_keep_failed', { itemId, error: msg });
  } finally {
    if (nvrPull.exportsByUser.get(user.id) === lock) nvrPull.exportsByUser.delete(user.id);
  }
}

async function keepItem(user, caseId, itemId) {
  await access(user, caseId, 'editor');
  const item = await models().CaseItem.findOne({ where: { id: itemId, caseId } });
  if (!item) throw new AppError('Item not found.', 404);
  if (!FOOTAGE.has(item.type)) throw new AppError('Only a person or a clip has footage to keep.', 400);
  if (['queued', 'keeping', 'kept'].includes(item.preservedStatus)) return itemView(item);
  queueKeep(user, item);
  await record(caseId, user, 'footage_keep_requested', { itemId });
  return itemView(await item.reload());
}

async function keptFile(user, caseId, itemId) {
  await access(user, caseId);
  const item = await models().CaseItem.findOne({ where: { id: itemId, caseId } });
  if (!item || item.preservedStatus !== 'kept' || !item.preservedPath) throw new AppError('No kept footage for this item.', 404);
  const p = path.resolve(item.preservedPath);
  const IMPORTS_DIR = process.env.IMPORTS_DIR || path.join(config.streamService?.recordingsDir || '/recordings', '_imports');
  const inside = [CASES_DIR, IMPORTS_DIR].some((root) => p.startsWith(path.resolve(root) + path.sep));
  if (!inside || !fs.existsSync(p)) throw new AppError('The kept file is missing on the server.', 410);
  await record(caseId, user, 'footage_opened', { itemId });
  return { path: p, item };
}

// ── members ──────────────────────────────────────────────────────────

async function accountUsers(user) {
  const { User, Sequelize } = models();
  const owner = ownerId(user);
  const rows = await User.findAll({
    where: { [Sequelize.Op.or]: [{ id: owner }, { parentUserId: owner }] },
    attributes: ['id', 'name', 'username', 'email'],
  });
  return rows.map((u) => ({ id: u.id, name: nameOf(u) }));
}

async function setMember(user, caseId, { userId, role }) {
  await access(user, caseId, 'owner');
  if (!ROLES.includes(role)) throw new AppError(`role must be one of ${ROLES.join(', ')}.`, 400);
  const people = await accountUsers(user);
  const who = people.find((p) => String(p.id) === String(userId));
  if (!who) throw new AppError('That person is not on this account.', 404);
  await models().CaseMember.upsert({ caseId, userId: who.id, role, userName: who.name, addedBy: user.id });
  await record(caseId, user, 'member_set', { userId: who.id, name: who.name, role });
  return { userId: who.id, name: who.name, role };
}

async function removeMember(user, caseId, userId) {
  const { c } = await access(user, caseId, 'owner');
  if (String(userId) === String(c.userId)) throw new AppError('The account owner always has access.', 400);
  await models().CaseMember.destroy({ where: { caseId, userId } });
  await record(caseId, user, 'member_removed', { userId });
  return { ok: true };
}

module.exports = {
  createCase, listCases, getCase, updateCase, addItem, removeItem, keepItem, keptFile,
  setMember, removeMember, accountUsers, CASES_DIR,
  _internals: { access, keepOne, keepQueue },
};
