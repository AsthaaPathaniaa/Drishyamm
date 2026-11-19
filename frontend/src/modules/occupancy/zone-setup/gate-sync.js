/**
 * Keeping a gate editor in step with the gate the footfall service holds.
 *
 * The editors used to copy `gate` into useState once, on mount. That is fine
 * when the gate is already there and wrong whenever it is not, which is most
 * of the time: Zone Setup's `ready` comes from the head-count poll, the gates
 * come from a separate footfall call, and the editors mount as soon as the
 * CAMERA list resolves. So opening a saved gate showed the default line
 * across the middle of the picture, the saved one arrived a moment later, and
 * nothing looked at it. The gate was on disk the whole time.
 *
 * Re-reading the prop on every render is not the fix either -- that would
 * throw away a line the operator has dragged but not saved, every time the
 * 5-second poll came back.
 *
 * So: compare what the service holds now against what this editor last took
 * from it, and act on the difference.
 *
 *   nothing changed      leave the draft alone
 *   changed, untouched   take the new values (this is the arriving gate)
 *   changed, touched     keep the operator's edits and say so
 *
 * "Touched" means the operator moved something, NOT that the draft differs
 * from the baseline. Those are not the same: a draft opens with counting
 * switched on (opening a line on a camera that is not a gate yet is asking to
 * make it one), so a brand-new editor already differs from its baseline and
 * would claim unsaved edits it does not have.
 *
 * Pure, with no imports, so it runs under `node --test`.
 */

/** Message for a gate that moved under the operator while they were editing. */
export const CHANGED_ELSEWHERE = 'This gate was changed elsewhere — reload?';

/**
 * The three fields an editor owns, from a footfall gate row (gate-model.js's
 * `gateFromCamera`). A camera the service has never counted on -- or has not
 * told us about yet -- reads as off, on the default line.
 */
export function storedGate(gate, defaults) {
  return {
    enabled: Boolean(gate?.enabled),
    line: gate?.line ?? defaults.line,
    direction: gate?.direction || defaults.direction,
  };
}

/**
 * A comparable fingerprint of those three fields. Values, not object
 * identity: the footfall poll builds a fresh object every 5 seconds, and
 * re-seeding the draft on each one would fight the operator for the cursor.
 */
export function storedKey(stored) {
  const { a = [], b = [] } = stored.line || {};
  return [
    stored.enabled ? 1 : 0,
    stored.direction,
    a[0], a[1], b[0], b[1],
  ].join('|');
}

/**
 * What the editor should do about the gate it is now being handed.
 *
 * @param key      fingerprint of what the service holds now
 * @param seen     fingerprint this editor last took from the service
 * @param touched  has the operator moved anything since?
 * @returns 'none' | 'adopt' | 'conflict'
 */
export function syncAction({ key, seen, touched }) {
  if (key === seen) return 'none';
  return touched ? 'conflict' : 'adopt';
}
