import { describe, expect, it } from 'vitest';
import { searchProposals, validateDrafts } from '../server/workforce/constraints.js';

const start = '2026-09-21T00:00:00-04:00';
const end = '2026-09-28T00:00:00-04:00';
const worker = (id: string) => ({ id, roles: ['floor'],
  availability: [{ start, end, source: 'reviewed-availability-1' }],
  absences: [] as { start: string; end: string }[], priorWeekMinutes: 0,
  precedingShift: null as { end: string; location: string } | null });
const demand = (id: string, a = '2026-09-22T18:00:00-04:00', b = '2026-09-22T22:00:00-04:00') =>
  ({ id, role: 'floor', start: a, end: b, location: 'dining', requiredCount: 1 });
const snapshot = () => ({ contractVersion: 1, projectId: 'project', prospectId: 'prospect',
  configurationId: 'config-1', source: 'reviewed-snapshot-1', workers: [worker('a'), worker('b')],
  demands: [demand('dinner')], rules: { workweekStart: start, workweekEnd: end,
    maxWeekMinutes: 2400, minRestMinutes: 480, travelGapMinutes: 60 } });
const draft = (demandId: string, workerId = 'a') => ({ demandId, workerId, status: 'acceptance-pending' });

describe('workforce preparation', () => {
  it('changes a proposal after an owner availability edit and leaves acceptance pending', () => {
    const s = snapshot();
    expect(searchProposals(s).assignments).toEqual([draft('dinner')]);
    s.workers[0].availability = [];
    expect(searchProposals(s).assignments).toEqual([draft('dinner', 'b')]);
    s.workers[1].availability = [];
    expect(searchProposals(s).status).toBe('infeasible');
  });
  it('blocks a partial absence and a worker without the required role', () => {
    const s = snapshot(); s.workers[0].roles = ['bar'];
    s.workers[1].absences = [{ start: '2026-09-22T21:00:00-04:00', end: '2026-09-22T23:00:00-04:00' }];
    const r = searchProposals(s);
    expect(r.status).toBe('infeasible');
    expect(r.conflicts.map(x => x.code)).toEqual(expect.arrayContaining(['role-unqualified', 'on-absence']));
  });
  it('detects overlapping overnight shifts independently of proposal search', () => {
    const s = snapshot(); s.demands = [demand('late', '2026-09-22T23:00:00-04:00', '2026-09-23T03:00:00-04:00'),
      demand('early', '2026-09-23T02:00:00-04:00', '2026-09-23T06:00:00-04:00')];
    const r = validateDrafts(s, [draft('late'), draft('early')]);
    expect(r.valid).toBe(false); expect(r.conflicts.some(x => x.code === 'double-booked')).toBe(true);
  });
  it('enforces rest and travel between otherwise nonoverlapping demands', () => {
    const s = snapshot(); s.demands = [demand('a'), demand('b', '2026-09-22T22:30:00-04:00', '2026-09-22T23:00:00-04:00')];
    expect(validateDrafts(s, [draft('a'), draft('b')]).conflicts.some(x => x.code === 'insufficient-rest')).toBe(true);
    s.rules.minRestMinutes = 0; s.demands[1].location = 'courtyard';
    expect(validateDrafts(s, [draft('a'), draft('b')]).conflicts.some(x => x.code === 'insufficient-travel-gap')).toBe(true);
  });
  it('checks the preceding shift at the start of the configured window', () => {
    const s = snapshot(); s.demands = [demand('early', '2026-09-21T01:00:00-04:00', '2026-09-21T04:00:00-04:00')];
    s.workers.forEach(w => { w.precedingShift = { end: '2026-09-20T23:00:00-04:00', location: 'dining' }; });
    expect(searchProposals(s).status).toBe('infeasible');
  });
  it('counts prior minutes and rejects demands outside the measured workweek', () => {
    const s = snapshot(); s.workers.forEach(w => { w.priorWeekMinutes = 2340; });
    expect(searchProposals(s).status).toBe('infeasible');
    s.demands[0].start = '2026-09-20T18:00:00-04:00';
    expect(searchProposals(s).status).toBe('invalid');
  });
  it('uses elapsed instants across the repeated daylight-saving hour', () => {
    const s = snapshot(); s.rules.workweekStart = '2026-10-26T00:00:00-04:00';
    s.rules.workweekEnd = '2026-11-02T00:00:00-05:00'; s.rules.maxWeekMinutes = 60;
    s.workers.forEach(w => { w.availability = [{ start: s.rules.workweekStart, end: s.rules.workweekEnd, source: 'dst-reviewed' }]; });
    s.demands = [demand('dst', '2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00')];
    expect(searchProposals(s).status).toBe('feasible');
    s.rules.maxWeekMinutes = 59; expect(searchProposals(s).status).toBe('infeasible');
  });
  it('backtracks when the first worker is required for a later specialized demand', () => {
    const s = snapshot(); s.rules.minRestMinutes = 0;
    s.workers[0].roles.push('bar'); s.demands.push({ ...demand('bar'), role: 'bar' });
    const r = searchProposals(s);
    expect(r.status).toBe('feasible'); expect(validateDrafts(s, r.assignments).valid).toBe(true);
    expect(r.assignments).toContainEqual(draft('dinner', 'b'));
  });
  it('distinguishes budget exhaustion from proof of no solution', () => {
    const s = snapshot(); s.demands[0].requiredCount = 2;
    const limited = searchProposals(s, { maxNodes: 1 });
    expect(limited.status).toBe('search-incomplete'); expect(limited.stats.nodesVisited).toBe(1);
    expect(searchProposals(s, { maxNodes: 3 }).status).toBe('feasible');
    s.workers = []; expect(searchProposals(s, { maxNodes: 0 }).status).toBe('infeasible');
  });
  it('rejects malformed, incomplete and normalized invalid calendar inputs', () => {
    for (const value of ['2026-02-30T18:00:00Z', '2026-09-22T18:00:00', '2026-09-22T18:00:30Z']) {
      const s = snapshot(); s.demands[0].start = value; expect(searchProposals(s).status).toBe('invalid');
    }
    const s = snapshot();
    for (const key of ['projectId', 'source', 'demands', 'workers']) {
      const bad = { ...s } as Record<string, unknown>; delete bad[key]; expect(searchProposals(bad).status).toBe('invalid');
    }
    for (const key of ['absences', 'priorWeekMinutes', 'precedingShift']) {
      const bad = { ...s.workers[0] } as Record<string, unknown>; delete bad[key];
      expect(searchProposals({ ...s, workers: [bad] }).status).toBe('invalid');
    }
    expect(searchProposals({ ...s, demands: [] }).status).toBe('invalid');
    expect(searchProposals({ ...s, workers: [s.workers[0], s.workers[0]] }).status).toBe('invalid');
  });
  it('rejects unknown, duplicate and falsely accepted draft assignments', () => {
    const s = snapshot();
    for (const drafts of [[draft('unknown')], [draft('dinner', 'unknown')], [draft('dinner'), draft('dinner')],
      [{ ...draft('dinner'), status: 'accepted' }]]) expect(validateDrafts(s, drafts).valid).toBe(false);
  });
  it('replays deterministically without mutating its inputs', () => {
    const s = snapshot(); const before = JSON.stringify(s); const r = searchProposals(s);
    expect(searchProposals(s)).toEqual(r); expect(JSON.stringify(s)).toBe(before);
  });
  it('unions adjacent and overlapping availability without bridging a real gap', () => {
    const s = snapshot(); s.workers = [worker('a')];
    s.demands = [demand('overnight', '2026-09-22T22:00:00-04:00', '2026-09-23T02:00:00-04:00')];
    s.workers[0].availability = [
      { start: '2026-09-23T00:00:00-04:00', end: '2026-09-23T08:00:00-04:00', source: 'day-2' },
      { start: '2026-09-22T08:00:00-04:00', end: '2026-09-23T00:00:00-04:00', source: 'day-1' },
    ];
    expect(searchProposals(s).status).toBe('feasible');
    expect(validateDrafts(s, [draft('overnight')]).valid).toBe(true);
    s.workers[0].availability[1].end = '2026-09-22T23:59:00-04:00';
    expect(searchProposals(s).status).toBe('infeasible');
    s.workers[0].availability[1].end = '2026-09-23T01:00:00-04:00';
    expect(searchProposals(s).status).toBe('feasible');
  });
  it('keeps space-bearing demand and worker identities distinct', () => {
    const s = snapshot(); s.workers = [worker('y'), worker('x y')];
    s.workers[0].roles = ['one']; s.workers[1].roles = ['two'];
    s.demands = [{ ...demand('d x'), role: 'one' }, { ...demand('d'), role: 'two' }];
    expect(validateDrafts(s, [draft('d x', 'y'), draft('d', 'x y')]).valid).toBe(true);
    expect(searchProposals(s).status).toBe('feasible');
  });
});
