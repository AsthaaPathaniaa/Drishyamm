/**
 * Switching a camera's AI on is the operator's decision, and this is the only
 * copy of what that means on the front end.
 *
 * WHY IT IS A RULE AND NOT A DETAIL
 * ---------------------------------
 * Every per-feature switch in this product -- head counting, zone body
 * detection, activity monitoring -- is gated on the camera's MASTER AI switch.
 * So a tick that asks for one feature cannot take effect on a camera whose
 * master is off, and something has to turn the master on.
 *
 * That something must ASK. Using a camera for AI at all is a privacy and a
 * cost choice: "I ticked counting" is not the same sentence as "yes, run AI on
 * this camera", and telling somebody afterwards that it happened is the same
 * fault one step quieter -- a change they did not choose. So the page asks
 * first, and the backend refuses (409 AI_CONSENT_REQUIRED) if anything ever
 * sends without having asked.
 *
 * WHY IT LIVES HERE
 * -----------------
 * The rule governs every feature behind that switch, so a module named after
 * one feature is the wrong home for it. It was written inside head count's
 * `counting-status.js`, and head count is now one of three readers -- the
 * occupancy zone setup and the AI setup drawer ask the same question. A rule
 * with three readers and no home is a rule that gets restated, and a second,
 * looser reading of the same switch is how a page comes to disagree with the
 * service it is describing.
 *
 * This is the front-end mirror of `backend/src/services/aiFlags.js`, which is
 * the single copy of what a stored flag MEANS; `aiLifecycle.service.js` is the
 * authority on consent itself. This file decides nothing -- the server does.
 * It is what the operator is ASKED and what the refusal is read as.
 *
 * The WORDING of each question stays with its own feature: "switch AI on and
 * count" is head-count copy, and zone setup has to say something else. Only
 * the rule is here.
 *
 * Pure, with no imports, so it runs under `node --test` -- the JSX around its
 * callers cannot be loaded there.
 */

/**
 * Is this camera's AI master switch on?
 *
 * Mirrors the backend's `isAiEnabled` exactly -- `enabled === true` AND the
 * mode is not 'off'. Restated here rather than guessed at, because every
 * feature gate in the product reads through this one question.
 */
export const aiOn = (cam) => cam?.ai?.enabled === true && cam?.ai?.mode !== 'off';

/** The server's machine-readable "ask first". Matched on the code, never prose. */
export const AI_CONSENT_REQUIRED = 'AI_CONSENT_REQUIRED';

/** Will switching this camera's feature on need the master switch turned on? */
export function needsAiConsent(cam) {
  return !aiOn(cam);
}

/** Is this the server telling us to ask? Read from the code, not the message. */
export function isConsentRefusal(err) {
  const body = err?.response?.data;
  return err?.response?.status === 409 && body?.code === AI_CONSENT_REQUIRED;
}

/**
 * The sentence the server sent, or the nearest honest thing.
 *
 * Here because the other half of asking is reporting the answer: a save
 * refused for a reason that is NOT a consent question (an exhausted licence, a
 * camera deleted in another tab, an unreachable backend) must still say
 * something true, and every caller of the rule above has that same catch.
 */
export function errorText(err) {
  return err?.response?.data?.message
    || err?.message
    || 'the request was refused and gave no reason';
}
