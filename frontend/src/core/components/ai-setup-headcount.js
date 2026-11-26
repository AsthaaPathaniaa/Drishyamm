/**
 * The one decision the AI setup drawer has to make about its SECOND call.
 *
 * Saving a camera's AI settings and switching head counting on are two routes
 * (PATCH .../lifecycle writes settings.ai; PUT .../headcount writes
 * settings.headcount), so the drawer saves twice. The second call is the one
 * that can contradict the first.
 *
 * Counting is gated on the camera's master AI switch, and the backend REFUSES
 * to switch that master on for a tick: 409 AI_CONSENT_REQUIRED, because "I
 * ticked counting" is not the same sentence as "yes, run AI on this camera"
 * (see aiLifecycle.service.js, which is the authority). The retry's consent is
 * `enableAi: true` -- and this drawer must never send it. This form is where an
 * operator turns the master on themselves; a flag behind their back would be
 * the same decision taken quietly.
 *
 * Which leaves one combination that can ONLY fail: a submit that leaves AI off
 * while asking for counting to start. It used to be sent anyway and reported
 * afterwards as "the AI settings were saved, but head counting could not be
 * changed" -- a true sentence about a request that never had a chance. The
 * drawer already knows what it is about to save, so it answers the question
 * before the network does.
 *
 * Pure, with no imports, so it runs under `node --test`.
 */

/**
 * Said in the drawer, beside the two controls that disagree, because both of
 * them are the fix: there is nothing to reopen and nothing to retry.
 */
export const HEADCOUNT_NEEDS_AI = "Head counting needs this camera's AI on. "
  + 'Switch AI on above, or untick counting.';

/**
 * Will the camera's master AI switch be ON once this payload is saved?
 *
 * Mirrors the backend's `isAiEnabled` (enabled AND mode !== 'off') read
 * against the row the lifecycle route is about to write, NOT the row the
 * drawer was opened on: the whole point is that a submit turning AI on makes
 * the counting call legitimate, and asking the stale row would refuse it.
 *
 * `mode` is resolved the way the controller resolves it -- `patch.mode ||
 * previousAi.mode || 'continuous'` -- so a payload that omits `mode` on a
 * camera whose stored mode is 'off' is read as still off, which is what the
 * save would actually leave behind.
 */
export function aiOnAfterSave(payload, camera) {
  if (payload?.enabled !== true) return false;
  const mode = payload?.mode || camera?.ai?.mode || 'continuous';
  return mode !== 'off';
}

/**
 * What this submit should do about head counting, as
 * `{ send, enabled, refuse }`:
 *
 *   send    make the second call at all. False when the tick did not change
 *           (nothing to write) or when the combination cannot succeed.
 *   enabled what to send as `enabled`, so the caller does not re-derive it.
 *   refuse  the sentence to show instead of calling, or null.
 *
 * A refusal is returned rather than thrown, and is decided BEFORE the first
 * call: a submit that can only end in an error should not have written the
 * camera's AI settings on the way there.
 *
 * Switching counting OFF is never refused, whatever the master is doing. The
 * backend only asks about starting (`startAi = enabled && !isAiEnabled`), and
 * un-ticking a camera is not a request to run anything on it -- refusing it
 * here would strand a camera ticked-but-not-counting with no way to untick it.
 *
 * @param camera          the GET /ai/cameras row the drawer was opened on
 * @param payload         the lifecycle body this submit is about to send
 * @param headcountEnabled what the counting tick now says, or undefined when
 *                        this submit is not about counting at all
 */
export function planHeadcountChange({ camera, payload, headcountEnabled } = {}) {
  const idle = { send: false, enabled: undefined, refuse: null };
  if (headcountEnabled === undefined) return idle;
  if (headcountEnabled === (camera?.headcount?.enabled === true)) return idle;

  if (headcountEnabled === true && !aiOnAfterSave(payload, camera)) {
    return { send: false, enabled: true, refuse: HEADCOUNT_NEEDS_AI };
  }
  return { send: true, enabled: headcountEnabled, refuse: null };
}
