// Ask Drishyam (investigation I-8) and AI Summaries (I-9): entry points.
//
// Mode: Claude when available (services/ask/claude.js: SDK installed + API key,
// ASK_PROVIDER not "builtin"), else the built-in rule planner, which works
// air-gapped. Both use the same tools, so both cite the same way.
//
// After the answer is written, citations are checked: a [n] that no tool
// produced is removed, and only the citations the answer uses are returned.
const logger = require('../../config/logger');
const { AskContext } = require('./tools');
const builtin = require('./builtin');
const claude = require('./claude');
const { digest } = require('./digest');

function useCitations(ctx, text) {
  const known = new Map(ctx.citations.map((c) => [c.n, c]));
  const used = [];
  const clean = String(text || '').replace(/\[(\d+)\]/g, (m, n) => {
    const c = known.get(Number(n));
    if (!c) return '';
    if (!used.includes(c)) used.push(c);
    return m;
  }).replace(/\s+([.,;])/g, '$1').trim();
  return { text: clean, citations: used.sort((a, b) => a.n - b.n) };
}

async function ask({ user, cameras, question, tz }) {
  const ctx = new AskContext({ user, cameras, tz });
  let mode = claude.available() ? 'claude' : 'builtin';
  let out;
  if (mode === 'claude') {
    try {
      out = await claude.answer(ctx, question);
    } catch (e) {
      // Cloud model unreachable: answer with the built-in planner instead of failing.
      logger.warn('ask: Claude mode failed, using built-in', { error: e.message, status: e.status });
      mode = 'builtin';
      ctx.citations.length = 0;
      ctx.calls.length = 0;
    }
  }
  if (mode === 'builtin') out = await builtin.answer(ctx, question);
  const { text, citations } = useCitations(ctx, out.text);
  return { mode, model: out.model || null, intent: out.intent || null, answer: text, citations, tools: ctx.calls, understood: out.parsed?.chips?.map((c) => c.label) || [] };
}

async function summary({ user, cameras, tz, period, cameraNames }) {
  const ctx = new AskContext({ user, cameras, tz });
  const d = await digest(ctx, { period, cameras: cameraNames || [] });
  const byN = new Map(ctx.citations.map((c) => [c.n, c]));
  return { ...d, citations: [...new Set(d.lines.flatMap((l) => l.refs))].sort((a, b) => a - b).map((n) => byN.get(n)).filter(Boolean) };
}

module.exports = { ask, summary, _internals: { useCitations } };
