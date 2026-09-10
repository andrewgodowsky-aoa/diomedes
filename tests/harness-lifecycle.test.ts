import { describe, expect, test } from 'vitest';
import {
  CORRECTION_LIMITS,
  SURFACE_FOR_STEP,
  correctionCandidate,
  correctionWithinBounds,
  governanceHook,
  observationEvidence,
  validateEffect,
} from '../server/harness/lifecycle.js';
import type { ExecutionResolution, LiveAuthority } from '../shared/execution.js';
import type { StepIntent, HarnessPrincipal } from '../shared/harness.js';

const resolution = (over: Partial<ExecutionResolution> = {}): ExecutionResolution => ({
  v: 1,
  resolvedAt: '2026-09-10T12:00:00.000Z',
  principal: { kind: 'local-owner', id: 'owner', tenantId: 'tenant-a', assurance: 'owner-local' },
  workspace: { kind: 'business', organizationId: 'org-1' },
  membership: { role: 'owner', state: 'active' },
  configuration: { organizationId: 'org-1', revision: 3, digest: 'sha256:cfg' },
  agent: {
    agentId: 'diomedes.builder',
    agentVersion: '1.0.0',
    agentDigest: 'sha256:agent',
    agentName: 'Change Builder',
    agentSelection: 'manual',
    effectivePermission: 'project',
  },
  team: null,
  route: { routeId: 'codex', requestedModel: null, modelSelection: 'runtime-default' },
  rules: { revision: 'r1-abc', governing: [] },
  context: { scopeIds: ['approved-files'], instructionRevision: 'r1-def' },
  payer: { kind: 'bring-your-own', id: 'org-1', coversChildren: true, reason: 'Your account.' },
  budget: null,
  gates: [],
  admitted: true,
  ...over,
});

const live = (over: Partial<LiveAuthority> = {}): LiveAuthority => ({
  tenantId: 'tenant-a',
  membershipState: 'active',
  configurationRevision: 3,
  agentDigest: 'sha256:agent',
  grantRevoked: false,
  generationAdvanced: false,
  budgetRemainingUsd: 10,
  revocationProven: true,
  ...over,
});

const intent = (over: Partial<StepIntent> = {}): StepIntent => ({
  stepId: 'write-brief',
  stepVersion: '1',
  kind: 'tool',
  effect: 'idempotent',
  name: 'format-report',
  input: null,
  cost: 1,
  maxAttempts: 1,
  permission: 'write.apply',
  approval: true,
  destination: 'local',
  trustedInputRequired: true,
  label: null,
  policyVersion: 'diomedes-host-policy-v1',
  ...over,
});

const principal: HarnessPrincipal = {
  id: 'owner',
  tenantId: 'tenant-a',
  projectId: 'p1',
  capabilities: ['write.apply'],
  identityGeneration: 0,
};

describe('the lifecycle surfaces', () => {
  test('each harness step kind maps onto a named surface', () => {
    expect(SURFACE_FOR_STEP.model).toBe('before-model');
    expect(SURFACE_FOR_STEP.tool).toBe('before-tool');
    expect(SURFACE_FOR_STEP.approval).toBe('before-effect');
  });

  test('the hook records what governed without changing the intent it was given', async () => {
    const recorded: unknown[] = [];
    const hook = governanceHook({
      resolution: resolution(),
      live: async () => live(),
      record: (entry) => recorded.push(entry),
    });
    const given = intent();
    await hook({ runId: 'run-1', step: given, principal });
    expect(recorded).toHaveLength(1);
    expect(given).toEqual(intent());
  });

  test('the hook refuses a step whose authority moved since the work started', async () => {
    const hook = governanceHook({
      resolution: resolution(),
      live: async () => live({ grantRevoked: true }),
      record: () => {},
    });
    await expect(
      hook({ runId: 'run-1', step: intent({ effect: 'non-idempotent' }), principal }),
    ).rejects.toThrow(/withdrawn/);
  });

  test('a read step is not stopped by a recheck it does not need', async () => {
    const hook = governanceHook({
      resolution: resolution(),
      live: async () => live({ grantRevoked: true }),
      record: () => {},
    });
    await expect(
      hook({ runId: 'run-1', step: intent({ effect: 'read' }), principal }),
    ).resolves.toBeUndefined();
  });
});

describe('before an effect', () => {
  const request = (over: Partial<Parameters<typeof validateEffect>[0]> = {}) => ({
    operation: 'text.modify' as const,
    paths: ['notes/weekly.md'],
    routeId: 'codex',
    expectedBaseDigest: 'sha256:base',
    actualBaseDigest: 'sha256:base',
    authorization: { kind: 'scope-grant' as const, id: 'grant-1' },
    ...over,
  });

  test('a canonical, granted, in-route change on the expected base is allowed', () => {
    expect(validateEffect(request(), resolution(), live()).ok).toBe(true);
  });

  test('a path the writer would never produce is refused', () => {
    const answer = validateEffect(request({ paths: ['../secrets.md'] }), resolution(), live());
    expect(answer.ok).toBe(false);
    expect(answer.refusals[0]).toContain('canonical');
  });

  test('an effect with nothing authorizing it is refused', () => {
    const answer = validateEffect(request({ authorization: null }), resolution(), live());
    expect(answer.ok).toBe(false);
  });

  test('an effect on a different route than the one resolved is refused', () => {
    const answer = validateEffect(request({ routeId: 'opencode' }), resolution(), live());
    expect(answer.ok).toBe(false);
    expect(answer.refusals.join(' ')).toContain('codex');
  });

  test('a base that changed under the proposal is refused', () => {
    const answer = validateEffect(
      request({ actualBaseDigest: 'sha256:moved' }),
      resolution(),
      live(),
    );
    expect(answer.ok).toBe(false);
    expect(answer.refusals.join(' ')).toContain('changed');
  });

  test('a standing scope cannot write for an Agent that works under review', () => {
    const answer = validateEffect(
      request(),
      resolution({ agent: { ...resolution().agent, effectivePermission: 'review' } }),
      live(),
    );
    expect(answer.ok).toBe(false);
    expect(answer.refusals.join(' ')).toContain('standing permission');
  });

  test('an exact approval still writes for an Agent that works under review', () => {
    const answer = validateEffect(
      request({ authorization: { kind: 'exact-approval', id: 'receipt-1' } }),
      resolution({ agent: { ...resolution().agent, effectivePermission: 'review' } }),
      live(),
    );
    expect(answer.ok).toBe(true);
  });

  test('every refusal is reported, not only the first', () => {
    const answer = validateEffect(
      request({ authorization: null, routeId: 'opencode' }),
      resolution(),
      live(),
    );
    expect(answer.refusals.length).toBeGreaterThan(1);
  });
});

describe('after an observation', () => {
  test('the evidence handed on names the attempt, the rules and the failure', () => {
    const evidence = observationEvidence({
      resolution: resolution(),
      runId: 'run-1',
      stepId: 'write-brief',
      attempt: 1,
      outcome: 'refused',
      refusals: ['This work has no permission to change files.'],
      observedTool: 'format-report',
      observedPaths: ['notes/weekly.md'],
    });
    expect(evidence.tenantId).toBe('tenant-a');
    expect(evidence.configurationRevision).toBe(3);
    expect(evidence.agentId).toBe('diomedes.builder');
    expect(evidence.rulesRevision).toBe('r1-abc');
    expect(evidence.payerKind).toBe('bring-your-own');
    expect(evidence.attempt).toBe(1);
    expect(evidence.outcome).toBe('refused');
  });

  test('the evidence carries no reasoning, no secret and no customer content', () => {
    const evidence = observationEvidence({
      resolution: resolution(),
      runId: 'run-1',
      stepId: 'write-brief',
      attempt: 1,
      outcome: 'failed',
      refusals: [],
      observedTool: 'format-report',
      observedPaths: ['clients/acme-invoice.md'],
    });
    const keys = Object.keys(evidence);
    expect(keys).not.toContain('reasoning');
    expect(keys).not.toContain('transcript');
    expect(keys).not.toContain('content');
    // Paths are counted, never listed: a filename can name a customer.
    expect(JSON.stringify(evidence)).not.toContain('acme');
    expect(evidence.pathCount).toBe(1);
  });
});

describe('what a correction may do', () => {
  test('a correction may change the attempt', () => {
    const answer = correctionWithinBounds({
      attempt: 1,
      changes: [
        { target: 'attempt', what: 'Narrow the selection to the files that were approved.' },
      ],
    });
    expect(answer.allowed).toBe(true);
  });

  test('a correction may not edit an Agent definition', () => {
    const answer = correctionWithinBounds({
      attempt: 1,
      changes: [{ target: 'agent-definition', what: 'Raise the ceiling to full access.' }],
    });
    expect(answer.allowed).toBe(false);
    expect(answer.reason).toContain('reviewed');
  });

  test('a correction may not edit a business rule', () => {
    expect(
      correctionWithinBounds({
        attempt: 1,
        changes: [{ target: 'business-rule', what: 'Remove the external-write policy.' }],
      }).allowed,
    ).toBe(false);
  });

  test('correction attempts are bounded', () => {
    expect(CORRECTION_LIMITS.maxAttempts).toBeGreaterThan(0);
    const answer = correctionWithinBounds({
      attempt: CORRECTION_LIMITS.maxAttempts,
      changes: [{ target: 'attempt', what: 'Try once more.' }],
    });
    expect(answer.allowed).toBe(false);
    expect(answer.reason).toContain('tried');
  });

  test('persistent failure produces a candidate for review, never an activation', () => {
    const failures = Array.from({ length: CORRECTION_LIMITS.candidateAfter }, () => ({
      stepId: 'write-brief',
      outcome: 'refused' as const,
      refusals: ['This work has no permission to change files.'],
    }));
    const candidate = correctionCandidate(resolution(), failures);
    expect(candidate).not.toBe(null);
    expect(candidate!.state).toBe('needs-review');
    expect(candidate!.activated).toBe(false);
    expect(candidate!.basedOnRevision).toBe(3);
  });

  test('one failure does not propose a configuration change', () => {
    expect(
      correctionCandidate(resolution(), [
        { stepId: 'write-brief', outcome: 'refused', refusals: ['No permission.'] },
      ]),
    ).toBe(null);
  });

  test('a candidate says what a person would be agreeing to, without rewriting anything', () => {
    const failures = Array.from({ length: CORRECTION_LIMITS.candidateAfter }, () => ({
      stepId: 'write-brief',
      outcome: 'refused' as const,
      refusals: ['This work has no permission to change files.'],
    }));
    const candidate = correctionCandidate(resolution(), failures)!;
    expect(candidate.summary.length).toBeGreaterThan(20);
    expect(candidate.summary).not.toContain('automatically');
  });
});
