import { describe, expect, it } from 'vitest';
import {
  ALLOWED_OPERATIONS,
  DISPOSITIONS,
  interactionDecisionSchema,
  type Disposition,
  type InteractionDecision,
  type OperationClass,
} from '../shared/interaction.js';
import {
  RESTRICTION_CEILING,
  admitInteraction,
  conversationCommandIds,
  proposalDigest,
  type AdmissionInput,
  type Restriction,
} from '../server/interaction-admission.js';
import { commandIdSchema } from '../server/command-admission.js';

// The deterministic half of "the model proposes, Trust and Runtime decide". These tests treat
// the model as an adversary: every proposal below is schema-valid, and the question is only
// what it is allowed to become.

const SM = 'sm.0123456789abcdef0123456789abcdef';
const HOME = 'home000000aa';
const LINEN = 'linen0000001';
const CATERING = 'cater0000002';
const RESTRICTIONS: Restriction[] = ['automatic', 'answer-only', 'plan-only'];

function decision(
  disposition: Disposition,
  operationClass: OperationClass,
  patch: Partial<InteractionDecision> = {},
): InteractionDecision {
  return interactionDecisionSchema.parse({
    sourceMessageId: SM,
    disposition,
    requestedProjectId: null,
    operationClass,
    sourceRefs: [],
    targetRunId: disposition === 'control' ? 'run-1' : null,
    question: disposition === 'clarify' ? 'Which supplier?' : null,
    publicSummary: 'Order the usual from the bakery supplier.',
    ...patch,
  });
}
function input(patch: Partial<AdmissionInput> & Pick<AdmissionInput, 'decision'>): AdmissionInput {
  return {
    restriction: 'automatic',
    conversationProjectId: LINEN,
    homeProjectId: HOME,
    targetableProjectIds: [LINEN, CATERING],
    selection: null,
    ...patch,
  };
}
/** Every pair the frozen schema allows. */
const PAIRS = DISPOSITIONS.flatMap((disposition) =>
  ALLOWED_OPERATIONS[disposition].map((operationClass) => ({ disposition, operationClass })),
);

describe('admitInteraction', () => {
  it('gives a verdict for every schema-valid pair under every restriction, and never throws', () => {
    for (const restriction of RESTRICTIONS)
      for (const pair of PAIRS)
        expect(() =>
          admitInteraction(input({ restriction, decision: decision(pair.disposition, pair.operationClass) })),
        ).not.toThrow();
  });

  it('never escalates without the person’s own selection, whatever the model proposes', () => {
    for (const restriction of RESTRICTIONS)
      for (const pair of PAIRS) {
        const verdict = admitInteraction(
          input({ restriction, decision: decision(pair.disposition, pair.operationClass) }),
        );
        expect(verdict.outcome, `${restriction} ${pair.disposition}/${pair.operationClass}`).not.toBe(
          'escalate',
        );
      }
  });

  it('C06: under Automatic a valid act proposal is shown, not started', () => {
    // The person wrote "just explain, do not change anything" and the model proposed act anyway.
    const proposal = decision('act', 'write_internal');
    const verdict = admitInteraction(input({ decision: proposal }));
    expect(verdict).toEqual({
      outcome: 'proposed',
      projectId: LINEN,
      operationClass: 'write_internal',
      proposalDigest: proposalDigest(proposal, LINEN),
    });
  });

  it('escalates only for the exact proposal the person selected', () => {
    const proposal = decision('act', 'prepare_artifact');
    const shown = proposalDigest(proposal, LINEN);
    const selection = { sourceMessageId: SM, proposalDigest: shown, projectId: LINEN };
    expect(admitInteraction(input({ decision: proposal, selection }))).toEqual({
      outcome: 'escalate',
      projectId: LINEN,
      operationClass: 'prepare_artifact',
      proposalDigest: shown,
      ...conversationCommandIds(SM),
    });
    for (const stale of [
      { ...selection, sourceMessageId: 'sm.' + 'f'.repeat(32) },
      { ...selection, proposalDigest: 'f'.repeat(64) },
      { ...selection, projectId: CATERING },
    ])
      expect(admitInteraction(input({ decision: proposal, selection: stale }))).toEqual({
        outcome: 'blocked',
        reason: 'stale-selection',
      });
    // The same selection cannot start a proposal whose words changed.
    const reworded = decision('act', 'prepare_artifact', { publicSummary: 'Order double.' });
    expect(admitInteraction(input({ decision: reworded, selection })).outcome).toBe('blocked');
  });

  it('a selection can never widen Answer only or Plan only', () => {
    for (const restriction of ['answer-only', 'plan-only'] as const)
      for (const pair of PAIRS) {
        const proposal = decision(pair.disposition, pair.operationClass);
        const selection = {
          sourceMessageId: SM,
          proposalDigest: proposalDigest(proposal, LINEN),
          projectId: LINEN,
        };
        const verdict = admitInteraction(input({ restriction, decision: proposal, selection }));
        expect(['inert', 'read', 'blocked']).toContain(verdict.outcome);
      }
  });

  it('holds the ceilings the limits name', () => {
    expect(RESTRICTION_CEILING).toEqual({ 'answer-only': 'read', 'plan-only': 'prepare_artifact' });
    expect(Object.isFrozen(RESTRICTION_CEILING)).toBe(true);
    const blocked = { outcome: 'blocked', reason: 'above-ceiling' };
    expect(
      admitInteraction(input({ restriction: 'answer-only', decision: decision('plan', 'prepare_artifact') })),
    ).toEqual(blocked);
    expect(
      admitInteraction(input({ restriction: 'plan-only', decision: decision('act', 'write_internal') })),
    ).toEqual(blocked);
    expect(
      admitInteraction(input({ restriction: 'plan-only', decision: decision('act', 'prepare_artifact') })),
    ).toEqual(blocked);
    // Under Plan only the plan text is the whole result: nothing is started and nothing is wrong.
    expect(
      admitInteraction(input({ restriction: 'plan-only', decision: decision('plan', 'prepare_artifact') })),
    ).toEqual({ outcome: 'inert' });
  });

  it('answers, questions and refusals change nothing', () => {
    for (const disposition of ['respond', 'clarify', 'blocked'] as const)
      for (const restriction of RESTRICTIONS)
        expect(admitInteraction(input({ restriction, decision: decision(disposition, 'none') }))).toEqual({
          outcome: 'inert',
        });
  });

  it('keeps a read inside the conversation that asked for it', () => {
    expect(admitInteraction(input({ decision: decision('retrieve', 'read') }))).toEqual({
      outcome: 'read',
      projectId: LINEN,
    });
    expect(
      admitInteraction(input({ decision: decision('retrieve', 'read', { requestedProjectId: CATERING }) })),
    ).toEqual({ outcome: 'blocked', reason: 'cross-project-read' });
  });

  it('never guesses a project for work asked from home', () => {
    const fromHome = { conversationProjectId: HOME };
    expect(admitInteraction(input({ ...fromHome, decision: decision('act', 'write_internal') }))).toEqual({
      outcome: 'blocked',
      reason: 'needs-target',
    });
    expect(
      admitInteraction(
        input({ ...fromHome, decision: decision('act', 'write_internal', { requestedProjectId: HOME }) }),
      ),
    ).toEqual({ outcome: 'blocked', reason: 'home-is-not-a-target' });
    expect(
      admitInteraction(
        input({ ...fromHome, decision: decision('act', 'write_internal', { requestedProjectId: 'nope' }) }),
      ),
    ).toEqual({ outcome: 'blocked', reason: 'unknown-target' });
    expect(
      admitInteraction(
        input({ ...fromHome, decision: decision('act', 'write_internal', { requestedProjectId: CATERING }) }),
      ).outcome,
    ).toBe('proposed');
  });

  it('reports what the first slice cannot reach, and reaches none of it', () => {
    expect(admitInteraction(input({ decision: decision('build_capability', 'develop_capability') }))).toEqual({
      outcome: 'blocked',
      reason: 'build-not-reachable',
    });
    expect(admitInteraction(input({ decision: decision('act', 'send_external') }))).toEqual({
      outcome: 'blocked',
      reason: 'send-not-reachable',
    });
    expect(admitInteraction(input({ decision: decision('control', 'control_run') }))).toEqual({
      outcome: 'blocked',
      reason: 'control-not-reachable',
    });
  });
});

describe('derived identities', () => {
  it('gives one stable command pair per source message, valid as command ids', () => {
    const ids = conversationCommandIds(SM);
    expect(conversationCommandIds(SM)).toEqual(ids);
    expect(ids.taskCommandId).not.toBe(ids.workCommandId);
    expect(conversationCommandIds('sm.' + 'f'.repeat(32)).taskCommandId).not.toBe(ids.taskCommandId);
    for (const id of Object.values(ids)) expect(commandIdSchema.safeParse(id).success).toBe(true);
  });

  it('binds a proposal digest to its message, its words, its refs and its target', () => {
    const proposal = decision('act', 'write_internal', { sourceRefs: ['prices.md'] });
    const shown = proposalDigest(proposal, LINEN);
    expect(proposalDigest(proposal, LINEN)).toBe(shown);
    expect(proposalDigest(proposal, CATERING)).not.toBe(shown);
    expect(proposalDigest({ ...proposal, publicSummary: 'Other words.' }, LINEN)).not.toBe(shown);
    expect(proposalDigest({ ...proposal, sourceRefs: [] }, LINEN)).not.toBe(shown);
    expect(proposalDigest({ ...proposal, sourceMessageId: 'sm.' + 'f'.repeat(32) }, LINEN)).not.toBe(shown);
  });
});
