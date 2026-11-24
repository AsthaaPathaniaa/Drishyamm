// Ask Drishyam, Claude mode (cloud tenants): Claude plans which tools to call
// and writes the answer; the tools and their citations are the same as in
// built-in mode (services/ask/tools.js).
//
// What leaves the server: the question and the tools' text results (camera
// names, times, counts, colours, match percentages). Never video or photos.
//
// Off unless BOTH the `@anthropic-ai/sdk` package is installed and an API key
// is configured (ANTHROPIC_API_KEY); ASK_PROVIDER=builtin forces it off.
// Everything else falls back to built-in mode.
const logger = require('../../config/logger');
const tools = require('./tools');
const { digest } = require('./digest');

const MODEL = process.env.ASK_CLAUDE_MODEL || 'claude-opus-5-5';

function sdk() {
  try {
    return { Anthropic: require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'), betaTool: require('@anthropic-ai/sdk/helpers/beta/json-schema').betaTool };
  } catch {
    return null;
  }
}

function available() {
  if ((process.env.ASK_PROVIDER || 'auto') === 'builtin') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY) && Boolean(sdk());
}

const SYSTEM = `You answer questions about what a business's security cameras saw, for the people who run that business.
You can only know what the tools return: search results for described people, journeys across cameras, counts of people per camera, alerts, and summaries. You never see video or photos.
Every sentence that states a fact must end with the citation numbers of the tool results it comes from, written like [3] or [3][5]. Only use numbers that appear as "ref" values in tool results. If the tools don't answer the question, say so plainly; do not guess.
Search matches are leads, not identifications: say "matches" or "possible match", never "this is the person". Never judge whether someone looks suspicious and never infer gender, age, religion or caste.
Answer in the language of the question (English or Hindi), in at most 5 short sentences. Times are already in the viewer's local time; repeat them as given.`;

function toolset(ctx, betaTool) {
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const when = {
    from: { type: 'string', description: 'Start, ISO 8601 with offset. Omit for all time.' },
    to: { type: 'string', description: 'End, ISO 8601 with offset. Omit for now.' },
  };
  const cams = { type: 'array', items: { type: 'string' }, description: 'Camera names as the person called them. Omit for all cameras.' };
  const run = (fn) => async (input) => {
    try {
      return JSON.stringify(await fn(input));
    } catch (e) {
      return JSON.stringify({ error: e.response?.data?.detail || e.message });
    }
  };
  return [
    betaTool({
      name: 'search_people',
      description: 'Find people seen on the cameras who match a description (clothes, colours, bag, vehicle). Best matches first, with times and a match percentage.',
      inputSchema: obj({ description: { type: 'string', description: 'What they look like, e.g. "man in a red top with a backpack". No times or places here.' }, cameras: cams, ...when, limit: { type: 'integer', minimum: 1, maximum: 30 } }, ['description']),
      run: run((i) => tools.searchPeople(ctx, i)),
    }),
    betaTool({
      name: 'person_journey',
      description: 'Where one person (a track_id from search_people) went: their confirmed stops across cameras, in time order.',
      inputSchema: obj({ track_id: { type: 'string' } }, ['track_id']),
      run: run((i) => tools.personJourney(ctx, i)),
    }),
    betaTool({
      name: 'count_people',
      description: 'How many people passed each camera in a time window, the busiest 10 minutes, and the first and last activity.',
      inputSchema: obj({ cameras: cams, from: when.from, to: when.to }, ['from', 'to']),
      run: run((i) => tools.countPeople(ctx, i)),
    }),
    betaTool({
      name: 'list_alerts',
      description: 'AI alerts (unknown faces, line crossings, restricted areas) in a time window.',
      inputSchema: obj({ cameras: cams, from: when.from, to: when.to, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['from', 'to']),
      run: run((i) => tools.listAlerts(ctx, i)),
    }),
    betaTool({
      name: 'summary',
      description: 'A short summary of a period: people per camera, start and end of activity, alerts.',
      inputSchema: obj({ period: { type: 'string', enum: ['last_night', 'today', 'yesterday', 'last_24h'] }, cameras: cams }, ['period']),
      run: run((i) => digest(ctx, i)),
    }),
    betaTool({
      name: 'list_cameras',
      description: 'The cameras (and imported videos) this person can see.',
      inputSchema: obj({}),
      run: run(() => tools.listCameras(ctx)),
    }),
  ];
}

async function answer(ctx, question) {
  const lib = sdk();
  const client = new lib.Anthropic();
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 8,
    output_config: { effort: 'medium' },
    // Server-side refusal fallback: a declined request is re-run on a fallback
    // model inside the same call (routing by refusal category).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: `${SYSTEM}\nNow: ${ctx.now.toISOString()} (viewer time zone ${ctx.tz}).`,
    tools: toolset(ctx, lib.betaTool),
    messages: [{ role: 'user', content: question }],
  });
  const final = await runner;
  if (final.stop_reason === 'refusal') {
    logger.warn('ask: Claude declined the question', { category: final.stop_details?.category });
    return { text: 'I can’t answer that question.', declined: true };
  }
  const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, model: final.model };
}

module.exports = { available, answer, MODEL };
