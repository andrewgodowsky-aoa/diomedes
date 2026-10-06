/** Fictional, deterministic inputs only. These are not customer incidents or model outputs. */
export const BASELINE_TENANTS = ['tenant-a', 'tenant-b'] as const;
export const BASELINE_QUERY = 'zebracurrent';
export const APPROVAL = 'The purchase order is approved.';
export const CORRECTION = 'Correction: approval is still pending; do not place the order.';
export const CORRECTED_ANSWER = `${APPROVAL} ${CORRECTION}`;
export const LONG_OPENING = `The purchase order is approved for the ${'fictional scheduled delivery '.repeat(7)}described in the draft.`;
export const EXCEPTION = 'Exception: approval is still pending; do not place the order.';

export interface BaselineTurn { key: string; prompt: string; answer: string }
export interface BaselineCase {
  id: string;
  targetIndex: number;
  critical: string;
  expectedPromptExcerpt: string;
  expectedAnswerExcerpt: string;
  turns: BaselineTurn[];
}

export function baselineCases(): BaselineCase[] {
  const turns = () => Array.from({ length: 15 }, (_, index) => ({
    key: `m-${index + 1}`, prompt: `Fixture question ${index + 1}.`, answer: `Fixture answer ${index + 1}.`,
  }));
  const answer = turns();
  answer[1] = { key: 'm-2', prompt: 'Report the purchase order status.', answer: CORRECTED_ANSWER };
  const later = turns();
  later[1] = { key: 'm-2', prompt: 'Report the purchase order status.', answer: APPROVAL };
  later[2] = { key: 'm-3', prompt: `A later update arrived. ${CORRECTION}`, answer: 'Update recorded.' };
  const long = turns();
  long[1] = { key: 'm-2', prompt: 'Report the purchase order status.', answer: `${LONG_OPENING} ${EXCEPTION}` };
  return [
    { id: 'answer-correction', targetIndex: 2, critical: CORRECTION,
      expectedPromptExcerpt: 'Report the purchase order status.', expectedAnswerExcerpt: APPROVAL, turns: answer },
    { id: 'later-user-correction', targetIndex: 3, critical: CORRECTION,
      expectedPromptExcerpt: 'A later update arrived.', expectedAnswerExcerpt: 'Update recorded.', turns: later },
    { id: 'exception-after-long-opening', targetIndex: 2, critical: EXCEPTION,
      expectedPromptExcerpt: 'Report the purchase order status.',
      expectedAnswerExcerpt: `${LONG_OPENING.slice(0, 159).trimEnd()}\u2026`, turns: long },
  ];
}

export const OPAQUE_TRANSCRIPT = {
  providerId: 'fixture', modelId: 'scripted-baseline', lineageId: 'fictional-lineage',
  opaqueRef: 'opaque:same-reference', prefixHash: 'fictional-prefix',
};
