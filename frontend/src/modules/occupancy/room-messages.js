/**
 * What a zone save and a zone delete say about themselves.
 *
 * Split out of room-settings.js for one reason: that module imports the AI
 * service, so the sentences an operator actually reads could not be checked by
 * `node --test`. They are the whole point of the partial-save design -- a save
 * that half-lands has to say WHICH half -- so they are worth a test, and a
 * pure module is what makes one possible. Same pattern as gate-sync.js.
 *
 * Nothing here talks to anything: ids in, words out.
 */

/** "A", "A and B", "A, B and C" -- a list inside a sentence, not a CSV. */
export function andList(items = []) {
  const list = (items || []).filter((s) => s != null && s !== '').map(String);
  if (list.length < 2) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Why the cameras did not all get the write, as sentences.
 *
 * The three failures are said differently because they are different events,
 * and only one of them is the camera's fault:
 *
 *   needsAi  the write was sent and refused because the camera's master AI
 *            switch is off. Nothing counts a camera whose AI is off, so the
 *            zone would read 0 for ever. This is the only one of the three
 *            with an action the operator can finish right now, so it is said
 *            FIRST, by name, with where to go and do it. Counted in with
 *            `failed` it came out as "1 of 3 cameras could not be updated",
 *            which names no cause and suggests nothing to do -- and it is the
 *            likeliest of the three to be the real reason.
 *   unknown  no registry row, so there was no camera id to write to and
 *            NOTHING WAS EVER SENT. Head counting is still off there, the zone
 *            will read 0 for ever, and no number on the page says which camera
 *            it was -- so these are NAMED. Being told "1 of 2 cameras could
 *            not be updated" leaves the operator to guess which, and the one
 *            they guess wrong about is the one that stays silent.
 *   failed    the write was sent and refused for a reason this browser cannot
 *            read -- a dead backend, a camera deleted somewhere else. The
 *            count is the useful shape: the camera is known, and the page
 *            lists it. Keeping this bucket generic is the point; it is what is
 *            left once the causes that CAN be named have been.
 *
 * `cameraName` turns a monitorId into the name the operator knows it by. It
 * falls back to the id -- as every other list in this module's callers does --
 * because a name nothing in the app knows is still better said than skipped.
 */
export function cameraFailures({
  unknown = [], failed = [], needsAi = [], touched = [], cameraName,
} = {}) {
  const nameOf = cameraName || ((m) => m);
  const out = [];
  if (needsAi.length) {
    const one = needsAi.length === 1;
    out.push(`head counting was not switched on for ${andList(needsAi.map(nameOf))}`
      + ` — ${one ? 'its' : 'their'} AI is switched off, and nothing counts a camera`
      + ` whose AI is off. Switch ${one ? 'it' : 'them'} on in Camera Setup → AI`
      + ' Detection, then save this zone again');
  }
  if (unknown.length) {
    out.push(`head counting was not switched on for ${andList(unknown.map(nameOf))}`
      + ` — this browser has no camera record for ${unknown.length === 1 ? 'it' : 'them'} yet,`
      + ' so the save never reached the detector. Save again once the camera list has loaded');
  }
  if (failed.length) {
    out.push(failed.length === touched.length
      ? 'the boundary and capacity could not be pushed to the camera'
      : `${failed.length} of ${touched.length} cameras could not be updated`);
  }
  return out;
}

/**
 * The one line a partial write reports itself with, or null when every half
 * landed. `lead` ends mid-sentence on purpose: what failed completes it.
 */
export function partialNote(lead, failures = []) {
  const list = (failures || []).filter(Boolean);
  return list.length ? `${lead} ${list.join('; and ')}.` : null;
}
