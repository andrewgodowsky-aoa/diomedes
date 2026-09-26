/**
 * 'owner-rules' (Andrew, 2026-09-25): a business's own instruction files reach
 * the work only while the business it belongs to holds the feature. Withheld
 * files are never silently absent — the delivery record names each one with
 * `not-included` and the plan's own sentence — while the product's rules (the
 * writing standard, shipped product knowledge) go regardless. A Personal
 * workspace has no business to hold the feature, and an embedded host with no
 * accounts passes everything through, exactly like the Agent gate.
 *
 * The unit half exercises `assembleInstructions` and `deliverySentence`
 * directly (the same path every run and message uses). The app half stands up
 * the real host on the faux cloud: Juniper Street Bakery holds the Business
 * plan, Harbor Hardware holds nothing, and a free account is Personal.
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

const assemble = (store: Store, id: string, workPaths: string[], ownerRulesIncluded?: boolean) =>
  assembleInstructions({
    state: store.state(id),
    routeId: 'codex',
    agentRole: 'Diomedes build file proposal writer',
    budgetBytes: instructionSectionBudget(0),
    workPaths,
    at: '2026-09-26T01:00:00.000Z',
    ...(ownerRulesIncluded === undefined ? {} : { ownerRulesIncluded }),
  });

describe('the instruction gate', () => {
  test('with the feature, and with the check absent, the files are sent', async () => {
    // One project: a folder can be a project only once in a store.
    const { store, id } = await project(REPO);
    await activatePack(store, id, PACK);
    for (const ownerRulesIncluded of [true, undefined] as const) {
      const { section, delivery } = await assemble(store, id, ['pkg/one.md'], ownerRulesIncluded);
      expect(delivery!.files.map((file) => [file.path, file.state])).toEqual([
        ['pkg/AGENTS.md', 'sent'],
        ['AGENTS.md', 'sent'],
      ]);
      expect(delivery!.excluded ?? []).toEqual([]);
      expect(section).toContain('PKG-AGENTS-BODY');
      expect(section).toContain('ROOT-AGENTS-BODY');
    }
  });

  test('without the feature every in-scope file is withheld by name with the plan’s reason', async () => {
    const { store, id } = await project(REPO);
    await activatePack(store, id, PACK);
    const { section, delivery } = await assemble(store, id, ['pkg/one.md'], false);
    // Nothing the owner wrote reached the section; the record is not silently empty.
    expect(section).not.toContain('ROOT-AGENTS-BODY');
    expect(section).not.toContain('PKG-AGENTS-BODY');
    expect(delivery).not.toBeNull();
    expect(delivery!.files).toEqual([]);
    expect(delivery!.excluded).toEqual([
      expect.objectContaining({
        path: 'pkg/AGENTS.md',
        exclusion: 'not-included',
        detail: OWNER_RULES_NOT_INCLUDED_REASON,
      }),
      expect.objectContaining({
        path: 'AGENTS.md',
        exclusion: 'not-included',
        detail: OWNER_RULES_NOT_INCLUDED_REASON,
      }),
    ]);
  });

  test('product rules still go: the writing standard and shipped product knowledge ride along', async () => {
    const { store, id } = await project(REPO);
    await activatePack(store, id, PACK);
    const withheld = await assemble(store, id, ['pkg/one.md'], false);
    expect(withheld.writing.state).toBe('sent');
    expect(withheld.section).not.toBeNull();
    // The project's own text is absent; what remains is the product's.
    expect(withheld.section).not.toContain('AGENTS-BODY');
    const delivered = await assemble(store, id, ['pkg/one.md'], true);
    expect(delivered.writing.state).toBe('sent');
    expect(delivered.productKnowledge.state).toBe(withheld.productKnowledge.state);
  });

  test('an out-of-scope file keeps its own reason; only governing files are withheld', async () => {
    const { store, id } = await project({
      ...REPO,
      'other/AGENTS.md': '# Other\nOTHER-BODY\n',
    });
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/one.md'], false);
    const excluded = Object.fromEntries(
      (delivery!.excluded ?? []).map((file) => [file.path, file.exclusion]),
    );
    expect(excluded['other/AGENTS.md']).toBe('out-of-scope');
    expect(excluded['pkg/AGENTS.md']).toBe('not-included');
    expect(excluded['AGENTS.md']).toBe('not-included');
  });

  test('the History sentence names the withheld files after the plan’s reason', async () => {
    const { store, id } = await project(REPO);
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/one.md'], false);
    const sentence = deliverySentence(delivery!);
    expect(sentence).toContain('Diomedes sent no project instructions to codex.');
    expect(sentence).toContain(OWNER_RULES_NOT_INCLUDED_REASON);
    const withheldAt = sentence.indexOf('Withheld:');
    expect(withheldAt).toBeGreaterThan(sentence.indexOf(OWNER_RULES_NOT_INCLUDED_REASON));
    expect(sentence.slice(withheldAt)).toContain('pkg/AGENTS.md');
    expect(sentence.slice(withheldAt)).toContain('AGENTS.md');
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

describe('the feature decides through the account session', () => {
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

  test('Juniper Street Bakery holds the Business plan, so its project’s instructions are sent', async () => {
    const signed = await signIn('owner@juniper.test');
    expect(signed.status).toBe(200);
    const { projectId, taskId } = await ownerRuledProject();

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBeNull();

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const delivery: InstructionDelivery = started.data.session.instructions!;
    expect(delivery.files.map((file) => [file.path, file.state])).toEqual([['AGENTS.md', 'sent']]);
    expect(delivery.excluded ?? []).toEqual([]);
  });

  test('Harbor Hardware holds no plan: its rules are kept, named as withheld, and reach nothing', async () => {
    const signed = await signIn('owner@harbor.test');
    expect(signed.status).toBe(200);
    const { projectId, taskId } = await ownerRuledProject();

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);
    // An admitted route is still admitted — only the owner's rules stop reaching it.
    expect(routes.data.routes.find((offer) => offer.route === 'native-fixture')?.admitted).toBe(true);

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const delivery: InstructionDelivery = started.data.session.instructions!;
    expect(delivery.files).toEqual([]);
    expect(delivery.excluded).toEqual([
      expect.objectContaining({
        path: 'AGENTS.md',
        exclusion: 'not-included',
        detail: OWNER_RULES_NOT_INCLUDED_REASON,
      }),
    ]);
  });

  test('a Personal workspace holds no business, so its own files are withheld the same way', async () => {
    const signed = await signIn('free@example.test');
    expect(signed.status).toBe(200);
    const { projectId, taskId } = await ownerRuledProject();

    const routes = await call<RoutesView>(`/projects/${projectId}/loop/routes`);
    expect(routes.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);

    const started = await startLoop(projectId, taskId);
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(started.data.session.instructions!.excluded).toEqual([
      expect.objectContaining({ path: 'AGENTS.md', exclusion: 'not-included' }),
    ]);
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
