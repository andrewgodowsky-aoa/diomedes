import { describe, expect, test } from 'vitest';
import {
  GATES,
  admit,
  chooseFallback,
  evidenceFor,
  payerFor,
  plainSummary,
  recheckAtEffect,
  telemetryOf,
  type ExecutionResolution,
  type GateResult,
  type LiveAuthority,
} from '../shared/execution.js';

const gate = (over: Partial<GateResult> & Pick<GateResult, 'gate'>): GateResult => ({
  verdict: 'passed',
  required: true,
  reason: 'Fine.',
  answered: 'Something.',
  ...over,
});

const resolution = (over: Partial<ExecutionResolution> = {}): ExecutionResolution => ({
  v: 1,
  resolvedAt: '2026-09-10T12:00:00.000Z',
  principal: { kind: 'local-owner', id: 'owner', tenantId: 'tenant-a', assurance: 'owner-local' },
  workspace: { kind: 'business', organizationId: 'org-1' },
  membership: { role: 'owner', state: 'active' },
  configuration: { organizationId: 'org-1', revision: 3, digest: 'sha256:abc' },
  agent: {
    agentId: 'diomedes.analyst',
    agentVersion: '1.0.0',
    agentDigest: 'sha256:agent',
    agentName: 'Weekly Operations Analyst',
    agentSelection: 'automatic',
    effectivePermission: 'review',
  },
  team: null,
  route: { routeId: 'codex', requestedModel: null, modelSelection: 'runtime-default' },
  rules: { revision: 'r1-0000', governing: [] },
  context: { scopeIds: ['approved-files'], instructionRevision: 'r1-1111' },
  payer: {
    kind: 'organization',
    id: 'org-1',
    coversChildren: true,
    reason: 'The business pays for this work.',
  },
  budget: { reservationId: 'res-1', reservedUsd: 0.4, capUsd: 25 },
  gates: [gate({ gate: 'entitlement' }), gate({ gate: 'trust' }), gate({ gate: 'budget' })],
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
  budgetRemainingUsd: 20,
  revocationProven: true,
  ...over,
});

describe('three gates', () => {
  test('the gates are separate and all required ones must pass', () => {
    expect(GATES).toEqual(['entitlement', 'trust', 'budget']);
    expect(
      admit([gate({ gate: 'entitlement' }), gate({ gate: 'trust' }), gate({ gate: 'budget' })])
        .admitted,
    ).toBe(true);
  });

  test('a business badge does not authorize a write', () => {
    const verdict = admit([
      gate({ gate: 'entitlement', answered: 'This organization has the feature.' }),
      gate({
        gate: 'trust',
        verdict: 'refused',
        reason: 'No one has approved a change to this project.',
      }),
      gate({ gate: 'budget' }),
    ]);
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusedBy).toEqual(['trust']);
    expect(verdict.reason).toContain('No one has approved');
  });

  test('write approval does not authorize company-funded inference', () => {
    const verdict = admit([
      gate({ gate: 'entitlement' }),
      gate({ gate: 'trust', answered: 'A person approved this exact change.' }),
      gate({
        gate: 'budget',
        verdict: 'refused',
        reason: 'This business has no allowance for paid model work.',
      }),
    ]);
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusedBy).toEqual(['budget']);
  });

  test('a missing gate is a refusal, not a pass', () => {
    expect(admit([gate({ gate: 'trust' })]).admitted).toBe(false);
    expect(admit([gate({ gate: 'trust' })]).refusedBy).toEqual(['entitlement', 'budget']);
  });

  test('a gate that is genuinely not required does not block', () => {
    const verdict = admit([
      gate({
        gate: 'entitlement',
        verdict: 'not-required',
        required: false,
        reason: 'Personal work.',
      }),
      gate({ gate: 'trust' }),
      gate({
        gate: 'budget',
        verdict: 'not-required',
        required: false,
        reason: 'Nothing is charged.',
      }),
    ]);
    expect(verdict.admitted).toBe(true);
  });

  test('every refusal is reported, not only the first', () => {
    const verdict = admit([
      gate({ gate: 'entitlement', verdict: 'refused', reason: 'No plan.' }),
      gate({ gate: 'trust', verdict: 'refused', reason: 'No approval.' }),
      gate({ gate: 'budget' }),
    ]);
    expect(verdict.refusedBy).toEqual(['entitlement', 'trust']);
  });
});

describe('who pays', () => {
  test('business work on a paid route is paid by the organization, and covers children', () => {
    const payer = payerFor({
      routeId: 'codex',
      workspace: { kind: 'business', organizationId: 'org-1' },
      managedInference: true,
    });
    expect(payer.kind).toBe('organization');
    expect(payer.coversChildren).toBe(true);
  });

  test('a personal workspace is never billed to an organization', () => {
    expect(
      payerFor({ routeId: 'codex', workspace: { kind: 'personal' }, managedInference: false }).kind,
    ).toBe('person');
  });

  test('a route that runs on this machine is paid by the machine', () => {
    const payer = payerFor({
      routeId: 'sample',
      workspace: { kind: 'business', organizationId: 'org-1' },
      managedInference: true,
    });
    expect(payer.kind).toBe('local-machine');
    expect(payer.reason).toContain('machine');
  });

  test('an account the person brought is paid by them, whatever the workspace says', () => {
    const payer = payerFor({
      routeId: 'claude-code',
      workspace: { kind: 'business', organizationId: 'org-1' },
      managedInference: false,
    });
    expect(payer.kind).toBe('bring-your-own');
    expect(payer.coversChildren).toBe(true);
  });
});

describe('fallback', () => {
  test('a local-only job never becomes cloud-backed after an outage', () => {
    const chosen = chooseFallback({
      from: 'sample',
      candidates: ['codex', 'claude-code'],
      processing: 'local-only',
      remoteRoutes: new Set(['codex', 'claude-code']),
      budgetRemainingUsd: 100,
      fallbackAllowed: true,
      capable: () => true,
    });
    expect(chosen.routeId).toBe(null);
    expect(chosen.reason).toContain('stay on this computer');
  });

  test('a fallback that cannot do the work is not chosen', () => {
    const chosen = chooseFallback({
      from: 'codex',
      candidates: ['claude-code', 'opencode'],
      processing: 'may-leave',
      remoteRoutes: new Set(['codex', 'claude-code', 'opencode']),
      budgetRemainingUsd: 100,
      fallbackAllowed: true,
      capable: (routeId) => routeId === 'opencode',
    });
    expect(chosen.routeId).toBe('opencode');
  });

  test('a fallback is not chosen when there is no allowance left', () => {
    const chosen = chooseFallback({
      from: 'codex',
      candidates: ['claude-code'],
      processing: 'may-leave',
      remoteRoutes: new Set(['codex', 'claude-code']),
      budgetRemainingUsd: 0,
      fallbackAllowed: true,
      capable: () => true,
    });
    expect(chosen.routeId).toBe(null);
    expect(chosen.reason).toContain('allowance');
  });

  test('a setup that forbids fallback is honoured', () => {
    const chosen = chooseFallback({
      from: 'codex',
      candidates: ['claude-code'],
      processing: 'may-leave',
      remoteRoutes: new Set(['codex', 'claude-code']),
      budgetRemainingUsd: 100,
      fallbackAllowed: false,
      capable: () => true,
    });
    expect(chosen.routeId).toBe(null);
  });
});

describe('rechecking at the effect boundary', () => {
  test('an unchanged world lets the effect through', () => {
    expect(recheckAtEffect(resolution(), live()).ok).toBe(true);
  });

  test('an old snapshot cannot revive a revoked grant', () => {
    const result = recheckAtEffect(resolution(), live({ grantRevoked: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('withdrawn');
  });

  test('a revoked membership stops the effect even though the run started as a member', () => {
    const result = recheckAtEffect(resolution(), live({ membershipState: 'revoked' }));
    expect(result.ok).toBe(false);
    expect(result.changed.some((item) => item.what === 'membership')).toBe(true);
  });

  test('an advanced generation stops the effect', () => {
    expect(recheckAtEffect(resolution(), live({ generationAdvanced: true })).ok).toBe(false);
  });

  test('a setup activated mid-run stops the effect rather than redirecting it', () => {
    const result = recheckAtEffect(resolution(), live({ configurationRevision: 4 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('setup');
  });

  test('an Agent definition edited mid-run stops the effect', () => {
    expect(recheckAtEffect(resolution(), live({ agentDigest: 'sha256:other' })).ok).toBe(false);
  });

  test('an exhausted allowance stops the effect', () => {
    expect(recheckAtEffect(resolution(), live({ budgetRemainingUsd: 0 })).ok).toBe(false);
  });

  test('a route that cannot prove revocation is noted, not silently trusted', () => {
    const result = recheckAtEffect(resolution(), live({ revocationProven: false }));
    expect(result.ok).toBe(true);
    const note = result.changed.find((item) => item.what === 'revocation-proof')!;
    expect(note.effect).toBe('noted');
  });

  test('the historical resolution is never rewritten by a recheck', () => {
    const original = resolution();
    const snapshot = JSON.stringify(original);
    recheckAtEffect(original, live({ grantRevoked: true, configurationRevision: 9 }));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test('every stopping change is reported, not only the first', () => {
    const result = recheckAtEffect(
      resolution(),
      live({ grantRevoked: true, membershipState: 'revoked' }),
    );
    expect(result.changed.filter((item) => item.effect === 'stops').length).toBeGreaterThan(1);
  });
});

describe('evidence', () => {
  test('everything the contract requires is inspectable', () => {
    const view = evidenceFor(resolution(), {
      runtimeModel: 'gpt-5-codex',
      runtimeEngine: 'codex',
      proposer: 'diomedes.analyst',
      reviewer: null,
      writer: 'diomedes.store',
      verifier: null,
      effect: 'Wrote notes/weekly.md',
      verification: null,
    });
    expect(view.person.known).toBe(true);
    expect(view.organization.known).toBe(true);
    expect(view.agent.known).toBe(true);
    expect(view.model.known).toBe(true);
    expect(view.configuration.known).toBe(true);
    expect(view.payer.known).toBe(true);
    expect(view.effect.known).toBe(true);
  });

  test('unknown stays unknown and is never filled in from a neighbour', () => {
    const view = evidenceFor(resolution(), {
      runtimeModel: null,
      runtimeEngine: null,
      proposer: 'diomedes.analyst',
      reviewer: null,
      writer: null,
      verifier: null,
      effect: null,
      verification: null,
    });
    expect(view.model.known).toBe(false);
    expect(view.roles.reviewer.known).toBe(false);
    expect(view.roles.writer.known).toBe(false);
    expect(view.roles.verifier.known).toBe(false);
    expect(view.roles.proposer.known).toBe(true);
    if (!view.model.known) expect(view.model.why.length).toBeGreaterThan(10);
  });

  test('the four roles stay distinct', () => {
    const view = evidenceFor(resolution(), {
      runtimeModel: 'gpt-5-codex',
      runtimeEngine: 'codex',
      proposer: 'diomedes.builder',
      reviewer: 'diomedes.reviewer',
      writer: 'diomedes.store',
      verifier: 'diomedes.store',
      effect: 'Wrote notes/weekly.md',
      verification: 'Digest matched.',
    });
    const named = [view.roles.proposer, view.roles.reviewer, view.roles.writer];
    const values = named.map((item) => (item.known ? item.value : null));
    expect(new Set(values).size).toBe(3);
  });

  test('an automatic choice is recorded as automatic', () => {
    const view = evidenceFor(resolution(), {
      runtimeModel: 'gpt-5-codex',
      runtimeEngine: 'codex',
      proposer: null,
      reviewer: null,
      writer: null,
      verifier: null,
      effect: null,
      verification: null,
    });
    expect(view.choice.agent).toBe('automatic');
    expect(view.choice.model).toBe('runtime-default');
  });
});

describe('telemetry', () => {
  test('generic telemetry carries identifiers and counts, never content', () => {
    const view = evidenceFor(
      resolution({
        context: { scopeIds: ['approved-files'], instructionRevision: 'r1-1111' },
      }),
      {
        runtimeModel: 'gpt-5-codex',
        runtimeEngine: 'codex',
        proposer: 'diomedes.analyst',
        reviewer: null,
        writer: 'diomedes.store',
        verifier: null,
        effect: 'Wrote notes/2026-09-10-acme-invoice.md for Acme Ltd',
        verification: 'Digest matched.',
      },
    );
    const wire = JSON.stringify(telemetryOf(view));
    expect(wire).not.toContain('Acme');
    expect(wire).not.toContain('invoice');
    expect(wire).toContain('diomedes.analyst');
    expect(wire).toContain('codex');
  });
});

describe('the ordinary view', () => {
  test('a person sees the business, the job, the state, the approval and the allowance', () => {
    const summary = plainSummary(resolution(), { job: 'Weekly brief', state: 'waiting' });
    expect(summary.business).toContain('org-1');
    expect(summary.job).toBe('Weekly brief');
    expect(summary.state).toBe('waiting');
    expect(summary.approval.length).toBeGreaterThan(10);
    expect(summary.allowance).toContain('25');
  });

  test('an allowance nobody set is said plainly rather than shown as zero', () => {
    const summary = plainSummary(resolution({ budget: null }), {
      job: 'Weekly brief',
      state: 'idle',
    });
    expect(summary.allowance).not.toContain('0');
    expect(summary.allowance.length).toBeGreaterThan(10);
  });

  test('personal work does not claim a business', () => {
    const summary = plainSummary(
      resolution({ workspace: { kind: 'personal' }, membership: null, configuration: null }),
      { job: 'Notes', state: 'idle' },
    );
    expect(summary.business).toBe('Personal');
  });
});
