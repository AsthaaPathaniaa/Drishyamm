/**
 * What a zone will and will not catch, given what is detecting people on its
 * camera — and the switch that changes the answer.
 *
 * A zone detects nothing itself. It applies its dwell / confirm rules to boxes
 * a PRODUCER publishes, and there are two:
 *
 *   face pipeline   `ai.faceRecognition`, absent means ON. Boxes carry a NAME,
 *                   so an allow-list can excuse a person — but a face that is
 *                   turned away, covered or too far to read produces no box at
 *                   all, so the person is simply not there as far as the zone
 *                   is concerned.
 *   zone-guard      `ai.zoneBodyDetection`, absent means OFF. Boxes carry no
 *                   name, ever, by design: it detects a BODY. It catches the
 *                   person the face pipeline misses, and it cannot tell staff
 *                   from an intruder.
 *
 * Why this file exists rather than a sentence in the editor: "off" is a
 * legitimate choice here, and a legitimate choice has to be an INFORMED one.
 * A strict-lockout zone saved with body detection off is a zone that misses
 * the intruder who knows where the camera is — which is the intruder it was
 * drawn for. A silent off on a security control is the failure; the off itself
 * is not.
 *
 * The rules mirror the backend's zoneProducer.service.js, which is the
 * authority and enforces them. Nothing here is a permission check; it is what
 * the operator is TOLD.
 *
 * Pure, with no imports, so it runs under `node --test`. The API call in
 * `enableBodyDetection` is injected, the same pattern as gate-ai.js.
 */

/** Is this camera used by AI at all? Mirrors the backend's isAiEnabled. */
const aiOn = (row) => row?.ai?.enabled === true && row?.ai?.mode !== 'off';

/** Is the face pipeline producing boxes here? Absent means on. */
export const faceProducing = (row) => aiOn(row) && row?.ai?.faceRecognition !== false;

/** Is zone-guard producing boxes here? Absent means OFF — it is opted into. */
export const bodyProducing = (row) => aiOn(row) && row?.ai?.zoneBodyDetection === true;

/** Would a zone on this camera have anything feeding it? */
export const hasProducer = (row) => faceProducing(row) || bodyProducing(row);

/**
 * Is body detection MANDATORY on this camera rather than a choice?
 *
 * AI on, face recognition off: there is no other producer, so a zone here
 * fires only if zone-guard is watching. AI off entirely is NOT this case —
 * then nothing runs because the operator said so, which the editor reports
 * separately rather than treating as a detector problem.
 */
export const bodyRequired = (row) => aiOn(row) && row?.ai?.faceRecognition === false;

/** The modes whose coverage depends on which producer is running. */
const LOCKOUT = 'lockout';

/**
 * What to tell the operator about a zone on this camera, as
 * `{ level, headline, catches, misses, offer, reason }` — or null when there
 * is nothing worth saying.
 *
 * `offer` is true when the useful next action is the inline switch. It is
 * false when the problem is elsewhere (AI off entirely), because offering a
 * detector switch on a camera whose AI is off would be a control that saves
 * and changes nothing — the same mistake as showing the toggle on a camera
 * with no zone.
 *
 * Only LOCKOUT zones get the warning. A public zone alarms on nobody, so its
 * coverage is not a security question; an allow-list zone is not offered at
 * all today (access-data.js) precisely because zone-guard breaks it, and that
 * mode carries its own explanation already.
 */
export function zoneCoverage(row, mode) {
  if (!aiOn(row)) {
    return {
      level: 'blocked',
      headline: 'This camera\'s AI is off, so this zone will not fire at all.',
      catches: [],
      misses: ['Everyone — nothing is detecting people on this camera.'],
      offer: false,
      reason: 'Turn AI on for this camera in Camera Setup → AI Detection.',
    };
  }

  if (bodyRequired(row) && !bodyProducing(row)) {
    // The invariant. The backend refuses to arm a zone in this state, so this
    // is not advice -- it is what has to change before the zone can be saved.
    return {
      level: 'blocked',
      headline: 'Nothing on this camera is detecting people.',
      catches: [],
      misses: ['Everyone. Face recognition is off, so there is no other detector.'],
      offer: true,
      reason: 'This zone cannot be armed until body detection is on.',
    };
  }

  if (mode !== LOCKOUT || bodyProducing(row)) return null;

  // Face-only lockout: the case worth a sentence. Off is allowed, and this is
  // what it costs.
  return {
    level: 'warning',
    headline: 'This zone will only catch people whose face the camera can read.',
    catches: ['Anyone facing the camera closely enough to be detected.'],
    misses: [
      'Someone with their back or side to the camera.',
      'A covered, hooded or masked face.',
      'Anyone too far away for their face to register.',
    ],
    offer: true,
    reason: 'Nobody is permitted in a strict-lockout zone, so a body with no readable '
      + 'face is still a breach — but only body detection can see one.',
  };
}

/** Said after the inline switch has turned body detection on. */
export const BODY_TURNED_ON = 'Body detection is on for this camera. The zone now catches '
  + 'people whose face cannot be read.';

/** Where an operator turns it on by hand when the inline switch could not. */
const BY_HAND = 'Turn on "Catch people with no visible face" in Camera Setup → AI Detection.';

/**
 * Turn body detection on for one camera, from inside the zone editor.
 *
 * Goes through the SAME per-camera lifecycle route the AI Detection tab uses,
 * with every setting the camera already has carried over, so a camera switched
 * on from here is indistinguishable from one switched on there.
 *
 * Never throws: the operator is in the middle of editing a zone, and a failure
 * here changes what they are told, not what they have drawn.
 *
 * @param row            the camera's GET /ai/cameras row
 * @param buildPayload   (row, overrides) => lifecycle body (aiCamera's
 *                       buildEnablePayload, injected so this stays pure)
 * @param enableCamera   (cameraId, payload) => PATCH /ai/cameras/:id/lifecycle
 *
 * @returns { status, note }
 *            already-on  it was already running; nothing was asked of the backend
 *            turned-on   it is on now
 *            unknown     there is no camera row to act on
 *            failed      the call was refused, or the AI service did not start it
 */
export async function enableBodyDetection({ row, buildPayload, enableCamera }) {
  if (!row?.id) {
    return { status: 'unknown', note: `This camera is not in the AI camera list. ${BY_HAND}` };
  }
  if (bodyProducing(row)) return { status: 'already-on', note: '' };

  try {
    const payload = await enableCamera(row.id, buildPayload(row, { zoneBodyDetection: true }));
    if (payload?.reconcile && payload.reconcile.ok === false) {
      return {
        status: 'failed',
        note: `Body detection is saved, but the AI service did not start this camera: ${
          payload.reconcile.error || 'it did not respond.'} Nothing is detected until it does.`,
      };
    }
    return { status: 'turned-on', note: BODY_TURNED_ON };
  } catch (err) {
    const why = err?.response?.data?.message || err?.message || 'the request was refused';
    return { status: 'failed', note: `Body detection could not be turned on (${why}). ${BY_HAND}` };
  }
}

/**
 * The reason a zone cannot be SAVED as armed, or null when it can.
 *
 * One string, for the editor's existing problem list (`zoneProblems`). This is
 * the client half of the backend's 409: the operator should never have to send
 * a save to learn the camera cannot carry the zone.
 */
export function zoneDetectorProblem(row, cameraName = 'this camera') {
  if (!row) return null;        // no row to judge; the server is the authority
  if (!aiOn(row)) return null;  // AI off is reported by the editor already
  if (hasProducer(row)) return null;
  return `${cameraName} has face recognition off and no body detection, so nothing would `
    + 'detect people in this zone. Switch on "Catch people with no visible face" for it.';
}
