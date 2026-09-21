import { describe, expect, it } from 'vitest';
import {
  ALLOWED_OPERATIONS,
  DISPOSITIONS,
  INTERACTION_EXAMPLES,
  OPERATION_CLASSES,
  PACKAGE_FIELD_NAMES,
  interactionDecisionSchema,
  isIssuedSourceId,
  type Disposition,
  type InteractionDecision,
  type OperationClass,
} from '../shared/interaction.js';

/**
 * The contract is a shape, not an authority. These tests check that the shape
 * refuses what the CD-1 fixture says it must refuse. None of them establishes
 * that a decision which parses would be admitted; admission is tested where
 * admission lives.
 */

const base: InteractionDecision = {
  sourceMessageId: 'msg_base',
  disposition: 'respond',
  requestedProjectId: null,
  operationClass: 'none',
  sourceRefs: [],
  targetRunId: null,
  question: null,
  publicSummary: 'Answered directly.',
};
const make = (over: Partial<InteractionDecision>): Record<string, unknown> => ({
  ...base,
  ...over,
});
const refused = (value: unknown) => {
  const result = interactionDecisionSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result;
};

describe('every supplied example parses', () => {
  for (const [name, example] of Object.entries(INTERACTION_EXAMPLES))
    it(`${name} parses and round-trips`, () => {
      const result = interactionDecisionSchema.safeParse(example);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      expect(result.data).toEqual(example);
    });

  it('covers all eight dispositions exactly once', () => {
    const covered = Object.values(INTERACTION_EXAMPLES).map((example) => example.disposition);
    expect([...covered].sort()).toEqual([...DISPOSITIONS].sort());
  });
});

describe('unknown fields are refused', () => {
  it('refuses an extra top-level field', () => {
    refused({ ...base, confidence: 0.98 });
  });

  it('refuses the package snake_case spelling as an extra field', () => {
    // Guards the camelCase/snake_case boundary: the fixture's spelling is
    // documented in PACKAGE_FIELD_NAMES, it is not silently accepted here.
    refused({ ...base, source_message_id: 'msg_base' });
  });

  it('maps every field to exactly one package field name', () => {
    const keys = Object.keys(base).sort();
    expect(Object.keys(PACKAGE_FIELD_NAMES).sort()).toEqual(keys);
    const mapped = Object.values(PACKAGE_FIELD_NAMES);
    expect(new Set(mapped).size).toBe(mapped.length);
  });
});

describe('a missing field is not a null field', () => {
  for (const field of Object.keys(base))
    it(`refuses a decision with no ${field}`, () => {
      const partial = { ...base } as Record<string, unknown>;
      delete partial[field];
      refused(partial);
    });
});

describe('one invalid case per conditional rule', () => {
  it('refuses respond with an operation class', () => {
    refused(make({ disposition: 'respond', operationClass: 'read' }));
  });

  it('refuses blocked with an operation class', () => {
    refused(make({ disposition: 'blocked', operationClass: 'write_internal' }));
  });

  it('refuses clarify with an operation class', () => {
    refused(
      make({ disposition: 'clarify', operationClass: 'read', question: 'Which project?' }),
    );
  });

  it('refuses each inert disposition that names a target run', () => {
    refused(make({ disposition: 'respond', targetRunId: 'run_01' }));
    refused(make({ disposition: 'blocked', targetRunId: 'run_01' }));
    refused(
      make({ disposition: 'clarify', question: 'Which project?', targetRunId: 'run_01' }),
    );
  });

  it('refuses retrieve with anything but read', () => {
    refused(make({ disposition: 'retrieve', operationClass: 'none' }));
    refused(make({ disposition: 'retrieve', operationClass: 'write_internal' }));
  });

  it('refuses plan that writes', () => {
    refused(make({ disposition: 'plan', operationClass: 'write_internal' }));
    refused(make({ disposition: 'plan', operationClass: 'send_external' }));
  });

  it('refuses act that develops a capability or controls a run', () => {
    refused(make({ disposition: 'act', operationClass: 'develop_capability' }));
    refused(make({ disposition: 'act', operationClass: 'none' }));
  });

  it('refuses build_capability with anything but develop_capability', () => {
    refused(make({ disposition: 'build_capability', operationClass: 'write_internal' }));
  });

  it('refuses control with anything but control_run', () => {
    refused(make({ disposition: 'control', operationClass: 'write_internal', targetRunId: 'run_01' }));
  });

  it('refuses control with no target run', () => {
    refused(make({ disposition: 'control', operationClass: 'control_run', targetRunId: null }));
  });

  it('accepts a target run on the dispositions the fixture leaves free', () => {
    // The fixture pins targetRunId to null only for respond, clarify and
    // blocked. An act that names the run it continues is a legal proposal.
    for (const [disposition, operationClass] of [
      ['retrieve', 'read'],
      ['plan', 'prepare_artifact'],
      ['act', 'write_internal'],
      ['build_capability', 'develop_capability'],
    ] as const)
      expect(
        interactionDecisionSchema.safeParse(
          make({ disposition, operationClass, targetRunId: 'run_01' }),
        ).success,
        `${disposition} with a target run`,
      ).toBe(true);
  });

  it('refuses clarify with no question', () => {
    refused(make({ disposition: 'clarify', operationClass: 'none', question: null }));
  });
});

describe('the allowed-operation map is exhaustive and honest', () => {
  it('names every disposition', () => {
    expect(Object.keys(ALLOWED_OPERATIONS).sort()).toEqual([...DISPOSITIONS].sort());
  });

  it('agrees with the schema for every disposition and operation pair', () => {
    for (const disposition of DISPOSITIONS)
      for (const operationClass of OPERATION_CLASSES) {
        const decision = make({
          disposition,
          operationClass,
          // Satisfy the independent per-disposition rules so this check
          // isolates the operation-class rule alone.
          targetRunId: disposition === 'control' ? 'run_01' : null,
          question: disposition === 'clarify' ? 'Which project?' : null,
        });
        const parsed = interactionDecisionSchema.safeParse(decision).success;
        expect(
          parsed,
          `${disposition} + ${operationClass} disagreed with ALLOWED_OPERATIONS`,
        ).toBe(ALLOWED_OPERATIONS[disposition as Disposition].includes(operationClass as OperationClass));
      }
  });
});

describe('bounded fields', () => {
  it('refuses an over-long source message id', () => {
    refused(make({ sourceMessageId: 'm'.repeat(161) }));
  });

  it('refuses an empty source message id', () => {
    refused(make({ sourceMessageId: '' }));
  });

  it('refuses a duplicated source reference', () => {
    refused(
      make({ disposition: 'retrieve', operationClass: 'read', sourceRefs: ['doc_a', 'doc_a'] }),
    );
  });

  it('refuses more than thirty-two source references', () => {
    refused(
      make({
        disposition: 'retrieve',
        operationClass: 'read',
        sourceRefs: Array.from({ length: 33 }, (_, index) => `doc_${index}`),
      }),
    );
  });

  it('refuses a public summary beyond two thousand characters', () => {
    refused(make({ publicSummary: 's'.repeat(2001) }));
  });

  it('accepts an empty public summary, which says nothing rather than claiming something', () => {
    expect(interactionDecisionSchema.safeParse(make({ publicSummary: '' })).success).toBe(true);
  });
});

describe('the issued source identity is separate from the parser', () => {
  it('accepts and refuses exactly the issued form', () => {
    expect(isIssuedSourceId(`sm.${'a'.repeat(32)}`)).toBe(true);
    expect(isIssuedSourceId(`sm.${'0123456789abcdef'.repeat(2)}`)).toBe(true);
    expect(isIssuedSourceId(`sm.${'A'.repeat(32)}`)).toBe(false);
    expect(isIssuedSourceId(`sm.${'a'.repeat(31)}`)).toBe(false);
    expect(isIssuedSourceId(` sm.${'a'.repeat(32)} `)).toBe(false);
    expect(isIssuedSourceId('message-1')).toBe(false);
  });

  it('is the same length under both length semantics, so the bridge cannot disagree', () => {
    const issued = `sm.${'a'.repeat(32)}`;
    expect(issued.length).toBe(35);
    expect([...issued]).toHaveLength(35);
    expect(issued.trim()).toBe(issued);
  });

  it('does not constrain the parser, which keeps fixture parity', () => {
    // A decision naming a non-issued identity is a valid object and an
    // invalid proposal. Admission rejects it; the schema does not.
    const parsed = interactionDecisionSchema.safeParse(make({ sourceMessageId: 'message-1' }));
    expect(parsed.success).toBe(true);
    expect(isIssuedSourceId('message-1')).toBe(false);
  });
});

describe('parity with the package fixture', () => {
  it('does not normalize a source identity', () => {
    const parsed = interactionDecisionSchema.parse(make({ sourceMessageId: ' spaced ' }));
    expect(parsed.sourceMessageId).toBe(' spaced ');
  });

  it('accepts whitespace the fixture minLength admits', () => {
    expect(interactionDecisionSchema.safeParse(make({ sourceMessageId: ' ' })).success).toBe(true);
    expect(
      interactionDecisionSchema.safeParse(
        make({ disposition: 'clarify', operationClass: 'none', question: ' ' }),
      ).success,
    ).toBe(true);
  });

  it('counts bounds in code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}';
    expect(
      interactionDecisionSchema.safeParse(make({ sourceMessageId: emoji.repeat(160) })).success,
    ).toBe(true);
    expect(
      interactionDecisionSchema.safeParse(make({ sourceMessageId: emoji.repeat(161) })).success,
    ).toBe(false);
    expect(
      interactionDecisionSchema.safeParse(make({ publicSummary: emoji.repeat(2000) })).success,
    ).toBe(true);
  });

  it('compares source reference uniqueness on the raw strings', () => {
    expect(
      interactionDecisionSchema.safeParse(
        make({ disposition: 'retrieve', operationClass: 'read', sourceRefs: ['doc', ' doc '] }),
      ).success,
    ).toBe(true);
  });

  it('still refuses a length overrun that trimming would have hidden', () => {
    refused(make({ sourceMessageId: ` ${'x'.repeat(159)} ` }));
  });
});
