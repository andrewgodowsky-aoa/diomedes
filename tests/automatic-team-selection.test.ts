/** Production automatic selector with labelled synthetic measured host facts; no live qualification is asserted. */
import { describe, expect, test } from 'vitest';
import { mintAutomaticWorkRequest } from '../server/automatic-work-admission.js';
import { planAutomaticWork, selectAutomaticTeam, automaticTeamStillCurrent } from '../server/harness/automatic-team-selection.js';
import type { AutomaticTeamCandidate, AutomaticTeamDecision } from '../shared/automatic-team.js';
import { digest } from '../server/harness/policy.js';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const GOAL = 'Reconcile the inventory and write an exceptions report, then independently review the result.';
const SOURCE = { path: 'inventory.txt', sha: digest('synthetic inventory') };
const request = (goal = GOAL) => {
  const minted = mintAutomaticWorkRequest({ projectId: 'inventory-project', threadId: 'inventory-thread',
    commandId: 'inventory-request', sourceMessageId: 'sm.' + 'a'.repeat(32), mode: 'auto',
    text: goal, sources: [SOURCE], homeProjectId: 'home-project',
    requestDigest: digest({ action: 'message', text: goal, mode: 'auto', sources: [SOURCE] }),
  });
  expect(minted, 'the selector receives the production host-minted request').not.toBeNull();
  return minted!;
};

function candidate(role: 'lead' | 'member'): AutomaticTeamCandidate {
  const slotId = role === 'lead' ? 'lead-slot' : 'worker-slot';
  const model = role === 'lead' ? 'openai/gpt-6.1-sol' : 'z-ai/glm-5.3-flash';
  const id = `synthetic-exact-qualification-${slotId}`;
  const profileDigest = digest({ fixture: 'synthetic profile', slotId, model });
  const pins = { route: 'openrouter', model, effort: 'medium', accountRoute: 'openrouter:synthetic-owner@r1',
    connectionId: 'synthetic-owner', connectionRevision: 1, payerId: 'synthetic-owner', profileDigest };
  return { slotId, role, profileId: `${slotId}-profile`, profileRevision: 1, ...pins,
    authorized: true, available: true, qualification: {
      ...pins, id, evidenceSha: digest({ fixture: 'synthetic benchmark', slotId }), scope: 'bounded-work',
      validUntil: '2026-10-02T00:00:00Z',
      benchmark: { id: 'synthetic-independent-benchmark-v1', accepted: true, independent: true, score: role === 'lead' ? 0.95 : 0.8 },
      bounds: { qualificationId: id, workerMicroUsd: role === 'lead' ? 1_000_000 : 200_000,
        verificationMicroUsd: 100_000, correctionMicroUsd: 100_000, coordinationMicroUsd: 50_000 },
    },
  };
}

function select(patch: Partial<Parameters<typeof selectAutomaticTeam>[0]> = {}) {
  const admitted = request();
  return selectAutomaticTeam({ request: admitted, plan: planAutomaticWork(admitted),
    candidates: [candidate('lead'), candidate('member')], leadRoute: 'openrouter',
    leadModel: 'openai/gpt-6.1-sol', leadAccountRoute: 'openrouter:synthetic-owner@r1',
    remainingMicroUsd: 1_000_000, now: NOW, ...patch });
}
function team(decision: AutomaticTeamDecision) {
  expect(decision.mode, decision.reason).toBe('team');
  if (decision.mode !== 'team') throw new Error('selector did not return a Team');
  return decision;
}
const single = (decision: AutomaticTeamDecision) => {
  expect(decision.mode, decision.reason).toBe('single');
  expect(decision.reason.trim().length).toBeGreaterThan(10);
};

describe('useful, measured and affordable automatic Team selection', () => {
  test('a qualified stronger lead and cheaper worker reserve checks, correction and coordination', () => {
    const decision = team(select());
    expect(decision.lead).toEqual(candidate('lead'));
    expect(decision.worker).toEqual(candidate('member'));
    expect(decision.reserve).toEqual({ workerMicroUsd: 200_000, verificationMicroUsd: 100_000,
      correctionMicroUsd: 100_000, coordinationMicroUsd: 50_000, totalMicroUsd: 450_000 });
    expect(decision.pinDigest).toBe(digest({ requestDigest: decision.requestDigest,
      lead: decision.lead, worker: decision.worker, reserve: decision.reserve }));
    expect(automaticTeamStillCurrent(decision, [candidate('lead'), candidate('member')], NOW)).toBe(true);
  });

  test('trivial work keeps one agent and says why even when an excellent Team is available', () => {
    const simple = request('Write one sentence describing the selected inventory.');
    single(select({ request: simple, plan: planAutomaticWork(simple) }));
    expect(planAutomaticWork(simple)).toMatchObject({ requestDigest: simple.requestDigest, independentReview: false });
  });

  test('a plan from a different request cannot select helpers', () => {
    single(select({ plan: { ...planAutomaticWork(request()), requestDigest: digest('another request') } }));
  });

  test('a cheaper worker is not useful when checks and corrections consume the saving', () => {
    const lead = candidate('lead'), worker = candidate('member');
    const expensive = { ...lead, qualification: { ...lead.qualification!, bounds: { ...lead.qualification!.bounds, correctionMicroUsd: 800_000 } } };
    single(select({ candidates: [expensive, worker] }));
  });

  test('the full carve must fit the remaining root budget; no independent child cap exists', () => {
    single(select({ remainingMicroUsd: 449_999 }));
    team(select({ remainingMicroUsd: 450_000 }));
    for (const remainingMicroUsd of [NaN, -1, 0, Infinity]) single(select({ remainingMicroUsd }));
  });

  test.each(['accepted', 'independent', 'evidence', 'expiry', 'qualification-id', 'scope'] as const)
    ('a missing %s qualification cannot be replaced by a profile name or model reputation', (failure) => {
      const lead = candidate('lead'), worker = candidate('member');
      const q = worker.qualification!;
      const qualification = failure === 'accepted' ? { ...q, benchmark: { ...q.benchmark, accepted: false } }
        : failure === 'independent' ? { ...q, benchmark: { ...q.benchmark, independent: false } }
        : failure === 'evidence' ? { ...q, evidenceSha: 'not-an-evidence-digest' }
        : failure === 'expiry' ? { ...q, validUntil: new Date(NOW).toISOString() }
        : failure === 'qualification-id' ? { ...q, bounds: { ...q.bounds, qualificationId: 'another-qualification' } }
        : { ...q, scope: 'unbounded' as never };
      single(select({ candidates: [lead, { ...worker, qualification }] }));
    });

  test.each(['authorized', 'available', 'route', 'model', 'effort', 'accountRoute', 'connectionId', 'connectionRevision', 'payerId', 'profileDigest'] as const)
    ('current worker %s must match its exact qualified binding', (field) => {
      const lead = candidate('lead'), worker = candidate('member');
      const altered = { ...worker, [field]: field === 'authorized' || field === 'available' ? false
        : field === 'connectionRevision' ? 2 : field === 'profileDigest' ? digest('changed profile')
        : field === 'effort' ? 'high' : `changed-${field}` };
      single(select({ candidates: [lead, altered] as AutomaticTeamCandidate[] }));
    });

  test('owned member medium is enforced even if high effort has measured qualification', () => {
    const worker = candidate('member');
    const high = { ...worker, effort: 'high', qualification: { ...worker.qualification!, effort: 'high' } };
    single(select({ candidates: [candidate('lead'), high] }));
  });

  test('the lead must be stronger on the same independent benchmark, not merely more expensive', () => {
    const lead = candidate('lead'), worker = candidate('member');
    for (const score of [lead.qualification!.benchmark.score, 1, NaN, Infinity]) {
      const bad = { ...worker, qualification: { ...worker.qualification!, benchmark: { ...worker.qualification!.benchmark, score } } };
      single(select({ candidates: [lead, bad] }));
    }
    const unrelated = { ...worker, qualification: { ...worker.qualification!, benchmark: { ...worker.qualification!.benchmark, id: 'different-benchmark' } } };
    single(select({ candidates: [lead, unrelated] }));
  });

  test('the lead’s actual route/model/account must match the qualified lead slot', () => {
    for (const patch of [{ leadRoute: 'aws-bedrock' }, { leadModel: 'another-model' }, { leadAccountRoute: 'another-account' }]) single(select(patch));
  });

  test('no Team is invented for unqualified K3 or the managed single-agent route', () => {
    const k3 = { ...candidate('lead'), route: 'aws-bedrock', model: 'us.moonshotai.kimi-k3', qualification: null };
    single(select({ candidates: [k3, candidate('member')], leadRoute: k3.route, leadModel: k3.model }));
    single(select({ leadRoute: 'nectovia' }));
  });

  test('selected facts are detached and remain immutable when candidate discovery updates', () => {
    const candidates = [candidate('lead'), candidate('member')];
    const decision = team(select({ candidates }));
    Object.assign(candidates[1]!.qualification!.bounds, { workerMicroUsd: 1 });
    expect(decision.worker.qualification!.bounds.workerMicroUsd).toBe(200_000);
    expect(automaticTeamStillCurrent(decision, candidates, NOW)).toBe(false);
  });

  test('restart rechecks the exact immutable decision; stale, missing and corrupt pins refuse', () => {
    const decision = team(select());
    const reloaded = JSON.parse(JSON.stringify(decision));
    const candidates = [candidate('lead'), candidate('member')];
    expect(automaticTeamStillCurrent(reloaded, candidates, NOW)).toBe(true);
    expect(automaticTeamStillCurrent(reloaded, candidates.slice(0, 1), NOW)).toBe(false);
    expect(automaticTeamStillCurrent(reloaded, candidates, Date.parse('2026-10-03T00:00:00Z'))).toBe(false);
    for (const corrupt of [
      { ...reloaded, pinDigest: digest('corrupt pin') },
      { ...reloaded, requestDigest: digest('other request') },
      { ...reloaded, reserve: { ...reloaded.reserve, totalMicroUsd: 1 } },
      { ...reloaded, reserve: { ...reloaded.reserve, correctionMicroUsd: 0 } },
    ]) expect(automaticTeamStillCurrent(corrupt, candidates, NOW)).toBe(false);
  });
});
