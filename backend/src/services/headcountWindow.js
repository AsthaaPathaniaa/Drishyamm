/**
 * When a camera is counted — head count's name for the window question.
 *
 * The mirror of zoneArming.js: that file says when a restricted ZONE is on
 * duty, this one says when a CAMERA is counted, and both get the time maths
 * itself from timeWindow.js so there is exactly one implementation of "is now
 * inside this window?" in the backend. Two readings of that question are how
 * 22:00-07:00 comes to mean a night shift in one file and an empty set in
 * another.
 *
 * WHY IT IS ITS OWN FILE, AND NOT A FUNCTION IN THE CAMERA SELECTOR
 * -----------------------------------------------------------------
 * It lived in aiFeatureCameras.service.js for about an hour, and the controller
 * that has to REPORT the answer imported it from there. That one import pulled
 * the selector in, which pulls in drishyamStreaming.service, which builds a
 * streaming engine at require() time -- and a suite that had never needed a
 * streaming engine to test a lifecycle route started failing with
 * `axios.create is not a function`.
 *
 * Nothing about "is this camera inside its hours?" needs a database, a stream
 * or an HTTP client. Kept here it stays PURE, and the two callers that have
 * nothing else in common -- the selector that filters on it and the controller
 * that reports it -- can both have it without inheriting each other's
 * dependencies.
 */
const { withinWindow } = require('./timeWindow');

/**
 * Is this camera inside its counting hours right now?
 *
 * The only reader of `settings.headcount.countWindow`. A camera with no window
 * counts always, which is what every camera configured before this feature
 * existed carries -- so absent MUST mean always, or shipping this would have
 * stopped counting on somebody's night shift.
 *
 * TWO CALLERS, ONE ANSWER, and that is the point of it being one function:
 *
 *   aiFeatureCameras.headcountCameras  FILTERS on it. A camera outside its
 *     hours drops out of the registry list the detector polls, so the detector
 *     stops its decode and its YOLO worker within one poll (~15s) and gives
 *     its stream slot back. This is what makes the feature save anything.
 *   ai.controller (GET /ai/cameras)    REPORTS it, as `headcount.countingNow`,
 *     so the page can explain a camera that has no tile.
 *
 * If those two ever disagreed, the page would be unable to explain its own
 * missing tile -- the exact defect the Head Count status work exists to
 * remove. They cannot disagree, because this is the only copy.
 *
 * @param {{countWindow?: {from?: string, to?: string}, schedule?: string}} headcount
 *        the camera's `settings.headcount`
 */
function withinCountWindow(headcount, now = new Date()) {
  return withinWindow(
    { window: headcount?.countWindow, schedule: headcount?.schedule },
    now,
  );
}

module.exports = { withinCountWindow };
