/**
 * P04 through the real model-API conversation driver: a turn is offered the Project's playbook
 * index as one read tool, a body loads only when the model asks for it, the load goes through the
 * message's pin (so turning the pack off mid-run does not pull the version it was admitted with),
 * and H18's context account shows the index in the tool definitions and the body only in the
 * tool results of the turn that loaded it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ModelRequest, ModelResult } from '../shared/harness.js';
import type { ContextAccount } from '../shared/context-accounting.js';
import type { TextRequest } from '../server/engines/contract.js';
import { AWS_MODEL_CONTRACT } from '../server/harness/aws-model-adapter.js';
import { ModelSessionRuns, modelApiDispatchAuthorizer, type ModelSessionTurn } from '../server/harness/model-session-run.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { answerInstructions } from '../server/answer-format.js';
import { Store } from '../server/store.js';
import { PackLifecycle } from '../server/pack-lifecycle.js';
import { bundledCatalogue } from '../server/pack-catalogue.js';
import { playbookAccess, PLAYBOOK_TOOL } from '../server/harness/capabilities/pack-playbooks.js';
import { renderSkillPlaybook, SMALL_BUSINESS_PACK } from '../shared/capability-packs.js';

const roots: string[] = [];
const drivers: ModelSessionRuns[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const ACCOUNT_ROUTE = 'aws-bedrock:aws-bedrock-1@r1';
const SB = SMALL_BUSINESS_PACK.id;

type Script = (call: number, request: ModelRequest) => ModelResult['response'] | Promise<ModelResult['response']>;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p04-driver-'));
  roots.push(root);
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  await fs.mkdir(path.join(root, 'cafe'), { recursive: true });
  const project = await store.createProject('Cafe', path.join(root, 'cafe'));
  const packs = new PackLifecycle({ store, root: path.join(store.dataDir, 'packs'), catalogue: () => bundledCatalogue() });

  const services: Record<string, unknown> = { 'aws-bedrock': true, 'aws-bedrockAccountRoute': ACCOUNT_ROUTE };
  const authorize = modelApiDispatchAuthorizer(() => services);
  const runs: RunService = new RunService(new FileRunStore(path.join(root, 'runs')), {
    authorizeEgress: async (runId, intent, _principal, phase) => authorize(await runs.get(runId), intent, phase),
  });
  const driver = new ModelSessionRuns(runs, 'aws-bedrock');
  driver.setSharingPolicy(() => {}, () => true);
  drivers.push(driver);
  const offered: string[][] = [];
  const send = async (
    commandId: string,
    prompt: string,
    script: Script,
    mode: ModelSessionTurn['mode'] = 'follow-up',
  ) => {
    // Admission: the host pins the playbooks from the Project as the message is admitted.
    const access = await playbookAccess(packs.contributions, store.state(project.id), commandId, 'ask');
    const input: TextRequest = {
      projectId: project.id,
      threadId: 't',
      requestId: commandId,
      prompt,
      documents: [],
      instructions: answerInstructions('ask'),
      model: 'us.openai.gpt-5.6-luna',
      accountRoute: ACCOUNT_ROUTE,
      ...access,
    };
    let call = 0;
    return driver.request({
      mode,
      runId: 'conv',
      input,
      admit: async () => ({
        route: 'aws-bedrock',
        connectionId: 'aws-bedrock-1',
        revision: 1,
        model: input.model,
        accountRoute: ACCOUNT_ROUTE,
      }),
      adapter: async (): Promise<ModelAdapter> => ({
        id: 'aws-bedrock',
        version: 'fixture-aws-1',
        contract: AWS_MODEL_CONTRACT,
        destination: 'external',
        capabilities: () => ({
          engineId: 'aws-bedrock',
          engineVersion: 'fixture-aws-1',
          protocolVersion: 'fixture',
          modelCalls: 'enforced',
          toolCalls: 'enforced',
          filesystemWrites: 'unsupported',
          networkEgress: 'observed',
          approvals: 'enforced',
          resumability: 'unsupported',
          cancellability: 'enforced',
          checkpointGranularity: 'step',
          notes: ['Scripted transport for the P04 tests; nothing reaches a provider.'],
        }),
        complete: async (request: ModelRequest): Promise<ModelResult> => {
          if (call === 0) offered.push(request.tools.map((tool) => tool.name));
          const response = await script(call++, request);
          return { response, usage: { inputTokens: 1_000, outputTokens: 30 } };
        },
      }),
    });
  };
  const contextOf = async (commandId: string) => {
    const run = await runs.get('conv');
    const turn = run.steps.find(
      (step) => step.intent.stepId.startsWith('turn:') && (step.intent.input as { requestId?: string }).requestId === commandId,
    )!;
    return (turn.output as { context?: ContextAccount }).context!;
  };
  const bytes = (account: ContextAccount, id: string) => account.sections.find((s) => s.id === id)!.bytes;
  return { store, packs, projectId: project.id, send, offered, contextOf, bytes };
}

const final = (text: string): ModelResult['response'] => ({ type: 'final', text });

describe('pack playbooks on a model-API conversation turn', () => {
  test('index only until the model asks; the body loads through the pin even after the pack is turned off', async () => {
    const { store, packs, projectId, send, offered, contextOf, bytes } = await fixture();

    // Off: nothing offered.
    await send('m-0', 'Hello', () => final('Hi.'), 'start');
    expect(offered[0]).not.toContain(PLAYBOOK_TOOL);

    await packs.activate(projectId, SB);
    // On, and the request does not match a playbook: the index is offered, nothing loads.
    await send('m-1', 'What is on the lunch menu?', () => final('Soup.'));
    expect(offered[1]).toContain(PLAYBOOK_TOOL);
    const indexed = await contextOf('m-1');
    const off = await contextOf('m-0');
    const indexCost = bytes(indexed, 'tools') - bytes(off, 'tools');
    expect(indexCost).toBeGreaterThan(0);
    expect(bytes(indexed, 'tool-results')).toBe(0);
    expect((store.state(projectId).contributionRecords ?? []).filter((r) => r.outcome === 'loaded')).toEqual([]);

    // The request matches Cash flow snapshot. The person turns the pack off while the model is
    // deciding; the message was admitted with it on, so its pin still serves the load.
    const playbook = renderSkillPlaybook(
      SMALL_BUSINESS_PACK.skills.find((s) => s.id === 'cash-flow-snapshot')!,
      SMALL_BUSINESS_PACK.version,
    );
    const answered = await send('m-2', 'Will we have enough cash for the next four weeks?', async (call, request) => {
      if (call === 0) {
        expect(request.tools.find((t) => t.name === PLAYBOOK_TOOL)!.description).toContain(
          'cash-flow-snapshot: Cash flow snapshot.',
        );
        await packs.deactivate(projectId, SB);
        return { type: 'tool', name: PLAYBOOK_TOOL, input: { id: 'cash-flow-snapshot' } };
      }
      const result = JSON.stringify(request.messages.at(-1));
      expect(result).toContain('Playbook: Cash flow snapshot (cash-flow-snapshot, version 0.1.0)');
      return final('Here is the snapshot.');
    });
    expect(answered.response?.text).toContain('Here is the snapshot.');
    const loadedTurn = await contextOf('m-2');
    // The body counts only in the turn that loaded it, as a tool result.
    expect(bytes(loadedTurn, 'tool-results')).toBeGreaterThan(Buffer.byteLength(playbook));
    const records = store.state(projectId).contributionRecords!;
    const load = records.find((r) => r.outcome === 'loaded')!;
    expect(load).toMatchObject({
      packId: SB,
      packVersion: '0.1.0',
      contributionId: 'cash-flow-snapshot',
      reason: 'triggered',
      runKey: 'm-2',
    });
    // The pack was turned off before the load, and the load still came from the pinned version.
    const unloadedAt = records.find((r) => r.outcome === 'unloaded')!.at;
    expect(load.at >= unloadedAt).toBe(true);

    // A message admitted after the pack went off is offered nothing.
    await send('m-3', 'And next month?', () => final('No playbook.'));
    expect(offered.at(-1)).not.toContain(PLAYBOOK_TOOL);
    expect(bytes(await contextOf('m-3'), 'tools')).toBe(bytes(off, 'tools'));

    // Measured on this route: what the index added to one turn, against all twelve bodies.
    const allBodies = SMALL_BUSINESS_PACK.skills.reduce(
      (total, skill) => total + Buffer.byteLength(renderSkillPlaybook(skill, SMALL_BUSINESS_PACK.version)),
      0,
    );
    console.log('P04_TURN_MEASURE', JSON.stringify({ indexToolBytes: indexCost, allBodiesBytes: allBodies, loadedTurnToolResultBytes: bytes(loadedTurn, 'tool-results') }));
    expect(indexCost).toBeLessThan(allBodies / 4);
  });

  test('an unknown id is answered, not loaded, and nothing is recorded', async () => {
    const { store, packs, projectId, send } = await fixture();
    await packs.activate(projectId, SB);
    await send('m-1', 'Help', async (call, request) => {
      if (call === 0) return { type: 'tool', name: PLAYBOOK_TOOL, input: { id: 'launder-money' } };
      expect(JSON.stringify(request.messages.at(-1))).toContain('No playbook has that id');
      return final('Done.');
    }, 'start');
    expect((store.state(projectId).contributionRecords ?? []).map((r) => r.outcome)).toEqual(['indexed']);
  });
});
