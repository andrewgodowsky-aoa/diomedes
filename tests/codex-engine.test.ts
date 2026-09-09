import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createHarnessHost, type HarnessHost } from '../server/harness/host.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { codexContextHash, type askCodex } from '../server/integrations.js';
import { parseApprovalCommand, validateApprovalReceipts } from '../server/approval-admission.js';
import type { Need } from '../shared/types.js';
import type { Capability } from '../server/harness/trust-port.js';

let root: string, store: Store, host: HarnessHost, projectId: string;
let calls: number, generation: number, denied: boolean;
let authorityExpiry: string;
let rights: Set<Capability>;
let command: Record<string, unknown>;
const accountRoute = 'openai:chatgpt:synthetic-account';
const selection = { model: 'synthetic-model', effort: 'low' };
const output = { text: JSON.stringify({ summary: 'A synthetic report', changes: [
  { path: 'Harness report.md', text: '# Synthetic report\n\nThree locations.\n', summary: 'A report' },
] }), model: 'synthetic-model', version: '0.153.4', threadId: 'synthetic-transcript' };
let generator: typeof askCodex;
async function open() {
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  host = createHarnessHost({ store, dataDir: store.dataDir,
    currentAuthority: async () => denied ? { denied: true, status: 403, code: 'revoked', reason: 'Synthetic revocation' } : ({
      principal: { kind: 'prototype', id: 'synthetic-host', tenantId: null, projectId: null,
        deviceId: null, sessionId: null, slotId: null },
      generation: { identity: 1, principal: generation },
      capabilities: rights,
      assurance: 'prototype', synthetic: true, expiresAt: authorityExpiry, resolvedAt: new Date().toISOString(),
    }),
    codexAccountRoute: async () => accountRoute,
    codexGenerator: input => generator(input),
  });
  await host.init();
}
const state = () => store.state(projectId);
const start = (body = command) => host.startCodexReport(projectId, body, selection);
async function waiting() {
  await vi.waitFor(() => expect(state().needs.find(n => n.state === 'open')).toBeTruthy(), { timeout: 5000 });
  return structuredClone(state().needs.find(n => n.state === 'open')!);
}
async function decide(need: Need, resolution: 'go-ahead' | 'declined' = 'go-ahead') {
  const admission = parseApprovalCommand(projectId, need.id, {
    protocolVersion: 1, commandId: `decision-${need.id}`, resolution,
    proposalDigest: need.approval!.proposalDigest, actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  })!;
  return store.locked(() => host.bridge.resolve(projectId, need.id, resolution, false, admission));
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-codex-engine-'));
  calls = 0; generation = 1; denied = false;
  authorityExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
  rights = new Set<Capability>(['work.submit', 'work.cancel', 'egress.send', 'egress.reconcile',
    'write.apply', 'approval.decide', 'project.read']);
  generator = async input => {
    const { instructions, model, effort } = input;
    if (!instructions || !model || !effort || !input.beforeDispatch) throw new Error('Missing dispatch binding');
    await input.beforeDispatch({ accountRoute, contextHash: codexContextHash({ ...input, instructions, model, effort }) });
    calls++;
    return output;
  };
  await open();
  const project = await store.locked(() => store.createProject('Synthetic Codex'));
  projectId = project.id;
  await fs.writeFile(path.join(project.folder, 'Synthetic.txt'), 'Three synthetic locations.\n');
  store.settings.services = { codex: true };
  store.settings.permissions.sending = true;
  await store.saveSettings(store.settings);
  const task = await store.locked(async () => {
    const t = store.createTask(state(), { name: 'Report', description: 'Synthetic', owner: 'diomedes-with-ok' });
    await store.persist(state());
    return t;
  });
  command = { protocolVersion: 1, commandId: 'synthetic-command', taskId: task.id,
    route: 'codex', capabilityId: 'codex-report', instruction: 'Summarize the synthetic locations.',
    sources: ['Synthetic.txt'], consent: true };
});
afterEach(async () => {
  vi.restoreAllMocks();
  denied = false;
  await host.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('durable admission, identical concurrent retry, restart, exact decision and one recorded write', async () => {
  const [one, two] = await Promise.all([start(), start()]);
  expect(two.id).toBe(one.id);
  const need = await waiting();
  expect(calls).toBe(1);
  expect(await store.current(projectId, 'Harness report.md')).toBeNull();
  expect(need.approval!.sources).toHaveLength(1);
  const run = await host.get(projectId, need.harness!.runId);
  expect(run.steps[0].intent).toMatchObject({ kind: 'model', effect: 'read', destination: 'external',
    label: { confidentiality: 'restricted', integrity: 'untrusted' } });
  expect(run.transcripts.codex).toMatchObject({ opaqueRef: 'synthetic-transcript', lineageId: run.id });
  await host.close();
  await open();
  expect((await start()).id).toBe(one.id);
  const saved = structuredClone(state().needs.find(n => n.id === need.id)!);
  await decide(saved);
  await decide(saved);
  await vi.waitFor(async () => expect((await host.get(projectId, run.id)).state).toBe('completed'), { timeout: 5000 });
  expect(calls).toBe(1);
  expect(state().history.filter(e => e.approvalId === need.id && e.files.length)).toHaveLength(1);
  expect(await store.current(projectId, 'Harness report.md')).toBe('# Synthetic report\n\nThree locations.\n');
  validateApprovalReceipts(state());
});

test('changed command payload and concurrent different starts cannot dispatch again', async () => {
  await start(); await waiting();
  await expect(start({ ...command, instruction: 'Changed' })).rejects.toThrow();
  await expect(start({ ...command, commandId: 'different-command' })).rejects.toThrow('in progress');
  expect(calls).toBe(1);
});

test.each(['consent', 'principal', 'sending', 'authority'])( '%s cannot manufacture outbound permission', async reason => {
  if (reason === 'sending') store.settings.permissions.sending = false;
  if (reason === 'authority') denied = true;
  const body = reason === 'consent' ? { ...command, consent: false }
    : reason === 'principal' ? { ...command, principal: localHarnessPrincipal(projectId) } : command;
  await expect(start(body)).rejects.toThrow();
  expect(calls).toBe(0);
});

test('admission persistence failure prevents dispatch and a retry creates one durable receipt', async () => {
  vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('Synthetic storage rejection'));
  await expect(start()).rejects.toThrow('Synthetic storage rejection');
  expect(calls).toBe(0);
  vi.restoreAllMocks();
  await start(); await waiting();
  expect(calls).toBe(1);
  expect(state().sessions.filter(s => s.receipt?.commandId === command.commandId)).toHaveLength(1);
});

test('revocation while dispatch is waiting prevents the provider send', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  host.runs.use(async context => { if (context.step.name === 'codex') await gate; });
  await start();
  const run = (await host.list(projectId))[0];
  host.codex.revoke(run.id);
  release();
  await vi.waitFor(async () => expect((await host.get(projectId, run.id)).state).toBe('failed'), { timeout: 5000 });
  expect(calls).toBe(0);
});

test('unknown provider completion stays parked and never causes redispatch', async () => {
  generator = async () => { calls++; throw new Error('Synthetic lost completion'); };
  await start();
  await vi.waitFor(async () => expect((await host.list(projectId))[0].state).toBe('reconcile_required'), { timeout: 5000 });
  await host.close(); await open();
  await start();
  expect(calls).toBe(1);
  expect(state().needs).toHaveLength(0);
});

test('changed source text prevents application after exact approval', async () => {
  await start(); const need = await waiting();
  await fs.writeFile(path.join(state().project.folder, 'Synthetic.txt'), 'A newer source.\n');
  await decide(need);
  await vi.waitFor(async () => expect((await host.get(projectId, need.harness!.runId)).state).toBe('failed'), { timeout: 5000 });
  expect(await store.current(projectId, 'Harness report.md')).toBeNull();
  expect(calls).toBe(1);
});

test('current authority is required for a later exact decision', async () => {
  await start(); const need = await waiting();
  denied = true;
  await expect(decide(need)).rejects.toThrow('revocation');
  expect(await store.current(projectId, 'Harness report.md')).toBeNull();
});

test('lost authority pauses recovery without blocking startup or changing the saved run', async () => {
  await start(); const need = await waiting();
  await host.close();
  const filename = path.join(store.dataDir, 'projects', projectId, 'harness', 'runs', `${need.harness!.runId}.json`);
  const before = await fs.readFile(filename, 'utf8');
  denied = true;
  await expect(open()).resolves.toBeUndefined();
  expect(await fs.readFile(filename, 'utf8')).toBe(before);
  expect(calls).toBe(1);
  expect(await store.current(projectId, 'Harness report.md')).toBeNull();
  expect(state().sessions.find(s => s.id === need.sessionId)!.log.at(-1)!.sentence).toContain('current authority');
  expect(state().needs.find(n => n.id === need.id)!.state).toBe('open');
  await expect(host.list(projectId)).rejects.toThrow('revocation');
  await expect(host.get(projectId, need.harness!.runId)).rejects.toThrow('revocation');
  await expect(store.locked(() => store.createProject('Another synthetic project'))).resolves.toBeTruthy();
});

test.each(['expired', 'forged', 'cross-run', 'cross-project', 'destination', 'context', 'generation', 'account'])(
  'a %s grant or context cannot dispatch', async fault => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.runs.use(async context => { if (context.step.name === 'codex') await gate; });
    await start();
    const run = (await host.list(projectId))[0];
    if (fault === 'generation') generation++;
    else if (fault === 'account') {
      generator = async input => {
        await input.beforeDispatch!({ accountRoute: 'openai:chatgpt:other-account', contextHash: 'wrong' });
        calls++; return output;
      };
    } else {
      // Simulate damaged/client-forged saved bytes, never mint host permission.
      const saved = JSON.parse(await fs.readFile(path.join(root, 'data/projects', projectId, 'harness/runs', `${run.id}.json`), 'utf8'));
      if (fault === 'expired') saved.input.grant.expiresAt = '2000-01-01T00:00:00.000Z';
      if (fault === 'forged') saved.input.grant.id = '00000000-0000-4000-8000-000000000000';
      if (fault === 'cross-run') saved.input.grant.runId = 'another-run';
      if (fault === 'cross-project') saved.input.grant.projectId = 'another-project';
      if (fault === 'destination') saved.input.grant.destination = 'another-provider';
      if (fault === 'context') saved.input.context.documents[0].text = 'Unapproved text';
      await fs.writeFile(path.join(root, 'data/projects', projectId, 'harness/runs', `${run.id}.json`), JSON.stringify(saved));
    }
    release();
    await vi.waitFor(async () => expect(['failed', 'reconcile_required']).toContain((await host.runs.get(run.id)).state), { timeout: 5000 });
    expect(calls).toBe(0);
  },
);

test('changing the requested model under an admitted command conflicts', async () => {
  await start(); await waiting();
  await expect(host.startCodexReport(projectId, command, { ...selection, model: 'another-model' })).rejects.toThrow();
  expect(calls).toBe(1);
});

test('Stop after dispatch rejects late proposal output', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  generator = async input => { calls++; await gate; return output; };
  const session = await start();
  await vi.waitFor(() => expect(calls).toBe(1));
  await store.locked(() => host.bridge.stop(projectId, session.id));
  release();
  await host.close();
  expect(state().needs).toHaveLength(0);
  const run = (await host.list(projectId))[0];
  expect(run.steps[0].state).toBe('reconcile_required');
  expect(run.steps[0].output).toBeNull();
  expect(await store.current(projectId, 'Harness report.md')).toBeNull();
});

test('the host grant deadline expires without modifying the saved input', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  host.runs.use(async context => { if (context.step.name === 'codex') await gate; });
  await start();
  const run = (await host.list(projectId))[0];
  const later = Date.now() + 6 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  release();
  await vi.waitFor(async () => expect((await host.runs.get(run.id)).state).toBe('failed'), { timeout: 5000 });
  expect(calls).toBe(0);
});

test('sending permission cannot accept a result after reconcile permission is revoked', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  generator = async () => { calls++; await gate; return output; };
  await start();
  await vi.waitFor(() => expect(calls).toBe(1));
  rights.delete('egress.reconcile');
  release();
  await vi.waitFor(async () => expect((await host.list(projectId))[0].state).toBe('reconcile_required'), { timeout: 5000 });
  expect(state().needs).toHaveLength(0);
  expect((await host.list(projectId))[0].steps[0].output).toBeNull();
});
