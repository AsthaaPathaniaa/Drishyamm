// Ask Drishyam (investigation I-8) + AI Summaries (I-9).
// Questions in English or Hindi, typed or spoken, answered from the search
// index, journeys, counts and alerts: never from a model watching video.
// Every fact in an answer carries [n]; each [n] links to where it came from.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MessageCircleQuestion, Mic, MicOff, Send, Sun } from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import { askService, cropUrl } from '@/core/services/investigate';
import { cn } from '@/core/lib/utils';
import { EXAMPLES, PERIOD_LABEL, langOf, splitCitations } from './ask-model';

const errText = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const Speech = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export default function AskDrishyam() {
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState([]);           // [{ q, a?, error?, busy }]
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [turns]);

  const send = async (question) => {
    const text = (question ?? q).trim();
    if (text.length < 3) return;
    setQ('');
    const i = turns.length;
    setTurns((t) => [...t, { q: text, busy: true }]);
    try {
      const a = await askService.ask(text);
      setTurns((t) => t.map((x, k) => (k === i ? { q: text, a } : x)));
    } catch (e) {
      setTurns((t) => t.map((x, k) => (k === i ? { q: text, error: errText(e) } : x)));
    }
  };

  const listen = () => {
    if (!Speech) return;
    if (listening) { recRef.current?.stop(); return; }
    const rec = new Speech();
    rec.lang = langOf(q) === 'hi-IN' ? 'hi-IN' : (navigator.language?.startsWith('hi') ? 'hi-IN' : 'en-IN');
    rec.interimResults = true;
    rec.onresult = (ev) => setQ(Array.from(ev.results).map((r) => r[0].transcript).join(' '));
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  return (
    <OperationsPage>
      <PageHeader icon={MessageCircleQuestion} title="Ask Drishyam"
        description="Ask about what your cameras saw, in English or Hindi. Answers come from your search index, journeys, counts and alerts — every fact links to where it came from." />
      <PageContent scroll className="gap-4 pb-6">
        <Summary />

        <PageCard className="p-4">
          <div className="space-y-4">
            {!turns.length ? (
              <div className="flex flex-wrap gap-2 text-small">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => send(ex)} className="rounded-full border border-line px-3 py-1 text-fg-secondary hover:bg-surface-sunken">{ex}</button>
                ))}
              </div>
            ) : null}
            {turns.map((t, k) => <Turn key={k} t={t} />)}
            <div ref={endRef} />
          </div>
          <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500}
              placeholder="e.g. When did the man in the red shirt first arrive at Gate 3?"
              className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-body text-fg outline-none focus:border-brand" />
            {Speech ? (
              <button type="button" onClick={listen} title={listening ? 'Stop' : 'Speak (English or Hindi)'}
                className={cn('grid h-11 w-11 place-items-center rounded-lg border', listening ? 'border-brand text-brand' : 'border-line text-fg-secondary hover:bg-surface-sunken')}>
                {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
            ) : null}
            <button type="submit" disabled={q.trim().length < 3}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white disabled:opacity-50">
              <Send className="h-4 w-4" /> Ask
            </button>
          </form>
        </PageCard>
      </PageContent>
    </OperationsPage>
  );
}

function Cited({ text, citations }) {
  const byN = new Map((citations || []).map((c) => [c.n, c]));
  return splitCitations(text).map((part, i) => {
    if (part.text != null) return <span key={i}>{part.text}</span>;
    const c = byN.get(part.ref);
    if (!c) return null;
    return (
      <Link key={i} to={c.link} title={c.label}
        className="mx-0.5 inline-grid min-w-5 place-items-center rounded bg-brand/10 px-1 align-super text-[10px] font-bold text-brand hover:bg-brand/20">{c.n}</Link>
    );
  });
}

function Turn({ t }) {
  const people = (t.a?.citations || []).filter((c) => c.trackId && c.kind === 'person');
  return (
    <div className="space-y-2">
      <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand/10 px-3 py-2 text-small text-fg">{t.q}</p>
      {t.busy ? <p className="flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Looking through your cameras…</p> : null}
      {t.error ? <p className="text-small text-danger">{t.error}</p> : null}
      {t.a ? (
        <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-line bg-surface px-3 py-2">
          <p className="text-small leading-relaxed text-fg"><Cited text={t.a.answer} citations={t.a.citations} /></p>
          {people.length ? (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {people.slice(0, 6).map((c) => (
                <Link key={c.n} to={c.link} title={c.label} className="relative shrink-0">
                  <img src={cropUrl(c.trackId)} alt="" className="h-20 w-14 rounded-md bg-surface-sunken object-cover" />
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-bold text-white">{c.n}</span>
                </Link>
              ))}
            </div>
          ) : null}
          <p className="mt-1.5 text-[11px] text-fg-muted">
            {t.a.mode === 'claude' ? `Answered by Claude from your data` : 'Answered on this server (no cloud AI)'}
            {t.a.understood?.length ? ` · understood: ${t.a.understood.join(' · ')}` : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Summary() {
  const [period, setPeriod] = useState('last_night');
  // The answer belongs to the period it was asked for; a different period is still loading.
  const [res, setRes] = useState({ period: null, d: null, error: null });
  useEffect(() => {
    let live = true;
    askService.summary(period)
      .then((d) => { if (live) setRes({ period, d, error: null }); })
      .catch((e) => { if (live) setRes({ period, d: null, error: errText(e) }); });
    return () => { live = false; };
  }, [period]);
  const current = res.period === period;
  const d = current ? res.d : null;
  const error = current ? res.error : null;
  return (
    <PageCard className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-body font-bold text-fg"><Sun className="h-4 w-4 text-amber-500" /> {d?.title || PERIOD_LABEL[period]}</h2>
        <div className="flex rounded-lg border border-line p-0.5 text-[12px]">
          {Object.entries(PERIOD_LABEL).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setPeriod(k)}
              className={cn('rounded-md px-2.5 py-1', period === k ? 'bg-surface-sunken font-semibold text-fg' : 'text-fg-muted')}>{label}</button>
          ))}
        </div>
      </div>
      {error ? <p className="mt-2 text-small text-danger">{error}</p> : null}
      {!d && !error ? <p className="mt-2 flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Summarising…</p> : null}
      {d ? (
        <ul className="mt-2 space-y-1 text-small text-fg">
          {d.lines.map((l, i) => (
            <li key={i}>• <Cited text={`${l.text} ${l.refs.map((n) => `[${n}]`).join('')}`} citations={d.citations} /></li>
          ))}
        </ul>
      ) : null}
    </PageCard>
  );
}
