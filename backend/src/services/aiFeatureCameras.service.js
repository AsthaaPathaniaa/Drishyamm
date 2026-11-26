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
const { bodyProducerOn } = require('./zoneProducer.service');
const { withinArmWindow } = require('./zoneArming');
const { withinCountWindow } = require('./headcountWindow');

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
 * zone-guard: the camera needs a REASON to be watched and PERMISSION to be,
 * which are two different things.
 *
 *   the reason      an enabled restricted zone that is ARMED RIGHT NOW. Zones
 *                   are queried first because far fewer cameras carry one than
 *                   exist, which bounds the camera query.
 *   the permission  `settings.ai.zoneBodyDetection`, the FOURTH condition.
 *
 * ARMED, not merely enabled. The engine already refuses to alert outside a
 * zone's window (zoneIntrusion.service.js), so listing a camera whose only
 * zone is armed 09:00-17:00 bought a decoded, inferred, posted stream for
 * sixteen hours a day whose every box the engine dropped on the floor. The
 * window test is shared with the engine rather than restated -- see
 * zoneArming.js -- because two readings of "is this zone on duty" is how the
 * feeder and the engine end up disagreeing. `enabled` is not re-tested here:
 * it is the SQL WHERE clause below.
 *
 * This is a LIVE condition, so the list changes with the clock and not only
 * with the database. The service re-reads it every ZONE_SIM_REGISTRY_REFRESH
 * seconds and starts and stops workers to match, so a window opening at 09:00
 * acquires the camera within one refresh and 17:00 releases it -- no restart,
 * and no operator action.
 *
 * The fourth condition exists because the right answer differs per ZONE, not
 * per deployment. A strict lockout wants this detector; an allow-list zone is
 * broken by its nameless boxes; a camera with face recognition off needs it or
 * the zone never fires at all. Without a per-camera switch, one of those three
 * was always being served badly.
 *
 * ABSENT MEANS FALSE -- the opposite of `faceRecognition`, deliberately. A
 * second detector per camera costs GPU on every frame, so it is opted into
 * rather than inherited: every camera that exists today keeps zone-guard OFF
 * until an operator asks for it on that camera. See zoneProducer.service.js
 * for the whole producer model, and for the invariant that stops a zone being
 * armed on a camera with NO producer at all.
 */
async function zoneGuardCameras() {
  const zones = await RestrictedZone.findAll({
    where: { enabled: true },
    // The window fields come back so the arm test can be applied here. A zone
    // carrying no schedule is armed always, which is the column default.
    attributes: ['monitorId', 'schedule', 'armWindow'],
  });
  const withZones = [...new Set(
    zones.filter((z) => withinArmWindow(z)).map((z) => z.monitorId).filter(Boolean),
  )];
  if (!withZones.length) return [];

  const permitted = (await eligible(withZones)).filter((c) => bodyProducerOn(c.settings?.ai));
  return permitted.map((c) => ({
    id: c.id,
    userId: c.userId,
    monitorId: c.monitorId,
    name: c.name,
    ...streamsFor(c),
  }));
}

/**
 * head count: the camera needs `settings.headcount.enabled`, AND to be inside
 * its counting hours.
 *
 * Rows come back in the SHAPE THE SERVICE ALREADY READS — `settings`, `status`,
 * `rtsp`, `rtspSub` — so the only change on that side is which URL it polls.
 * `status` is included deliberately: the service drops cameras the VMS reports
 * offline, which is about whether a camera can be DIALLED, not whether it is
 * eligible, and that stays its decision. So do its stream caps.
 *
 * THE HOURS ARE APPLIED HERE, NOT IN THE DETECTOR, and that is the whole point
 * of the feature. The detector reconciles its workers to whatever list this
 * returns (manager.reconcile stops the ones that have gone), so a camera that
 * falls outside its window DROPS OUT of the list and its decode and its YOLO
 * worker are stopped within one poll -- 15s. Filtering inside the detector
 * instead would keep the stream open and throw the frames away, which is the
 * exact waste zone-guard was found doing for sixteen hours a day before
 * zoneArming moved this test to the selector.
 *
 * It also GIVES THE SLOT BACK. The detector opens 8 streams at most, so a
 * night-shift camera that counts nobody until 07:00 was holding one of eight
 * all night; now a day camera can have it.
 */
async function headcountCameras() {
  const cams = await eligible(null);
  return cams
    .filter((c) => c.settings?.headcount?.enabled === true)
    .filter((c) => withinCountWindow(c.settings?.headcount))
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
