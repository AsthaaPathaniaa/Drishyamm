// Ask Drishyam (I-8) and Summaries (I-9): question shapes in English and
// Hindi, citations that can't be faked, and periods in the viewer's time zone.
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const { _internals: { intentOf, describe } } = require('../src/services/ask/builtin');
const { _internals: { useCitations } } = require('../src/services/ask');
const { periodWindow } = require('../src/services/ask/digest');
const claude = require('../src/services/ask/claude');

test.each([
  ['When did the man in the red shirt first arrive?', 'first'],
  ['How many people came to Gate 3 last night?', 'count'],
  ['कल रात कितने लोग आए?', 'count'],
  ['लाल शर्ट वाला आदमी कब आया?', 'first'],
  ['Where did the woman in the yellow kurta go?', 'where'],
  ['वह कहाँ गया?', 'where'],
  ['Any unknown people at the gate today?', 'alerts'],
  ['What happened last night?', 'summary'],
  ['man with a backpack last hour', 'find'],          // "last hour" is a time, not the "last seen" question
])('%s → %s', (q, intent) => expect(intentOf(q)).toBe(intent));

test('the description keeps natural wording and drops the asking words', () => {
  expect(describe('When did the man in the red shirt first arrive?', {})).toBe('the man in the red shirt');
  expect(describe('When did he arrive?', {})).toBe('a person');          // a pronoun alone is no description
  expect(describe('कब?', { object_class: 'vehicle' })).toBe('a vehicle');
});

test('citations no tool produced are removed; only used ones are returned', () => {
  const ctx = { citations: [{ n: 1, link: '/a' }, { n: 2, link: '/b' }, { n: 3, link: '/c' }] };
  const out = useCitations(ctx, 'Seen at 10:00 [2]. Also at 11:00 [7]. Count [1][2].');
  expect(out.text).toBe('Seen at 10:00 [2]. Also at 11:00. Count [1][2].');
  expect(out.citations.map((c) => c.n)).toEqual([1, 2]);
});

test('"last night" is 18:00 yesterday to 06:00 today in India time', () => {
  const now = new Date('2026-11-24T09:00:00Z');                         // 14:30 IST
  const w = periodWindow('last_night', 'Asia/Kolkata', now);
  expect(w.from.toISOString()).toBe('2026-11-23T12:30:00.000Z');       // 18:00 IST
  expect(w.to.toISOString()).toBe('2026-11-24T00:30:00.000Z');         // 06:00 IST
  const early = periodWindow('last_night', 'Asia/Kolkata', new Date('2026-11-23T22:00:00Z'));   // 03:30 IST
  expect(early.to.toISOString()).toBe('2026-11-23T22:00:00.000Z');     // ends now, not in the future
  expect(periodWindow('today', 'Asia/Kolkata', now).from.toISOString()).toBe('2026-11-23T18:30:00.000Z');
});

test('Claude mode stays off without the SDK and a key (air-gapped default)', () => {
  const old = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  expect(claude.available()).toBe(false);
  process.env.ASK_PROVIDER = 'builtin';
  process.env.ANTHROPIC_API_KEY = 'x';
  expect(claude.available()).toBe(false);
  delete process.env.ASK_PROVIDER;
  if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old;
});
