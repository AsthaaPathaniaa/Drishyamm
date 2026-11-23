/**
 * Which cameras zone-guard should watch.
 *
 * zone-guard produces the PERSON boxes the restricted-zone engine needs. It
 * used to choose its own cameras from `ZONE_SIM_MONITORS` — an environment
 * variable, read once at import, checked against nothing. Set to `all` it
 * opened every camera in the deployment on the MAIN stream and held each
 * session permanently: cameras with no zone drawn on them, cameras whose AI an
 * operator had deliberately switched off, and cameras on accounts with no AI
 * plan. A large invisible load, and a service that disobeyed the one switch the
 * operator is given.
 *
 * The product decides here instead. A camera qualifies when ALL THREE hold:
 *
 *   1. its own AI switch is on — `isAiEnabled`, the SAME function the face-AI
 *      reconcile loop uses. Restating the test here would let the two drift,
 *      and a camera the operator switched off being watched anyway is the exact
 *      defect this selector exists to remove;
 *   2. it has a reason to be watched — at least one restricted zone with
 *      `enabled = true`;
 *   3. the owner's plan includes AI.
 *
 * Lives in a service rather than inline in the route so the rule can be tested
 * without standing up Express.
 */
const { Camera, RestrictedZone } = require('../models');
const { isAiEnabled } = require('./aiLifecycle.service');
const { getAiEntitledUserIds } = require('./entitlements.service');
const streamingService = require('./drishyamStreaming.service');

/**
 * @returns {Promise<Array<{id, userId, monitorId, name, rtsp, rtspSub}>>}
 *   the cameras zone-guard should be analysing right now. Empty is a valid and
 *   common answer — most deployments have zones on a handful of cameras.
 */
async function zoneGuardCameras() {
  // Zones first. On any real deployment far fewer cameras carry a zone than
  // exist, so this is the cheap way round and it bounds the camera query.
  const zones = await RestrictedZone.findAll({
    where: { enabled: true },
    attributes: ['monitorId'],
  });
  const wanted = [...new Set(zones.map((z) => z.monitorId).filter(Boolean))];
  if (!wanted.length) return [];

  const [cameras, aiUserIds] = await Promise.all([
    Camera.findAll({
      where: { monitorId: wanted },
      attributes: ['id', 'userId', 'monitorId', 'name', 'path', 'settings'],
    }),
    getAiEntitledUserIds(),
  ]);

  return cameras
    .filter((c) => isAiEnabled(c) && aiUserIds.has(c.userId))
    .map((c) => ({
      id:        c.id,
      userId:    c.userId,
      monitorId: c.monitorId,
      name:      c.name,
      rtsp:      streamingService.getRtspEgressUrl(c.monitorId, false),
      // Published so the service CAN move to the lighter stream; zone-guard
      // infers at 4 fps on 640 px input and has no need of the main channel.
      // That switch is a separate change — this only makes it possible.
      rtspSub:   streamingService.deriveSubPath(c.path)
                   ? streamingService.getRtspEgressUrl(c.monitorId, true)
                   : null,
    }));
}

module.exports = { zoneGuardCameras };
