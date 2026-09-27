/**
 * A project's own instruction files are part of the free harness (Andrew, 2026-09-27): they reach
 * every engine whatever the plan, as they would in any harness. What stays paid under
 * 'owner-rules' (Andrew, 2026-09-25) is the Console's rules and the trigger rules, and a loop
 * says so once through `notIncludedReason`. The product's rules (the writing standard, shipped
 * product knowledge) go regardless.
 *
 * The unit half exercises `assembleInstructions` and `deliverySentence` directly (the same path
 * every run and message uses). The app half stands up the real host on the faux cloud: Juniper
 * Street Bakery holds the Business plan, Harbor Hardware holds nothing, and a free account is
 * Personal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { activatePack } from '../server/capability-packs.js';
import {
  assembleInstructions,
  deliverySentence,
  instructionSectionBudget,
} from '../server/harness/instruction-delivery.js';
import {
  OWNER_RULES_NOT_INCLUDED_REASON,
  OWNER_RULES_FEATURE,
} from '../shared/access.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import {
  createFauxCloud,
  FAUX_BACKEND_LABEL,
  type FauxCloud,
} from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { InstructionDelivery } from '../shared/capability-packs.js';
import type { Project, Session } from '../shared/types.js';
import type { AccountStateView } from '../shared/accounts.js';

const PACK = 'diomedes.software-engineering' as const;
const REPO = {
  'AGENTS.md': '# Root\nROOT-AGENTS-BODY\n',
  'pkg/AGENTS.md': '# Pkg\nPKG-AGENTS-BODY\n',
};

// --- the rule path itself ------------------------------------------------------

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-owner-rules-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

async function project(files: Record<string, string>) {
  const folder = path.join(temp, 'repo');
  await fs.mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await fs.writeFile(path.join(folder, name), text, 'utf8');
  }
  const store = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
  await store.init();
  const created = await store.createProject('Repo', folder);
  return { store, id: created.id };
}

const assemble = (store: Store, id: string, workPaths: string[]) =>
  assembleInstructions({
    state: store.state(id),
    routeId: 'codex',
    agentRole: 'Diomedes build file proposal writer',
    budgetBytes: instructionSectionBudget(0),
    workPaths,
    at: '2026-09-26T01:00:00.000Z',
  });

describe('a project’s own instruction files', () => {
  test('are sent with no plan to ask, alongside the product’s rules', async () => {
    const { store, id } = await project(REPO);
    await activatePack(store, id, PACK);
    const { section, delivery, writing } = await assemble(store, id, ['pkg/one.md']);
    expect(delivery!.files.map((file) => [file.path, file.state])).toEqual([
      ['pkg/AGENTS.md', 'sent'],
      ['AGENTS.md', 'sent'],
    ]);
    expect(delivery!.excluded ?? []).toEqual([]);
    expect(section).toContain('PKG-AGENTS-BODY');
    expect(section).toContain('ROOT-AGENTS-BODY');
    expect(writing.state).toBe('sent');
  });

  test('an out-of-scope file keeps its own reason; the governing files are sent', async () => {
    const { store, id } = await project({
      ...REPO,
      'other/AGENTS.md': '# Other\nOTHER-BODY\n',
    });
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/one.md']);
    expect((delivery!.excluded ?? []).map((file) => [file.path, file.exclusion])).toEqual([
      ['other/AGENTS.md', 'out-of-scope'],
    ]);
    expect(delivery!.files.map((file) => file.path)).toEqual(['pkg/AGENTS.md', 'AGENTS.md']);
  });

  test('a record written before 2026-09-27 still names what it withheld, after the plan’s reason', async () => {
    const { store, id } = await project(REPO);
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/one.md']);
    // What the earlier gate wrote: no file sent, each one kept back with the plan's sentence.
    const earlier: InstructionDelivery = {
      ...delivery!,
      files: [],
      excluded: delivery!.files.map((file) => ({
        path: file.path,
        scope: '.',
        sha: file.sha,
        bytes: null,
        packId: PACK,
        exclusion: 'not-included' as const,
        detail: OWNER_RULES_NOT_INCLUDED_REASON,
      })),
    };
    const sentence = deliverySentence(earlier);
    expect(sentence).toContain('Diomedes sent no project instructions to codex.');
    const withheldAt = sentence.indexOf('Withheld:');
    expect(withheldAt).toBeGreaterThan(sentence.indexOf(OWNER_RULES_NOT_INCLUDED_REASON));
    expect(sentence.slice(withheldAt)).toContain('pkg/AGENTS.md');
  });
});

// --- through the real host on the faux cloud ------------------------------------

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let cloud: FauxCloud;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;

async function open(accounts: { backend: AccountBackend } | null) {
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    reviewerAdapter: null,
    accounts,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closing = server;
  server = undefined;
  await app.locals.close();
  closing.closeAllConnections();
  await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
}
const call = async <T>(route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
};
const store = () => app.locals.store;
const signIn = (email: string) =>
  call<AccountStateView>('/account/sign-in', 'POST', {
    email,
    password: FAUX_DEMO_PASSWORD,
    remember: false,
  });

/** A project holding one instruction file, its pack on, and one task a loop can run. */
async function ownerRuledProject() {
  const created = await call<Project>('/projects', 'POST', { name: 'Linen orders' });
  expect(created.status).toBe(200);
  await fs.writeFile(path.join(created.data.folder, 'AGENTS.md'), '# House\nHOUSE-BODY\n', 'utf8');
  await activatePack(store(), created.data.id, PACK);
  const taskId = await store().locked(async () => {
    const task = store().createTask(store().state(created.data.id), { name: 'Check the delivery' });
    await store().persist(store().state(created.data.id));
    return task.id;
  });
  return { projectId: created.data.id, taskId };
}

interface RoutesView {
  routes: { route: string; admitted: boolean }[];
  notIncludedReason: string | null;
}
const startLoop = (projectId: string, taskId: string) =>
  call<{ runId: string; session: Session }>(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1,
    commandId: `loop-${Math.random().toString(36).slice(2)}`,
    taskId,
    goal: 'Check the delivery and write the report.',
    route: 'native-fixture',
    sources: [],
  });

describe('through the account session', () => {
  beforeEach(async () => {
    cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
    await seedDemo(cloud);
    const backend: AccountBackend = {
      client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
      close: async () => {},
    };
    await open({ backend });
  });
  afterEach(close);

  const sentFiles = (delivery: InstructionDelivery) => {
    expect(delivery.excluded ?? []).toEqual([]);
    return delivery.files.map((file) => [file.path, file.state]);
  };

  test('Juniper Street Bakery holds the Business plan: its instructions are sent and its trigger rules watch', async () => {
    const signed = await signIn('owner@juniper.test');
    expect(signed.status).toBe(200);
    const { projectId, taskId } = await ownerRuledProject();
    const bound = await call(`/workspace/organizations/${signed.data.workspaces[0].organization.id}/output`, 'POST', { projectId });
    expect(bound.status).toBe(200);

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBeNull();

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(sentFiles(started.data.session.instructions!)).toEqual([['AGENTS.md', 'sent']]);
  });

  test('Harbor Hardware holds no plan: its instructions are still sent, and only its trigger rules wait', async () => {
    const signed = await signIn('owner@harbor.test');
    expect(signed.status).toBe(200);
    const { projectId, taskId } = await ownerRuledProject();
    const bound = await call(`/workspace/organizations/${signed.data.workspaces[0].organization.id}/output`, 'POST', { projectId });
    expect(bound.status).toBe(200);

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);
    expect(routes.data.routes.find((offer) => offer.route === 'native-fixture')?.admitted).toBe(true);

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(sentFiles(started.data.session.instructions!)).toEqual([['AGENTS.md', 'sent']]);
  });

  test('a free person’s own project sends its instructions like any harness', async () => {
    const signed = await signIn('free@example.test');
    expect(signed.status).toBe(200);
    const { projectId, taskId } = await ownerRuledProject();

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(sentFiles(started.data.session.instructions!)).toEqual([['AGENTS.md', 'sent']]);
  });

  test('with accounts off the host passes every rule through, exactly like the Agent gate', async () => {
    await close();
    await open(null);
    const { projectId, taskId } = await ownerRuledProject();

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBeNull();

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(started.data.session.instructions!.files.map((file) => file.path)).toEqual(['AGENTS.md']);
  });

  test('the feature name is the one the seed grants and the gate reads', () => {
    expect(OWNER_RULES_FEATURE).toBe('owner-rules');
  });
});
