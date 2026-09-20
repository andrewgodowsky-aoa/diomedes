import { describe, expect, it } from 'vitest';
import { projectOutcomeEvidence } from '../server/outcome-evidence/projection.js';

const base = () => ({
  id: 'outcome-1', revision: '1', projectId: 'project', prospectId: 'prospect',
  causalGroup: 'booking-1', runId: 'run-1', artifactId: 'artifact-1',
  period: { start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z' },
  calculationVersion: 1, evidenceClass: 'reviewed-attributable', realization: 'realized',
  exclusions: [], sources: ['baseline', 'observation', 'realization', 'review'].map(role =>
    ({ id: `source-${role}`, revision: '1', role })),
});
const contribution = () => ({ ...base(), kind: 'incremental-contribution', currency: 'USD',
  revenueMinor: 10000, fulfillmentCostMinor: 4000, attributionMethod: 'Reviewed comparable baseline.' });
const time = () => ({ ...base(), kind: 'human-time', baselineMinutes: 100, executionMinutes: 0,
  reviewMinutes: 30, correctionMinutes: 0, supportMinutes: 10 });
const project = (...records: unknown[]) => projectOutcomeEvidence({ projectId: 'project', prospectId: 'prospect', records });

describe('outcome evidence projection', () => {
  it('separates human capacity from realized contribution', () => {
    const result = project(contribution(), { ...time(), id: 'time-1' });
    expect(result.measuredNetHumanMinutes).toBe(60);
    expect(result.realizedFinancial).toEqual({ currency: 'USD', amountMinor: 6000 });
  });
  it('keeps negative time visible and deducts all human effort', () => {
    expect(project({ ...time(), executionMinutes: 80 }).measuredNetHumanMinutes).toBe(-20);
  });
  it.each(['synthetic', 'owner-estimate', 'observed'])('does not realize %s money', evidenceClass => {
    expect(project({ ...contribution(), evidenceClass }).realizedFinancial).toBeNull();
  });
  it.each(['cancelled', 'no-show', 'proposed', 'accepted', 'unknown'])('does not count %s revenue', realization => {
    expect(project({ ...contribution(), realization }).realizedFinancial).toBeNull();
  });
  it('keeps associated gross revenue and deferral outside financial totals', () => {
    for (const kind of ['associated-revenue', 'purchase-deferral']) {
      expect(project({ ...base(), kind, currency: 'USD', amountMinor: 10000 }).realizedFinancial).toBeNull();
    }
  });
  it('does not count missing margin, attribution or baseline', () => {
    for (const r of [{ ...contribution(), fulfillmentCostMinor: null },
      { ...contribution(), attributionMethod: null }, { ...contribution(), sources: [] }]) {
      expect(project(r).realizedFinancial).toBeNull();
    }
  });
  it('distinguishes requested, accepted and received credits', () => {
    const credit = { ...base(), kind: 'supplier-credit', currency: 'USD', amountMinor: 3000 };
    expect(project({ ...credit, realization: 'proposed' }).realizedFinancial).toBeNull();
    expect(project({ ...credit, realization: 'accepted' }).realizedFinancial).toBeNull();
    expect(project(credit).realizedFinancial?.amountMinor).toBe(3000);
  });
  it('deducts operating costs and preserves a negative total', () => {
    const cost = { ...base(), kind: 'operating-cost', currency: 'USD', amountMinor: 7000 };
    expect(project(cost).realizedFinancial?.amountMinor).toBe(-7000);
  });
  it('deduplicates identical replay, but refuses conflicting revisions and causal duplicates', () => {
    const r = contribution();
    expect(project(r, r).duplicateRecordsIgnored).toBe(1);
    expect(project(r, r).realizedFinancial?.amountMinor).toBe(6000);
    expect(() => project(r, { ...r, revision: '2' })).toThrow(/revision/);
    expect(() => project(r, { ...r, id: 'other' })).toThrow(/causal/);
  });
  it('refuses reused realization references even across causal groups', () => {
    expect(() => project(contribution(), { ...contribution(), id: 'other', causalGroup: 'other' }))
      .toThrow(/already counted/);
  });
  it('rejects a foreign project or prospect before returning rows', () => {
    expect(() => project({ ...time(), projectId: 'foreign' })).toThrow(/scope/);
    expect(() => project({ ...time(), prospectId: 'foreign' })).toThrow(/scope/);
  });
  it('retains incomplete and synthetic time only as excluded rows', () => {
    expect(project({ ...time(), baselineMinutes: null }).measuredNetHumanMinutes).toBeNull();
    const result = project({ ...time(), evidenceClass: 'synthetic' });
    expect(result.rows[0]?.netHumanMinutes).toBe(60);
    expect(result.measuredNetHumanMinutes).toBeNull();
    expect(project({ ...time(), sources: [] }).measuredNetHumanMinutes).toBeNull();
  });
  it('rejects mixed currencies, fractional cents and unsafe arithmetic', () => {
    expect(() => project(contribution(), { ...contribution(), id: 'other', causalGroup: 'other', currency: 'EUR' }))
      .toThrow(/currencies/);
    expect(() => project({ ...contribution(), revenueMinor: 0.5 })).toThrow();
    expect(() => project({ ...time(), baselineMinutes: 0, executionMinutes: Number.MAX_SAFE_INTEGER,
      supportMinutes: Number.MAX_SAFE_INTEGER })).toThrow(/safe integer/);
  });
  it('rejects invalid periods and malformed quantities', () => {
    expect(() => project({ ...time(), reviewMinutes: NaN })).toThrow();
    expect(() => project({ ...time(), period: { start: '2026-09-08T00:00:00Z', end: '2026-09-01T00:00:00Z' } })).toThrow();
  });
  it('does not mutate inputs; empty projection is unknown, not a zero achievement', () => {
    const r = contribution(); const before = JSON.stringify(r); project(r);
    expect(JSON.stringify(r)).toBe(before);
    expect(project().realizedFinancial).toBeNull();
    expect(project().measuredNetHumanMinutes).toBeNull();
  });
  it('requires a comparable baseline before realizing expense reduction', () => {
    const reduction = { ...base(), kind: 'expense-reduction', currency: 'USD', amountMinor: 2000 };
    expect(project(reduction).realizedFinancial?.amountMinor).toBe(2000);
    expect(project({ ...reduction, sources: reduction.sources.filter(s => s.role !== 'baseline') }).realizedFinancial).toBeNull();
  });
  it('sums distinct realized benefits and costs without double counting', () => {
    const cost = { ...base(), id: 'cost', causalGroup: 'service-cost', kind: 'operating-cost', currency: 'USD', amountMinor: 7000,
      sources: base().sources.map(s => ({ ...s, id: 'cost-' + s.id })) };
    expect(project(contribution(), cost).realizedFinancial?.amountMinor).toBe(-1000);
  });
});
