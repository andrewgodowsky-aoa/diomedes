/**
 * Choosing what the main model sees.
 *
 * This is the feature: give the model the information it needs, not as much as
 * will fit. It is also the most dangerous part, because every failure here is
 * invisible — a wrong answer built on a correct-looking selection reads exactly
 * like a right one, and the missing document is not in the transcript to notice.
 *
 * `validatePrepared` in the native loop already stops a prepared context from
 * gaining tool authority, but it says nothing about messages: a ranking is free
 * to drop any instruction it likes. So the protection has to be here, and these
 * tests are what makes it real.
 *
 * Three rules, and each has a scenario behind it that actually happens:
 *
 * - A ranking never removes an obligation. A safety instruction that scores
 *   badly is still an instruction.
 * - A shortlist cannot support "there are none". If the request said every
 *   location, a selection that dropped one answers a narrower question.
 * - A conflict is information. Two sources that disagree are the reason to read
 *   both, not grounds to keep the higher-scoring one and manufacture agreement.
 *
 * The fixtures are the synthetic supplier review: a rebate amendment with an
 * unhelpful filename that a name-based ranking would miss, and staff notes that
 * genuinely do not matter.
 */
import { describe, expect, test } from 'vitest';
import {
  selectContext,
  type SelectableSource,
  type SelectionInput,
} from '../shared/evaluation-selection.js';

const source = (over: Partial<SelectableSource> & { id: string }): SelectableSource => ({
  revision: 1,
  authority: 'optional',
  bytes: 1_000,
  conflictsWith: [],
  ...over,
});

/** The synthetic supplier project. `attachment-07` is the rebate amendment. */
const SUPPLIER: SelectableSource[] = [
  source({ id: 'report-only-policy', authority: 'protected', bytes: 200 }),
  source({ id: 'current-invoice', authority: 'requested' }),
  source({ id: 'prior-invoice' }),
  source({ id: 'attachment-07' }),
  source({ id: 'staff-notes' }),
  source({ id: 'marketing-draft' }),
];

const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  candidates: SUPPLIER,
  ranked: ['current-invoice', 'prior-invoice', 'attachment-07'],
  budgetBytes: 100_000,
  coverageRequired: false,
  ...over,
});

describe('what a ranking is allowed to do', () => {
  test('keeps what the ranking chose', () => {
    const { selected } = selectContext(input());
    expect(selected).toContain('prior-invoice');
    expect(selected).toContain('attachment-07');
  });

  test('drops what it did not choose, and says so', () => {
    const { selected, omitted } = selectContext(input());
    expect(selected).not.toContain('staff-notes');
    expect(omitted.find((o) => o.id === 'staff-notes')?.reason).toBe('not-selected');
  });

  test('omits nothing silently — every candidate is either selected or explained', () => {
    const { selected, omitted } = selectContext(input());
    expect([...selected, ...omitted.map((o) => o.id)].sort()).toEqual(
      SUPPLIER.map((s) => s.id).sort(),
    );
  });
});

describe('what a ranking is never allowed to do', () => {
  test('cannot drop a protected instruction, however badly it scores', () => {
    const { selected, protectedRetained } = selectContext(input({ ranked: ['staff-notes'] }));
    expect(selected).toContain('report-only-policy');
    expect(protectedRetained).toEqual(['report-only-policy']);
  });

  test('cannot drop a source the person explicitly asked for', () => {
    const { selected } = selectContext(input({ ranked: ['staff-notes'] }));
    expect(selected).toContain('current-invoice');
  });

  test('cannot conjure a source that was never a candidate', () => {
    const { selected } = selectContext(input({ ranked: ['payroll-export', 'prior-invoice'] }));
    expect(selected).not.toContain('payroll-export');
    expect(selected).toContain('prior-invoice');
  });

  test('cannot separate two sources that contradict each other', () => {
    // The contract says the current case price; the amendment changes it. A
    // selection that keeps one and drops the other reads as agreement.
    const candidates = [
      source({ id: 'contract', conflictsWith: ['attachment-07'] }),
      source({ id: 'attachment-07', conflictsWith: ['contract'] }),
      source({ id: 'staff-notes' }),
    ];
    const { selected, omitted } = selectContext(
      input({ candidates, ranked: ['contract'] }),
    );
    expect(selected).toContain('contract');
    expect(selected).toContain('attachment-07');
    expect(omitted.find((o) => o.id === 'attachment-07')).toBeUndefined();
  });
});

describe('the rebate amendment with an unhelpful name', () => {
  test('survives when the ranking found it, whatever it is called', () => {
    expect(selectContext(input()).selected).toContain('attachment-07');
  });

  test('is not dropped for a budget that the low-value sources could have paid for', () => {
    // Enough room for the obligation, the two invoices and the amendment, but
    // not for everything. The notes and the draft are what goes.
    const { selected } = selectContext(input({ budgetBytes: 3_500 }));
    expect(selected).toContain('attachment-07');
    expect(selected).not.toContain('marketing-draft');
  });
});

describe('when it does not all fit', () => {
  test('spends the budget on the ranking order, not on whatever comes first', () => {
    const { selected } = selectContext(input({ budgetBytes: 2_200 }));
    expect(selected).toContain('report-only-policy');
    expect(selected).toContain('current-invoice');
    expect(selected).toContain('prior-invoice');
    expect(selected).not.toContain('attachment-07');
  });

  test('records a budget omission as a different fact from an unranked one', () => {
    const { omitted } = selectContext(input({ budgetBytes: 2_200 }));
    expect(omitted.find((o) => o.id === 'attachment-07')?.reason).toBe('over-budget');
    expect(omitted.find((o) => o.id === 'staff-notes')?.reason).toBe('not-selected');
  });

  test('escalates rather than quietly discarding an obligation that does not fit', () => {
    // Doc 04: if the mandatory material cannot fit, escalate or change the
    // strategy — never silently drop it. A result that dropped the policy would
    // be a different, unauthorized task.
    const result = selectContext(input({ budgetBytes: 100 }));
    expect(result.escalate).toBe('protected-context-exceeds-budget');
    expect(result.selected).toContain('report-only-policy');
  });

  test('does not escalate when everything mandatory fits', () => {
    expect(selectContext(input()).escalate).toBeNull();
  });
});

describe('coverage, and what a shortlist cannot prove', () => {
  test('is complete only when nothing was left out', () => {
    const everything = input({
      ranked: SUPPLIER.map((s) => s.id),
      coverageRequired: true,
    });
    expect(selectContext(everything).coverage).toBe('complete');
  });

  test('is partial the moment a required sweep drops anything', () => {
    expect(selectContext(input({ coverageRequired: true })).coverage).toBe('partial');
  });

  test('is unknown when no sweep was required, rather than claiming completeness', () => {
    // Not being asked for everything is not evidence of having seen everything.
    expect(selectContext(input()).coverage).toBe('unknown');
  });

  test('stays partial even when only low-value material was dropped', () => {
    const almost = input({
      ranked: SUPPLIER.filter((s) => s.id !== 'marketing-draft').map((s) => s.id),
      coverageRequired: true,
    });
    expect(selectContext(almost).coverage).toBe('partial');
  });
});

describe('the selection record', () => {
  test('pins the revision of every source it selected', () => {
    const { revisions } = selectContext(input());
    expect(revisions['attachment-07']).toBe(1);
  });

  test('notices when a source changed under it', () => {
    const changed = SUPPLIER.map((s) =>
      s.id === 'attachment-07' ? { ...s, revision: 2 } : s,
    );
    const first = selectContext(input());
    const second = selectContext(input({ candidates: changed }));
    expect(second.revisions['attachment-07']).not.toBe(first.revisions['attachment-07']);
  });

  test('is a pure function of its input', () => {
    const one = input();
    expect(selectContext(one)).toEqual(selectContext(one));
  });

  test('does not mutate the candidates it was handed', () => {
    const before = JSON.stringify(SUPPLIER);
    selectContext(input({ budgetBytes: 500 }));
    expect(JSON.stringify(SUPPLIER)).toBe(before);
  });
});
