/**
 * The weekly-brief pack on its own.
 *
 * Slice A of governed self-configuration claims one thing: two synthetic
 * variants of a single workflow that share every authority decision and differ
 * only where the pack says they may. These tests hold that claim directly —
 * compiling the same questionnaire under both variants and comparing the two
 * proposals structurally — and then check each honest-behaviour promise the
 * compiler makes: determinism, closed risky routes, catalogue connections,
 * inactive schedules, missing Agents that block rather than invent, and a
 * proposal the real validator and screen both accept.
 *
 * Every fixture is invented. No workplace is real and no figure is financial.
 */
import { describe, expect, test } from 'vitest';
import { AGENT_CATALOG, AGENT_REQUIREMENTS, type AgentRequirement } from '../shared/agents.js';
import { ROUTE_CAPABILITIES, type RouteCapabilities } from '../shared/capabilities.js';
import { ruleScopeSchema } from '../shared/connection-rules.js';
import {
  screenCandidate,
  validateProposal,
  type ConfigurationProposal,
  type KnownAgent,
  type ValidationContext,
} from '../shared/configuration.js';
import { type AnswerMap, type AnswerValue, type BusinessAnswer } from '../shared/business-setup.js';
import {
  compileProposal,
  variantFor,
  type CompileInput,
  type PackVariantId,
} from '../shared/packs.js';
import { agentDigest } from '../server/agents.js';

const AT = '2026-09-10T09:00:00.000Z';
const ORG = 'org-weekly-brief';
const TENANT = 'tenant-weekly-brief';
const BY = 'person_owner';

/** One questionnaire row, so the fixtures read as answers rather than literals. */
const answer = (questionId: string, value: AnswerValue, unknown = false): BusinessAnswer => ({
  questionId,
  value,
  unknown,
  origin: 'person',
  at: AT,
  by: BY,
});

const build = (pairs: [string, AnswerValue, boolean?][]): AnswerMap =>
  Object.fromEntries(pairs.map(([id, value, unknown]) => [id, answer(id, value, unknown)]));

/** A complete questionnaire for a fictional design studio. Nothing here is real. */
const fullAnswers = (): AnswerMap =>
  build([
    ['name', 'Northfield Design Studio'],
    ['industry', 'design studio'],
    ['job', 'recurring-report'],
    ['result', 'A short brief one person reads before Monday.'],
    ['sources', ['files']],
    ['people', 'just-me'],
    ['locations', 'one'],
    ['human-required', ['sending']],
    ['data-leaving', 'non-sensitive'],
    ['host', 'The front desk computer'],
    ['spend-cap', 120],
    ['first-run', 'manual'],
  ]);

// --- the live facts a validation context is honestly derived from ----------------

/** A route counts as remote unless it can prove its network stays off. */
const isRemote = (route: RouteCapabilities): boolean => route.network.answer !== 'no';

/** The requirements a route satisfies, read from the capability facts. */
const satisfied = (route: RouteCapabilities): ReadonlySet<AgentRequirement> => {
  const met = new Set<AgentRequirement>();
  for (const [id, rule] of Object.entries(AGENT_REQUIREMENTS))
    if (route[rule.field].answer === rule.needs) met.add(id as AgentRequirement);
  return met;
};

const catalogAgents = (): Map<string, KnownAgent> =>
  new Map(
    AGENT_CATALOG.map((definition) => [
      definition.id,
      {
        version: definition.version,
        digest: agentDigest(definition),
        requires: definition.requires,
        permissionCeiling: definition.permissionCeiling,
      },
    ]),
  );

const contextFor = (options?: {
  teamExecutionAvailable?: boolean;
  connectedConnections?: ReadonlySet<string>;
}): ValidationContext => ({
  tenantId: TENANT,
  organizationId: ORG,
  knownAgents: catalogAgents(),
  knownRuleScopeKeys: new Set(Object.keys(ruleScopeSchema.shape)),
  routeRequirements: new Map(
    Object.values(ROUTE_CAPABILITIES).map((route) => [route.routeId, satisfied(route)]),
  ),
  remoteRoutes: new Set(
    Object.values(ROUTE_CAPABILITIES)
      .filter(isRemote)
      .map((route) => route.routeId),
  ),
  connectedConnections: options?.connectedConnections ?? new Set(),
  maxBudgetUsd: 1_000_000,
  teamExecutionAvailable: options?.teamExecutionAvailable ?? true,
});

const inputFor = (answers: AnswerMap, options?: Partial<CompileInput>): CompileInput => ({
  organizationId: ORG,
  tenantId: TENANT,
  answers,
  answersDigest: `sha256:${'c'.repeat(64)}`,
  previousConfigurationDigest: null,
  variantId: 'professional-services',
  agents: catalogAgents(),
  teamExecutionAvailable: true,
  connectedConnections: new Set<string>(),
  at: AT,
  by: BY,
  ...options,
});

const guidanceText = (proposal: ConfigurationProposal): string =>
  proposal.rules.find((rule) => rule.category === 'guidance')?.text ?? '';

/**
 * Mask every field the pack declares as variant-specific, so the comparison
 * below proves the two proposals differ only there.
 */
const normalizeVariantFields = (proposal: ConfigurationProposal) => ({
  ...proposal,
  template: { ...proposal.template, variantId: 'variant' },
  rules: proposal.rules.map((rule) =>
    rule.category === 'guidance' ? { ...rule, text: 'guidance' } : rule,
  ),
  contextScopes: proposal.contextScopes.map((scope) => ({
    ...scope,
    label: 'scope',
    selection: ['selection'],
  })),
  expectedOutputs: proposal.expectedOutputs.map((output) => ({
    ...output,
    label: 'output',
    destination: 'output.md',
  })),
});

describe('variant selection', () => {
  test('food-service wording selects restaurant-operations, everything else stays neutral', () => {
    expect(
      variantFor(
        build([
          ['name', 'Harborlight Bistro'],
          ['industry', 'cafe'],
        ]),
      ),
    ).toBe('restaurant-operations');
    expect(
      variantFor(
        build([
          ['name', 'Northfield Design Studio'],
          ['industry', 'design'],
        ]),
      ),
    ).toBe('professional-services');
    expect(variantFor(build([]))).toBe('professional-services');
  });
});

describe('variant equivalence', () => {
  test('the same answers compile to proposals that differ only where the pack allows', () => {
    const answers = fullAnswers();
    const restaurant = compileProposal(inputFor(answers, { variantId: 'restaurant-operations' }));
    const professional = compileProposal(inputFor(answers, { variantId: 'professional-services' }));

    // The authority-bearing fields are deeply equal across variants.
    expect(restaurant.agents.map(({ agentId, ceiling }) => ({ agentId, ceiling }))).toEqual(
      professional.agents.map(({ agentId, ceiling }) => ({ agentId, ceiling })),
    );
    expect(restaurant.team?.handoffs).toEqual(professional.team?.handoffs);
    expect(restaurant.modelPolicy).toEqual(professional.modelPolicy);
    expect(restaurant.budget).toEqual(professional.budget);
    expect(restaurant.approvers).toEqual(professional.approvers);
    expect(restaurant.expectedOutputs.map((output) => output.artifact)).toEqual(
      professional.expectedOutputs.map((output) => output.artifact),
    );
    expect(restaurant.expectedOutputs.map((output) => output.reviewedBy)).toEqual(
      professional.expectedOutputs.map((output) => output.reviewedBy),
    );

    // Structurally, nothing else differs either.
    expect(normalizeVariantFields(restaurant)).toEqual(normalizeVariantFields(professional));

    // And the declared differences are real, not vacuous masking.
    expect(restaurant.template.variantId).toBe('restaurant-operations');
    expect(professional.template.variantId).toBe('professional-services');
    expect(restaurant.contextScopes[0]?.label).not.toBe(professional.contextScopes[0]?.label);
    expect(restaurant.expectedOutputs[0]?.label).not.toBe(professional.expectedOutputs[0]?.label);
    expect(restaurant.expectedOutputs[0]?.destination).not.toBe(
      professional.expectedOutputs[0]?.destination,
    );
    expect(guidanceText(restaurant)).not.toBe(guidanceText(professional));
  });
});

describe('determinism', () => {
  test('identical input yields deeply equal proposals', () => {
    const answers = fullAnswers();
    const first = compileProposal(inputFor(answers, { variantId: 'restaurant-operations' }));
    const second = compileProposal(inputFor(answers, { variantId: 'restaurant-operations' }));
    expect(first).toEqual(second);
  });
});

describe('data-leaving', () => {
  test('an unanswered data-leaving question keeps the risky routes closed', () => {
    const answers = build(
      Object.entries(fullAnswers())
        .filter(([id]) => id !== 'data-leaving')
        .map(([id, row]) => [id, row.value] as [string, AnswerValue]),
    );
    const proposal = compileProposal(inputFor(answers));
    expect(proposal.modelPolicy.processing).toBe('local-only');
    expect(proposal.modelPolicy.fallbackAllowed).toBe(false);
    const remote = new Set(
      Object.values(ROUTE_CAPABILITIES)
        .filter(isRemote)
        .map((route) => route.routeId),
    );
    for (const route of proposal.modelPolicy.routes) expect(remote.has(route)).toBe(false);
  });
});

describe('business systems', () => {
  test('a named system becomes a catalogue entry with a fallback, and stays valid', () => {
    const answers = build([
      ['name', 'Harborlight Bistro'],
      ['industry', 'restaurant'],
      ['job', 'recurring-report'],
      ['result', 'A short brief one person reads before Monday.'],
      ['sources', ['business-system']],
      ['people', 'just-me'],
      ['human-required', ['sending']],
      ['data-leaving', 'non-sensitive'],
      ['first-run', 'manual'],
    ]);
    const proposal = compileProposal(inputFor(answers, { variantId: 'restaurant-operations' }));
    expect(proposal.requiredConnections).toHaveLength(1);
    const connection = proposal.requiredConnections[0]!;
    expect(connection.status).toBe('catalogue');
    expect(connection.required).toBe(false);
    expect(connection.fallback).toBeTruthy();
    expect(validateProposal(proposal, contextFor()).ok).toBe(true);
  });
});

describe('schedules', () => {
  test('a weekly start is recorded but stays inactive and non-blocking', () => {
    const answers = build([
      ['name', 'Northfield Design Studio'],
      ['job', 'recurring-report'],
      ['result', 'A short brief one person reads before Monday.'],
      ['sources', ['files']],
      ['people', 'just-me'],
      ['human-required', ['sending']],
      ['data-leaving', 'no'],
      ['first-run', 'weekly'],
    ]);
    const proposal = compileProposal(inputFor(answers));
    const issue = proposal.unresolved.find((item) => item.kind === 'unsupported-schedule');
    expect(issue).toBeDefined();
    expect(issue?.blocking).toBe(false);
    expect(validateProposal(proposal, contextFor()).ok).toBe(true);
  });
});

describe('missing agents', () => {
  test('an unknown specialist blocks rather than being invented', () => {
    const proposal = compileProposal(inputFor(fullAnswers(), { agents: new Map() }));
    expect(proposal.agents).toEqual([]);
    expect(proposal.team?.members ?? []).toEqual([]);
    const blocking = proposal.unresolved.filter((item) => item.blocking);
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.some((item) => item.what.includes('diomedes.analyst'))).toBe(true);
  });
});

describe('validation and screening', () => {
  test('a fully answered questionnaire passes the real screen and validator', () => {
    const proposal = compileProposal(inputFor(fullAnswers()));
    expect(screenCandidate(proposal)).toEqual([]);
    const result = validateProposal(proposal, contextFor());
    expect(result.ok).toBe(true);
  });

  test('a remote-only route under local-only processing is a blocking conflict', () => {
    const answers = build([
      ['name', 'Northfield Design Studio'],
      ['job', 'recurring-report'],
      ['result', 'A short brief one person reads before Monday.'],
      ['sources', ['files']],
      ['people', 'just-me'],
      ['human-required', ['sending']],
      ['data-leaving', 'no'],
      ['first-run', 'manual'],
    ]);
    const local = compileProposal(inputFor(answers));
    expect(local.modelPolicy.processing).toBe('local-only');
    const remoteOnly: ConfigurationProposal = {
      ...local,
      modelPolicy: { ...local.modelPolicy, routes: ['claude-code'] },
    };
    const result = validateProposal(remoteOnly, contextFor());
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (problem) => problem.code === 'processing-conflict' && problem.severity === 'blocking',
      ),
    ).toBe(true);
  });
});

describe('team honesty', () => {
  test('without team execution the team says it will not hand work over', () => {
    const proposal = compileProposal(inputFor(fullAnswers(), { teamExecutionAvailable: false }));
    expect(proposal.team).not.toBeNull();
    expect(proposal.team?.runnable).toBe(false);
    expect(typeof proposal.team?.notRunnableReason).toBe('string');
    expect(proposal.team?.notRunnableReason?.length).toBeGreaterThan(0);
  });

  for (const variantId of ['restaurant-operations', 'professional-services'] as const) {
    const id: PackVariantId = variantId;
    test(`variant ${id} is honest the same way`, () => {
      const proposal = compileProposal(
        inputFor(fullAnswers(), { variantId: id, teamExecutionAvailable: false }),
      );
      expect(proposal.team?.runnable).toBe(false);
      expect(proposal.team?.notRunnableReason?.length).toBeGreaterThan(0);
    });
  }
});
