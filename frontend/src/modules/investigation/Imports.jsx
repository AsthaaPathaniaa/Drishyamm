// File import (investigation toolkit I-7): bring in video from a phone, USB
// stick or another recorder; it becomes searchable like a camera.
//   /investigate/imports        upload + the account's imports (status, people found, SHA-256)
//   /investigate/imports/:id    play an imported video (at ?at=<time>), with the people found in it
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Clapperboard, Footprints, Loader2, RotateCcw, Search, Trash2, Upload } from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import importsService, { importVideoUrl } from '@/core/services/imports';
import investigateService, { cropUrl } from '@/core/services/investigate';
import { cn } from '@/core/lib/utils';
import { sizeLabel, toLocalInput } from './evidence-model';
import SynopsisDialog from './SynopsisDialog';

const errText = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
const mins = (s) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
const START_SOURCE = { file: 'from the video file', user: 'as entered', modified: 'from the file date', upload: 'unknown (upload time)' };

export default function Imports() {
  const { importId } = useParams();
  return importId ? <ImportPlayer key={importId} id={importId} /> : <ImportList />;
}

function ImportList() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => importsService.list().then(setRows).catch((e) => setError(errText(e))), []);
  useEffect(() => { load(); }, [load]);
  const busy = rows?.some((r) => ['queued', 'indexing'].includes(r.status));
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  return (
    <OperationsPage>
      <PageHeader icon={Upload} title="Import video"
        description="Bring in video from a phone, USB stick or another recorder. Everyone in it becomes searchable with Smart Search and Click to track, like your cameras." />
      <PageContent scroll className="gap-4 pb-6">
        <UploadCard onDone={load} />
        {error ? <p className="text-small text-danger">{error}</p> : null}
        <PageCard className="overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-body font-bold text-fg">Imported videos</h2>
            <p className="text-[12px] text-fg-muted">Each file keeps the SHA-256 taken while it was uploaded.</p>
          </div>
          {!rows && !error ? <p className="flex items-center gap-2 p-4 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : null}
          {rows?.length === 0 ? <p className="p-4 text-small text-fg-muted">Nothing imported yet.</p> : null}
          <ul className="divide-y divide-line">
            {(rows || []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link to={`/investigate/imports/${r.id}`} className="text-small font-semibold text-fg hover:text-brand">{r.title}</Link>
                  <p className="text-[12px] text-fg-muted">
                    {r.place ? `${r.place} · ` : ''}recorded {fmt(r.recordedStart)} ({START_SOURCE[r.recordedStartSource] || r.recordedStartSource})
                    {' · '}{mins(r.durationS)} · {sizeLabel(r.size)} · {r.video?.width}×{r.video?.height} {r.video?.codec}
                  </p>
                  <p className="font-mono text-[11px] text-fg-muted" title="SHA-256 taken while uploading">{r.sha256}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-small">
                  {r.status === 'ready' ? (
                    <span className="text-fg-secondary"><b>{r.tracks}</b> {r.tracks === 1 ? 'person' : 'people'} found{r.indexSeconds ? ` in ${Math.round(r.indexSeconds)} s` : ''}</span>
                  ) : r.status === 'failed' ? (
                    <span className="text-danger" title={r.error || ''}>{r.error || 'Failed'}</span>
                  ) : (
                    <span className="flex items-center gap-2 text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Indexing {Math.round((r.progress || 0) * 100)}%</span>
                  )}
                  {r.status === 'failed' ? (
                    <button type="button" onClick={() => importsService.reindex(r.id).then(load)} className="inline-flex items-center gap-1 text-brand hover:underline"><RotateCcw className="h-3.5 w-3.5" /> Try again</button>
                  ) : null}
                  <button type="button" title="Delete the file and everyone found in it"
                    onClick={() => { if (window.confirm(`Delete “${r.title}” and everyone found in it?`)) importsService.remove(r.id).then(load).catch((e) => setError(errText(e))); }}
                    className="text-fg-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        </PageCard>
      </PageContent>
    </OperationsPage>
  );
}

function UploadCard({ onDone }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState('');
  const [source, setSource] = useState('phone');
  const [when, setWhen] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setFile(f);
    setTitle((t) => t || f.name.replace(/\.[^.]+$/, ''));
    setError(null);
  };
  const send = async () => {
    if (!file) return;
    setProgress(0);
    setError(null);
    try {
      await importsService.upload(file, { title, place, source, recordedAt: when ? new Date(when).toISOString() : undefined },
        (p) => setProgress(p.total ? p.loaded / p.total : 0));
      setFile(null); setTitle(''); setPlace(''); setWhen('');
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setProgress(null);
    }
  };
  return (
    <PageCard className="p-4">
      <div className="flex flex-wrap items-end gap-3">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={progress != null}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-dashed border-line-strong px-4 text-small font-semibold text-fg-secondary hover:bg-surface-sunken">
          <Upload className="h-4 w-4" /> {file ? `${file.name} (${sizeLabel(file.size)})` : 'Choose a video file'}
        </button>
        <input ref={fileRef} type="file" accept="video/*,.dav,.ts,.mts,.mkv,.avi,.h264,.h265" className="hidden" onChange={pick} />
        <label className="grid min-w-48 flex-1 gap-1 text-[12px] font-medium text-fg-secondary">Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg" />
        </label>
        <label className="grid min-w-40 gap-1 text-[12px] font-medium text-fg-secondary">Where it was filmed
          <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={200} placeholder="e.g. Gate 3, outside" className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg" />
        </label>
        <label className="grid gap-1 text-[12px] font-medium text-fg-secondary">From
          <select value={source} onChange={(e) => setSource(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg">
            <option value="phone">Phone</option><option value="usb">USB / pen drive</option><option value="nvr">Another recorder</option><option value="other">Other</option>
          </select>
        </label>
        <label className="grid gap-1 text-[12px] font-medium text-fg-secondary" title="Leave empty to use the time stored in the video file">Recording started (optional)
          <input type="datetime-local" step="1" value={when} onChange={(e) => setWhen(e.target.value)} max={toLocalInput(new Date())}
            className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg" />
        </label>
        <button type="button" onClick={send} disabled={!file || progress != null}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white disabled:opacity-50">
          {progress != null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {progress != null ? `Uploading ${Math.round(progress * 100)}%` : 'Import'}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-fg-muted">The recording time decides where people land on the timeline: leave it empty to use the time stored in the file (phones and most recorders store it).</p>
      {error ? <p className="mt-2 text-small text-danger">{error}</p> : null}
    </PageCard>
  );
}

function ImportPlayer({ id }) {
  const [params] = useSearchParams();
  const at = params.get('at');
  const videoRef = useRef(null);
  const [imp, setImp] = useState(null);
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [synOpen, setSynOpen] = useState(false);

  useEffect(() => {
    importsService.get(id).then(setImp).catch((e) => setError(errText(e)));
    investigateService.search({ q: 'a person', overrides: { camera_codes: [`file:${id}`] }, topK: 200 })
      .then((d) => setPeople([...d.results].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen))))
      .catch(() => setPeople([]));
  }, [id]);

  const seek = (iso) => {
    const v = videoRef.current;
    if (!v || !imp) return;
    v.currentTime = Math.max(0, (Date.parse(iso) - Date.parse(imp.recordedStart)) / 1000 - 2);
    v.play().catch(() => {});
  };
  const onLoaded = () => { if (at) seek(at); };

  return (
    <OperationsPage>
      <PageHeader icon={Upload} title={imp ? imp.title : 'Imported video'}
        description={imp ? `${imp.place ? `${imp.place} · ` : ''}recorded ${fmt(imp.recordedStart)} (${START_SOURCE[imp.recordedStartSource] || ''}) · SHA-256 ${imp.sha256}` : ''}
        actions={(
          <div className="flex items-center gap-3">
            {imp?.status === 'ready' && imp.tracks ? (
              <button type="button" onClick={() => setSynOpen(true)} className="inline-flex items-center gap-1.5 text-small font-semibold text-brand hover:underline">
                <Clapperboard className="h-4 w-4" /> Synopsis
              </button>
            ) : null}
            <Link to="/investigate/imports" className="text-small font-semibold text-brand hover:underline">All imports</Link>
          </div>
        )} />
      {synOpen && imp ? (
        <SynopsisDialog open onOpenChange={setSynOpen} camera={{ monitorId: `file:${imp.id}`, name: imp.title }}
          from={Date.parse(imp.recordedStart)} to={Date.parse(imp.recordedStart) + (imp.durationS || 0) * 1000} />
      ) : null}
      <PageContent scroll className="gap-4 pb-6">
        {error ? <p className="text-small text-danger">{error}</p> : null}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <PageCard className="overflow-hidden bg-black">
            <video ref={videoRef} src={importVideoUrl(id)} controls onLoadedMetadata={onLoaded} className="max-h-[70vh] w-full bg-black" />
          </PageCard>
          <PageCard className="p-3">
            <h2 className="flex items-center gap-2 text-body font-bold text-fg"><Search className="h-4 w-4 text-brand" /> People in this video</h2>
            {!people ? <p className="mt-2 flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : null}
            {people?.length === 0 ? <p className="mt-2 text-small text-fg-muted">No one found{imp && imp.status !== 'ready' ? ' yet: the video is still being indexed' : ''}.</p> : null}
            <ul className="mt-2 grid max-h-[65vh] grid-cols-3 gap-2 overflow-auto">
              {(people || []).map((p) => (
                <li key={p.track_id} className={cn('overflow-hidden rounded-lg border border-line', at && Math.abs(Date.parse(p.first_seen) - Date.parse(at)) < 1000 && 'ring-2 ring-brand')}>
                  <button type="button" onClick={() => seek(p.first_seen)} title="Play from here" className="block w-full">
                    <img src={cropUrl(p.track_id)} alt="" loading="lazy" className="aspect-[3/4] w-full bg-surface-sunken object-cover" />
                  </button>
                  <div className="flex items-center justify-between px-1.5 py-1 text-[11px]">
                    <span className="text-fg-muted">{imp ? mins((Date.parse(p.first_seen) - Date.parse(imp.recordedStart)) / 1000) : ''}</span>
                    <Link to={`/investigate/track/${p.track_id}`} title="Track this person" className="text-brand"><Footprints className="h-3.5 w-3.5" /></Link>
                  </div>
                </li>
              ))}
            </ul>
          </PageCard>
        </div>
      </PageContent>
    </OperationsPage>
  );
}
