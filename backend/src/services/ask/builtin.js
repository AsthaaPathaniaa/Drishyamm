// Ask Drishyam, built-in mode: no language model, works air-gapped.
//
// Reads the question with the AI's rule parser (time, place, person/colours,
// English or Hindi), picks one of a few question shapes, calls the tools and
// writes a short answer in which every factual sentence cites [n]. Questions
// it can't shape are answered as a search ("here is who matches"), never with
// a guess.
const axios = require('axios');
const tools = require('./tools');

const ai = axios.create({ baseURL: process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001', timeout: 15_000 });
const GOOD_MATCH = 0.45;

// Question shapes, English + Hindi (Devanagari and romanised).
const INTENTS = [
  ['count', /\b(how many|count|number of|kitne|kitni|kitna)\b|कितने|कितनी|कितना|गिनती/i],
  ['alerts', /\b(alerts?|alarms?|unknown (people|person|faces?)|strangers?|intruders?|breach(es)?)\b|अलर्ट|अनजान|अजनबी/i],
  ['where', /\b(where did|where was|which cameras?|route|journey|go next|kahan|kidhar)\b|कहाँ|कहां|किधर|रास्ता/i],
  ['first', /\b(first|earliest|arrive[ds]?|arrival|came in|entered|pehli|pehle)\b|पहली|पहले|सबसे पहले|आया|आई|पहुंचा|पहुँचा/i],
  ['last', /\b(last seen|latest|most recent|left|leave|exit(ed)?|aakhri)\b|आखिरी|अंतिम|गया|गई|निकला/i],
  ['summary', /\b(summary|summari[sz]e|what happened|overview|digest|report)\b|क्या हुआ|सारांश/i],
];
// Words that ask rather than describe: removed before the description is embedded.
// Articles and prepositions stay: SigLIP matches a natural phrase better.
const ASKING = /\b(when|where|did|does|do|was|were|is|are|first|last|seen|arrive[ds]?|arrival|came|come|enter(ed)?|leave|left|go|went|how|many|show|me|find|any|who|which|cameras?|count|number|time|kab|kahan|kidhar|aaya|aayi|kitne|kitni|pehli|baar|kya|tha|thi|hai)\b|कब|कहाँ|कहां|किधर|आया|आई|कितने|कितनी|पहली|बार|क्या|था|थी|है|सबसे|पहले|गया|गई|\?/gi;

function intentOf(question) {
  // Time phrases ("last night", "last 2 hours") are not the "last" question.
  const q = question.replace(/\blast (night|hour|day|week|\d+\s*\w+)\b|कल रात|पिछले/gi, ' ');
  for (const [name, re] of INTENTS) if (re.test(q)) return name;
  return 'find';
}

function describe(question, parsed) {
  const stripped = question.replace(ASKING, ' ').replace(/[,;.!]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length >= 3 ? stripped : (parsed.object_class === 'vehicle' ? 'a vehicle' : 'a person');
}

const cites = (...refs) => refs.filter(Boolean).map((r) => `[${r}]`).join('');

async function parse(ctx, question) {
  const { data } = await ai.post('/investigate/parse', { q: question, tz: ctx.tz, cameras: ctx.cameras }, { headers: ctx.headers() });
  return data;
}

function windowOf(ctx, parsed, fallbackHours = 24) {
  const to = parsed.until ? new Date(parsed.until) : ctx.now;
  const from = parsed.since ? new Date(parsed.since) : new Date(to.getTime() - fallbackHours * 3600_000);
  return { from, to };
}

async function answer(ctx, question) {
  const parsed = await parse(ctx, question);
  const intent = intentOf(question);
  const cameraNames = (parsed.camera_codes || []).map((c) => ctx.names[c]).filter(Boolean);
  const lines = [];

  if (intent === 'count' || intent === 'summary') {
    const { from, to } = windowOf(ctx, parsed, intent === 'summary' ? 12 : 24);
    const res = await tools.countPeople(ctx, { cameras: cameraNames, from, to });
    const busy = res.cameras.filter((c) => c.people_passes > 0);
    const total = res.cameras.reduce((s, c) => s + c.people_passes, 0);
    if (!busy.length) {
      lines.push(`No one was seen on ${cameraNames.join(', ') || 'your cameras'} between ${res.window} ${cites(...res.cameras.slice(0, 3).map((c) => c.ref))}.`);
    } else {
      lines.push(`Between ${res.window}, ${total} ${total === 1 ? 'person pass was' : 'person passes were'} seen on ${busy.length} ${busy.length === 1 ? 'camera' : 'cameras'} ${cites(...busy.map((c) => c.ref))}.`);
      for (const c of busy.slice(0, 3)) {
        lines.push(`${c.camera}: ${c.people_passes} ${c.people_passes === 1 ? 'pass' : 'passes'}, busiest ${c.busiest_10_min}, first at ${c.first_activity}, last at ${c.last_activity} ${cites(c.ref)}.`);
      }
      lines.push('A pass is one person crossing a camera’s view, so one person seen twice counts twice.');
    }
    if (intent === 'summary') {
      const al = await tools.listAlerts(ctx, { cameras: cameraNames, from, to });
      if (al.total) lines.push(`${al.total} ${al.total === 1 ? 'alert' : 'alerts'}: ${Object.entries(al.by_type).map(([t, n]) => `${n} ${t}`).join(', ')} ${cites(al.alerts_ref)}.`);
    }
    return { intent, parsed, text: lines.join(' ') };
  }

  if (intent === 'alerts') {
    const { from, to } = windowOf(ctx, parsed);
    const al = await tools.listAlerts(ctx, { cameras: cameraNames, from, to });
    if (!al.total) {
      lines.push(`There were no alerts on ${cameraNames.join(', ') || 'your cameras'} between ${ctx.time(from)} and ${ctx.time(to)} ${cites(al.alerts_ref)}.`);
    } else {
      lines.push(`${al.total} ${al.total === 1 ? 'alert' : 'alerts'} between ${ctx.time(from)} and ${ctx.time(to)}: ${Object.entries(al.by_type).map(([t, n]) => `${n} ${t}`).join(', ')} ${cites(al.alerts_ref)}.`);
      for (const a of al.latest.slice(0, 3)) lines.push(`${a.type} on ${a.camera} at ${a.at}${a.name ? ` (${a.name})` : ''} ${cites(a.ref)}.`);
    }
    return { intent, parsed, text: lines.join(' ') };
  }

  // Questions about a described person: find them first.
  const description = describe(question, parsed);
  const { from, to } = parsed.since ? windowOf(ctx, parsed) : { from: undefined, to: undefined };
  const res = await tools.searchPeople(ctx, { description, cameras: cameraNames, from, to, limit: 12 });
  const good = res.people.filter((p) => p.match >= GOOD_MATCH * 100);
  if (!res.people.length) {
    return { intent, parsed, text: `I found no one matching “${description}”${cameraNames.length ? ` on ${cameraNames.join(', ')}` : ''}${parsed.since ? ' in that time' : ''} ${cites(res.search_ref)}.` };
  }
  const pool = good.length ? good : res.people.slice(0, 3);
  const weak = !good.length;
  const byTime = [...pool].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen));

  if (intent === 'first' || intent === 'last') {
    const p = intent === 'first' ? byTime[0] : byTime[byTime.length - 1];
    lines.push(`${intent === 'first' ? 'The earliest' : 'The latest'} ${weak ? 'possible' : 'good'} match for “${description}” is on ${p.camera} at ${p.seen_local} (${p.match}% match${p.colours ? `, ${p.colours}` : ''}) ${cites(p.ref)}.`);
    const others = byTime.filter((x) => x !== p).slice(0, 2);
    if (others.length) lines.push(`Other matches: ${others.map((o) => `${o.camera} at ${o.seen_local} ${cites(o.ref)}`).join('; ')}.`);
  } else if (intent === 'where') {
    const best = pool[0];
    const j = await tools.personJourney(ctx, { track_id: best.track_id });
    lines.push(`The best match for “${description}” is on ${best.camera} at ${best.seen_local} (${best.match}% match) ${cites(best.ref)}.`);
    if (j.stops.length > 1) {
      lines.push(`Their confirmed route: ${j.stops.map((s) => `${s.camera} (${s.seen_local})`).join(' → ')} ${cites(j.journey_ref)}.`);
    } else {
      lines.push(`No other sightings are confirmed yet ${cites(j.journey_ref)}.`);
    }
    if (j.unconfirmed_sightings) lines.push(`${j.unconfirmed_sightings} look-alike ${j.unconfirmed_sightings === 1 ? 'sighting needs' : 'sightings need'} review on the journey page ${cites(j.journey_ref)}.`);
  } else {
    lines.push(`${good.length || res.people.length} ${weak ? 'weak ' : ''}${(good.length || res.people.length) === 1 ? 'match' : 'matches'} for “${description}” ${cites(res.search_ref)}.`);
    for (const p of pool.slice(0, 3)) lines.push(`${p.camera} at ${p.seen_local}, ${p.match}% match${p.colours ? `, ${p.colours}` : ''} ${cites(p.ref)}.`);
  }
  lines.push(weak ? 'None of these is a strong match; check the photos before relying on them.' : 'Matches are leads, not identifications: open them to check the footage.');
  return { intent, parsed, text: lines.join(' ') };
}

module.exports = { answer, _internals: { intentOf, describe } };
