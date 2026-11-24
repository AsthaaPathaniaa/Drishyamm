/**
 * Telling the activity monitor which cameras to analyse — as a RECONCILE.
 *
 * This used to be fire-and-forget, and it was the one real reliability hole in
 * the AI control plane. `pushActivityCameras` was called from exactly two
 * places — an operator toggling the feature, and the admin console switching it
 * off on excess cameras — and on failure it logged a warning and returned. No
 * retry, no queue, and no push at startup. So:
 *
 *   * a toggle made while the activity service was restarting was LOST, and the
 *     database and the service disagreed indefinitely;
 *   * a backend restart never re-stated the set;
 *   * changing a camera's AI switch, or an owner's plan lapsing, never reached
 *     it at all, because neither path calls this;
 *   * and the service PERSISTS whatever set it last received, so a wrong set
 *     survived reboots with nothing anywhere that would ever correct it.
 *
 * Face AI never had any of those problems, for one reason: a loop re-states its
 * desired set every 15 seconds and never trusts its own last instruction. This
 * module makes the activity set work the same way. The service's endpoint is
 * already a full-set reconcile, so re-stating an unchanged set is a no-op.
 *
 * Still called directly on a toggle, so a save takes effect at once rather than
 * within one interval. The loop is the safety net, not the mechanism.
 */
const axios = require('axios');

const config = require('../config/env');
const logger = require('../config/logger');
const { activityCameras } = require('./aiFeatureCameras.service');

const ACTIVITY_BASE = config.activityServiceUrl;

// Re-posting an identical list every 15 s would be pointless chatter, so the
// push is skipped when nothing changed -- but only SELF_HEAL_EVERY times in a
// row. The exception matters: the service could have been restarted, rolled
// back or hand-edited since, and a reconcile that only ever reacts to local
// change cannot discover that. Every Nth tick it states the truth regardless.
const SELF_HEAL_EVERY = Number(process.env.ACTIVITY_SELF_HEAL_EVERY || 20);

let _lastPostedKey = null;
let _skippedSincePost = 0;

/** A stable identity for a desired set, so "has it changed?" is one compare. */
function keyOf(cameras) {
  return cameras.map((c) => c.id).sort().join(',');
}

/** Reset on demand -- tests need this, and so does a deliberate re-push. */
function forgetLastPosted() {
  _lastPostedKey = null;
  _skippedSincePost = 0;
}

/**
 * Compute the desired activity-camera set and send it.
 *
 * @param {{force?: boolean}} [opts] force skips the unchanged-set check, which
 *   is what a toggle wants: the operator is waiting on the answer.
 * @returns {Promise<{ok: boolean, pushed?: number, skipped?: boolean, error?: string}>}
 *   Never throws -- the caller is either a request handler that has already
 *   saved, or a loop that must survive to its next tick.
 */
async function pushActivityCameras({ force = false } = {}) {
  if (!ACTIVITY_BASE) return { ok: false, error: 'activity service not configured' };

  let desired;
  try {
    desired = await activityCameras();
  } catch (err) {
    logger.warn('activity cameras: could not compute the desired set', { error: err.message });
    return { ok: false, error: err.message };
  }

  const key = keyOf(desired);
  if (!force && key === _lastPostedKey && _skippedSincePost < SELF_HEAL_EVERY) {
    _skippedSincePost += 1;
    return { ok: true, pushed: desired.length, skipped: true };
  }

  try {
    const { data } = await axios.post(
      `${ACTIVITY_BASE}/activity/cameras`,
      { cameras: desired },
      { timeout: 8000 },
    );
    // Logged only when the set actually moved, so the loop is silent when
    // nothing is happening -- which is almost always.
    if (key !== _lastPostedKey) {
      logger.info('activity cameras pushed', {
        count: desired.length,
        previousCount: _lastPostedKey === null ? null : _lastPostedKey.split(',').filter(Boolean).length,
      });
    }
    _lastPostedKey = key;
    _skippedSincePost = 0;
    return { ok: true, pushed: desired.length, data };
  } catch (err) {
    // Deliberately does NOT remember this set: the next tick must try again.
    logger.warn('activity cameras push failed', { error: err.message });
    return { ok: false, error: err.message, pushed: desired.length };
  }
}

module.exports = { pushActivityCameras, forgetLastPosted };
