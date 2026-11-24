// Evidence export (investigation toolkit I-5): sealed, hashed, signed packs.
//
//   POST /api/evidence                { monitorId, start, end, reason, trackIds?, scores?, timeZone? }
//   GET  /api/evidence                the account's export log
//   GET  /api/evidence/:id            one export (poll while 'building')
//   GET  /api/evidence/:id/download   the ZIP (JWT may ride as ?token=)
//   POST /api/evidence/verify         upload a ZIP → is it intact and signed?
//
// A reason is required (rule 7 of the toolkit design); every export,
// download and verification is audited. The pull from the recorder is the
// same one Recordings › Export uses: one at a time per user, 30 min max.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { audit } = require('../utils/audit');
const { aiTenantId } = require('../utils/aiTenant');
const { EvidenceExport } = require('../models');
const { nvrPull } = require('./playback.controller');
const { buildPack, EVIDENCE_DIR } = require('../services/evidence/build');
const { verifyPack } = require('../services/evidence/manifest');
const { knownFingerprints } = require('../services/evidence/keys');

const REASON_MIN = 10;
const REASON_MAX = 1000;
const ownerId = (u) => String(u?.parentUserId || u?.id || '');
const verifyUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 },
});

const view = (r) => ({
  id: r.id,
  status: r.status,
  error: r.error,
  monitorId: r.monitorId,
  cameraName: r.cameraName,
  start: r.startAt,
  end: r.endAt,
  reason: r.reason,
  createdBy: r.createdByName,
  createdAt: r.createdAt,
  trackIds: r.trackIds || [],
  files: r.files || [],
  zipSize: r.zipSize != null ? Number(r.zipSize) : null,
  zipSha256: r.zipSha256,
  manifestSha256: r.manifestSha256,
  keyFingerprint: r.keyFingerprint,
  downloads: r.downloads,
});

async function ownExport(req) {
  const row = await EvidenceExport.findByPk(req.params.id);
  if (!row || row.userId !== ownerId(req.user)) throw new AppError('Evidence export not found.', 404);
  return row;
}

const create = asyncHandler(async (req, res) => {
  const { monitorId, start, end, trackIds, scores, timeZone } = req.body || {};
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!monitorId || !start || !end) throw new AppError('monitorId, start and end are required.', 400);
  if (reason.length < REASON_MIN) throw new AppError(`Say why this footage is being exported (at least ${REASON_MIN} characters).`, 400);
  if (reason.length > REASON_MAX) throw new AppError(`The reason can be at most ${REASON_MAX} characters.`, 400);
  const ids = Array.isArray(trackIds) ? trackIds.filter((t) => typeof t === 'string' && /^[0-9a-f-]{36}$/i.test(t)).slice(0, 20) : [];

  const { startMs, endMs } = nvrPull.parseRange(start, end, nvrPull.MAX_EXPORT_MS, '30 minutes');
  if (endMs > Date.now()) throw new AppError("The end of the range hasn't been recorded yet.", 400);
  const cam = await nvrPull.loadCamera(req.user.id, monitorId);
  nvrPull.assertPlayback(cam);
  if (nvrPull.exportsByUser.has(req.user.id)) {
    throw new AppError('An export is already running. Wait for it to finish, then try again.', 429);
  }

  const row = await EvidenceExport.create({
    tenantId: aiTenantId(req.user),
    userId: ownerId(req.user),
    createdBy: req.user.id,
    createdByName: req.user.name || req.user.email || String(req.user.id),
    monitorId,
    cameraName: cam.camera.name,
    startAt: new Date(startMs),
    endAt: new Date(endMs),
    reason,
    trackIds: ids,
    ip: req.ip,
  });
  audit('evidence.export', {
    req, targetType: 'evidence_export', targetId: row.id,
    meta: { monitorId, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), reason, trackIds: ids },
  });
  const safeScores = scores && typeof scores === 'object' ? scores : {};
  setImmediate(() => { buildPack(row, cam, req.user, { scores: safeScores, timeZone }).catch(() => {}); });
  res.status(202).json({ success: true, export: view(row) });
});

const list = asyncHandler(async (req, res) => {
  const rows = await EvidenceExport.findAll({
    where: { userId: ownerId(req.user) }, order: [['created_at', 'DESC']], limit: 200,
  });
  res.json({ success: true, exports: rows.map(view) });
});

const get = asyncHandler(async (req, res) => {
  res.json({ success: true, export: view(await ownExport(req)) });
});

const download = asyncHandler(async (req, res) => {
  const row = await ownExport(req);
  if (row.status !== 'ready' || !row.zipPath) throw new AppError('This pack is not ready.', 409);
  const resolved = path.resolve(row.zipPath);
  if (!resolved.startsWith(path.resolve(EVIDENCE_DIR) + path.sep) || !fs.existsSync(resolved)) {
    throw new AppError('The pack file is no longer on the server. The export log entry remains.', 410);
  }
  await row.increment('downloads');
  audit('evidence.download', { req, targetType: 'evidence_export', targetId: row.id, meta: { zipSha256: row.zipSha256 } });
  const name = `evidence_${(row.cameraName || row.monitorId).replace(/[^\w.-]+/g, '_').slice(0, 60)}_${new Date(row.startAt).toISOString().slice(0, 19).replace(/:/g, '-')}_${row.id.slice(0, 8)}.zip`;
  res.download(resolved, name, { headers: { 'Cache-Control': 'no-store' } });
});

const verify = [
  verifyUpload.single('pack'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('Upload the evidence ZIP as "pack".', 400);
    try {
      const tenantId = aiTenantId(req.user);
      const result = await verifyPack(req.file.path);
      const ours = await knownFingerprints(tenantId);
      const madeHere = !!result.keyFingerprint && ours.includes(result.keyFingerprint);
      const exportId = result.manifest?.export_id;
      let logged = null;
      if (madeHere && exportId) {
        const row = await EvidenceExport.findByPk(exportId);
        if (row && row.userId === ownerId(req.user)) logged = view(row);
      }
      audit('evidence.verify', {
        req, targetType: 'evidence_export', targetId: exportId || null,
        meta: { ok: result.ok, signatureOk: result.signatureOk, madeHere, bad: result.files.filter((f) => !f.ok).map((f) => f.path) },
      });
      res.json({
        success: true,
        ok: result.ok,
        signatureOk: result.signatureOk,
        madeHere,
        keyFingerprint: result.keyFingerprint,
        exportId: exportId || null,
        logged,
        files: result.files,
        missing: result.missing,
        unlisted: result.unlisted,
        error: result.error,
      });
    } finally {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  }),
];

module.exports = { create, list, get, download, verify };
