import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  Search,
  Video,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { aiService } from '@/core/services/ai';
import { activeFeatureLabels, lifecycleCopy } from '@/core/services/aiCamera';
import AiSetupDrawer from '@/core/components/AiSetupDrawer';
import { PageAttention, PageTabs } from '@/core/layout/OperationsPage';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { SetupEmptyState, SetupErrorState } from '@/core/components/SetupState';
import { isEmptyPreview } from '@/core/lib/emptyPreview'; // TEMP-PREVIEW

/**
 * Camera Setup → AI Detection: the ONE place AI is switched on for a camera.
 *
 * Kept deliberately plain: a full-width camera list, and a side drawer that
 * opens on "Set up" / "Edit" with only what an operator needs (which features,
 * where the camera is, start). Feature descriptions live in tooltips; the
 * technical knobs sit under a collapsed "Advanced".
 */

const SHOW_TABS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'AI on' },
  { id: 'available', label: 'AI off' },
];

export default function AiDetectionSetup({ onNavigate }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // The list itself failed to load. Kept apart from `error` so a failed
  // fetch with nothing loaded shows the error card, never the empty state.
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  // ?camera=<id> (from AI Feed's "Set up AI") opens the drawer on that camera.
  const [searchParams] = useSearchParams();
  const [openId, setOpenId] = useState(() => searchParams.get('camera') || '');
  const [show, setShow] = useState('all');
  const queryClient = useQueryClient();

  const load = async () => {
    setLoading(true);
    try {
      const payload = await aiService.listCameraAiSettings();
      setRows(payload.data || []);
      setLoadError('');
      setLoaded(true);
      // Keep the tab-strip count (CameraSetup's summary query) in step.
      queryClient.setQueryData(['ai-camera-settings-summary'], payload.summary || {});
    } catch (err) {
      setLoadError(err?.response?.data?.message || err.message || 'Could not load AI camera settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((camera) => {
        if (show === 'running' && !camera.ai?.enabled) return false;
        if (show === 'available' && camera.ai?.enabled) return false;
        if (!q) return true;
        return camera.name?.toLowerCase().includes(q)
          || camera.groupName?.toLowerCase().includes(q)
          || camera.ai?.purpose?.toLowerCase().includes(q)
          || camera.monitorId?.toLowerCase().includes(q);
      })
      // Cameras with AI on first, then by name.
      .sort((a, b) => (b.ai?.enabled === true) - (a.ai?.enabled === true)
        || String(a.name || '').localeCompare(String(b.name || '')));
  }, [rows, query, show]);

  const openCamera = rows.find((camera) => camera.id === openId) || null;
  const onCount = rows.filter((camera) => camera.ai?.enabled).length;

  // Selected for AI but not running (and not merely starting): the one thing
  // on this tab that needs a hand.
  const stalled = rows.filter((camera) =>
    camera.ai?.enabled && !camera.runtime?.running && camera.lifecycle !== 'starting');
  const attention = stalled.length > 0 ? [{
    key: 'stalled',
    label: `${stalled.length} AI camera${stalled.length === 1 ? '' : 's'} selected but not running`,
    onClick: () => { setQuery(''); setShow('running'); setOpenId(stalled[0].id); },
  }] : [];

  // The drawer saves on its own; keep the list in step with what it saved.
  const handleSaved = (next) => {
    if (next?.id) setRows((prev) => prev.map((item) => item.id === next.id ? next : item));
  };

  return (
    <div className="h-full min-h-0 w-full">
      <div className="flex h-full w-full flex-col gap-4">
        {/* No heading here — Camera Setup's tab strip names the section. */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="text-body font-semibold text-fg">
              {loaded ? `AI is on for ${onCount} of ${rows.length} camera${rows.length === 1 ? '' : 's'}` : 'AI detection'}
            </p>
            <p className="text-small text-fg-muted">Choose a camera to pick what AI watches for.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search cameras…"
                aria-label="Search cameras"
                className="bg-surface pl-9 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <PageTabs tabs={SHOW_TABS} active={show} onChange={setShow} />
            <Button variant="outline" size="icon" onClick={load} type="button" aria-label="Refresh" title="Refresh">
              <RefreshCw className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>

        <PageAttention items={attention} className="shrink-0" />

        {/* Poll every 8 s: a failure after cameras have loaded keeps the
            list and shows the strip; a failure with nothing loaded gets the
            error card. TEMP-PREVIEW: isEmptyPreview() is dev-only. */}
        {isEmptyPreview() || (loaded && !loadError && rows.length === 0) ? (
          <NoAiCamerasState onNavigate={onNavigate} />
        ) : loadError && rows.length === 0 ? (
          <SetupErrorState
            title="Couldn't load AI detection"
            description="There was a problem connecting to the server."
            onRetry={load}
          />
        ) : (
          <>
            {loadError ? (
              <div className="shrink-0 rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-body font-medium text-warning-ink">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {loadError}
                </div>
              </div>
            ) : null}

            <section className="min-h-0 flex-1 overflow-y-auto">
              {loading && rows.length === 0 ? (
                <div className="grid min-h-[320px] place-items-center">
                  <Loader2 className="h-8 w-8 animate-spin text-brand" />
                </div>
              ) : visible.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-body text-fg-muted">
                  No cameras match.
                </p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {visible.map((camera) => (
                    <CameraTile key={camera.id} camera={camera} onOpen={() => setOpenId(camera.id)} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      <AiSetupDrawer camera={openCamera} onClose={() => setOpenId('')} onSaved={handleSaved} />
    </div>
  );
}

function NoAiCamerasState({ onNavigate }) {
  return (
    <SetupEmptyState
      illustration="ai"
      title="No cameras to run AI on"
      description="AI detection runs on your cameras. Add a camera or connect a recorder first, then come back to choose which feeds to watch."
      action={onNavigate ? (
        <Button onClick={() => onNavigate('cameras')}>Go to Cameras</Button>
      ) : null}
      secondary={onNavigate ? (
        <Button variant="outline" onClick={() => onNavigate('devices')}>Connect a recorder</Button>
      ) : null}
      steps={[
        { title: 'Add cameras',     detail: 'Connect a recorder or add IP cameras.' },
        { title: 'Pick feeds',      detail: 'Choose gates, reception and restricted areas.' },
        { title: 'Set alerts',      detail: 'Decide which detections raise an alert.' },
      ]}
    />
  );
}

/** One camera tile: name, where it is, AI state, what it watches for, one button. */
function CameraTile({ camera, onOpen }) {
  const on = camera.ai?.enabled === true;
  const status = lifecycleCopy(camera.lifecycle);
  const features = activeFeatureLabels(camera);
  return (
    <li className={`flex flex-col rounded-xl border bg-surface p-4 shadow-sm transition hover:shadow-md ${
      on ? 'border-brand-line' : 'border-line'
    }`}
    >
      <div className="flex items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${
          on ? 'bg-brand-soft text-brand-ink' : 'bg-surface-muted text-fg-subtle'
        }`}
        >
          <Video className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-semibold text-fg">{camera.name}</p>
          <p className="truncate text-small text-fg-muted">
            {camera.groupName || 'Standalone'}{camera.channel ? ` · Ch ${camera.channel}` : ''}
          </p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium ${
          on ? 'bg-success-soft text-success-ink' : 'bg-surface-muted text-fg-muted'
        }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${on ? status.dot : 'bg-line-strong'}`} />
          {on ? status.label : 'Off'}
        </span>
      </div>

      <div className="mt-3 flex min-h-6 flex-wrap gap-1">
        {on && features.length ? features.map((label) => (
          <span key={label} className="rounded-md bg-surface-muted px-1.5 py-0.5 text-caption font-medium text-fg-secondary">{label}</span>
        )) : (
          <span className="text-small text-fg-subtle">No AI features yet</span>
        )}
      </div>

      <Button className="mt-4 w-full" size="sm" variant={on ? 'outline' : 'default'} onClick={onOpen} type="button">
        {on ? 'Edit AI' : 'Set up AI'}
      </Button>
    </li>
  );
}

