import { describe, expect, test } from 'vitest';
import type { HarnessRun, StepRecord } from '../shared/harness.js';
import {
  ADAPTER_CAPABILITIES,
  guaranteeSentences,
  needFromWaitingStep,
  presentRun,
} from '../server/harness/index.js';

/**
 * The presentation boundary maps a harness run onto the words the Workbook
 * and the Console already use (TaskState, Task.reason, Session.state) so no
 * new vocabulary reaches a person. The adapter matrix must never promise more
 * than the source proves.
 */

const step = (overrides: Partial<StepRecord> = {}): StepRecord => ({
  intent: {
    stepId: 'tool:0',
    stepVersion: '1',
    kind: 'tool',
    effect: 'non-idempotent',
    input: { to: 'owner@example.test' },
    cost: 1,
    maxAttempts: 3,
    permission: 'send',
    approval: true,
    destination: 'external',
    trustedInputRequired: false,
    label: null,
    policyVersion: 'p1',
  },
  intentHash: 'abc123',
  attempt: 0,
  state: 'waiting_approval',
  output: null,
  outputHash: null,
  leaseFence: 1,
  startedAt: null,
  endedAt: null,
  error: null,
  ...overrides,
});
const run = (overrides: Partial<HarnessRun> = {}): HarnessRun => ({
  v: 1,
  id: 'R1',
  tenantId: 'local',
  projectId: 'P1',
  taskId: 'T1',
  sessionId: null,
  capabilityId: 'fixture',
  capabilityVersion: 'v1',
  policyVersion: 'p1',
  principal: { id: 'w', tenantId: 'local', projectId: 'P1', capabilities: [], identityGeneration: 1 },
  state: 'waiting',
  budget: { units: 10, modelCalls: 5, toolCalls: 5, wallMs: null },
  used: { units: 2, modelCalls: 1, toolCalls: 1 },
  owner: 'host',
  fence: 1,
  leaseExpiresAt: null,
  parentRunId: null,
  forkPoint: null,
  contextRevision: 1,
  transcripts: {},
  result: null,
  failure: null,
  cancelReason: null,
  createdAt: '2026-09-08T11:00:00.000Z',
  updatedAt: '2026-09-08T11:00:01.000Z',
  steps: [step()],
  approvals: [],
  events: [{ v: 1, seq: 1, runId: 'R1', at: '2026-09-08T11:00:00.000Z', type: 'run.created', attributes: {} }],
  lastSeq: 1,
  ...overrides,
});

describe('presenting a harness run in the existing vocabulary', () => {
  test('waiting for approval reads as a task that needs you', () => {
    const shown = presentRun(run());
    expect(shown.taskState).toBe('waiting');
    expect(shown.reason).toBe('needs-ok');
    expect(shown.sessionState).toBe('waiting');
    expect(shown.waiting?.stepId).toBe('tool:0');
    expect(shown.waiting?.intentHash).toBe('abc123');
  });

  test('an uncertain outcome is shown as something went wrong, not as done', () => {
    const shown = presentRun(
      run({ state: 'reconcile_required', steps: [step({ state: 'reconcile_required', attempt: 1 })] }),
    );
    expect(shown.taskState).toBe('waiting');
    expect(shown.reason).toBe('went-wrong');
    expect(shown.uncertain?.stepId).toBe('tool:0');
    expect(shown.sentence).toMatch(/check/i);
  });

  test('completed, failed and cancelled map onto done, failed and stopped', () => {
    expect(presentRun(run({ state: 'completed' })).sessionState).toBe('done');
    expect(presentRun(run({ state: 'completed' })).taskState).toBe('done');
    expect(presentRun(run({ state: 'failed' })).sessionState).toBe('failed');
    expect(presentRun(run({ state: 'failed' })).reason).toBe('went-wrong');
    expect(presentRun(run({ state: 'cancelled' })).sessionState).toBe('stopped');
    expect(presentRun(run({ state: 'running' })).sessionState).toBe('working');
    expect(presentRun(run({ state: 'queued' })).sessionState).toBe('queued');
  });

  test('fork lineage and evidence counts are carried through', () => {
    const shown = presentRun(run({ parentRunId: 'R0', forkPoint: 'tool:0' }));
    expect(shown.lineage).toEqual({ parentRunId: 'R0', forkPoint: 'tool:0' });
    expect(shown.evidence).toEqual({ steps: 1, events: 1, lastSeq: 1 });
  });

  test('a waiting step becomes Need fields the host can create without new words', () => {
    const need = needFromWaitingStep(run(), step());
    expect(need.what).toMatch(/send/);
    expect(need.consequence).toMatch(/outside/i);
    expect(need.files).toEqual([]);
    expect(need.intentHash).toBe('abc123');
    expect(need.why).not.toMatch(/model|token|harness/i);
  });
});

describe('adapter capability matrix', () => {
  test('every adapter labels every guarantee with one of the four words', () => {
    const words = new Set(['enforced', 'observed', 'instructional', 'unsupported']);
    for (const caps of Object.values(ADAPTER_CAPABILITIES))
      for (const key of [
        'modelCalls',
        'toolCalls',
        'filesystemWrites',
        'networkEgress',
        'approvals',
        'resumability',
        'cancellability',
      ] as const)
        expect(words.has(caps[key]), `${caps.engineId}.${key}`).toBe(true);
  });

  test('Codex tool calls and network are observed, never enforced', () => {
    expect(ADAPTER_CAPABILITIES.codex.toolCalls).not.toBe('enforced');
    expect(ADAPTER_CAPABILITIES.codex.networkEgress).not.toBe('enforced');
    expect(ADAPTER_CAPABILITIES['codex-team'].toolCalls).not.toBe('enforced');
    expect(ADAPTER_CAPABILITIES.codex.resumability).toBe('unsupported');
  });

  test('guarantee sentences are plain and name the weakest label', () => {
    const lines = guaranteeSentences(ADAPTER_CAPABILITIES.codex);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).toMatch(/report/i);
    for (const line of lines) expect(line).toMatch(/[.]$/);
  });
});
