// Audio Search (investigation phase 4): search what was said.
// Speech in an imported video, or a chosen range of this server's recordings,
// is transcribed on request (Whisper, on the GPU) and becomes searchable here.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines, Loader2, PlayCircle, Search } from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import { speechService } from '@/core/services/investigate';
import importsService from '@/core/services/imports';
import { highlight, playbackLink } from './search-model';

const errText = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const fmt = (d) => new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

export default function AudioSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const search = async (e) => {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try { setRes(await speechService.search(q.trim())); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  return (
    <OperationsPage>
      <PageHeader icon={AudioLines} title="Audio search"
        description="Search what was said. Speech is turned into text only when you ask for a video or a time range, and only on accounts where recording audio is allowed." />
      <PageContent scroll className="gap-4 pb-6">
        <PageCard className="p-4">
          <form onSubmit={search} className="flex gap-2">
            <label className="relative flex-1">
              <span className="sr-only">Words that were said</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} placeholder="Words that were said, in English or Hindi"
                className="h-11 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-body text-fg outline-none focus:border-brand" />
            </label>
            <button type="submit" disabled={q.trim().length < 2 || busy}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
            </button>
          </form>
          {error ? <p className="mt-2 text-small text-danger">{error}</p> : null}
          {res ? (
            <ul className="mt-4 divide-y divide-line">
              {!res.results.length ? <li className="py-3 text-small text-fg-muted">Nothing said matches “{res.q}” in what has been transcribed.</li> : null}
              {res.results.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-[12px] text-fg-muted">{r.camera_name} · {fmt(r.start)} · {r.lang === 'hi' ? 'Hindi' : r.lang === 'en' ? 'English' : r.lang}</p>
                    <p className="text-small text-fg">“{highlight(r.text, res.q).map((p, i) => (p.hit ? <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-fg">{p.hit}</mark> : <span key={i}>{p.text}</span>))}”</p>
                  </div>
                  <Link to={playbackLink({ camera_code: r.camera_code, first_seen: r.start, last_seen: r.end })}
                    className="inline-flex shrink-0 items-center gap-1 text-small font-semibold text-brand hover:underline">
                    <PlayCircle className="h-4 w-4" /> Play
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </PageCard>
        <TranscribeCard />
      </PageContent>
    </OperationsPage>
  );
}

function TranscribeCard() {
  const [imports, setImports] = useState([]);
  const [pick, setPick] = useState('');
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    importsService.list().then((rows) => setImports(rows.filter((r) => r.status === 'ready' && r.video?.audio))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!job?.job_id || ['ready', 'failed'].includes(job.status)) return undefined;
    const t = setInterval(() => speechService.status(job.job_id).then(setJob).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [job?.job_id, job?.status]);

  const start = async () => {
    setError(null);
    try { setJob(await speechService.transcribe({ monitorId: `file:${pick}` })); } catch (e) { setError(errText(e)); }
  };

  return (
    <PageCard className="p-4">
      <h2 className="text-body font-bold text-fg">Transcribe an imported video</h2>
      <p className="text-[12px] text-fg-muted">
        Its speech becomes searchable above. For a camera, use the speech button in Recordings on a range this server has recorded.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 min-w-64 rounded-lg border border-line bg-surface px-2 text-small text-fg">
          <option value="">Choose a video with sound…</option>
          {imports.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <button type="button" onClick={start} disabled={!pick || ['queued', 'transcribing'].includes(job?.status)}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-small font-semibold text-white disabled:opacity-50">
          <AudioLines className="h-4 w-4" /> Transcribe
        </button>
        {job ? (
          <span className="text-small text-fg-muted">
            {['queued', 'transcribing'].includes(job.status) ? <><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Transcribing {Math.round((job.progress || 0) * 100)}%</>
              : job.status === 'ready' ? `Done: ${job.segments} ${job.segments === 1 ? 'passage' : 'passages'} with speech.`
                : <span className="text-danger">{job.error}</span>}
          </span>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-small text-danger">{error}</p> : null}
    </PageCard>
  );
}
