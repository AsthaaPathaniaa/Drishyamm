/**
 * restrictedZone.controller.js — CRUD for user-drawn restricted zones.
 * Zones are per-user + per-camera; a user may have many per camera and across
 * cameras (each is a row). Scoped to req.user.id.
 */
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { Camera, RestrictedZone } = require('../models');
const { assertAiLicence } = require('../services/entitlements.service');
const { zoneHasProducer, NO_PRODUCER_REASON } = require('../services/zoneProducer.service');

// A camera spends one restricted-zone licence while it has at least one armed
// zone, so arming the FIRST zone on a camera is the licensed step.
async function assertZoneLicence(req, monitorId) {
  const armed = await RestrictedZone.count({
    where: { userId: req.user.id, monitorId: String(monitorId), enabled: true },
  });
  if (armed === 0) await assertAiLicence(req.user.id, 'restricted_zone', 1);
}

/**
 * A zone may not be ARMED on a camera that has nothing detecting people.
 *
 * A zone is not a detector: it subscribes to boxes a producer publishes and
 * applies its own dwell / confirm rules to them. There are two producers (the
 * face pipeline, and zone-guard via `settings.ai.zoneBodyDetection`), and a
 * camera with face recognition off and body detection off has NEITHER. Such a
 * zone shows as armed, spends a restricted-zone licence, and watches nothing
 * -- the worst failure a security control has, because it is invisible.
 *
 * So this refuses, rather than arming something hollow. The reason names the
 * switch to turn on, because "no" without a next step is how an operator ends
 * up disabling the zone instead of fixing the camera.
 *
 * The OTHER direction -- an operator switching face recognition off on a
 * camera that already carries an armed zone -- cannot be refused here, because
 * it is not this route. It forces body detection on instead; see
 * resolveZoneBodyFlag in ai.controller.js. Both read zoneProducer.service.js,
 * so the two ends of the invariant cannot drift apart.
 *
 * A camera this account does not own, or one the AI registry has never seen,
 * is NOT refused: ownership is already enforced by the queries around this,
 * and inventing a second not-found path here would turn a missing-camera bug
 * into "your zone cannot be saved" with no way forward.
 */
async function assertZoneHasProducer(req, monitorId) {
  const camera = await Camera.findOne({
    where: { monitorId: String(monitorId), userId: req.user.id },
    attributes: ['id', 'settings'],
  });
  if (!camera) return;
  if (zoneHasProducer(camera.settings?.ai)) return;
  // 409, not 400: the request is well formed and the operator is allowed to
  // make it -- the CAMERA is in a state that cannot carry an armed zone.
  throw new AppError(NO_PRODUCER_REASON, 409);
}

// GET /api/restricted-zones?monitorId=...
const list = asyncHandler(async (req, res) => {
  const where = { userId: req.user.id };
  if (req.query.monitorId) where.monitorId = String(req.query.monitorId);
  const zones = await RestrictedZone.findAll({ where, order: [['created_at', 'DESC']] });
  res.json({ success: true, zones });
});

// POST /api/restricted-zones
const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.monitorId || !b.name) {
    return res.status(400).json({ success: false, message: 'Camera and zone name are required.' });
  }
  if (b.enabled !== false) {
    await assertZoneHasProducer(req, b.monitorId);
    await assertZoneLicence(req, b.monitorId);
  }
  const zone = await RestrictedZone.create({
    userId: req.user.id,
    monitorId: String(b.monitorId),
    cameraName: b.cameraName ? String(b.cameraName).slice(0, 120) : null,
    name: String(b.name).slice(0, 120),
    shape: b.shape === 'rectangle' ? 'rectangle' : 'polygon',
    points: Array.isArray(b.points) ? b.points : null,
    rect: b.rect && typeof b.rect === 'object' ? b.rect : null,
    priority: b.priority || 'high',
    schedule: b.schedule || 'always',
    armWindow: b.armWindow || b.window || null,
    dwellSec: Number.isFinite(+b.dwellSec) ? +b.dwellSec : 5,
    // The capacity rule. The column and the engine that reads it (`cap` in
    // zoneIntrusion.service.js) have both existed from the start; this route
    // simply never accepted the field, so a limit set in the zone editor could
    // not reach the engine and a zone configured by capacity alarmed on entry
    // instead. 0 and null both mean "no capacity rule" to the engine.
    maxOccupancy: Number.isFinite(+b.maxOccupancy) && +b.maxOccupancy > 0 ? Math.round(+b.maxOccupancy) : null,
    alertOnEntry: b.alertOnEntry !== false,
    allowed: Array.isArray(b.allowed) ? b.allowed : [],
    enabled: b.enabled !== false,
  });
  res.status(201).json({ success: true, zone });
});

// PUT /api/restricted-zones/:id
const update = asyncHandler(async (req, res) => {
  const zone = await RestrictedZone.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!zone) return res.status(404).json({ success: false, message: 'Zone not found.' });
  const b = req.body || {};
  if (b.enabled === true && zone.enabled !== true) {
    await assertZoneHasProducer(req, zone.monitorId);
    await assertZoneLicence(req, zone.monitorId);
  }
  const patch = {};
  ['name', 'priority', 'schedule', 'shape', 'cameraName'].forEach((k) => { if (b[k] != null) patch[k] = b[k]; });
  if (b.points != null) patch.points = b.points;
  if (b.rect != null) patch.rect = b.rect;
  if (b.armWindow != null || b.window != null) patch.armWindow = b.armWindow || b.window;
  if (b.dwellSec != null) patch.dwellSec = +b.dwellSec;
  // Sent explicitly as null or 0 to clear the capacity rule, so `!= null` is
  // the wrong test here: an operator removing a limit has to be able to.
  if ('maxOccupancy' in b) {
    patch.maxOccupancy = Number.isFinite(+b.maxOccupancy) && +b.maxOccupancy > 0
      ? Math.round(+b.maxOccupancy)
      : null;
  }
  if (typeof b.alertOnEntry === 'boolean') patch.alertOnEntry = b.alertOnEntry;
  if (Array.isArray(b.allowed)) patch.allowed = b.allowed;
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  await zone.update(patch);
  res.json({ success: true, zone });
});

// DELETE /api/restricted-zones/:id
const remove = asyncHandler(async (req, res) => {
  const n = await RestrictedZone.destroy({ where: { id: req.params.id, userId: req.user.id } });
  if (!n) return res.status(404).json({ success: false, message: 'Zone not found.' });
  res.json({ success: true, removed: n });
});

module.exports = { list, create, update, remove };
