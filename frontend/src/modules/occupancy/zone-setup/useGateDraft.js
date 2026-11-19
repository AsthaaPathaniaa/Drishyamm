/**
 * The draft of one camera's gate line, and how it is written back.
 *
 * Shared by gate mode (GateEditor) and the "Entry line" tool inside zone mode
 * (GateLineEditor), so the two places a line can be placed save it the same
 * way. The footfall service is the only store: nothing is cached on this
 * browser, so a gate counts identically whichever screen set it up.
 *
 * Saving a gate takes TWO things, not one. The footfall write configures the
 * counter; the camera also has to be running the AI pipeline, which the
 * backend starts only for a camera whose own AI flag is on, on a plan that
 * includes AI (aiLifecycle.service.js). A gate saved on a camera with AI off
 * is a line nothing crosses, so `write` switches AI on after the counter
 * lands -- see gate-ai.js -- and refuses to switch counting on at all when
 * the plan has no AI to switch.
 */
import { useState } from 'react';
import { aiService } from '@/core/services/ai';
import { makeEntitlement } from '@/core/nav/entitlements';
import { useAuthStore } from '@/core/store/authStore';
import { DEFAULT_DIRECTION, DEFAULT_LINE, gatePatch } from '../gate-model';
import { AI_BLOCKED, ensureAiForGate } from './gate-ai';
import { storedGate, storedKey, syncAction } from './gate-sync';

export function useGateDraft({ gate, cameraName, onSaved }) {
  // What the service holds now. A camera it has never counted on reads as
  // off, on the default line.
  const stored = storedGate(gate, { line: DEFAULT_LINE, direction: DEFAULT_DIRECTION });
  const [baseline, setBaseline] = useState(stored);
  // Opening a line on a camera that is not a gate yet is asking to make it
  // one, so the draft starts switched on; Save is then the one step left.
  const [draft, setDraft] = useState(() => ({ ...stored, enabled: true }));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  // Has the operator moved anything? Deliberately not "does the draft differ
  // from the baseline" -- the draft opens with counting switched on, so a
  // brand-new editor already differs and would claim edits it has not got.
  const [touched, setTouched] = useState(false);

  // ── Staying in step with the service ──────────────────────────────────
  // The gate often is not there on mount: this page's `ready` comes from the
  // head-count poll while gates come from the footfall call, so an editor can
  // open before its gate exists. Seeding state once, as this used to, meant a
  // saved gate arriving a moment later was ignored and the operator was shown
  // the default line over their own.
  const key = storedKey(stored);
  const [seen, setSeen] = useState(key);
  const [conflict, setConflict] = useState(false);

  const adopt = (next) => {
    setBaseline(next);
    setDraft({ ...next, enabled: true });
    setTouched(false);
    setConflict(false);
  };

  // Adjusting state during render, rather than in an effect: React re-runs
  // this render before committing, so the arriving gate is drawn once, with
  // no frame of the default line in between.
  const action = syncAction({ key, seen, touched });
  if (action !== 'none') {
    setSeen(key);
    if (action === 'conflict') setConflict(true);
    else adopt(stored);
  }

  /** Throw away the operator's edits and take the service's gate. */
  const reloadStored = () => { setSeen(key); adopt(stored); };

  // Does the account's plan include AI at all? Without it the backend will
  // never start this camera, so counting cannot be switched on here -- and
  // every /ai route, the footfall write included, answers 403 anyway.
  const planAllowsAi = makeEntitlement(useAuthStore((s) => s.user)).aiOn;
  const aiBlocked = !planAllowsAi;

  // Without the service's own id for this camera there is nowhere to write --
  // and so nothing that could count as unsaved.
  const known = Boolean(gate?.cameraId);
  const patch = gatePatch(baseline, draft);
  const dirty = known && Object.keys(patch).length > 0;
  const set = (p) => { setTouched(true); setDraft((d) => ({ ...d, ...p })); };

  // `after` is what the service holds once `body` lands -- only what was sent
  // moves, so an unsaved line position is not mistaken for a saved one.
  const write = async (body, after, message) => {
    setSaving(true);
    setResult(null);
    try {
      await aiService.footfallPutConfig(gate.cameraId, body);
      setBaseline(after);
      setDraft((d) => ({ ...d, ...(body.enabled === false ? { enabled: false } : null) }));
      // Saved, so there is nothing unsaved to protect: the refreshed gate that
      // follows (onSaved) should be adopted, not reported as a conflict.
      setTouched(false);
      setConflict(false);
      // A gate that is counting needs the pipeline behind it. Only on the way
      // on: switching counting off needs nothing started, and ensureAiForGate
      // never throws, so the catch below still means "the gate did not save".
      const ai = after.enabled
        ? await ensureAiForGate({
          monitorId: gate.monitorId,
          planAllowsAi,
          listCameras: () => aiService.listCameraAiSettings(),
          enableCamera: (cameraId, payload) => aiService.updateCameraAiLifecycle(cameraId, payload),
        })
        : { note: '' };
      setResult({ message: ai.note ? `${message} ${ai.note}` : message });
      onSaved?.();
    } catch (err) {
      setResult({ error: `Not saved: ${err?.response?.data?.message || err?.message || 'the footfall service did not accept the change'}. Nothing was changed on the camera.` });
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    // Nothing to save on a plan with no AI: the counter would be configured
    // and then never fed. GateEditor says the same thing up front, with a link
    // to the plan; this is for the smaller editor, and for a plan that lapsed
    // while the page was open.
    if (aiBlocked && draft.enabled) {
      setResult({ error: `${AI_BLOCKED}, and this plan does not include AI. The gate would stay at 0, so nothing was changed.` });
      return undefined;
    }
    return write(patch, draft, draft.enabled
      ? `Gate saved. ${cameraName} counts everyone crossing the line; it appears in the Gate Activity Matrix on the dashboard.`
      : `Saved. ${cameraName} is not counting as a gate.`);
  };

  // No confirm here. This used to raise a `window.confirm`, which was the last
  // one left in Zone Setup after the zone deletes moved to ConfirmDialog, and
  // it also meant the hook could only be driven from a place willing to be
  // interrupted by a browser modal. Asking is the caller's job now, so the
  // rail can offer the same action from a row menu.
  const stop = () => write(
    { enabled: false },
    { ...baseline, enabled: false },
    `${cameraName} is no longer counting as a gate.`,
  );

  return {
    draft, set, baseline, known, dirty, saving, result, save, stop, aiBlocked,
    // The gate moved under an operator who had unsaved edits. Their work is
    // kept; `reloadStored` is them choosing to drop it.
    conflict, reloadStored,
  };
}
