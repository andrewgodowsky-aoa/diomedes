import { describe, expect, it } from 'vitest';
import {
  interactionDecisionSchema,
  type InteractionDecision,
} from '../shared/interaction.js';

// Independent counterexamples against CD-1/contracts/interaction-decision.schema.json.
// Expectations use the fixture after its documented snake_case -> camelCase mapping.
// These tests intentionally remain red while the candidate diverges from that fixture.
const base: InteractionDecision = {
  sourceMessageId: 'message-1',
  disposition: 'respond',
  requestedProjectId: null,
  operationClass: 'none',
  sourceRefs: [],
  targetRunId: null,
  question: null,
  publicSummary: '',
};

describe('CD-1 fixture counterexamples', () => {
  // The fixture restricts target_run_id to null only for respond/clarify/blocked.
  // Its retrieve/plan/act/build_capability conditionals constrain operation_class only.
  const targets = [
    ['retrieve', 'read'],
    ['plan', 'prepare_artifact'],
    ['act', 'write_internal'],
    ['build_capability', 'develop_capability'],
  ] as const;
  for (const [disposition, operationClass] of targets)
    it(`accepts the fixture's ${disposition} with a target run`, () => {
      expect(interactionDecisionSchema.safeParse({
        ...base, disposition, operationClass, targetRunId: 'run-1',
      }).success).toBe(true);
    });

  it('accepts a one-character whitespace source ID allowed by minLength', () => {
    expect(interactionDecisionSchema.safeParse({
      ...base, sourceMessageId: ' ',
    }).success).toBe(true);
  });

  it('rejects a 161-character ID even when trimming would shorten it', () => {
    expect(interactionDecisionSchema.safeParse({
      ...base, sourceMessageId: ` ${'x'.repeat(159)} `,
    }).success).toBe(false);
  });

  it('preserves the source identity rather than silently normalizing it', () => {
    const parsed = interactionDecisionSchema.parse({ ...base, sourceMessageId: ' message-1 ' });
    expect(parsed.sourceMessageId).toBe(' message-1 ');
  });

  it('accepts two distinct source strings under uniqueItems', () => {
    expect(interactionDecisionSchema.safeParse({
      ...base, sourceRefs: ['document', ' document '],
    }).success).toBe(true);
  });

  it('accepts a whitespace question allowed by the clarify conditional', () => {
    expect(interactionDecisionSchema.safeParse({
      ...base, disposition: 'clarify', question: ' ',
    }).success).toBe(true);
  });

  // JSON Schema length counts Unicode code points, not UTF-16 code units.
  it('accepts a source ID of exactly 160 supplementary Unicode characters', () => {
    const sourceMessageId = '\u{1F600}'.repeat(160);
    expect([...sourceMessageId]).toHaveLength(160);
    expect(interactionDecisionSchema.safeParse({ ...base, sourceMessageId }).success).toBe(true);
  });

  it('accepts a summary of exactly 2000 supplementary Unicode characters', () => {
    const publicSummary = '\u{1F600}'.repeat(2000);
    expect([...publicSummary]).toHaveLength(2000);
    expect(interactionDecisionSchema.safeParse({ ...base, publicSummary }).success).toBe(true);
  });
});
