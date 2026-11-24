// Smart Search (investigation toolkit, I-2): describe someone — or drop a
// photo — and get every pass of a matching person across the cameras, best
// first. The parsed filters show as chips the user can remove; the search
// lives in the URL so it can be shared or reopened. A result opens Recordings
// on that camera at that moment.
//
// Matches are leads, not identifications: the score is how well the photo
// fits the words, shown so the user can judge (docs/investigation rule 15).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Camera, Car, Clock, FolderPlus, Footprints, ImageUp, Loader2, Moon, Palette, PlayCircle, Search, SearchX, ShieldCheck, User, X } from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import investigateService, { cropUrl } from '@/core/services/investigate';
import { cn } from '@/core/lib/utils';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import EvidenceExportDialog from './EvidenceExportDialog';
import { rangeAround } from './evidence-model';
import AddToCaseDialog from './AddToCaseDialog';
import { itemFrom } from './case-model';
import {
  colourLabel, isImported, playbackLink, readSearchState, removeChip, scoreLabel, visibleChips, whenLabel, writeSearchState,
} from './search-model';

const EXAMPLES = ['man, red top, backpack, 1–4 pm', 'woman in yellow kurta, yesterday evening', 'लाल शर्ट वाला आदमी, आज'];
const CHIP_ICON = { object_class: User, camera: Camera, time: Clock, top_colour: Palette, bottom_colour: Palette, vehicle_type: Car, vehicle_colour: Palette };

function errorText(err) {
  return err?.response?.data?.message || err?.response?.data?.detail || err?.message || 'Search failed';
}

export default function SmartSearch() {
  const [params, setParams] = useSearchParams();
  const urlState = readSearchState(params);
  const [draft, setDraft] = useState(urlState.q);
  const [photo, setPhoto] = useState(null);          // { file, url }
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [status, setStatus] = useState(null);
  const fileRef = useRef(null);
  const reqId = useRef(0);
  const user = useAuthStore((s) => s.user);
  const canExport = makeEntitlement(user).has('evidence_export');
  const canCase = makeEntitlement(user).has('investigate_cases');
  const [casing, setCasing] = useState(null);           // the result being added to a case
  const [exporting, setExporting] = useState(null);    // the result being exported

  useEffect(() => {
    investigateService.status().then(setStatus).catch(() => setStatus({ enabled: false }));
  }, []);

  const run = useCallback(async ({ q, clear }, file = null) => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const overrides = { clear };
      const data = file
        ? await investigateService.searchPhoto(file, { overrides })
        : await investigateService.search({ q, overrides });
      if (id === reqId.current) setState({ loading: false, error: null, data });
    } catch (err) {
      if (id === reqId.current) setState({ loading: false, error: errorText(err), data: null });
    }
  }, []);

  // The URL is the search: run whenever it changes (typing doesn't, Enter does).
  const key = params.toString();
  useEffect(() => {
    if (photo) return;
    setDraft(urlState.q);
    if (urlState.q) run(urlState);
    else setState({ loading: false, error: null, data: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const submit = (e) => {
    e?.preventDefault();
    const q = draft.trim();
    if (!q) return;
    setPhoto(null);
    setParams(writeSearchState({ q, clear: [] }));
    if (q === urlState.q && !urlState.clear.length) run({ q, clear: [] });
  };

  const onPhoto = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (photo?.url) URL.revokeObjectURL(photo.url);
    setPhoto({ file, url: URL.createObjectURL(file) });
    setParams(new URLSearchParams());
    run({ q: '', clear: [] }, file);
  };

  const clearPhoto = () => {
    if (photo?.url) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setState({ loading: false, error: null, data: null });
  };

  const dropChip = (kind) => setParams(writeSearchState(removeChip(urlState, kind)));

  const data = state.data;
  const results = data?.results || [];
  const chips = photo ? [] : visibleChips(data?.parsed, urlState.clear);
  const empty = status && status.enabled && status.tracks === 0;

  return (
    <OperationsPage>
      <PageHeader
        icon={Search}
        title="Smart Search"
        description="Describe who you are looking for — clothes, colours, bag, where and when — in English or Hindi, or search with a photo."
      />
      <PageContent scroll className="gap-4 pb-6">
        <PageCard className="p-4">
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">Describe the person</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={300}
                placeholder="e.g. man, red top, backpack, gate 3, 1–4 pm"
                className="h-11 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-body text-fg outline-none focus:border-brand"
              />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={!draft.trim() || state.loading}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white disabled:opacity-50">
                {state.loading && !photo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Search
              </button>
              <button type="button" onClick={() => fileRef.current?.click()}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:bg-surface-sunken">
                <ImageUp className="h-4 w-4" /> Photo
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPhoto} />
            </div>
          </form>

          {photo ? (
            <div className="mt-3 flex items-center gap-3 text-small text-fg-secondary">
              <img src={photo.url} alt="Search photo" className="h-14 w-14 rounded-md object-cover" />
              Searching by this photo
              <button type="button" onClick={clearPhoto} className="inline-flex items-center gap-1 text-fg-muted hover:text-fg">
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
          ) : null}

          {chips.length ? (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Filters understood from your search">
              {chips.map((c) => {
                const Icon = CHIP_ICON[c.kind] || Search;
                return (
                  <span key={c.kind} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-sunken pl-3 pr-1 text-small text-fg">
                    <Icon className="h-3.5 w-3.5 text-brand" />
                    {c.label}
                    <button type="button" onClick={() => dropChip(c.kind)} title="Remove this filter"
                      className="ml-0.5 grid h-6 w-6 place-items-center rounded-full text-fg-muted hover:bg-surface hover:text-fg">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}

          {!data && !state.loading && !photo ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-small text-fg-muted">
              Try:
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => { setDraft(ex); setParams(writeSearchState({ q: ex })); }}
                  className="rounded-full border border-line px-3 py-1 hover:bg-surface-sunken">{ex}</button>
              ))}
            </div>
          ) : null}
        </PageCard>

        {status && !status.enabled ? (
          <Notice title="Smart Search isn’t running on this server yet">
            The search index is switched off. Ask Drishyam support to turn it on; people are indexed from then on.
          </Notice>
        ) : empty ? (
          <Notice title="Nothing indexed yet">
            The index fills as people walk past your cameras. Come back in a little while.
          </Notice>
        ) : null}

        {state.error ? <Notice title="Search failed" tone="error">{state.error}</Notice> : null}

        {data ? (
          <div className="flex items-baseline justify-between gap-3 text-small text-fg-muted">
            <span>
              <strong className="text-fg">{results.length}</strong> {results.length === 1 ? 'match' : 'matches'}
              {data.summary?.cameras ? <> on <strong className="text-fg">{data.summary.cameras}</strong> {data.summary.cameras === 1 ? 'camera' : 'cameras'}</> : null}
              {' '}· best first
            </span>
            <span className="hidden sm:inline">Matches are leads: check the footage before acting on one.</span>
          </div>
        ) : null}

        {data && !results.length && !state.loading ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-fg-muted">
            <SearchX className="h-8 w-8" />
            <p>No one matched. Remove a filter or describe them differently.</p>
          </div>
        ) : null}

        <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6', state.loading && 'opacity-60')}>
          {results.map((r) => (
            <ResultCard key={r.track_id} r={r} onExport={canExport && r.camera_code && !isImported(r.camera_code) ? () => setExporting(r) : null}
              onCase={canCase && r.camera_code ? () => setCasing(r) : null} />
          ))}
        </div>
        {casing ? (
          <AddToCaseDialog open onOpenChange={(o) => { if (!o) setCasing(null); }} item={itemFrom.searchResult(casing)}
            what={`This person on ${casing.camera_name || casing.camera_code}.`} />
        ) : null}
        {exporting ? (
          <EvidenceExportDialog
            open
            onOpenChange={(o) => { if (!o) setExporting(null); }}
            camera={{ monitorId: exporting.camera_code, name: exporting.camera_name }}
            {...rangeAround(exporting)}
            trackIds={[exporting.track_id]}
            scores={{ [exporting.track_id]: exporting.score }}
          />
        ) : null}
      </PageContent>
    </OperationsPage>
  );
}

function ResultCard({ r, onExport, onCase }) {
  const colour = colourLabel(r);
  return (
    <PageCard as="article" className="group overflow-hidden">
      <Link to={playbackLink(r)} className="block" title="Play this moment">
        <div className="relative aspect-[3/4] bg-surface-sunken">
          <img src={cropUrl(r.track_id)} alt={`Person on ${r.camera_name || 'camera'}`} loading="lazy"
            className="h-full w-full object-cover" />
          <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white">
            {scoreLabel(r.score)} match
          </span>
          {r.ir ? (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
              <Moon className="h-3 w-3" /> Night
            </span>
          ) : null}
          <PlayCircle className="absolute bottom-2 right-2 h-8 w-8 text-white opacity-0 drop-shadow transition group-hover:opacity-100" />
        </div>
      </Link>
      <div className="space-y-0.5 p-2.5">
        <p className="truncate text-small font-semibold text-fg">{r.camera_name || r.camera_code || 'Camera'}</p>
        <p className="truncate text-[12px] text-fg-muted">{whenLabel(r)}</p>
        {colour ? <p className="truncate text-[12px] capitalize text-fg-muted">{colour}</p> : null}
        <Link to={`/investigate/track/${r.track_id}`}
          className="mt-1 mr-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
          <Footprints className="h-3.5 w-3.5" /> Track this person
        </Link>
        {onCase ? (
          <button type="button" onClick={onCase}
            className="mt-1 mr-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
            <FolderPlus className="h-3.5 w-3.5" /> Add to case
          </button>
        ) : null}
        {onExport ? (
          <button type="button" onClick={onExport}
            className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
            <ShieldCheck className="h-3.5 w-3.5" /> Export evidence
          </button>
        ) : null}
      </div>
    </PageCard>
  );
}

function Notice({ title, children, tone }) {
  return (
    <PageCard className={cn('p-4', tone === 'error' && 'border-danger')}>
      <p className={cn('text-small font-semibold', tone === 'error' ? 'text-danger' : 'text-fg')}>{title}</p>
      <p className="mt-1 text-small text-fg-muted">{children}</p>
    </PageCard>
  );
}
