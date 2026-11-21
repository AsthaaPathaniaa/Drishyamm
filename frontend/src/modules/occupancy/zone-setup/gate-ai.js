/**
 * Turning the face pipeline on for a camera that has just been made a gate.
 *
 * Saving a gate only configures the COUNTER in the footfall service. The
 * pipeline that feeds it runs somewhere else entirely: smart-cam-backend's
 * aiLifecycle reconcile starts a camera in the AI service only when that
 * camera's own AI flag is on AND the owner's plan includes AI
 * (services/aiLifecycle.service.js). So a gate placed on a camera with AI off
 * is a line nothing ever crosses -- it sits at 0 for ever, and the operator is
 * told the gate is counting.
 *
 * This module is the missing half of that save: after the footfall write
 * lands, look at the camera's AI setting and switch it on through the same
 * per-camera lifecycle call Camera Setup's AI Detection tab uses, so the two
 * places that can start a camera agree on the payload.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It never sends `detectionZones`. The backend keeps the stored ones when
 *     the field is absent, so turning AI on for a gate cannot wipe a detection
 *     area somebody drew in AI Feed.
 *   - It never throws. The gate IS saved by the time this runs; a failure here
 *     changes what the operator is told, not whether the save happened.
 *
 * The AI service itself is untouched: everything here goes through existing
 * backend routes.
 *
 * Pure, with no imports, so it runs under `node --test`. The two API calls
 * are injected (see useGateDraft.js for the real ones).
 */

import { buildEnablePayload } from '../../../core/services/aiCamera.js';

/** Where an account's plan is shown. /pricing is parked (App.jsx), so this is it. */
export const PLAN_PATH = '/settings?tab=organization';

/** Said after a save that had to switch the camera's AI on first. */
export const AI_TURNED_ON = 'AI turned on for this camera so the gate can count.';

/** Said instead of saving, when the plan has no AI at all. */
export const AI_BLOCKED = 'Gate counting needs AI on this camera';

/** Where an operator turns AI on by hand when this could not. */
const BY_HAND = 'Turn AI on for it in Camera Setup → AI Detection.';

/** The camera row for `monitorId` in a GET /ai/cameras payload, or null. */
export function findAiCamera(rows, monitorId) {
  if (!monitorId) return null;
  const list = Array.isArray(rows) ? rows : [];
  return list.find((row) => row?.monitorId === monitorId) || null;
}

/** Is the pipeline already asked for on this camera? */
export const aiIsOn = (row) => row?.ai?.enabled === true;

/**
 * What to call this camera's AI purpose. Mirrors AiDetectionSetup's
 * inferPurpose for a camera it has never been set for, except that a camera
 * being made a gate is a gate -- not the "Restricted area" fallback.
 */
export function gatePurpose(row) {
  const stored = row?.ai?.purpose;
  if (stored) return stored;
  const text = `${row?.name || ''} ${row?.groupName || ''}`.toLowerCase();
  if (text.includes('entrance')) return 'Main gate';
  if (text.includes('reception')) return 'Reception';
  return 'Main gate';
}

/**
 * The PATCH /ai/cameras/:id/lifecycle body that switches this camera on.
 * Same shape as AiDetectionSetup's enableCamera, so a gate-started camera is
 * indistinguishable from one started on the AI Detection tab -- and every
 * setting the camera already had is carried, not reset to a default.
 */
export function enableAiPayload(row) {
  return buildEnablePayload(row, { purpose: gatePurpose(row) });
}

/**
 * Make sure the camera behind a just-saved gate is running the AI pipeline.
 *
 * @param monitorId      the camera's monitorId. NOT the footfall service's
 *                       `camera_id` the gate itself is saved under: the
 *                       lifecycle route takes smart-cam-backend's own camera
 *                       id, which is read off the AI camera list here.
 * @param planAllowsAi   does the account's plan include AI (entitlements' aiOn)
 * @param listCameras    () => GET /ai/cameras  -> { data: [row] }
 * @param enableCamera   (cameraId, payload) => PATCH /ai/cameras/:id/lifecycle
 *
 * @returns { status, note } -- `note` is a sentence to show the operator, or
 *          '' when there is nothing to say. Never rejects.
 *            blocked     the plan has no AI; nothing was asked of the backend
 *            already-on  the pipeline was already on, nothing to do
 *            turned-on   AI was off and is now on
 *            unknown     the backend does not list this camera
 *            unverified  the camera list could not be read
 *            failed      the lifecycle call was refused, or did not start it
 */
export async function ensureAiForGate({
  monitorId, planAllowsAi, listCameras, enableCamera,
}) {
  if (!planAllowsAi) return { status: 'blocked', note: '' };

  let rows;
  try {
    const payload = await listCameras();
    rows = payload?.data;
  } catch {
    return {
      status: 'unverified',
      note: `The gate is saved, but whether AI is on for this camera could not be checked, and a gate on a camera without AI stays at 0. ${BY_HAND}`,
    };
  }

  const row = findAiCamera(rows, monitorId);
  if (!row) {
    return {
      status: 'unknown',
      note: `The gate is saved, but this camera is not in the AI camera list, so nothing is counting it yet. ${BY_HAND}`,
    };
  }
  if (aiIsOn(row)) return { status: 'already-on', note: '' };

  try {
    const payload = await enableCamera(row.id, enableAiPayload(row));
    if (payload?.reconcile && payload.reconcile.ok === false) {
      return {
        status: 'failed',
        note: `The gate is saved and AI is now on for this camera, but the AI service did not start it: ${payload.reconcile.error || 'it did not respond.'} Nothing is counted until it does.`,
      };
    }
    return { status: 'turned-on', note: AI_TURNED_ON };
  } catch (err) {
    const why = err?.response?.data?.message || err?.message || 'the request was refused';
    return {
      status: 'failed',
      note: `The gate is saved, but AI could not be turned on for this camera (${why}), so nothing is counted yet. ${BY_HAND}`,
    };
  }
}
