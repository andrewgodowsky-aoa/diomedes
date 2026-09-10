import { describe, expect, test } from 'vitest';
import {
  budgetGate,
  entitlementGate,
  liveAuthorityFor,
  resolveExecution,
  trustGate,
} from '../server/execution.js';
import { entitlementFor, NO_ENTITLEMENT_REASON } from '../shared/workspaces.js';
import { denial, type Authority } from '../server/trust/index.js';
import type { AgentResolution } from '../shared/agents.js';

const authority = (over: Partial<Authority> = {}): Authority => ({
  principal: {
    kind: 'local-owner',
    id: 'owner',
    tenantId: 'tenant-a',
    projectId: 'p1',
    deviceId: null,
    sessionId: null,
    slotId: null,
  },
  generation: { identity: 0, principal: 0 },
  assurance: 'owner-local',
  capabilities: new Set(['work.submit', 'project.read']),
  expiresAt: null,
  synthetic: false,
  resolvedAt: '2026-09-10T12:00:00.000Z',
  ...over,
});

const agent: AgentResolution = {
  protocolVersion: 1,
  agentId: 'diomedes.analyst',
  agentVersion: '1.0.0',
  agentName: 'Weekly Operations Analyst',
  agentOrigin: 'built-in',
  agentDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  agentSelection: 'automatic',
  requestedAgentId: null,
  mode: 'ask',
  routeId: 'codex',
  requestedModel: null,
  modelSelection: 'runtime-default',
  compatible: true,
  unmet: [],
  policy: {
    agentCeiling: 'review',
    granted: 'review',
    effective: 'review',
    grantId: null,
    grantsAuthority: false,
  },
  resolvedAt: '2026-09-10T12:00:00.000Z',
};

describe('the entitlement gate', () => {
  test('personal work is not asked to hold an entitlement', () => {
    const result = entitlementGate({
      workspace: { kind: 'personal' },
      entitlement: entitlementFor('org-1'),
      needsManagedInference: false,
    });
    expect(result.required).toBe(false);
    expect(result.verdict).toBe('not-required');
  });

  test('managed inference is refused honestly, because no entitlement service exists', () => {
    const result = entitlementGate({
      workspace: { kind: 'business', organizationId: 'org-1' },
      entitlement: entitlementFor('org-1'),
      needsManagedInference: true,
    });
    expect(result.verdict).toBe('refused');
    expect(result.reason).toBe(NO_ENTITLEMENT_REASON);
  });

  test('business work that pays for itself does not need an entitlement', () => {
    const result = entitlementGate({
      workspace: { kind: 'business', organizationId: 'org-1' },
      entitlement: entitlementFor('org-1'),
      needsManagedInference: false,
    });
    expect(result.verdict).toBe('not-required');
    expect(result.answered).toContain('entitlement');
  });
});

describe('the trust gate', () => {
  test('a capability the principal holds passes', () => {
    const result = trustGate({ authority: authority(), required: 'work.submit' });
    expect(result.verdict).toBe('passed');
  });

  test('a capability the principal does not hold is refused with Trust wording', () => {
    const result = trustGate({ authority: authority(), required: 'write.apply' });
    expect(result.verdict).toBe('refused');
    expect(result.reason.length).toBeGreaterThan(10);
  });

  test('a denial is carried through rather than reinterpreted', () => {
    const result = trustGate({
      authority: denial(403, 'revoked', 'This device was removed.'),
      required: 'work.submit',
    });
    expect(result.verdict).toBe('refused');
    expect(result.reason).toBe('This device was removed.');
  });

  test('the trust gate answers about action and data only', () => {
    expect(trustGate({ authority: authority(), required: 'work.submit' }).answered).not.toContain(
      'pay',
    );
  });
});

describe('the budget gate', () => {
  test('work nobody is billed for passes without a reservation', () => {
    const result = budgetGate({
      payer: { kind: 'local-machine', id: null, coversChildren: true, reason: 'On your machine.' },
      harnessBudget: { units: 100, modelCalls: 4, toolCalls: 8, wallMs: null },
      entitlement: entitlementFor('org-1'),
    });
    expect(result.verdict).toBe('passed');
  });

  test('company-funded inference is refused, because nothing accounts for spend here', () => {
    const result = budgetGate({
      payer: {
        kind: 'organization',
        id: 'org-1',
        coversChildren: true,
        reason: 'The business pays.',
      },
      harnessBudget: { units: 100, modelCalls: 4, toolCalls: 8, wallMs: null },
      entitlement: entitlementFor('org-1'),
    });
    expect(result.verdict).toBe('refused');
    expect(result.reason).toContain('allowance');
  });

  test('an account the person brought is their own spend, and passes', () => {
    const result = budgetGate({
      payer: {
        kind: 'bring-your-own',
        id: 'org-1',
        coversChildren: true,
        reason: 'Your own account.',
      },
      harnessBudget: { units: 100, modelCalls: 4, toolCalls: 8, wallMs: null },
      entitlement: entitlementFor('org-1'),
    });
    expect(result.verdict).toBe('passed');
    expect(result.answered).toContain('account');
  });

  test('a run with no budget at all is refused rather than assumed unlimited', () => {
    const result = budgetGate({
      payer: { kind: 'person', id: null, coversChildren: true, reason: 'Your own account.' },
      harnessBudget: null,
      entitlement: entitlementFor('org-1'),
    });
    expect(result.verdict).toBe('refused');
  });

  test('a budget with no model calls left is refused', () => {
    const result = budgetGate({
      payer: { kind: 'person', id: null, coversChildren: true, reason: 'Your own account.' },
      harnessBudget: { units: 100, modelCalls: 0, toolCalls: 8, wallMs: null },
      entitlement: entitlementFor('org-1'),
    });
    expect(result.verdict).toBe('refused');
  });
});

describe('resolving one admitted unit', () => {
  const resolve = (over: Partial<Parameters<typeof resolveExecution>[0]> = {}) =>
    resolveExecution({
      principal: authority(),
      workspace: { kind: 'business', organizationId: 'org-1' },
      membership: { role: 'owner', state: 'active' },
      configuration: { organizationId: 'org-1', revision: 3, digest: 'sha256:cfg' },
      entitlement: entitlementFor('org-1'),
      agent,
      team: null,
      rules: { revision: 'r1-abc', governing: [] },
      context: { scopeIds: ['approved-files'], instructionRevision: 'r1-def' },
      harnessBudget: { units: 100, modelCalls: 4, toolCalls: 8, wallMs: null },
      requiredCapability: 'work.submit',
      needsManagedInference: false,
      at: '2026-09-10T12:00:00.000Z',
      ...over,
    });

  test('the resolution binds person, business, setup, worker, route, rules and payer', () => {
    const resolved = resolve();
    expect(resolved.principal.id).toBe('owner');
    expect(resolved.workspace).toEqual({ kind: 'business', organizationId: 'org-1' });
    expect(resolved.configuration?.revision).toBe(3);
    expect(resolved.agent.agentId).toBe('diomedes.analyst');
    expect(resolved.route.routeId).toBe('codex');
    expect(resolved.rules.revision).toBe('r1-abc');
    expect(resolved.payer.kind).toBe('bring-your-own');
  });

  test('all three gates are recorded, whether or not they refused', () => {
    expect(resolve().gates.map((gate) => gate.gate)).toEqual(['entitlement', 'trust', 'budget']);
  });

  test('an admitted unit needs every required gate', () => {
    expect(resolve().admitted).toBe(true);
    expect(resolve({ requiredCapability: 'write.apply' }).admitted).toBe(false);
  });

  test('asking for company-funded inference fails the entitlement gate, not the trust gate', () => {
    const resolved = resolve({ needsManagedInference: true });
    expect(resolved.admitted).toBe(false);
    expect(resolved.gates.find((gate) => gate.gate === 'entitlement')!.verdict).toBe('refused');
    expect(resolved.gates.find((gate) => gate.gate === 'trust')!.verdict).toBe('passed');
  });

  test('a revoked principal never resolves as admitted', () => {
    const resolved = resolve({
      principal: denial(403, 'revoked', 'Your access to this business was removed.'),
    });
    expect(resolved.admitted).toBe(false);
    expect(resolved.principal.id).toBe('unknown');
  });

  test('the effective permission recorded is the narrower of Agent and grant', () => {
    expect(resolve().agent.effectivePermission).toBe('review');
  });
});

describe('gathering what is true now', () => {
  test('live values come from the current registries, not from the snapshot', () => {
    const live = liveAuthorityFor({
      authority: authority({ generation: { identity: 1, principal: 0 } }),
      mintedGeneration: { identity: 0, principal: 0 },
      membershipState: 'active',
      activeConfigurationRevision: 3,
      currentAgentDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      grantRevoked: false,
      routeId: 'codex',
      budgetRemainingUsd: null,
    });
    expect(live.generationAdvanced).toBe(true);
    expect(live.tenantId).toBe('tenant-a');
    expect(live.revocationProven).toBe(true);
  });

  test('a route whose revocation is unmeasured says so rather than claiming it', () => {
    const live = liveAuthorityFor({
      authority: authority(),
      mintedGeneration: { identity: 0, principal: 0 },
      membershipState: 'active',
      activeConfigurationRevision: null,
      currentAgentDigest: null,
      grantRevoked: false,
      routeId: 'opencode',
      budgetRemainingUsd: null,
    });
    expect(live.revocationProven).toBe(false);
  });

  test('a denied re-resolution reads as an advanced generation, not as a pass', () => {
    const live = liveAuthorityFor({
      authority: denial(409, 'generation-advanced', 'Access was reissued.'),
      mintedGeneration: { identity: 0, principal: 0 },
      membershipState: 'active',
      activeConfigurationRevision: null,
      currentAgentDigest: null,
      grantRevoked: false,
      routeId: 'codex',
      budgetRemainingUsd: null,
    });
    expect(live.generationAdvanced).toBe(true);
  });
});
