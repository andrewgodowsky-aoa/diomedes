/** W00 fixtures now enforce the repaired MEM-01 preservation invariant by default.
 * The original first-sentence failure evidence remains in the security audit.
 * NC_MEMORY_BASELINE_EXPECT_PRESERVED=1 remains accepted by older runners; both
 * invocations now require preservation. These tests do not evaluate model reasoning.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { HarnessPrincipal, ModelRequest } from '../shared/harness.js';
import { estimateTokens, modelContextWindow, utf8Bytes } from '../shared/context-accounting.js';
import { AWS_KIMI_K3 } from '../shared/model-api.js';
import { STRICT_RESTRICTIONS } from '../shared/routing-policy.js';
import { accountContext, compactTurns, selectHistory, stablePrefix } from '../server/harness/context-assembly.js';
import { answeredTurns } from '../server/harness/conversation-history.js';
import { NativeAgent, validatePrepared, type ModelAdapter } from '../server/harness/native-agent.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService, Suspended } from '../server/harness/run-service.js';
import { ToolRegistry } from '../server/harness/tools.js';
import { HarnessError } from '../server/harness/policy.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { ModelSessionRuns, modelApiDispatchAuthorizer } from '../server/harness/model-session-run.js';
import { AWS_MODEL_CONTRACT } from '../server/harness/aws-model-adapter.js';
import { BASELINE_TENANTS, BASELINE_QUERY, APPROVAL, CORRECTION, LONG_OPENING,
  OPAQUE_TRANSCRIPT, baselineCases, type BaselineCase } from './fixtures/memory-context/baseline.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const roots: string[] = [];
const drivers: ModelSessionRuns[] = [];
const observations: unknown[] = [];
afterAll(async () => {
  if (process.env.NC_MEMORY_BASELINE_WRITE_EVIDENCE !== '1') return;
  const output = path.resolve('evidence/memory-context-w00');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'preservation-observations.json'), JSON.stringify({
    schema: 'w00-observed-context/1', synthetic: true, desiredInvariantMode: true,
    boundary: 'Observed text and references only; use the test runner log for verdicts. No model reasoning or live provider was tested.',
    observations,
  }, null, 2) + '\n');
});
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('memory-w00-'))
      throw new Error('Refusing cleanup outside the owned baseline temporary directory.');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-w00-'));
  roots.push(root);
  return root;
}
function adapter(overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    id: 'fixture', version: 'w00-1', contract: routeContractFor('native-fixture'), destination: 'local',
    capabilities: () => ({ engineId: 'fixture', engineVersion: 'w00-1', protocolVersion: 'fixture',
      modelCalls: 'enforced', toolCalls: 'enforced', filesystemWrites: 'unsupported', networkEgress: 'unsupported',
      approvals: 'enforced', resumability: 'enforced', cancellability: 'enforced', checkpointGranularity: 'step',
      notes: ['Scripted offline transport; no provider or reasoning evaluation.'] }),
    complete: async () => ({ response: { type: 'final', text: 'Scripted response.' }, usage: null }),
    ...overrides,
  };
}
async function start(runs: RunService, tenantId: string, id: string, tools = new ToolRegistry()) {
  const principal: HarnessPrincipal = { id: `fixture-${tenantId}`, tenantId, projectId: `project-${tenantId}`,
    capabilities: [], identityGeneration: 1 };
  await runs.start({ id, tenantId, projectId: principal.projectId, principal, tools,
    capability: { id: 'w00-baseline', version: '1', label: 'Synthetic baseline', description: 'Offline W00 inputs.',
      tools: tools.describe().map(tool => tool.name), requestedPermissions: [], approvalPolicy: 'show-first',
      maxTurns: 8, supportedPlatforms: ['win32', 'linux', 'darwin'] },
    budget: { units: 20, modelCalls: 8, toolCalls: 8, wallMs: null } });
  await runs.claim(id, 'host', 60_000);
  return principal;
}
async function seed(runs: RunService, tenant: string, fixture: BaselineCase) {
  const id = `${tenant}-${fixture.id}`;
  const principal = await start(runs, tenant, id);
  for (const turn of fixture.turns)
    await runs.step(id, 'host', { id: `turn:${turn.key}`, version: '1', kind: 'transform', effect: 'pure',
      name: 'seed_fictional_history', cost: 0, input: { prompt: turn.prompt } },
    () => ({ response: { text: turn.answer } }), principal);
  return runs.get(id);
}
function assertCompaction(fixture: BaselineCase, own: Awaited<ReturnType<RunService['get']>>) {
  const before = JSON.stringify(own);
  const source = answeredTurns([own]);
  // The real driver may repair writing before persistence. Prove the full input
  // survived that path before attributing any missing correction to compaction.
  expect(source.map(turn => ({ prompt: turn.prompt, answer: turn.answer })),
    'Source precondition: persisted History must contain every complete fixture prompt and answer.')
    .toEqual(fixture.turns.map(turn => ({ prompt: turn.prompt, answer: turn.answer })));
  const target = source[fixture.targetIndex - 1];
  expect([target.prompt, target.answer].join('\n'),
    'Source precondition: the target correction must be present before history selection.')
    .toContain(fixture.critical);
  const selected = selectHistory({ own, message: BASELINE_QUERY });
  expect(selected.selection?.omitted.map(item => item.index)).toEqual([2, 3, 4]);
  const omitted = source.filter(turn => [2, 3, 4].includes(turn.index));
  const compacted = compactTurns(omitted);
  expect(selected.compaction).toEqual(compacted);
  expect(compacted.turns).toEqual(omitted.map(turn => ({ runId: own.id, stepId: turn.stepId, index: turn.index,
    promptSha: sha(turn.prompt!), answerSha: sha(turn.answer!) })));
  expect(compacted.id).toBe(sha(JSON.stringify({ method: compacted.method, turns: compacted.turns, text: compacted.text })));
  expect(compacted.text).toContain(`- Message ${fixture.targetIndex}: the person asked \u201c${target.prompt}\u201d; Diomedes answered \u201c${target.answer}\u201d`);
  expect(compacted).toMatchObject({ author: 'diomedes-application', method: 'verbatim-turns/1', listed: 3 });
  expect(compacted.bytes).toBe(utf8Bytes(compacted.text));
  expect(selected.text).toContain(compacted.text);
  expect(JSON.stringify(own)).toBe(before);
  return selected;
}
function assertCriticalText(text: string, critical: string) {
  expect(text, 'The exact correction must survive or be rehydrated.').toContain(critical);
}

describe('W00 two-tenant context preservation', () => {
  test.each(BASELINE_TENANTS.flatMap(tenant => baselineCases().map(fixture => ({ tenant, fixture }))))(
    '$tenant / $fixture.id: actual selection and compaction preserve references and critical text', async ({ tenant, fixture }) => {
      const runs = new RunService(new FileRunStore(await directory()));
      const own = await seed(runs, tenant, fixture);
      const otherTenant = tenant === 'tenant-a' ? 'tenant-b' : 'tenant-a';
      const other = await seed(runs, otherTenant, fixture);
      const original = JSON.stringify(own.steps);
      const selected = assertCompaction(fixture, own);
      expect(selected.compaction!.turns.every(ref => ref.runId === own.id)).toBe(true);
      expect(selected.compaction!.turns.some(ref => ref.runId === other.id)).toBe(false);
      expect(JSON.stringify((await runs.get(own.id)).steps)).toBe(original);
      observations.push({ seam: 'selectHistory+compactTurns', tenant, case: fixture.id,
        originalTurns: answeredTurns([own]), selected, sourceStepsUnchanged: true,
        criticalText: fixture.critical, criticalTextPresent: selected.text.includes(fixture.critical) });
      assertCriticalText(selected.text, fixture.critical);
    });

  test('safe controls: whole recent text and an omitted first-sentence correction survive', async () => {
    const runs = new RunService(new FileRunStore(await directory()));
    const fixture = baselineCases()[0];
    fixture.turns[1].answer = CORRECTION;
    fixture.turns[14].answer = `${APPROVAL} ${CORRECTION}`;
    const own = await seed(runs, 'tenant-a', fixture);
    const selected = selectHistory({ own, message: BASELINE_QUERY });
    expect(selected.selection!.omitted.some(ref => ref.index === 2)).toBe(true);
    expect(selected.compaction!.text).toContain(CORRECTION);
    expect(selected.selection!.included.some(ref => ref.index === 15 && !ref.truncated)).toBe(true);
    expect(selected.text).toContain(`Diomedes: ${APPROVAL} ${CORRECTION}`);
    expect(LONG_OPENING.length).toBeGreaterThan(160);
  });
});

describe('W00 actual ModelSessionRuns to NativeAgent dispatch', () => {
  // The current conversation host binds tenant=local. These tests do not claim cloud tenancy.
  test.each(baselineCases())('$id: the recorded omitted text actually reaches offline downstream dispatch', async fixture => {
    const authorize = modelApiDispatchAuthorizer(() => ({ 'aws-bedrock': true,
      'aws-bedrockAccountRoute': 'aws-bedrock:fixture@r1' }));
    const runs: RunService = new RunService(new FileRunStore(await directory()), {
      authorizeEgress: async (runId, intent, _principal, phase) => authorize(await runs.get(runId), intent, phase),
    });
    const driver = new ModelSessionRuns(runs, 'aws-bedrock');
    drivers.push(driver);
    driver.setSharingPolicy(() => {}, () => true);
    const sent: ModelRequest[] = [];
    const runId = `driver-${fixture.id}`;
    const send = (key: string, prompt: string, answer: string, first: boolean) => driver.request({
      mode: first ? 'start' : 'follow-up', runId,
      input: { projectId: 'project-local', threadId: `thread-${fixture.id}`, requestId: key, prompt, documents: [],
        instructions: 'Offline fictional fixture.', model: 'us.openai.gpt-5.6-luna', accountRoute: 'aws-bedrock:fixture@r1' },
      admit: async () => ({ route: 'aws-bedrock', connectionId: 'fixture', revision: 1,
        model: 'us.openai.gpt-5.6-luna', accountRoute: 'aws-bedrock:fixture@r1' }),
      adapter: async () => adapter({ id: 'aws-bedrock', contract: AWS_MODEL_CONTRACT, destination: 'external',
        prepare: async request => request,
        complete: async request => { sent.push(structuredClone(request)); return { response: { type: 'final', text: answer }, usage: null }; },
      }),
    });
    for (const [index, turn] of fixture.turns.entries()) await send(turn.key, turn.prompt, turn.answer, index === 0);
    const original = await runs.get(runId);
    const selected = assertCompaction(fixture, original);
    await send('probe', BASELINE_QUERY, 'Scripted probe response; no inference was evaluated.', false);
    const finalRequest = sent.at(-1)!;
    const dispatched = finalRequest.messages.map(message => message.text ?? '').join('\n');
    expect(dispatched).toContain(selected.text);
    const child = await driver.turnRun('project-local', runId, 'probe');
    expect(child!.input).toMatchObject({ historyShared: true, history: { selection: selected.selection, compaction: selected.compaction } });
    expect(child!.steps.find(step => step.intent.stepId === 'context:0')?.intent).toMatchObject({ effect: 'pure', cost: 0 });
    const after = await runs.get(runId);
    const originalTurns = answeredTurns([original]);
    expect(answeredTurns([after]).slice(0, fixture.turns.length)).toEqual(originalTurns);
    // A follow-up resolves the old pending wait. The completed source steps stay immutable.
    const sourceIds = new Set(originalTurns.map(turn => turn.stepId));
    expect(after.steps.filter(step => sourceIds.has(step.intent.stepId)))
      .toEqual(original.steps.filter(step => sourceIds.has(step.intent.stepId)));
    const account = (await driver.evidence('project-local', runId, 'probe')).context!;
    expect(account.window).toEqual({ tokens: null, source: 'not declared' });
    expect(account.requestLimitBytes).toBe(200_000);
    expect(account.provider?.firstCallInputTokens).toBeNull();
    observations.push({ seam: 'ModelSessionRuns+NativeAgent', tenant: original.tenantId, case: fixture.id,
      originalTurns: answeredTurns([original]), selection: selected.selection, compaction: selected.compaction,
      dispatchedRequest: finalRequest, account, sourceStepsUnchanged: true,
      criticalText: fixture.critical, criticalTextPresent: dispatched.includes(fixture.critical) });
    assertCriticalText(dispatched, fixture.critical);
  });
});

const request = (text = ''): ModelRequest => ({ runId: 'synthetic-run', capabilityId: 'w00-baseline',
  messages: [{ role: 'user', text }], tools: [], transcript: null });

describe('L01 separate serialization, UTF-8 and declared token constraints', () => {
  test('262144 is the inclusive serialized UTF-16 code-unit guard, even with a million-token declaration', () => {
    const before = request();
    const room = 262_144 - JSON.stringify(before).length;
    const boundary = request('a'.repeat(room));
    const oversized = request('a'.repeat(room + 1));
    expect(modelContextWindow('aws-bedrock', AWS_KIMI_K3.model).tokens).toBe(1_000_000);
    expect(JSON.stringify(boundary).length).toBe(262_144);
    expect(validatePrepared(before, boundary)).toEqual(boundary);
    expect(() => validatePrepared(before, oversized)).toThrow(expect.objectContaining({ code: 'invalid_prepared_context' }));
  });
  test('Unicode and JSON escaping distinguish serialized units from bytes and estimates', () => {
    const before = request();
    const unicode = request('\u754c'.repeat(100_000));
    expect(JSON.stringify(unicode).length).toBeLessThan(262_144);
    expect(utf8Bytes(JSON.stringify(unicode))).toBeGreaterThan(262_144);
    expect(validatePrepared(before, unicode)).toEqual(unicode); // This is not byte admission.
    expect(estimateTokens(unicode.messages[0].text!)).toBe(75_000); // Estimate only.
    const escaped = request('"'.repeat(140_000));
    expect(utf8Bytes(escaped.messages[0].text!)).toBe(140_000);
    expect(JSON.stringify(escaped).length).toBeGreaterThan(262_144);
    expect(() => validatePrepared(before, escaped)).toThrow(expect.objectContaining({ code: 'invalid_prepared_context' }));
  });
  test('unknown native window and unknown usage remain unknown in the real account', () => {
    const prefix = stablePrefix('Synthetic instructions.', null);
    const account = accountContext({ route: 'fixture', model: 'undeclared', system: prefix.instructions,
      guidance: [], tools: [], parts: { history: '', files: '', message: '\u754c' }, separatorBytes: 0,
      documents: 0, requestLimitBytes: 200_000, prefix, previousPrefixSha: null, history: null, compaction: null });
    expect(account.window).toEqual({ tokens: null, source: 'not declared' });
    expect(account.estimator).toBe('utf8-bytes/4');
    expect(account.provider).toBeNull();
  });
});

describe('W00 prepare authority, epochs and opaque transcript replay', () => {
  test.each(['scope', 'transcript', 'tools', 'restrictions'] as const)('prepare cannot expand or rewrite %s', kind => {
    const before = { ...request('source'), transcript: OPAQUE_TRANSCRIPT, sourceRestrictions: [STRICT_RESTRICTIONS] };
    const after: ModelRequest = structuredClone(before);
    if (kind === 'scope') after.runId = 'other-tenant-run';
    if (kind === 'transcript') after.transcript = { ...OPAQUE_TRANSCRIPT, opaqueRef: 'replacement' };
    if (kind === 'tools') after.tools.push({ name: 'new_authority', version: '1', description: 'Not offered.', effect: 'read',
      permission: null, approval: false, destination: 'local', trustedInputRequired: false, cost: 0, inputSchema: {} });
    if (kind === 'restrictions') after.sourceRestrictions = [];
    expect(() => validatePrepared(before, after)).toThrow(expect.objectContaining({ code: 'invalid_prepared_context' }));
  });

  test.each(['before-dispatch', 'after-observation'] as const)('host source epoch change at %s refuses replay without rewriting frozen prepare', async point => {
    const root = await directory();
    let now = 1_000, epoch = 1, prepareCalls = 0, calls = 0, validations = 0;
    const runs = new RunService(new FileRunStore(root), { clock: () => now });
    const principal = await start(runs, 'tenant-a', 'epoch-run');
    const model = adapter({
      prepare: async value => { prepareCalls++; return { ...value, messages: [{ role: 'user', text: '[fictional-source epoch=1]' }, ...value.messages] }; },
      validatePrepared: async value => {
        validations++;
        if (epoch !== 1) throw new HarnessError('fixture_source_epoch_changed', 'The fictional source epoch changed.');
        expect(value.messages[0].text).toBe('[fictional-source epoch=1]');
        if (point === 'before-dispatch' && validations === 1) throw new Suspended('event', 'Injected interruption before dispatch.');
      },
      complete: async () => { calls++; return { response: { type: 'final', text: 'Scripted.' }, transcript: OPAQUE_TRANSCRIPT }; },
    });
    if (point === 'after-observation') runs.recordTranscript = async () => { throw new Suspended('event', 'Injected interruption after observation.'); };
    await expect(new NativeAgent(runs, model, new ToolRegistry()).run('epoch-run', 'host', 'Read.', principal)).rejects.toBeInstanceOf(Suspended);
    const before = await runs.get('epoch-run');
    const prepared = before.steps.find(step => step.intent.stepId === 'context:0')!;
    expect(prepared.intent).toMatchObject({ effect: 'pure', cost: 0 });
    epoch = 2;
    now += 120_000;
    const reopened = new RunService(new FileRunStore(root), { clock: () => now });
    await reopened.recover('epoch-run', principal);
    await reopened.claim('epoch-run', 'host', 60_000);
    await expect(new NativeAgent(reopened, model, new ToolRegistry()).run('epoch-run', 'host', 'Read.', principal))
      .rejects.toMatchObject({ code: 'fixture_source_epoch_changed' });
    expect(prepareCalls).toBe(1);
    expect(calls).toBe(point === 'before-dispatch' ? 0 : 1);
    expect((await reopened.get('epoch-run')).steps.find(step => step.intent.stepId === 'context:0')).toEqual(prepared);
    // Epoch policy is deliberately supplied by this host fixture. This does not claim a memory epoch service exists.
  });

  test('repeated opaque references stay outside portable messages; completed steps replay without another call', async () => {
    const runs = new RunService(new FileRunStore(await directory()));
    const tools = new ToolRegistry();
    let toolCalls = 0, prepares = 0;
    tools.register({ name: 'read_fixture', version: '1', description: 'Read fictional content.', effect: 'pure', effectClass: 'pure',
      permission: null, approval: false, destination: 'local', trustedInputRequired: false, cost: 0,
      schema: z.strictObject({}), outputSchema: z.strictObject({ text: z.string() }),
      execute: () => { toolCalls++; return { text: 'Fictional observation.' }; } });
    const principal = await start(runs, 'tenant-a', 'opaque-run', tools);
    const sent: ModelRequest[] = [];
    const model = adapter({ prepare: async value => { prepares++; return value; }, complete: async value => {
      sent.push(structuredClone(value));
      return { transcript: OPAQUE_TRANSCRIPT, response: sent.length < 3
        ? { type: 'tool', name: 'read_fixture', input: {} } : { type: 'final', text: 'Scripted completion.' } };
    } });
    const agent = new NativeAgent(runs, model, tools);
    await agent.run('opaque-run', 'host', 'Read twice.', principal);
    const completed = await runs.get('opaque-run');
    await agent.run('opaque-run', 'host', 'Read twice.', principal);
    expect(sent.map(value => value.transcript)).toEqual([null, OPAQUE_TRANSCRIPT, OPAQUE_TRANSCRIPT]);
    expect(sent.every(value => !JSON.stringify(value.messages).includes(OPAQUE_TRANSCRIPT.opaqueRef))).toBe(true);
    expect(sent).toHaveLength(3);
    expect(prepares).toBe(3);
    expect(toolCalls).toBe(2);
    expect((await runs.get('opaque-run')).steps).toEqual(completed.steps);
    expect(completed.used).toMatchObject({ modelCalls: 3, toolCalls: 2 });
  });

  test('actual NativeAgent refuses a foreign-tenant ancestor before prepare or dispatch', async () => {
    const store = new FileRunStore(await directory());
    const runs = new RunService(store);
    const principalA = await start(runs, 'tenant-a', 'parent-a');
    const principalB = await start(runs, 'tenant-b', 'child-b');
    // Corrupt the stored lineage through its store seam to challenge NativeAgent's independent check.
    const foreign = await runs.get('child-b');
    foreign.parentRunId = 'parent-a';
    await store.write(foreign);
    let calls = 0;
    const model = adapter({ prepare: async value => { calls++; return value; }, complete: async () => {
      calls++; return { response: { type: 'final', text: 'Unexpected.' } };
    } });
    await expect(new NativeAgent(runs, model, new ToolRegistry()).run('child-b', 'host', 'Read.', principalB))
      .rejects.toMatchObject({ code: 'cross_tenant' });
    expect(principalA.tenantId).not.toBe(principalB.tenantId);
    expect(calls).toBe(0);
  });
});
