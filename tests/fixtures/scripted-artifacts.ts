import { AWS_LUNA_MODEL } from '../../server/engines/aws-bedrock';
import { EngineService, TESTED_VERSIONS } from '../../server/engines/service';
import { routeContractFor } from '../../server/harness/route-contract';

// A model that answers with artifacts, for tests/artifacts-ui.spec.ts. It sits where
// tests/h01-preview-repair.spec.ts puts its fixture: behind the Claude Code route's `generate`,
// so the real host, Store, event stream and built Console carry every answer. The Console sends
// a thread's message to `/ask`, which answers on an engine route (a model-API route answers only
// through the Diomedes conversation), so the Luna transport cannot stand in here. It starts no
// engine, reads no credential and contacts nobody.
//
// Each answer is chosen by the first word of the person's message, so the spec reads as the
// conversation it has.

export const ARTIFACT_ENGINE = 'claude-code';
export const ARTIFACT_MODEL = 'artifact-fixture';

const fence = (lang: string, lines: readonly string[]) => ['```' + lang, ...lines, '```'].join('\n');
const answer = (...parts: string[]) => parts.join('\n\n');

const DELIVERY = [
  '%% artifact: id=delivery-flow title="Delivery check"',
  'flowchart TD',
  '  A[Order in] --> B{Address valid?}',
  '  B -- yes --> C[Book the van]',
  '  B -- no --> D[Call the customer]',
];

/** The same declared id again, one step longer: the second version of one artifact. */
const DELIVERY_V2 = [...DELIVERY.slice(0, 4), '  C --> E[Load by 7am]', DELIVERY[4]];

export const WEEKLY_CHART = {
  type: 'bar',
  id: 'weekly-sends',
  title: 'Weekly sends',
  unit: 'msgs',
  x: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  series: [
    { name: 'Sent', values: [120, 80, 150, 95, 130] },
    { name: 'Replies', values: [9, 12, 20, 7, 15] },
  ],
};

/** The two charts the Console's segment bar draws: steps as the record lists them, and a count. */
export const LAUNCH_STEPS = {
  type: 'segments',
  title: 'Launch steps',
  steps: [
    { label: 'Draft the offer', state: 'done' },
    { label: 'Check the prices', state: 'done' },
    { label: 'Book the van', state: 'active' },
    { label: 'Tell the regulars', state: 'pending' },
    { label: 'Open the doors', state: 'pending' },
  ],
};
export const PACKING = { type: 'progress', title: 'Boxes packed', done: 7, total: 12, label: 'boxes' };

/**
 * A page that tries every way out of its frame and writes down, in its own DOM, what happened.
 * Every attempt is caught: an uncaught error in a frame is reported as a page error, which would
 * fail the spec on the attack failing rather than on the interface.
 */
const HOSTILE_DESIGN = [
  '<!-- artifact: id=spring-offer title="Spring offer" -->',
  '<!doctype html>',
  '<html>',
  '<head>',
  '<style>@import url("https://example.com/import.css"); body { font: 16px sans-serif; background: url("https://example.com/bg.png"); }</style>',
  '<link rel="stylesheet" href="https://example.com/sheet.css">',
  '</head>',
  '<body>',
  '<h1>Spring offer</h1>',
  '<p>Ten percent off every order this week.</p>',
  '<img src="https://example.com/x.png" alt="" onerror="document.body.dataset.img = \'blocked\'" onload="document.body.dataset.img = \'loaded\'">',
  '<script>',
  '  const mark = (name, value) => { document.body.dataset[name] = value; };',
  '  try { window.parent.document.title = "owned"; mark("parent", "reached"); } catch (error) { mark("parent", "blocked"); }',
  '  try { mark("top", window.top.document ? "reached" : "blocked"); } catch (error) { mark("top", "blocked"); }',
  '  try { mark("popup", window.open("https://example.com/popup") ? "opened" : "blocked"); } catch (error) { mark("popup", "blocked"); }',
  '  try { mark("storage", typeof window.localStorage.length === "number" ? "reached" : "blocked"); } catch (error) { mark("storage", "blocked"); }',
  '  try { mark("cookie", typeof document.cookie === "string" ? "reached" : "blocked"); } catch (error) { mark("cookie", "blocked"); }',
  '  fetch("https://example.com/data").then(() => mark("fetch", "reached"), () => mark("fetch", "blocked"));',
  '  mark("ran", "yes");',
  '</script>',
  '</body>',
  '</html>',
];

/**
 * A page that sends its own frame somewhere else once it has loaded. A sandbox cannot stop a frame
 * navigating itself; the desktop shell refuses it (desktop/main.mjs), and in a browser the panel
 * takes the frame down on its second load. It goes to about:blank, so the test needs no network.
 */
const WANDERING_DESIGN = [
  '<!-- artifact: id=wandering-page title="Wandering page" -->',
  '<p>This page leaves.</p>',
  '<script>setTimeout(() => location.replace("about:blank"), 50);</script>',
];

/** A picture that would load three files and run a script if anything let it. */
const HOSTILE_PICTURE = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120" style="background: url(https://example.com/bg.png)">',
  '  <style>@import url("https://example.com/import.css"); text { font: 20px sans-serif; }</style>',
  '  <rect x="0" y="0" width="240" height="120" fill="#44d2c9" style="mask-image: url(https://example.com/mask.png)"/>',
  '  <image href="https://example.com/x.png" x="0" y="0" width="240" height="120"/>',
  '  <text x="24" y="68">Linen Co.</text>',
  '  <script>document.documentElement.setAttribute("data-ran", "yes");</script>',
  '</svg>',
];

/** Node labels carrying markup: an image with a handler, a script, and a link. */
const HOSTILE_LABELS = [
  'flowchart TD',
  '  A["<img src=\'https://example.com/label.png\' onerror=\'top.__owned = 1\'>Plain label"] --> B["<script>top.__owned = 2</script>Second step"]',
  '  B --> C["<a href=\'https://example.com/go\'>Third step</a>"]',
];

const ROUTE = [
  '%% artifact: id=van-route title="Van route"',
  'flowchart LR',
  '  A[Depot] --> B[North stop]',
  '  B --> C[South stop]',
];

/** What arrives first while the STREAM answer is held: an artifact fence that is still open. */
export const STREAM_PREVIEW = ['Here is the route.', '', '```mermaid', ROUTE[0], ROUTE[1], '  A[Depot] --> B'].join('\n');

export const ANSWERS: Readonly<Record<string, string>> = {
  DIAGRAM: answer('Here is how a delivery gets checked.', fence('mermaid', DELIVERY)),
  REDRAW: answer('Updated: the van is loaded before seven.', fence('mermaid', DELIVERY_V2)),
  CHART: answer('Sends and replies this week.', fence('chart', [JSON.stringify(WEEKLY_CHART)])),
  STEPS: answer(
    'Where the launch stands.',
    fence('chart', [JSON.stringify(LAUNCH_STEPS)]),
    'And the packing.',
    fence('chart', [JSON.stringify(PACKING)]),
  ),
  TABLE: answer(
    '## Replies by region',
    ['| Region | Sent | Replies |', '|---|---:|---:|', '| North | 120 | 9 |', '| South | 80 | 4 |', '| East | 150 | 20 |'].join('\n'),
  ),
  DESIGN: answer('Here is the offer page.', fence('html', HOSTILE_DESIGN)),
  WANDER: answer('Here is a page.', fence('html', WANDERING_DESIGN)),
  PICTURE: answer('## Shop sign', fence('svg', HOSTILE_PICTURE)),
  LABEL: answer('## Hostile labels', fence('mermaid', HOSTILE_LABELS)),
  STREAM: answer('Here is the route.', fence('mermaid', ROUTE)),
};

export function artifactAnswer(prompt: string): string {
  const word = /^[A-Z]+/.exec(prompt.trim())?.[0] ?? '';
  return ANSWERS[word] ?? `You said: ${prompt}`;
}

// ---- the home conversation: AWS Bedrock (Luna) at its provider boundary ---------------------

type Item = Record<string, unknown>;
let lunaCalls = 0;

/**
 * The `modelApiTransport` createApp takes, answering the Diomedes conversation by the same script.
 * It has the envelope tests/fixtures/scripted-home-luna.ts sends (that file's respond() speaks
 * `scripted` and is not parameterised). Nothing here reaches AWS or spends money.
 */
export const artifactTransport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  lunaCalls += 1;
  const body = JSON.parse(String(init?.body)) as { input: Item[] };
  // The message this turn carries is the last user item; earlier ones are replayed transcript.
  const user = body.input.filter((item) => item.role === 'user').at(-1);
  const content = user?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => String((part as Item).text ?? '')).join('')
        : '';
  const message = (text.split("The person's message:\n\n")[1] ?? text).split('\n\n[[diomedes')[0];
  const envelope = {
    id: `resp_${lunaCalls}`,
    object: 'response',
    created_at: 1_790_000_000,
    status: 'completed',
    model: AWS_LUNA_MODEL,
    output: [
      { type: 'reasoning', id: `rs_${lunaCalls}`, summary: [], encrypted_content: `enc-${lunaCalls}` },
      {
        type: 'message',
        id: `msg_${lunaCalls}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: artifactAnswer(message), annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1_400,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 220,
      output_tokens_details: { reasoning_tokens: 80 },
      total_tokens: 1_620,
    },
    incomplete_details: null,
    error: null,
  };
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': `req-${lunaCalls}` },
  });
}) as typeof globalThis.fetch;

export interface ArtifactEngine {
  service: EngineService;
  /** Every message the fixture answered, in order. */
  prompts: string[];
  /** True while a STREAM answer is held after its first live text. */
  holding(): boolean;
  /** Lets a held STREAM answer finish. */
  release(): void;
}

/**
 * The Claude Code route with this fixture as its model. A message starting with STREAM sends
 * STREAM_PREVIEW as live text and holds its answer until `release`, the way h01's fixture holds
 * one, so the spec can look at the live turn while an artifact fence is still open.
 */
export function artifactEngine(enginesDir: string): ArtifactEngine {
  const prompts: string[] = [];
  let release: (() => void) | null = null;
  const service = new EngineService(enginesDir, {
    discover: async () => [
      {
        id: ARTIFACT_ENGINE,
        name: 'Artifact fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: '',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS[ARTIFACT_ENGINE],
        location: 'fixture',
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS[ARTIFACT_ENGINE],
    adapter: () => ({
      id: ARTIFACT_ENGINE,
      contract: routeContractFor(ARTIFACT_ENGINE),
      inspect: async () => ({
        authentication: 'signed-in',
        accountRoute: 'fixture:account',
        models: [
          { slug: ARTIFACT_MODEL, name: 'Artifact fixture', description: '', efforts: [], defaultEffort: null },
        ],
        detail: '',
      }),
      generate: async (input) => {
        prompts.push(input.prompt);
        const text = artifactAnswer(input.prompt);
        if (input.prompt.startsWith('STREAM')) {
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          input.onDelta?.(STREAM_PREVIEW);
          await held;
          release = null;
        }
        return {
          text,
          model: input.model,
          version: TESTED_VERSIONS[ARTIFACT_ENGINE],
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
        };
      },
    }),
  });
  return {
    service,
    prompts,
    holding: () => release !== null,
    release: () => release?.(),
  };
}
