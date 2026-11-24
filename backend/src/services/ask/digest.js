// AI Summaries (investigation I-9): "last night at Gate 3 in 3 lines".
//
// Built from the same tools as Ask Drishyam, without a language model: who
// was seen (per-camera passes, busiest 10 minutes), when activity started and
// ended, and the alerts. Every sentence links to where it came from, so a
// manager can read the digest and open exactly the footage behind a line.
const tools = require('./tools');

const PERIODS = {
  last_night: 'Last night',
  today: 'Today so far',
  yesterday: 'Yesterday',
  last_24h: 'Last 24 hours',
};

/** The UTC instant of local wall time y-m-d h:00 in `tz`. */
function localToUtc(tz, y, m, d, h = 0) {
  const guess = Date.UTC(y, m - 1, d, h);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return new Date(guess - (asLocal - guess));
}

function localDate(tz, at) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at).split('-').map(Number);
  return { y, m, d };
}

/** [from, to] for a named period in the viewer's time zone. */
function periodWindow(period, tz, now = new Date()) {
  const { y, m, d } = localDate(tz, now);
  const today0 = localToUtc(tz, y, m, d, 0);
  const day = 86_400_000;
  switch (period) {
    case 'today': return { from: today0, to: now };
    case 'yesterday': return { from: new Date(today0.getTime() - day), to: today0 };
    case 'last_24h': return { from: new Date(now.getTime() - day), to: now };
    case 'last_night':
    default: {
      // 18:00 yesterday → 06:00 today (or now, if it's before 06:00).
      const six = localToUtc(tz, y, m, d, 6);
      const end = now < six ? now : six;
      const yd = localDate(tz, new Date(today0.getTime() - day / 2));
      return { from: localToUtc(tz, yd.y, yd.m, yd.d, 18), to: end };
    }
  }
}

const c = (...refs) => refs.filter(Boolean).map((r) => `[${r}]`).join('');

async function digest(ctx, { period = 'last_night', cameras = [] } = {}) {
  const { from, to } = periodWindow(period, ctx.tz, ctx.now);
  const counts = await tools.countPeople(ctx, { cameras, from, to });
  const alerts = await tools.listAlerts(ctx, { cameras, from, to, limit: 3 });
  const busy = counts.cameras.filter((x) => x.people_passes > 0);
  const total = busy.reduce((s, x) => s + x.people_passes, 0);
  const title = `${PERIODS[period] || PERIODS.last_night} (${counts.window})`;
  const lines = [];
  if (!busy.length) {
    lines.push({ text: `No one was seen on ${cameras.length ? cameras.join(', ') : 'your cameras'}.`, refs: counts.cameras.map((x) => x.ref).slice(0, 3) });
  } else {
    const top = busy[0];
    lines.push({
      text: `${total} ${total === 1 ? 'person pass' : 'person passes'} on ${busy.length} ${busy.length === 1 ? 'camera' : 'cameras'}; busiest was ${top.camera} (${top.people_passes}), peaking ${top.busiest_10_min}.`,
      refs: busy.slice(0, 4).map((x) => x.ref),
    });
    const first = [...busy].sort((a, b) => String(a.first_activity).localeCompare(String(b.first_activity)))[0];
    const last = [...busy].sort((a, b) => String(b.last_activity).localeCompare(String(a.last_activity)))[0];
    lines.push({ text: `Activity started at ${first.first_activity} on ${first.camera} and ended at ${last.last_activity} on ${last.camera}.`, refs: [first.ref, last.ref] });
  }
  lines.push(alerts.total
    ? { text: `${alerts.total} ${alerts.total === 1 ? 'alert' : 'alerts'}: ${Object.entries(alerts.by_type).map(([t, n]) => `${n} ${t}`).join(', ')}${alerts.latest[0] ? `; the latest ${alerts.latest[0].type} on ${alerts.latest[0].camera} at ${alerts.latest[0].at}` : ''}.`, refs: [alerts.alerts_ref, alerts.latest[0]?.ref] }
    : { text: 'No alerts.', refs: [alerts.alerts_ref] });
  return {
    period, title, from: from.toISOString(), to: to.toISOString(),
    lines: lines.map((l) => ({ text: l.text, refs: [...new Set(l.refs.filter(Boolean))] })),
    text: lines.map((l) => `${l.text} ${c(...new Set(l.refs))}`).join(' '),
  };
}

module.exports = { digest, periodWindow, PERIODS };
