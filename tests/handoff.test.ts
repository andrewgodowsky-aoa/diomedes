import { describe, expect, test } from 'vitest';
import {
  MAX_CHILDREN_PER_HANDOFF,
  MAX_DELEGATION_DEPTH,
  acceptHandoff,
  admissionOrder,
  modelPin,
  openHandoff,
  reconcileAfterReplay,
  type HandoffEnvelope,
} from '../shared/handoff.js';
import type { Payer } from '../shared/execution.js';

const payer: Payer = {
  kind: 'organization',
  id: 'org-1',
  coversChildren: true,
  reason: 'The business pays for this work.',
};

const parent = {
  agentId: 'diomedes.builder',
  agentVersion: '1.0.0',
  agentDigest: 'sha256:builder',
  produces: ['proposal.text'] as const,
};
const child = {
  agentId: 'diomedes.reviewer',
  agentVersion: '1.0.0',
  agentDigest: 'sha256:reviewer',
  accepts: ['proposal.text'] as const,
};

const open = (over: Partial<Parameters<typeof openHandoff>[0]> = {}) =>
  openHandoff({
    id: 'handoff-1',
    tenantId: 'tenant-a',
    from: parent,
    to: child,
    artifact: 'proposal.text',
    parentWork: { runId: 'run-1', taskId: 'task-1', summary: 'Draft the weekly brief.' },
    evidence: [{ id: 'e1', artifact: 'proposal.text', summary: 'One file changed.' }],
    unresolved: [
      {
        kind: 'missing-connection',
        what: 'The accounting export is not connected.',
        next: 'Connect it, or continue from the files you selected.',
        blocking: false,
      },
    ],
    depth: 0,
    siblings: 0,
    payer,
    requiredAuthority: ['project.read'],
    createdAt: '2026-09-10T12:00:00.000Z',
    ...over,
  });

describe('opening a handoff', () => {
  test('a handoff names versioned Agent identities on both sides', () => {
    const result = open();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.from.agentVersion).toBe('1.0.0');
    expect(result.envelope.to.agentDigest).toBe('sha256:reviewer');
  });

  test('it carries the parent work, the scoped evidence and what is unresolved', () => {
    const result = open();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.parentWork.runId).toBe('run-1');
    expect(result.envelope.evidence).toHaveLength(1);
    expect(result.envelope.unresolved).toHaveLength(1);
  });

  test('an artifact the parent does not produce is refused', () => {
    const result = open({ artifact: 'review.verdict' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('diomedes.builder');
  });

  test('an artifact the child does not accept is refused', () => {
    const result = open({
      from: { ...parent, produces: ['report.markdown'] },
      artifact: 'report.markdown',
    });
    expect(result.ok).toBe(false);
  });

  test('delegation is bounded', () => {
    expect(open({ depth: MAX_DELEGATION_DEPTH - 1 }).ok).toBe(true);
    const tooDeep = open({ depth: MAX_DELEGATION_DEPTH });
    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) return;
    expect(tooDeep.reason).toContain('far enough');
  });

  test('the number of children at one step is bounded', () => {
    expect(open({ siblings: MAX_CHILDREN_PER_HANDOFF }).ok).toBe(false);
  });

  test('the payer is inherited, never replaced', () => {
    const result = open();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.payer).toEqual(payer);
  });

  test('a handoff without a tenant is still bound to that absence', () => {
    const result = open({ tenantId: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.tenantId).toBe(null);
  });
});

describe('accepting a handoff', () => {
  const envelope = (): HandoffEnvelope => {
    const result = open();
    if (!result.ok) throw new Error(result.reason);
    return result.envelope;
  };

  test('a child that holds what it needs may start', () => {
    const answer = acceptHandoff(envelope(), {
      tenantId: 'tenant-a',
      capabilities: ['project.read'],
      membershipState: 'active',
      grantRevoked: false,
    });
    expect(answer.ok).toBe(true);
  });

  test('being on the team is not permission — the child rechecks its own authority', () => {
    const answer = acceptHandoff(envelope(), {
      tenantId: 'tenant-a',
      capabilities: [],
      membershipState: 'active',
      grantRevoked: false,
    });
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('project.read');
  });

  test('there is no cross-tenant context sharing by default', () => {
    const answer = acceptHandoff(envelope(), {
      tenantId: 'tenant-b',
      capabilities: ['project.read'],
      membershipState: 'active',
      grantRevoked: false,
    });
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('different business');
  });

  test('a grant withdrawn between the handoff and the start stops the child', () => {
    const answer = acceptHandoff(envelope(), {
      tenantId: 'tenant-a',
      capabilities: ['project.read'],
      membershipState: 'active',
      grantRevoked: true,
    });
    expect(answer.ok).toBe(false);
  });

  test('a child whose membership was revoked does not start', () => {
    const answer = acceptHandoff(envelope(), {
      tenantId: 'tenant-a',
      capabilities: ['project.read'],
      membershipState: 'revoked',
      grantRevoked: false,
    });
    expect(answer.ok).toBe(false);
  });
});

describe('after a restart', () => {
  test('work already completed is not repeated', () => {
    const answer = reconcileAfterReplay(
      [
        { handoffId: 'h1', state: 'completed' },
        { handoffId: 'h2', state: 'running' },
      ],
      ['h1', 'h2', 'h3'],
    );
    expect(answer.skip).toEqual(['h1']);
    expect(answer.resume).toEqual(['h2']);
    expect(answer.start).toEqual(['h3']);
  });

  test('a handoff that vanished from the replay is reported rather than forgotten', () => {
    const answer = reconcileAfterReplay([{ handoffId: 'h9', state: 'running' }], []);
    expect(answer.missing).toEqual(['h9']);
  });

  test('the same inputs reconcile the same way whatever order they arrive in', () => {
    const recorded = [
      { handoffId: 'b', state: 'completed' as const },
      { handoffId: 'a', state: 'running' as const },
    ];
    const forward = reconcileAfterReplay(recorded, ['a', 'b']);
    const reversed = reconcileAfterReplay([...recorded].reverse(), ['b', 'a']);
    expect(reversed).toEqual(forward);
  });
});

describe('scheduling', () => {
  test('a waiting member does not pin a model', () => {
    expect(modelPin('waiting').pinned).toBe(false);
    expect(modelPin('working').pinned).toBe(true);
    expect(modelPin('idle').pinned).toBe(false);
  });

  test('a released model says why it was released', () => {
    expect(modelPin('waiting').reason.length).toBeGreaterThan(20);
  });

  test('background work never goes ahead of interactive work', () => {
    const ordered = admissionOrder([
      { id: 'bg-1', kind: 'background', queuedAt: '2026-09-10T10:00:00.000Z' },
      { id: 'ui-1', kind: 'interactive', queuedAt: '2026-09-10T12:00:00.000Z' },
      { id: 'bg-2', kind: 'background', queuedAt: '2026-09-10T09:00:00.000Z' },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['ui-1', 'bg-2', 'bg-1']);
  });

  test('two interactive jobs keep their arrival order', () => {
    const ordered = admissionOrder([
      { id: 'second', kind: 'interactive', queuedAt: '2026-09-10T12:00:01.000Z' },
      { id: 'first', kind: 'interactive', queuedAt: '2026-09-10T12:00:00.000Z' },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['first', 'second']);
  });
});
