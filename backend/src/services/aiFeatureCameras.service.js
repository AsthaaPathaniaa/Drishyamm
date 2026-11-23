/**
 * Which cameras each AI service is allowed to read.
 *
 * Every AI service used to decide this for itself, by a different mechanism,
 * and only face AI consulted the switch the operator is actually given:
 *
 *   face AI     the camera's AI switch + the plan, re-checked every 15 s
 *   head count  settings.headcount.enabled ALONE, filtered inside the service
 *   activity    settings.ai.activityMonitoring ALONE, filtered in the backend
 *   zone-guard  an environment variable, read once at import
 *
 * So switching a camera's AI off stopped face recognition and nothing else: the
 * one switch an operator is shown governed one of four services.
 *
 * ONE rule lives here and every feature is answered through it:
 *
 *   a camera qualifies for a feature when
 *       the camera's own AI switch is on          (isAiEnabled)
 *   AND the feature's own flag/reason is present  (per feature, below)
 *   AND the owner's plan includes AI              (getAiEntitledUserIds)
 *
 * The feature flag says WHAT to do with a camera. The AI switch says whether
 * to look at it at all. `isAiEnabled` is imported from the reconcile loop
 * rather than restated, because two copies of "is this camera's AI on?" is
 * precisely how a service ends up disobeying a human.
 *
 * In a service, not inline in the route, so the rule can be tested without
 * standing up Express.
 */
const config = require('../config/env');
const { Camera, RestrictedZone } = require('../models');
const { isAiEnabled } = require('./aiLifecycle.service');
const { getAiEntitledUserIds } = require('./entitlements.service');
const streamingService = require('./drishyamStreaming.service');

/** The two stream URLs a service may subscribe to, main and sub. */
function streamsFor(camera) {
  return {
    rtsp: streamingService.getRtspEgressUrl(camera.monitorId, false),
    rtspSub: streamingService.deriveSubPath(camera.path)
      ? streamingService.getRtspEgressUrl(camera.monitorId, true)
      : null,
  };
}

/**
 * Cameras that pass the two conditions every feature shares.
 * @param {string[]|null} monitorIds restrict to these, or null for all cameras
 */
async function eligible(monitorIds) {
  if (Array.isArray(monitorIds) && !monitorIds.length) return [];
  const [cameras, aiUserIds] = await Promise.all([
    Camera.findAll({
      ...(monitorIds ? { where: { monitorId: monitorIds } } : {}),
      attributes: ['id', 'userId', 'monitorId', 'name', 'path', 'status', 'settings'],
    }),
    getAiEntitledUserIds(),
  ]);
  return cameras.filter((c) => c.monitorId && isAiEnabled(c) && aiUserIds.has(c.userId));
}

/**
 * zone-guard: the camera needs a REASON to be watched, which is an enabled
 * restricted zone. Zones are queried first because far fewer cameras carry one
 * than exist, which bounds the camera query.
 */
async function zoneGuardCameras() {
  const zones = await RestrictedZone.findAll({
    where: { enabled: true },
    attributes: ['monitorId'],
  });
  const withZones = [...new Set(zones.map((z) => z.monitorId).filter(Boolean))];
  if (!withZones.length) return [];

  return (await eligible(withZones)).map((c) => ({
    id: c.id,
    userId: c.userId,
    monitorId: c.monitorId,
    name: c.name,
    ...streamsFor(c),
  }));
}

/**
 * head count: the camera needs `settings.headcount.enabled`.
 *
 * Rows come back in the SHAPE THE SERVICE ALREADY READS — `settings`, `status`,
 * `rtsp`, `rtspSub` — so the only change on that side is which URL it polls.
 * `status` is included deliberately: the service drops cameras the VMS reports
 * offline, which is about whether a camera can be DIALLED, not whether it is
 * eligible, and that stays its decision. So do its stream caps.
 */
async function headcountCameras() {
  const cams = await eligible(null);
  return cams
    .filter((c) => c.settings?.headcount?.enabled === true)
    .map((c) => ({
      id: c.id,
      userId: c.userId,
      monitorId: c.monitorId,
      name: c.name,
      status: c.status,
      settings: c.settings,
      ...streamsFor(c),
    }));
}

/**
 * activity monitoring: the camera needs `settings.ai.activityMonitoring`.
 *
 * Shaped for the activity service's own `POST /activity/cameras`, which takes
 * the FULL desired list and reconciles its workers to it. The source URL is
 * built from config rather than through streamingService so that the string
 * sent is byte-identical to what the controller sent before this moved -- a
 * reliability fix is the wrong place to change what a service receives.
 *
 * The set spans every user, not one: the activity monitor is a single global
 * service, so it has to be told the whole truth or it will stop cameras
 * belonging to everyone else.
 */
async function activityCameras() {
  const host = config.streamService.rtspHost;
  const port = config.streamService.rtspPort || 8554;
  const cams = await eligible(null);
  return cams
    .filter((c) => c.settings?.ai?.activityMonitoring === true)
    .map((c) => ({
      id: c.monitorId,
      name: c.name || c.monitorId,
      source: `rtsp://${host}:${port}/cam_${c.monitorId}`,
      vms_camera: c.monitorId,
    }));
}

module.exports = { zoneGuardCameras, headcountCameras, activityCameras };
