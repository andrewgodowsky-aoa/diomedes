import { describe, expect, test } from 'vitest';
import { AGENT_CATALOG, agentCompatibility } from '../shared/agents.js';
import { fullAccessEligibility, ROUTE_CAPABILITIES } from '../shared/capabilities.js';
import { enforcementFor } from '../shared/rule-authority.js';
import { NECTOVIA_ROUTE } from '../shared/model-api.js';
import { nectoviaAgentGap } from '../client/console/agent-gaps.js';

// Slice 2 of the round 2 reskin, decision 5 option A: the Agent menu works on Nectovia. Before
// this, every worker read "nectovia is not a known execution route" because the capability table
// had no row for it.
describe('the Nectovia capability row', () => {
  test('Nectovia is a known execution route, named for the customer', () => {
    const route = ROUTE_CAPABILITIES[NECTOVIA_ROUTE];
    expect(route).toBeDefined();
    expect(route.routeId).toBe(NECTOVIA_ROUTE);
    // The name reaches customers (PermissionPanel): no vendor, model or route words.
    expect(route.name).toBe('Nectovia');
  });

  test('its facts are a model-API route: no process, no shell, no credential, a recorded writer', () => {
    const route = ROUTE_CAPABILITIES[NECTOVIA_ROUTE];
    expect(route.storeOnlyWrites).toMatchObject({ answer: 'yes', basis: 'diomedes-enforced' });
    expect(route.spawnsProcesses).toMatchObject({ answer: 'no', basis: 'diomedes-enforced' });
    expect(route.runsShellCommands.answer).toBe('no');
    expect(route.arbitraryFilesystem.answer).toBe('no');
    expect(route.receivesSecrets).toMatchObject({ answer: 'no', basis: 'diomedes-enforced' });
    expect(route.network.answer).toBe('yes');
    expect(route.network.evidence).toContain('server/engines/nectovia.ts');
    expect(route.receivesSecrets.evidence).toContain('server/engines/nectovia.ts');
    // Revocation mid-call is not measured on any model route, and Nectovia claims no more.
    expect(route.revocationStopsFutureEffects.answer).not.toBe('yes');
  });

  test('every built-in worker is compatible with Nectovia', () => {
    for (const agent of AGENT_CATALOG) expect(agentCompatibility(agent, NECTOVIA_ROUTE).ok, agent.id).toBe(true);
  });

  test('Full access stays unavailable, now for a reason that names Nectovia', () => {
    const eligibility = fullAccessEligibility(NECTOVIA_ROUTE, null);
    expect(eligibility.available).toBe(false);
    expect(eligibility.unsupportedEffects).not.toContain('unknown route');
    expect(eligibility.summary).toContain('Nectovia');
  });

  test('a rule on Nectovia is no longer unsupported for want of a row', () => {
    expect(enforcementFor('guidance', NECTOVIA_ROUTE, 'context-assembly').enforcement).toBe('instructional');
  });
});

describe('the Build and Fix workers on Nectovia', () => {
  const byId = (id: string) => AGENT_CATALOG.find((agent) => agent.id === id)!;

  test('Change Builder and Problem Debugger are grayed, with one plain reason each', () => {
    expect(nectoviaAgentGap(byId('diomedes.builder'), NECTOVIA_ROUTE)).toBe("Build isn't on Nectovia yet.");
    expect(nectoviaAgentGap(byId('diomedes.debugger'), NECTOVIA_ROUTE)).toBe("Fix isn't on Nectovia yet.");
  });

  test('the other six stay pickable on Nectovia', () => {
    const open = AGENT_CATALOG.filter((agent) => nectoviaAgentGap(agent, NECTOVIA_ROUTE) === null).map((a) => a.id);
    expect(open).toEqual([
      'diomedes.general',
      'diomedes.architect',
      'diomedes.researcher',
      'diomedes.explorer',
      'diomedes.reviewer',
      'diomedes.analyst',
    ]);
  });

  test('on any other route nothing is grayed by this rule', () => {
    for (const route of ['codex', 'claude-code', 'aws-bedrock', 'bonsai'])
      for (const agent of AGENT_CATALOG) expect(nectoviaAgentGap(agent, route)).toBeNull();
  });

  test('a person-made worker that leads with Build is grayed the same way', () => {
    expect(nectoviaAgentGap({ modes: ['build', 'ask'] }, NECTOVIA_ROUTE)).toBe("Build isn't on Nectovia yet.");
    expect(nectoviaAgentGap({ modes: ['ask', 'build'] }, NECTOVIA_ROUTE)).toBeNull();
    expect(nectoviaAgentGap({ modes: [] }, NECTOVIA_ROUTE)).toBeNull();
  });
});
