/**
 * H16 Console: what the rule editor and the loop start control read and write through the
 * real host (`createApp`). The editor states which runs rules watch from the server's own
 * answer, a project's rule writes land in its History as the person's, and the start control
 * offers only the loop routes the server would admit, with each refusal in the server's words.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import type { StreamRule } from '../shared/stream-rules.js';
import type { LoopRouteOffer } from '../shared/native-loop.js';

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const state = () => store().state(projectId);

async function open(loopModelRoutes?: LoopModelRoutes) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    ...(loopModelRoutes ? { loopModelRoutes } : {}),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  }
}
async function call<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const project = <T>(route: string, method = 'GET', body?: unknown) => call<T>(`/projects/${projectId}${route}`, method, body);

const rule = (id: string, extra: Partial<StreamRule> & Pick<StreamRule, 'match' | 'intervention'>): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: `Rule ${id}.`,
  ...extra,
});
const put = (rules: StreamRule[]) => project<{ error?: string; code?: string }>('/stream-rules', 'PUT', { protocolVersion: 1, rules });
const ruleEntries = () => state().history.filter((entry) => entry.kind === 'rules');

async function seed() {
  const created = await store().locked(() => store().createProject('Linen orders'));
  projectId = created.id;
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Check the linen delivery' });
    await store().persist(state());
    return task.id;
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h16-console-'));
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('H16 Console: the rules the editor reads and writes', () => {
  beforeEach(async () => {
    await open();
    await seed();
  });

  test('both rule reads say which runs rules watch: Diomedes loop runs only', async () => {
    const global = await call<{ watches: string[] }>('/stream-rules');
    expect(global.data.watches).toEqual(['diomedes-loop']);
    const local = await project<{ watches: string[] }>(`/stream-rules?taskId=${taskId}`);
    expect(local.data.watches).toEqual(['diomedes-loop']);
  });

  test("a project's rule write lands in its History as the person's, saying what changed; an unchanged or refused write records nothing", async () => {
    const hold = rule('hold-reports', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' });
    const note = rule('helper-note', { match: { kind: 'text', phrase: 'helper' }, intervention: 'annotate' });
    expect((await put([hold, note])).status).toBe(200);
    expect(ruleEntries()).toHaveLength(1);
    expect(ruleEntries()[0]).toMatchObject({
      actor: 'you',
      sentence: "You changed this project's trigger rules: added hold-reports v1, added helper-note v1. A rule grants nothing.",
    });

    // The same rules again decide nothing, so nothing is recorded.
    expect((await put([hold, note])).status).toBe(200);
    expect(ruleEntries()).toHaveLength(1);

    const off = { ...note, version: 2, enabled: false };
    const edited = { ...hold, version: 2, text: 'Reports are read first.' };
    const added = rule('mind-the-count', { match: { kind: 'text', phrase: 'order.md' }, intervention: 'steer', message: 'Count line by line.' });
    expect((await put([edited, off, added])).status).toBe(200);
    expect(ruleEntries().at(-1)!.sentence).toBe(
      "You changed this project's trigger rules: changed hold-reports v2, turned off helper-note v2, added mind-the-count v1. A rule grants nothing.",
    );
    expect((await put([edited])).status).toBe(200);
    expect(ruleEntries().at(-1)!.sentence).toBe(
      "You changed this project's trigger rules: removed helper-note, removed mind-the-count. A rule grants nothing.",
    );

    // Refused (a hold on streamed text): nothing saved, nothing recorded, the server's sentence returned.
    const count = ruleEntries().length;
    const refused = await put([edited, rule('bad', { match: { kind: 'text', phrase: 'x' }, intervention: 'hold' })]);
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe('Only a tool intent can be held for you; text that was streamed has already been said.');
    expect(ruleEntries()).toHaveLength(count);
    expect(state().streamTriggerRules).toEqual([edited]);
  });

  test('a project rule that would loosen an organization rule is refused with the reason, and records nothing', async () => {
    const global = await call('/stream-rules', 'PUT', {
      protocolVersion: 1,
      rules: [rule('reports-held', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' })],
    });
    expect(global.status).toBe(200);
    const loosen = rule('reports-noted', {
      constrains: 'trigger:reports-held',
      match: { kind: 'tool', tool: 'propose_write' },
      intervention: 'annotate',
    });
    const refused = await put([loosen]);
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('stream_rule_loosens');
    expect(refused.data.error).toBe(
      'reports-noted: reports-held (organization) restricts trigger:reports-held with organization authority, and this cannot loosen it.',
    );
    expect(ruleEntries()).toHaveLength(0);
  });
});

describe('H16 Console: the loop routes a start control may offer', () => {
  test('the scripted route is admitted; a model-API route that is off says so in the start route’s own words', async () => {
    await open();
    await seed();
    const { status, data } = await project<{ routes: LoopRouteOffer[] }>('/loop/routes');
    expect(status).toBe(200);
    expect(data.routes.map((offer) => offer.route)).toEqual(['native-fixture', 'aws-bedrock', 'azure-openai', 'openrouter', 'google-vertex']);
    expect(data.routes[0]).toMatchObject({ route: 'native-fixture', admitted: true, sends: false, model: null, reason: null });
    for (const offer of data.routes.slice(1))
      expect(offer).toMatchObject({ admitted: false, sends: true, reason: 'Turn the selected route on in Settings before using it.' });
  });

  test("a model-API route that is on is admitted by the route's own admission, and its refusal is quoted", async () => {
    const asked: string[] = [];
    await open({
      async admit(route, input) {
        asked.push(`${route}:${input.model}:${input.accountRoute}`);
        if (route === 'google-vertex') throw new Error('The saved Google Vertex AI key has expired. Enter a new key in AI setup.');
        return { model: input.model!, accountRoute: input.accountRoute! };
      },
      async adapter() {
        throw new Error('not used');
      },
    });
    await seed();
    await store().saveSettings({
      ...structuredClone(store().settings),
      services: {
        ...store().settings.services,
        openrouter: true,
        openrouterModel: 'openai/gpt-5.5',
        openrouterAccountRoute: 'openrouter:acct',
        'google-vertex': true,
        'google-vertexModel': 'gemini-3.8-flash',
        'google-vertexAccountRoute': 'vertex:acct',
      } as never,
    });
    const { data } = await project<{ routes: LoopRouteOffer[] }>('/loop/routes');
    const byRoute = Object.fromEntries(data.routes.map((offer) => [offer.route, offer]));
    expect(byRoute.openrouter).toMatchObject({ admitted: true, model: 'openai/gpt-5.5', reason: null, sends: true });
    expect(byRoute['google-vertex']).toMatchObject({
      admitted: false,
      reason: 'The saved Google Vertex AI key has expired. Enter a new key in AI setup.',
    });
    expect(asked).toEqual(['openrouter:openai/gpt-5.5:openrouter:acct', 'google-vertex:gemini-3.8-flash:vertex:acct']);
  });

  test('an unknown project is refused', async () => {
    await open();
    const missing = await call('/projects/P-missing/loop/routes');
    expect(missing.status).toBe(404);
  });
});
