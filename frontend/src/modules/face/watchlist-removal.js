/**
 * What happened when we asked the AI service to stop matching a face — and
 * whether the list on screen may be changed to say so.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * The Watchlist page's roster is this browser's localStorage. The faces that
 * are actually MATCHED live in the AI service's gallery, and there is no
 * endpoint that lists it, so the only thing keeping the two in step is that
 * neither is written without the other.
 *
 * The page used to break that by swallowing the server's refusal and deleting
 * locally anyway:
 *
 *     try { await aiService.deleteFace(entry.name); } catch { }
 *     saveRoster(roster.filter(...));          // ran regardless
 *
 * So a FAILED removal looked exactly like a successful one. The person vanished
 * from the screen and went on being recognised — an operator believing they had
 * taken someone off a watchlist while the system kept identifying them. On a
 * privacy control that is the worst direction to fail in: silently, towards
 * more surveillance than was asked for.
 *
 * The decision is here, pure and tested, rather than inline in a 700-line JSX
 * file where the project has no way to test it at all. Same reason
 * room-messages.js and counting-status.js exist.
 */

/** The gallery confirmed it is gone. Safe to update the list on screen. */
export const REMOVED = 'removed';
/** The gallery never had it. Also gone, so also safe — see below. */
export const ALREADY_GONE = 'already-gone';
/** The gallery still has it. The list on screen must NOT change. */
export const REFUSED = 'refused';

/**
 * Read the outcome of `aiService.deleteFace`.
 *
 * A 404 IS SUCCESS. "The gallery does not have this face" is the state we were
 * asking for. Treating it as a failure would leave a row on screen that can
 * never be removed, which pushes an operator towards ignoring this list — and
 * an ignored privacy control is a broken one.
 *
 * Everything else is a refusal, including a network error. We asked, we did
 * not get a yes, so we must assume the face is still being matched. Guessing
 * optimistically here is the original defect.
 *
 * @param err the rejection from deleteFace, or nothing on success
 */
export function removalOutcome(err) {
  if (!err) return REMOVED;
  if (err?.response?.status === 404) return ALREADY_GONE;
  return REFUSED;
}

/** May the list on screen be changed to show this face as gone? */
export function mayForget(outcome) {
  return outcome === REMOVED || outcome === ALREADY_GONE;
}

/**
 * What to tell the operator, as `{ kind, msg }`.
 *
 * The refusal says three things, in this order, because an operator who stops
 * reading after the first clause must still have the important one: it did NOT
 * happen, the face is STILL being matched, and try again. The reason the server
 * gave comes between, where it informs without being the headline.
 */
export function removalMessage(name, outcome, err) {
  const who = name || 'That face';
  if (outcome === REFUSED) {
    const why = err?.response?.data?.message || 'the AI service did not respond.';
    return {
      kind: 'error',
      msg: `"${who}" was NOT removed: ${why} Their face is still being matched — try again.`,
    };
  }
  if (outcome === ALREADY_GONE) {
    // Not phrased as an error, because nothing is wrong: the end state the
    // operator asked for is the end state they have.
    return { kind: 'success', msg: `"${who}" was already gone, and is not being matched.` };
  }
  return { kind: 'success', msg: `"${who}" is no longer being matched.` };
}
