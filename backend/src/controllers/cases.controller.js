// Cases (investigation toolkit I-4). Thin HTTP layer over services/cases.js,
// which does access checks and writes case_audit for every read and change.
const asyncHandler = require('../middleware/asyncHandler');
const cases = require('../services/cases');

const list = asyncHandler(async (req, res) => res.json({ success: true, cases: await cases.listCases(req.user, req.query) }));
const create = asyncHandler(async (req, res) => res.status(201).json({ success: true, case: await cases.createCase(req.user, req.body || {}) }));
const get = asyncHandler(async (req, res) => res.json({ success: true, case: await cases.getCase(req.user, req.params.id) }));
const update = asyncHandler(async (req, res) => res.json({ success: true, case: await cases.updateCase(req.user, req.params.id, req.body || {}) }));
const addItem = asyncHandler(async (req, res) => res.status(201).json({ success: true, item: await cases.addItem(req.user, req.params.id, req.body || {}) }));
const removeItem = asyncHandler(async (req, res) => res.json(await cases.removeItem(req.user, req.params.id, req.params.itemId)));
const keepItem = asyncHandler(async (req, res) => res.json({ success: true, item: await cases.keepItem(req.user, req.params.id, req.params.itemId) }));
const keptFootage = asyncHandler(async (req, res) => {
  const { path: p, item } = await cases.keptFile(req.user, req.params.id, req.params.itemId);
  const name = `case_${(item.cameraName || item.monitorId || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 60)}_${new Date(item.tsFrom).toISOString().slice(0, 19).replace(/:/g, '-')}.mp4`;
  res.set('X-Content-SHA256', item.preservedSha256 || '');
  res.download(p, name, { headers: { 'Cache-Control': 'no-store' } });
});
const people = asyncHandler(async (req, res) => res.json({ success: true, people: await cases.accountUsers(req.user) }));
const setMember = asyncHandler(async (req, res) => res.json({ success: true, member: await cases.setMember(req.user, req.params.id, req.body || {}) }));
const removeMember = asyncHandler(async (req, res) => res.json(await cases.removeMember(req.user, req.params.id, req.params.userId)));

module.exports = { list, create, get, update, addItem, removeItem, keepItem, keptFootage, people, setMember, removeMember };
