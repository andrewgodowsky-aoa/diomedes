/**
 * The owner's rule, Andrew, 2026-09-26: this integration may use PostHog's ordinary usage-billed
 * ingestion, never PostHog's AI services (PostHog AI, trace or event summarization, evaluations,
 * offline evaluations, evaluation summaries, `text_repr`, anything billed in AI credits). The
 * transport reaches one endpoint only: `POST <configured host>/batch/`. `$ai_generation`,
 * `$ai_trace` and `$ai_span` are ordinary ingested events and are not affected.
 *
 * Three guards:
 *   1. Driven: every request the observation runtime makes, whatever PostHog answers and however
 *      the host is spelled, is `POST https://posthog.invalid/batch/`.
 *   2. Static: nothing in `server/observability/` can reach the network except the transport's one
 *      call, and that call can only be a POST to `<origin>/batch/`.
 *   3. Canary: no PostHog AI, query or feature-flag name appears in `server/observability/`.
 *
 * No request leaves this process: the transport's fetch is a fake, and the global fetch is replaced
 * by a recorder for the whole file.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { operatorConfigFromEnv, type ObservationOperatorConfig, type ObservationScope } from '../server/observability/eligibility.js';
import { PostHogTransport } from '../server/observability/posthog-transport.js';
import { createObservation, type ObservationRuntime } from '../server/observability/runtime.js';
import { spanIdFor, traceIdFor, uuidFor } from '../server/observability/sanitize.js';
import type { ParkedObservation } from '../shared/observability.js';

const HOST = 'https://posthog.invalid';
const ENDPOINT = `${HOST}/batch/`;
const KEY = 'phc_testOnlyNotARealKey0';
const ORG = 'org_internal_a';
const START = Date.UTC(2026, 8, 26, 12, 0, 0);
const root = fileURLToPath(new URL('..', import.meta.url));
const OBSERVABILITY = path.join(root, 'server', 'observability');

type Answer = { status: number; headers?: Record<string, string> } | 'throw' | 'hang';
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}
/** A fetch that records every call and answers from a script; nothing leaves. */
function recorder(script: () => Answer) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init: { ...(input instanceof Request ? { method: input.method } : {}), ...init } });
    const answer = script();
    if (answer === 'throw') throw new TypeError('fetch failed');
    if (answer === 'hang')
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    return new Response(answer.status === 204 || answer.status === 304 ? null : '{"status":1}', { status: answer.status, headers: answer.headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
/** What the PostHog ingestion endpoint is sent: one POST of `{api_key, batch}`, nothing else. */
function expectOnlyBatchPosts(calls: readonly Call[], endpoint = ENDPOINT) {
  expect(calls.length, 'the transport was reached').toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).toBe(endpoint);
    expect(String(call.init.method).toUpperCase()).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(Object.keys(JSON.parse(String(call.init.body)))).toEqual(['api_key', 'batch']);
  }
}

let globalCalls: Call[];
beforeEach(() => {
  // Anything in this file that reached the real network would go through here instead.
  const global = recorder(() => ({ status: 200 }));
  globalCalls = global.calls;
  vi.stubGlobal('fetch', global.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const posthogOperator = (host: string): ObservationOperatorConfig => ({
  mode: 'posthog',
  environment: 'test',
  companyHost: true,
  internalOrganizations: new Set([ORG]),
  pseudonymKey: new Uint8Array(32).fill(9),
  customerExport: false,
  posthog: { host, captureKey: KEY, fundedUntil: '2026-12-31', dailyEvents: 10_000 },
});
const admission: AdmittedAgentWork = {
  admissionId: 'adm_no_ai_0001',
  organizationId: ORG,
  personId: 'person_1',
  planId: 'business',
  policyRevision: 1,
  routeKind: 'byo',
  surface: 'conversation',
  validUntil: '2026-09-26T13:00:00.000Z',
};
const parked = (scope: ObservationScope, index: number): ParkedObservation => ({
  kind: 'parked',
  contract: 'nectovia-observation/1',
  ids: { uuid: uuidFor('test', `no-ai-${index}`), traceId: traceIdFor('test', 'r'), spanId: spanIdFor('test', `r|${index}`), parentId: traceIdFor('test', 'r'), sessionId: null },
  at: new Date(START + index).toISOString(),
  scope: scope.facts,
  build: '0.2.0',
  capability: 'model-api-turn',
  stepKind: 'model',
});
/** The runtime the app builds, in `posthog` mode, over a fake network and a virtual clock. */
function posthogRuntime(host: string, fetch: typeof globalThis.fetch | undefined) {
  let now = START;
  const runtime = createObservation({
    options: { operator: posthogOperator(host), fetch, timer: false, clock: () => now, random: () => 0 },
    env: {},
    build: '0.2.0',
    session: { personId: () => 'person_1', entitlement: () => ({ agent: true, state: 'active' }), backend: { view: () => ({ kind: 'faux' }) } } as never,
    workspaces: { active: () => ({ kind: 'business', organizationId: ORG }), projectOwner: () => null } as never,
  }) as ObservationRuntime;
  expect(runtime, 'posthog mode constructs the runtime').not.toBeNull();
  const decision = runtime.scopes.decide({ admission, rootJobId: 'turn-1', route: 'aws-bedrock', connectionId: 'c1', model: null });
  if (!decision.eligible) throw new Error(decision.denial);
  return { runtime, scope: decision.scope, advance: (ms: number) => (now += ms) };
}

describe('1. driven: the runtime reaches POST <host>/batch/ and nothing else', () => {
  test('whatever PostHog answers (2xx, 3xx, 4xx, 429, 5xx, a network error, a hang), every request is one POST to /batch/', async () => {
    const answers: Answer[] = [
      { status: 200 },
      { status: 204 },
      { status: 301, headers: { location: `${HOST}/api/projects/1/llm_analytics/summarization` } },
      { status: 400 },
      { status: 401 },
      { status: 404 },
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 500 },
      { status: 503 },
      'throw',
      'hang',
    ];
    let next: Answer = { status: 200 };
    const { fetch, calls } = recorder(() => next);
    const { runtime, scope, advance } = posthogRuntime(HOST, fetch);
    let index = 0;
    for (const answer of answers) {
      next = answer;
      runtime.exporter.enqueue(parked(scope, index++), scope);
      // Past any backoff and the circuit's pause, so every answer is met by a send.
      advance(10 * 60_000);
      await runtime.exporter.flush(answer === 'hang' ? 50 : 1_000);
      next = { status: 200 };
      advance(10 * 60_000);
      await runtime.exporter.flush(1_000);
    }
    await runtime.exporter.close(100);
    expect(calls.length).toBeGreaterThanOrEqual(answers.length);
    expectOnlyBatchPosts(calls);
    expect(globalCalls, 'nothing reached the global fetch').toEqual([]);
  });

  test('the host is only ever an origin: a configured path, query or fragment never becomes the endpoint', async () => {
    for (const host of [
      `${HOST}/`,
      `${HOST}/api/projects/1/llm_analytics/summarization`,
      `${HOST}/api/environments/1/query?kind=HogQLQuery#text_repr`,
      `${HOST}/decide/?v=3`,
    ]) {
      const { fetch, calls } = recorder(() => ({ status: 200 }));
      const { runtime, scope } = posthogRuntime(host, fetch);
      runtime.exporter.enqueue(parked(scope, 0), scope);
      await runtime.exporter.flush(1_000);
      await runtime.exporter.close(100);
      expectOnlyBatchPosts(calls);
      // From the environment, such a host is not configuration at all: nothing is constructed.
      if (host !== `${HOST}/`)
        expect(
          operatorConfigFromEnv({ NECTOVIA_OBSERVATION: 'posthog', NECTOVIA_POSTHOG_HOST: host, NECTOVIA_POSTHOG_CAPTURE_KEY: KEY }).posthog,
          host,
        ).toBeNull();
    }
    expect(globalCalls).toEqual([]);
  });

  test('the production path, with no fetch injected, uses the global fetch for the same one POST', async () => {
    const transport = new PostHogTransport({ host: `${HOST}/api/projects/1/`, captureKey: KEY });
    expect(await transport.send('{"batch":[]}', new AbortController().signal)).toEqual({ ok: true });
    expectOnlyBatchPosts(globalCalls);
  });
});

// --- the static guard -----------------------------------------------------------------------------

function sources(dir: string): { file: string; text: string }[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file))
    .sort()
    .map((file) => ({ file: file.replaceAll('\\', '/'), text: fs.readFileSync(path.join(dir, file), 'utf8') }));
}
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
const parsed = () =>
  sources(OBSERVABILITY).map(({ file, text }) => ({ file, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) }));

/**
 * The value imports from outside `server/observability/`. Type-only imports are erased. Each of these
 * is a pure function or constant; a new one (a client, an SDK, a socket) fails this test.
 */
const VALUE_IMPORTS: Readonly<Record<string, readonly string[] | '*'>> = {
  'node:crypto': ['createHash', 'createHmac'],
  '../../shared/observability.js': '*',
  '../../shared/access.js': ['PLAN_TEMPLATES'],
  '../../shared/team-routes.js': ['TEAM_TOOL_NAMES'],
  '../../shared/team-delegation.js': ['ADVISE_TOOL', 'ASSIGN_TOOL'],
  '../harness/model-api-adapter.js': ['exposureStepId'],
  '../harness/native-agent.js': ['isScriptedAdapter'],
  '../harness/text-route.js': ['TEXT_ADMISSION_STEP', 'TEXT_DISPATCH_STEP'],
};
const NETWORK_GLOBALS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'navigator', 'Request', 'importScripts']);
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

describe('2. static: nothing in server/observability can reach another path or method', () => {
  test('every value import from outside the folder is a named pure helper; no dynamic import or require', () => {
    const files = parsed();
    expect(files.map((item) => item.file)).toContain('posthog-transport.ts');
    const unexpected: string[] = [];
    for (const { file, source } of files)
      walk(source, (node) => {
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
          unexpected.push(`${file}: ${node.getText()}`);
        if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('./')) return;
        let names: string[] = [];
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          if (!clause || clause.isTypeOnly) return;
          if (clause.name) names.push('default');
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
          if (bindings && ts.isNamedImports(bindings))
            names = names.concat(bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text));
        } else {
          if (node.isTypeOnly) return;
          names.push('re-export');
        }
        if (names.length === 0) return;
        const allowed = VALUE_IMPORTS[specifier];
        for (const name of names) if (!allowed || (allowed !== '*' && !allowed.includes(name))) unexpected.push(`${file}: ${name} from ${specifier}`);
      });
    expect(unexpected).toEqual([]);
  });

  test('no network global is named, and `fetch` is only the transport’s injected or global function, never called by name', () => {
    const named: string[] = [];
    const fetches: string[] = [];
    for (const { file, source } of parsed())
      walk(source, (node) => {
        if (ts.isIdentifier(node) && NETWORK_GLOBALS.has(node.text)) named.push(`${file}: ${node.parent.getText()}`);
        if (ts.isCallExpression(node) && /(^|\.)fetch$/.test(node.expression.getText().replace(/\?\./g, '.'))) named.push(`${file}: call ${node.getText()}`);
        if (ts.isIdentifier(node) && node.text === 'fetch') {
          let at: ts.Node = node;
          while (at.parent && !ts.isVariableStatement(at) && !ts.isPropertySignature(at) && !ts.isPropertyAssignment(at) && !ts.isSourceFile(at.parent)) at = at.parent;
          fetches.push(`${file}: ${at.getText()}`);
        }
      });
    expect(named).toEqual([]);
    expect(fetches.sort()).toEqual(
      [
        'posthog-transport.ts: const post = this.options.fetch ?? globalThis.fetch;',
        'posthog-transport.ts: const post = this.options.fetch ?? globalThis.fetch;',
        'posthog-transport.ts: readonly fetch?: typeof globalThis.fetch;',
        'posthog-transport.ts: readonly fetch?: typeof globalThis.fetch;',
        'runtime.ts: fetch: input.options?.fetch',
        'runtime.ts: fetch: input.options?.fetch',
        'runtime.ts: readonly fetch?: typeof globalThis.fetch;',
        'runtime.ts: readonly fetch?: typeof globalThis.fetch;',
      ].sort(),
    );
  });

  test('the transport’s one call is a POST of this.url, and this.url is only ever `${origin}/batch/`', () => {
    const transport = parsed().find((item) => item.file === 'posthog-transport.ts')!.source;
    const posts: ts.CallExpression[] = [];
    const postNames: ts.Identifier[] = [];
    const urlWrites: ts.BinaryExpression[] = [];
    walk(transport, (node) => {
      if (ts.isIdentifier(node) && node.text === 'post') postNames.push(node);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'post') posts.push(node);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText() === 'this.url') urlWrites.push(node);
    });
    // Declared once, called once, never passed anywhere else.
    expect(postNames).toHaveLength(2);
    expect(posts).toHaveLength(1);
    const [call] = posts;
    expect(call.arguments[0].getText()).toBe('this.url');
    const init = call.arguments[1];
    expect(ts.isObjectLiteralExpression(init)).toBe(true);
    const property = (name: string) =>
      (init as ts.ObjectLiteralExpression).properties.find((item) => item.name?.getText() === name) as ts.PropertyAssignment | undefined;
    expect(property('method')?.initializer.getText()).toBe("'POST'");
    expect(property('redirect')?.initializer.getText()).toBe("'error'");
    // The URL: assigned once, from the parsed origin alone, to the one path.
    expect(urlWrites.map((item) => item.right.getText())).toEqual(['`${origin.origin}/batch/`']);
    expect(transport.getText()).toMatch(/private readonly url: string;/);
  });

  test('the only HTTP method named is the transport’s POST, and the only path is its /batch/', () => {
    const methods: string[] = [];
    const methodProperties: string[] = [];
    const paths: string[] = [];
    for (const { file, source } of parsed())
      walk(source, (node) => {
        // Any `method` given to a request, in any case (fetch upper-cases the standard ones).
        if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText().replace(/['"]/g, '') === 'method')
          methodProperties.push(`${file}: ${node.getText()}`);
        const literal =
          ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
            ? node.text
            : null;
        if (literal === null) return;
        // Upper case only: 'trace' is also an observation kind.
        if (HTTP_METHODS.has(literal)) methods.push(`${file}: ${literal}`);
        if (literal.includes('://') || literal.startsWith('/')) paths.push(`${file}: ${literal}`);
      });
    expect(methodProperties).toEqual(["posthog-transport.ts: method: 'POST'"]);
    expect(methods).toEqual(['posthog-transport.ts: POST']);
    // Eligibility's '/' is the check that a configured host carries no path at all.
    expect(paths).toEqual(['eligibility.ts: /', 'posthog-transport.ts: /batch/']);
  });
});

// --- the canary -----------------------------------------------------------------------------------

/** PostHog's AI services, its query and project APIs, and its feature-flag endpoints: never named. */
const CANARIES = [
  'llm_analytics',
  '/api/projects',
  '/api/environments',
  'summariz',
  'evaluation_summary',
  'offline_evaluations',
  'text_repr',
  'posthog-ai',
  '/decide',
  '/flags',
] as const;

describe('3. canary: no PostHog AI service is named', () => {
  test('server/observability/ (and the shared observation contract) contain none of the canaries, in any case', () => {
    const scanned = [
      ...sources(OBSERVABILITY).map((item) => ({ file: `server/observability/${item.file}`, text: item.text })),
      { file: 'shared/observability.ts', text: fs.readFileSync(path.join(root, 'shared', 'observability.ts'), 'utf8') },
    ];
    expect(scanned.length, 'the folder was read').toBeGreaterThanOrEqual(9);
    const found = scanned.flatMap(({ file, text }) =>
      CANARIES.filter((canary) => text.toLowerCase().includes(canary.toLowerCase())).map((canary) => `${file}: ${canary}`),
    );
    expect(found).toEqual([]);
  });

  test('the canary scan is not vacuous: it finds each canary when one is planted', () => {
    for (const canary of CANARIES) {
      const planted = `const endpoint = '${canary.toUpperCase()}';`;
      expect(CANARIES.filter((item) => planted.toLowerCase().includes(item.toLowerCase())), canary).toContain(canary);
    }
  });
});
