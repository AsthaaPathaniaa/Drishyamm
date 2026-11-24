// Pure helpers for Ask Drishyam (I-8/I-9). Tested in ask-model.test.js.

/** "Seen at 10:00 [2][3]." → [{ text: 'Seen at 10:00 ' }, { ref: 2 }, { ref: 3 }, { text: '.' }] */
export function splitCitations(text = '') {
  const out = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ ref: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Hindi when the question has Devanagari, else English (for voice + examples). */
export const langOf = (s = '') => (/[ऀ-ॿ]/.test(s) ? 'hi-IN' : 'en-IN');

export const PERIOD_LABEL = { last_night: 'Last night', today: 'Today', yesterday: 'Yesterday', last_24h: 'Last 24 hours' };

export const EXAMPLES = [
  'When did the man in the red shirt first arrive?',
  'How many people came to the gate today?',
  'Where did the woman in the yellow kurta go?',
  'कल रात कितने लोग आए?',
  'Any unknown people today?',
];
