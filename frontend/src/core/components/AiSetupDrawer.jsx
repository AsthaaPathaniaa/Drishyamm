import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { aiService } from '@/core/services/ai';
import {
  AI_FEATURES,
  PURPOSES,
  PURPOSE_PRESETS,
  buildDisablePayload,
  buildEnablePayload,
  cameraFeatures,
  inferPurpose,
  lifecycleCopy,
} from '@/core/services/aiCamera';
import { Button } from '@/core/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/core/ui/sheet';

/**
 * The "Set up AI" drawer: which features, where the camera is, start.
 *
 * Shared by Camera Setup → AI Detection and AI Feed, so a camera is set up
 * the same way wherever the operator is. It saves on its own through the
 * per-camera lifecycle route and reports back with onSaved(nextRow).
 *
 * `camera` is a GET /ai/cameras row (serializeAiCamera in the backend).
 * Pass null to close.
 */
export default function AiSetupDrawer({ camera, onClose, onSaved }) {
  return (
    <Sheet open={Boolean(camera)} onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <SheetContent side="right" className="w-[400px] max-w-[calc(var(--app-vw)*0.92)] gap-0 p-0">
        {camera ? <SetupDrawer key={camera.id} camera={camera} onClose={onClose} onSaved={onSaved} /> : null}
      </SheetContent>
    </Sheet>
  );
}

const PRIORITY = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const INPUT_SIZES = [
  { value: 640, label: 'Fast' },
  { value: 960, label: 'Clear' },
  { value: 1280, label: 'Best' },
];

/** The drawer: pick features, say where the camera is, start. */
function SetupDrawer({ camera, onClose, onSaved }) {
  // Keyed on camera.id by the parent, so each camera starts a fresh draft.
  const [draft, setDraft] = useState(() => draftFromCamera(camera));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (payload) => {
    setSaving(true);
    setError('');
    try {
      const res = await aiService.updateCameraAiLifecycle(camera.id, payload);
      onSaved?.(res.data);
      if (res.reconcile && res.reconcile.ok === false) {
        // Saved, but the AI service did not start it: keep the drawer open and say so.
        setError(res.reconcile.error || 'Saved, but the AI service did not start this camera. Try again shortly.');
        return;
      }
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Could not update this camera.');
    } finally {
      setSaving(false);
    }
  };
  const updateDraft = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  // Picking a place pre-ticks the usual alerts for it; still editable.
  const applyPurpose = (purpose) => setDraft((prev) => ({ ...prev, purpose, ...(PURPOSE_PRESETS[purpose] || {}) }));
  const on = camera.ai?.enabled === true;
  const status = lifecycleCopy(camera.lifecycle);
  const drawn = Object.fromEntries(
    cameraFeatures({ ...camera, ai: { ...camera.ai, enabled: true } }).map((f) => [f.key, f.on]),
  );

  return (
    <>
      <div className="shrink-0 border-b border-line px-5 py-4 pr-12">
        <SheetTitle className="truncate text-heading font-semibold text-fg">{camera.name}</SheetTitle>
        <SheetDescription className="mt-0.5 flex items-center gap-1.5 text-small text-fg-muted">
          <span className={`h-2 w-2 rounded-full ${on ? status.dot : 'bg-line-strong'}`} />
          {on ? `AI ${status.label.toLowerCase()}` : 'AI is off'}
          <span className="text-fg-subtle">· {camera.groupName || 'Standalone'}{camera.channel ? ` · Ch ${camera.channel}` : ''}</span>
        </SheetDescription>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-2 text-small font-semibold text-fg">Turn on</p>
        <div className="divide-y divide-line rounded-lg border border-line">
          {AI_FEATURES.map((f) => {
            if (f.kind === 'core') {
              return (
                <FeatureLine key={f.key} feature={f}>
                  <span className="text-small text-fg-subtle">Always on</span>
                </FeatureLine>
              );
            }
            if (f.kind === 'flag') {
              return (
                <FeatureLine key={f.key} feature={f}>
                  <Switch label={f.label} value={draft[f.flag]} onChange={(v) => updateDraft(f.flag, v)} />
                </FeatureLine>
              );
            }
            return (
              <FeatureLine key={f.key} feature={f}>
                {drawn[f.key] ? (
                  <Link to={f.setupPath} className="inline-flex items-center gap-1 text-small font-medium text-success-ink hover:underline">
                    <Check className="h-3.5 w-3.5" /> Ready
                  </Link>
                ) : (
                  <Link to={f.setupPath} className="text-small font-medium text-brand-ink hover:underline">
                    {f.setupLabel.replace(/^Draw a /, 'Draw ')}
                  </Link>
                )}
              </FeatureLine>
            );
          })}
        </div>

        <label className="mt-5 block">
          <span className="mb-2 block text-small font-semibold text-fg">Place</span>
          <select
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-body text-fg outline-none focus:border-brand-line"
            onChange={(event) => applyPurpose(event.target.value)}
            value={draft.purpose}
          >
            <option value="">Select a place</option>
            {PURPOSES.map((purpose) => <option key={purpose} value={purpose}>{purpose}</option>)}
          </select>
        </label>

        <button
          aria-expanded={advancedOpen}
          className="mt-5 inline-flex items-center gap-1 text-small font-medium text-fg-muted hover:text-fg"
          onClick={() => setAdvancedOpen((v) => !v)}
          type="button"
        >
          Advanced
          <ChevronDown className={`h-4 w-4 transition ${advancedOpen ? 'rotate-180' : ''}`} />
        </button>

        {advancedOpen ? (
          <div className="mt-3 grid gap-4">
            <Labeled label="Alert priority">
              <Segmented options={PRIORITY} value={draft.priority} onChange={(v) => updateDraft('priority', v)} />
            </Labeled>
            <Labeled label={`Checking speed · ${draft.fps} fps`} title="Frames per second the AI looks at. 4 is recommended.">
              <input
                aria-label="Checking speed"
                className="w-full accent-brand"
                max="12"
                min="1"
                onChange={(event) => updateDraft('fps', Number(event.target.value))}
                type="range"
                value={draft.fps}
              />
            </Labeled>
            <Labeled label="Face detail" title="Higher spots faces further away but is slower.">
              <Segmented options={INPUT_SIZES} value={draft.detectionInputSize} onChange={(v) => updateDraft('detectionInputSize', v)} />
            </Labeled>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line px-5 py-4">
        {error ? (
          <p className="mb-3 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-small font-medium text-warning-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}
        <Button className="w-full" disabled={saving} onClick={() => submit(buildEnablePayload(camera, draft))} type="button">
          {saving ? <Loader2 className="animate-spin" /> : null}
          {on ? 'Save' : 'Start AI'}
        </Button>
        {on ? (
          <button
            className="mt-2 w-full rounded-lg py-2 text-small font-medium text-danger-ink hover:bg-danger-soft disabled:opacity-60"
            disabled={saving}
            onClick={() => submit(buildDisablePayload(camera))}
            type="button"
          >
            Turn AI off
          </button>
        ) : null}
      </div>
    </>
  );
}

/** A feature: its name (description on hover) and its control. */
function FeatureLine({ feature, children }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 px-3 py-2.5">
      <span className="text-body text-fg" title={feature.note}>{feature.label}</span>
      {children}
    </div>
  );
}

function Switch({ label, value, onChange }) {
  return (
    <button
      aria-label={label}
      aria-pressed={value}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${value ? 'bg-brand' : 'bg-line-strong'}`}
      onClick={() => onChange(!value)}
      type="button"
    >
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-surface shadow-sm transition-all ${value ? 'left-6' : 'left-1'}`} />
    </button>
  );
}

function Labeled({ label, title, children }) {
  return (
    <div title={title}>
      <p className="mb-1.5 text-small text-fg-muted">{label}</p>
      {children}
    </div>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1">
      {options.map((item) => (
        <button
          aria-pressed={value === item.value}
          className={`h-8 rounded-md text-small font-medium transition ${
            value === item.value ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
          key={item.value}
          onClick={() => onChange(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function draftFromCamera(camera) {
  const draft = buildEnablePayload(camera);
  // A camera never set up starts from its inferred place's preset.
  if (!camera.ai?.purpose) {
    const purpose = inferPurpose(camera);
    Object.assign(draft, PURPOSE_PRESETS[purpose] || {}, { purpose });
  }
  return draft;
}
