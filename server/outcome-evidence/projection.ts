import {
  outcomeProjectionInputSchema,
  type OutcomeEvidence,
  type OutcomeProjection,
  type OutcomeProjectionRow,
} from '../../shared/outcome-evidence.js';

const exactNumber = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Outcome arithmetic exceeds safe integer range.');
  }
  return Number(value);
};
const has = (record: OutcomeEvidence, role: OutcomeEvidence['sources'][number]['role']) =>
  record.sources.some(s => s.role === role);

/** Pure projection. No persistence, reference resolution, authorization, or external effects. */
export function projectOutcomeEvidence(input: unknown): OutcomeProjection {
  const parsed = outcomeProjectionInputSchema.parse(input);
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  const realizationRefs = new Map<string, string>();
  const currencies = new Set<string>();
  const rows: OutcomeProjectionRow[] = [];
  let duplicates = 0;
  let minutes = 0n;
  let money = 0n;
  let measuredTimeCount = 0;
  let realizedMoneyCount = 0;
  for (const record of parsed.records) {
    if (record.projectId !== parsed.projectId || record.prospectId !== parsed.prospectId) {
      throw new Error('Outcome evidence is outside the selected project/prospect scope.');
    }
    const canonical = JSON.stringify(record);
    const prior = ids.get(record.id);
    if (prior !== undefined) {
      if (prior !== canonical) throw new Error('Conflicting outcome identity or revision.');
      duplicates++;
      continue;
    }
    ids.set(record.id, canonical);
    // Time and money stay separate. Within each category, one causal outcome is counted once.
    const group = `${record.kind === 'human-time' ? 'time' : 'money'}:${record.causalGroup}`;
    if (groups.has(group)) throw new Error('Duplicate causal outcome requires explicit reconciliation.');
    groups.set(group, record.id);
    if ('currency' in record) currencies.add(record.currency);
    if (currencies.size > 1) throw new Error('Mixed currencies require separate projections.');

    const reasons = [...record.exclusions];
    let netHumanMinutes: number | null = null;
    let realizedFinancialMinor: number | null = null;
    if (record.evidenceClass === 'synthetic' || record.evidenceClass === 'owner-estimate') {
      reasons.push('Illustration or estimate; excluded from measured and realized totals.');
    }
    if (record.realization !== 'realized') reasons.push(`Outcome is ${record.realization}, not realized.`);
    if (!has(record, 'observation')) reasons.push('Observation source is missing.');
    if (record.kind === 'human-time') {
      if (!has(record, 'baseline')) reasons.push('Comparable baseline source is missing.');
      const terms = [record.baselineMinutes, record.executionMinutes, record.reviewMinutes,
        record.correctionMinutes, record.supportMinutes];
      if (terms.some(v => v === null)) {
        reasons.push('Human effort measurement is incomplete.');
      } else {
        const [baseline, execution, review, correction, support] = terms as number[];
        netHumanMinutes = exactNumber(BigInt(baseline!) - BigInt(execution!) - BigInt(review!)
          - BigInt(correction!) - BigInt(support!));
      }
      if (reasons.length === 0 && netHumanMinutes !== null) {
        minutes += BigInt(netHumanMinutes);
        measuredTimeCount++;
      }
    } else {
      if (record.kind === 'unknown') reasons.push(record.reason);
      if (record.kind === 'associated-revenue') reasons.push('Associated gross revenue is not incremental contribution.');
      if (record.kind === 'purchase-deferral') reasons.push('Deferred purchasing is cash timing, not realized expense reduction.');
      if (record.evidenceClass !== 'reviewed-attributable') reasons.push('Reviewed attributable evidence is required.');
      if (!has(record, 'realization')) reasons.push('Realization evidence is missing.');
      if (!has(record, 'review')) reasons.push('Review source is missing.');
      if (record.kind === 'incremental-contribution') {
        if (record.fulfillmentCostMinor === null) reasons.push('Incremental fulfillment cost is unknown.');
        if (record.attributionMethod === null) reasons.push('Incremental attribution method is missing.');
        if (!has(record, 'baseline')) reasons.push('Attribution baseline or comparison source is missing.');
      }
      if (record.kind === 'expense-reduction' && !has(record, 'baseline')) {
        reasons.push('Comparable expense baseline source is missing.');
      }
      if (reasons.length === 0 && record.kind !== 'unknown' && record.kind !== 'associated-revenue'
        && record.kind !== 'purchase-deferral') {
        for (const ref of record.sources.filter(s => s.role === 'realization')) {
          // Revisions of one source cannot be used to realize multiple benefits.
          if (realizationRefs.has(ref.id)) throw new Error('Realization source is already counted.');
          realizationRefs.set(ref.id, record.id);
        }
        const amount = record.kind === 'incremental-contribution'
          ? BigInt(record.revenueMinor) - BigInt(record.fulfillmentCostMinor!)
          : BigInt(record.amountMinor) * (record.kind === 'operating-cost' ? -1n : 1n);
        realizedFinancialMinor = exactNumber(amount);
        money += amount;
        realizedMoneyCount++;
      }
    }
    rows.push({ evidence: record, netHumanMinutes, realizedFinancialMinor, excludedReasons: reasons });
  }
  return {
    projectId: parsed.projectId, prospectId: parsed.prospectId, rows,
    measuredNetHumanMinutes: measuredTimeCount ? exactNumber(minutes) : null,
    realizedFinancial: realizedMoneyCount
      ? { currency: [...currencies][0]!, amountMinor: exactNumber(money) } : null,
    duplicateRecordsIgnored: duplicates,
  };
}
