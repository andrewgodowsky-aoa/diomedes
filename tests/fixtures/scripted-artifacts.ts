import { AWS_LUNA_MODEL } from '../../server/engines/aws-bedrock';
import { EngineService, TESTED_VERSIONS } from '../../server/engines/service';
import { routeContractFor } from '../../server/harness/route-contract';
import { responsesAnswer } from './model-api-streams.js';

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
 * Where the hostile fixtures below point, set by tests/artifacts-ui.spec.ts once its observers
 * are listening: a UDP socket that records any STUN request, and a path on the spec's own server
 * that records any request made to it. `{{STUN}}` and `{{LEAK}}` in an answer are replaced by them.
 */
export const probes = { stun: 'stun:127.0.0.1:9', leak: 'http://127.0.0.1:9/leak' };

/** A 1x1 GIF: an image that loads under the frame's policy, so its onload would fire if it could. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * A page that tries every way out of its frame, and writes in its own DOM what it did. No script
 * runs in a design (sandbox=""), so none of its marks may appear: its inline script, its
 * onload and onerror handlers, a javascript: URL and a WebRTC connection to the spec's STUN
 * listener all stay unrun. Every attempt is caught, so that if one ever ran, the spec would fail
 * on the mark it left rather than on an uncaught error. Its <link>s, and the one in its nested
 * frame's srcdoc, are taken out before its srcdoc is built: Chromium does not hold dns-prefetch or
 * preconnect to the frame's policy.
 */
const HOSTILE_DESIGN = [
  '<!-- artifact: id=spring-offer title="Spring offer" -->',
  '<!doctype html>',
  '<html>',
  '<head>',
  '<style>@import url("https://example.com/import.css"); body { font: 16px sans-serif; background: url("https://example.com/bg.png"); }</style>',
  '<link rel="stylesheet" href="https://example.com/sheet.css">',
  '<link rel="preconnect" href="https://preconnect.example.com">',
  '<link rel="dns-prefetch" href="https://dns-prefetch.example.com">',
  '</head>',
  '<body onload="document.body.dataset.onload = \'ran\'">',
  '<h1>Spring offer</h1>',
  '<p>Ten percent off every order this week.</p>',
  '<img src="https://example.com/x.png" alt="" onerror="document.body.dataset.img = \'error ran\'" onload="document.body.dataset.img = \'load ran\'">',
  `<img src="${PIXEL}" alt="" onload="document.body.dataset.pixel = 'ran'">`,
  '<iframe title="Nested" src="javascript:parent.document.body.dataset.js = \'ran\'"></iframe>',
  '<iframe title="Nested document" srcdoc="<link rel=dns-prefetch href=https://srcdoc-prefetch.example.com>"></iframe>',
  '<script>',
  '  const mark = (name, value) => { document.body.dataset[name] = value; };',
  '  mark("ran", "yes");',
  '  try { window.parent.document.title = "owned"; mark("parent", "reached"); } catch (error) { mark("parent", "blocked"); }',
  '  try { mark("top", window.top.document ? "reached" : "blocked"); } catch (error) { mark("top", "blocked"); }',
  '  try { mark("popup", window.open("https://example.com/popup") ? "opened" : "blocked"); } catch (error) { mark("popup", "blocked"); }',
  '  try { mark("storage", typeof window.localStorage.length === "number" ? "reached" : "blocked"); } catch (error) { mark("storage", "blocked"); }',
  '  try { mark("cookie", typeof document.cookie === "string" ? "reached" : "blocked"); } catch (error) { mark("cookie", "blocked"); }',
  '  fetch("https://example.com/data").then(() => mark("fetch", "reached"), () => mark("fetch", "blocked"));',
  '  try {',
  '    const peer = new RTCPeerConnection({ iceServers: [{ urls: "{{STUN}}" }] });',
  '    peer.createDataChannel("probe");',
  '    peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => undefined);',
  '    mark("rtc", "constructed");',
  '  } catch (error) { mark("rtc", "blocked"); }',
  '</script>',
  '</body>',
  '</html>',
];

/**
 * A page whose every link points at the spec's own server with a secret in the query, in every
 * form a link can take: an anchor, an image-map area, SVG links (xlink:href, and one an SVG
 * animation would write back), a form and its button, a ping, a target, a <base>, a refresh, and
 * an anchor inside a declarative shadow root. Its links are made inert before its srcdoc is built
 * (client/console/artifact-links.ts), so clicking the first one sends nothing anywhere.
 */
const LINKED_DESIGN = [
  '<!-- artifact: id=price-list title="Price list" -->',
  '<!doctype html>',
  '<html>',
  '<head>',
  '<base href="{{LEAK}}/base/">',
  '<meta http-equiv="refresh" content="60;url={{LEAK}}?via=refresh">',
  '<style>body { margin: 0; font: 18px sans-serif; } a.big { display: block; box-sizing: border-box; height: 180px; padding: 24px; background: #dfe7f0; color: #123456; }</style>',
  '</head>',
  '<body>',
  '<a class="big" href="{{LEAK}}?secret=from-design" ping="{{LEAK}}?via=ping" target="_self">Open the price list</a>',
  `<img src="${PIXEL}" alt="Area map" usemap="#prices" width="40" height="40"><map name="prices"><area shape="rect" coords="0,0,40,40" href="{{LEAK}}?via=area" alt="Area link"></map>`,
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="260" height="60">',
  '  <a xlink:href="{{LEAK}}?via=svg"><text x="4" y="20">Chart link</text></a>',
  '  <a><text x="4" y="48">Animated link</text><set attributeName="href" to="{{LEAK}}?via=animation"/></a>',
  '</svg>',
  '<form action="{{LEAK}}?via=form"><button formaction="{{LEAK}}?via=formaction">Send the order</button></form>',
  '<div><template shadowrootmode="open"><a href="{{LEAK}}?via=shadow">Shadow link</a></template></div>',
  '</body>',
  '</html>',
];

/** An ordinary page: what a design is for. */
const PLAIN_DESIGN = [
  '<!-- artifact: id=opening-hours title="Opening hours" -->',
  '<!doctype html>',
  '<html>',
  '<head><style>body { margin: 0; padding: 24px; font: 16px system-ui, sans-serif; color: #1a1d21; background: #ffffff; } td { padding: 4px 16px 4px 0; }</style></head>',
  '<body><h1>Opening hours</h1><table><tr><td>Monday to Friday</td><td>8:00 to 18:00</td></tr><tr><td>Saturday</td><td>9:00 to 13:00</td></tr></table></body>',
  '</html>',
];

/**
 * A page whose script sends its own frame somewhere else once it has loaded. No script runs in a
 * design, so it stays where it is. (Should a frame ever navigate itself anyway, the desktop shell
 * refuses it, and in a browser the panel takes the frame down on its second load.)
 */
const WANDERING_DESIGN = [
  '<!-- artifact: id=wandering-page title="Wandering page" -->',
  '<p>This page leaves.</p>',
  '<script>setTimeout(() => location.replace("about:blank"), 50);</script>',
];

/** A picture that would load three files, run a script and link away if anything let it. */
const HOSTILE_PICTURE = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 240 120" width="240" height="120" style="background: url(https://example.com/bg.png)">',
  '  <style>@import url("https://example.com/import.css"); text { font: 20px sans-serif; }</style>',
  '  <rect x="0" y="0" width="240" height="120" fill="#44d2c9" style="mask-image: url(https://example.com/mask.png)"/>',
  '  <image href="https://example.com/x.png" x="0" y="0" width="240" height="120"/>',
  '  <a href="{{LEAK}}?via=picture"><text x="24" y="68">Linen Co.</text></a>',
  '  <a xlink:href="{{LEAK}}?via=picture-xlink"><text x="24" y="100">Since 1998</text></a>',
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
  LINK: answer('Here is the price list.', fence('html', LINKED_DESIGN)),
  HOURS: answer('Here are the opening hours.', fence('html', PLAIN_DESIGN)),
  WANDER: answer('Here is a page.', fence('html', WANDERING_DESIGN)),
  PICTURE: answer('## Shop sign', fence('svg', HOSTILE_PICTURE)),
  LABEL: answer('## Hostile labels', fence('mermaid', HOSTILE_LABELS)),
  STREAM: answer('Here is the route.', fence('mermaid', ROUTE)),
};

export function artifactAnswer(prompt: string): string {
  const word = /^[A-Z]+/.exec(prompt.trim())?.[0] ?? '';
  const text = ANSWERS[word] ?? `You said: ${prompt}`;
  return text.replaceAll('{{STUN}}', probes.stun).replaceAll('{{LEAK}}', probes.leak);
}

// ---- the home conversation: AWS Bedrock (Luna) at its provider boundary ---------------------

type Item = Record<string, unknown>;
let lunaCalls = 0;

/**
 * The `modelApiTransport` createApp takes, answering the Diomedes conversation by the same script.
 * It has the envelope tests/fixtures/scripted-home-luna.ts sends, streamed the same way (that
 * file's respond() speaks `scripted` and is not parameterised). Nothing here reaches AWS or
 * spends money.
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
  // The model-API core asks for a stream: a Responses object is sent as its event stream.
  return responsesAnswer(envelope, 200, { 'x-amzn-requestid': `req-${lunaCalls}` });
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
