import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { disablePrototypeAuthority } from '../server/trust/index.js';
import { evaluateRules, withinServiceWindow } from '../server/rules.js';
import { ruleSchema } from '../shared/connection-rules.js';
import { digest, HarnessError } from '../server/harness/policy.js';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let origin: string;
let projectId: string;
const window = { start: '00:00', end: '23:59', timeZone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
async function launch() {
  app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects') });
  server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local port');
  origin = `http://127.0.0.1:${address.port}`;
}
async function close() {
  await app.locals.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
}
beforeEach(async () => {
  process.env.DIOMEDES_TEST_MODE = '1'; disablePrototypeAuthority();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-desktop-connections-'));
  await launch(); projectId = (await app.locals.store.createProject('Synthetic group')).id;
});
afterEach(async () => {
  await close(); disablePrototypeAuthority(); delete process.env.DIOMEDES_TEST_MODE;
  await fs.rm(root, { recursive: true, force: true });
});
async function call(action = '', body?: unknown, expected = 200) {
  const response = await fetch(`${origin}/api/projects/${projectId}/connections${action ? `/${action}` : ''}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(expected); return result;
}
async function enable() {
  const proposed = await call('propose', { text: 'Watch Toast menu availability across three Raleigh restaurants', threshold: 5, serviceWindow: window });
  const input = { id: proposed.plan.id, digest: proposed.digest };
  await call('adopt', input); return input;
}
test('actual app routes require exact completed review and current session authority', async () => {
  const incomplete = await call('propose', { text: 'Watch Toast across three Raleigh restaurants' });
  expect(incomplete.plan.questions).toHaveLength(2);
  await call('adopt', { id: incomplete.plan.id, digest: incomplete.digest }, 409);
  await call('propose', { text: 'Toast', tenantId: 'forged' }, 400);
  const approved = await enable();
  const view = await call(); expect(view.connections[0].connection.resources).toHaveLength(3);
  expect(view.connections[0].connection.vendorScopes).toEqual(['stock:read']);
  expect((await call('adopt', approved)).replay).toBe(true);
  await call('control', { status: 'disconnected' });
  await call('adopt', approved); expect((await call()).connections[0].health).toBe('disconnected');
  await call('read', {}, 409);
  await close(); await launch();
  expect((await call()).authorized).toBe(false);
  await call('read', {}, 409); await call('resume', {});
  expect((await call()).connections[0].health).toBe('stale');
});
test('ordinary app dispatch preserves raw bad output, freezes context, then adopts and rolls back a scoped revision', async () => {
  await enable(); await call('rules/revise', {}, 409);
  await call('investigate', {});
  const view = await call(), run = view.runs.at(-1);
  expect(run.state).toBe('completed'); expect(run.used.modelCalls).toBe(3);
  const models = run.steps.filter((step: { intent: { kind: string } }) => step.intent.kind === 'model');
  expect(JSON.stringify(models[1].output)).toContain('12 units');
  expect(JSON.stringify(models[2].output)).toContain('not tracked');
  expect(models[0].intent.input.request.messages[0].text).toContain('stock-investigator-notes v1');
  expect(view.observations.filter((item: { facts: { quantityState: string } }) => item.facts.quantityState === 'not-tracked')).toHaveLength(3);
  const proposed = await call('rules/revise', {}); expect(proposed.proposal.review.sourceSteps).toHaveLength(1);
  expect(proposed.proposal.review.replay[0].before).not.toEqual(proposed.proposal.review.replay[0].after);
  expect((await call()).rules.active.find((item: { id: string }) => item.id === 'stock-investigator-notes').version).toBe(1);
  await call('rules/adopt', { id: proposed.proposal.id, digest: '0'.repeat(64) }, 409);
  await call('rules/adopt', { id: proposed.proposal.id, digest: proposed.digest });
  const revised = (await call()).rules.active.find((item: { id: string }) => item.id === 'stock-investigator-notes');
  expect(revised.version).toBe(2); expect(revised.text).toContain('quantity not tracked');
  const rollback = await call('rules/revise', { rollbackVersion: 1 });
  expect(rollback.proposal.review.kind).toBe('rollback');
  await call('rules/adopt', { id: rollback.proposal.id, digest: rollback.digest });
  const restored = (await call()).rules.active.find((item: { id: string }) => item.id === 'stock-investigator-notes');
  expect(restored.version).toBe(3); expect(restored.text).not.toContain('quantity not tracked');
  expect(restored.scope).toEqual(revised.scope);
  await call('rules/revise', { capabilities: ['connections.write'] }, 400);
});
test('durable signed ingress coalesces replay, rejects conflicts, and registered write never dispatches', async () => {
  await enable();
  const event = { id: crypto.randomUUID(), quantity: 3, at: new Date().toISOString() };
  await call('event', event, 202); await call('event', event, 202);
  await expect.poll(async () => (await call()).tasks.length).toBe(1);
  await call('event', { ...event, quantity: 4 }, 409);
  const before = await call(); expect(before.inbox).toHaveLength(1);
  expect(before.tasks[0].description).toContain('Rule low-stock v1');
  const probe = await call('proof/write-denial', {});
  expect(probe.registered).toBe(true); expect(probe.dispatches).toBe(0); expect(probe.denied).toBeTruthy();
  await close(); await launch(); await call('resume', {}); await call('event', event, 202);
  expect((await call()).tasks).toHaveLength(1);
  await call('control', { status: 'disconnected' }); await call('event', { ...event, id: crypto.randomUUID() }, 409);
  const bad = await fetch(`${origin}/vendor/connections/${projectId}/${before.connections[0].connection.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Toast-Signature': 'bad' }, body: '{}' });
  expect(bad.status).toBe(409);
});
test('service window AND numeric threshold is deterministic across days, overnight and missing source time', () => {
  const rule = ruleSchema.parse({ id: 'low', version: 1, enabled: true, scope: {}, type: 'workflow', action: 'create-issue',
    provenance: { source: 'reviewed test', connectorVersion: null, trust: 'host-reviewed' }, text: 'Notify manager',
    predicate: { field: 'quantity', operator: 'lte', value: 5 },
    serviceWindow: { start: '22:00', end: '02:00', timeZone: 'America/New_York', days: [2] } });
  expect(withinServiceWindow(rule, '2026-09-09T03:00:00Z')).toBe(true);
  expect(withinServiceWindow(rule, '2026-09-09T05:59:00Z')).toBe(true);
  expect(withinServiceWindow(rule, '2026-09-09T06:00:00Z')).toBe(false);
  expect(withinServiceWindow(rule, undefined)).toBe(false);
  expect(evaluateRules([rule], {}, { quantity: null, sourceAt: '2026-09-09T03:00:00Z' })).toHaveLength(0);
  expect(evaluateRules([rule], {}, { quantity: 3, sourceAt: '2026-09-09T03:00:00Z' })).toHaveLength(1);
  expect(digest(rule)).toHaveLength(64);
});

test.each(['exact', 'resource', 'operation'])('pending adoption recovery checks the complete %s authority shape', async (change) => {
  const proposed = await call('propose', { text: 'Toast across three Raleigh restaurants', threshold: 5, serviceWindow: window });
  const approval = { id: proposed.plan.id, digest: proposed.digest };
  const fault = vi.spyOn(app.locals.connections.service, 'proposeMonitor').mockRejectedValueOnce(new HarnessError('interrupted', 'Injected interruption after connection install'));
  await call('adopt', approval, 409); fault.mockRestore();
  expect(app.locals.store.state(projectId).desktopConnections.admissions[0].state).toBe('pending');
  if (change !== 'exact') await app.locals.store.locked(async () => {
    const state = structuredClone(app.locals.store.state(projectId));
    if (change === 'resource') state.connections.instances[0].resources.pop();
    else state.connections.instances[0].operations = [];
    await app.locals.store.persist(state);
  });
  await close(); await launch();
  await call('adopt', approval, change === 'exact' ? 200 : 409);
  const state = app.locals.store.state(projectId);
  expect(state.desktopConnections.admissions[0].state).toBe(change === 'exact' ? 'complete' : 'pending');
});

test('malformed persisted rule scope cannot acquire broader ownership through exact adoption', async () => {
  await enable(); await call('investigate', {});
  const proposed = await call('rules/revise', {});
  await app.locals.store.locked(async () => {
    const state = structuredClone(app.locals.store.state(projectId));
    const rule = state.rules.proposals.find((item: { id: string }) => item.id === proposed.proposal.id);
    rule.rule.scope = { connectionId: rule.rule.scope.connectionId };
    proposed.digest = digest(rule);
    await app.locals.store.persist(state);
  });
  await call('rules/adopt', { id: proposed.proposal.id, digest: proposed.digest }, 409);
});

test.each(['before-triage', 'after-task-commit'])('fresh session recovers accepted event at %s without replaying old authority', async (seam) => {
  await enable();
  const desktop = app.locals.connections, service = desktop.service;
  const event = { id: crypto.randomUUID(), at: new Date().toISOString(), quantity: 3 };
  await desktop.event(projectId, event); // Raw HMAC accept, intentionally no asynchronous drain yet.
  const receipt = service.snapshot(projectId).connections.inbox[0];
  await service.admit(projectId, receipt.connectionId, [receipt.observation.resourceId], ['get_item_availability'], receipt.runId);
  if (seam === 'after-task-commit') {
    const step = app.locals.harness.runs.step.bind(app.locals.harness.runs);
    const fault = vi.spyOn(app.locals.harness.runs, 'step').mockImplementation(async (...args: unknown[]) => {
      const [runId, owner, definition, handler, principal] = args;
      return step(runId, owner, definition, async (context: unknown) => {
        await (handler as (context: unknown) => Promise<unknown>)(context);
        throw new Error('Injected interruption after Task receipt commit');
      }, principal);
    });
    await expect(service.drain(projectId)).rejects.toThrow('Injected interruption'); fault.mockRestore();
    expect(service.snapshot(projectId).connections.inbox[0].state).toBe('processed');
  }
  await close(); disablePrototypeAuthority(); await launch();
  expect((await call()).authorized).toBe(false);
  await call('resume', {});
  const recovered = await call(); expect(recovered.tasks).toHaveLength(1);
  expect(recovered.inbox[0].state).toBe('processed');
  expect(recovered.connections[0].connection.generation).toBe(1);
  if (seam === 'before-triage') {
    expect(recovered.inbox[0].runId).not.toBe(receipt.runId);
    expect(recovered.inbox[0].priorRunIds).toContain(receipt.runId);
  }
  const old = await app.locals.harness.runs.get(receipt.runId);
  expect(old.state).toBe('cancelled');
  await call('event', event, 202); expect((await call()).tasks).toHaveLength(1);
});
