/**
 * Adversarial tests for the frozen configuration contract.
 *
 * `shared/configuration.ts` promises three things that are easy to claim and
 * easy to get quietly wrong: that blocking and degraded are a real contract
 * rather than a cosmetic label, that a depth-first walk can tell a cycle from
 * a node it has merely finished, and that a reviewer is shown what actually
 * moved rather than what the walkthrough happened to still visit.
 *
 * Every fixture is built from the real catalogues — the real Agent catalog,
 * the real route capabilities, the real rule scope keys — because a validator
 * checked against invented identifiers proves nothing about the system a
 * person will actually run. The one invented Agent below is a realistic
 * user-added definition, the exact case the contract permits, and even its
 * digest is computed by the real digest function.
 */
import { describe, expect, test } from 'vitest';
import {
  MAX_AGENTS,
  MAX_SELECTION,
  explainProposal,
  REMOVED_VALUE,
  REMOVED_WHY,
  screenCandidate,
  validateProposal,
  type BudgetPolicy,
  type CandidateRefusal,
  type CandidateRefusalCode,
  type ConfigurationProposal,
  type KnownAgent,
  type ModelPolicy,
  type ProblemCode,
  type ProposedAgent,
  type Provenance,
  type ProposedTeam,
  type ValidationContext,
  type ValidationResult,
} from '../shared/configuration.js';
import {
  AGENT_CATALOG,
  AGENT_REQUIREMENTS,
  type AgentDefinition,
  type AgentRequirement,
} from '../shared/agents.js';
import { ROUTE_CAPABILITIES, type RouteCapabilities } from '../shared/capabilities.js';
import { ruleScopeSchema } from '../shared/connection-rules.js';
import type { PermissionChoiceId } from '../shared/permissions.js';
import { BUSINESS_SETUP_SCHEMA_REVISION } from '../shared/business-setup.js';
import { agentDigest } from '../server/agents.js';

const TENANT = 'tenant-ridge';
const ORG = 'org-ridge';
const AT = '2026-09-10T09:00:00.000Z';

const why = (why: string): Provenance => ({ source: 'answer', why });

// --- the live facts a context is honestly derived from ------------------------

/**
 * A route counts as able to carry work off this computer unless it can prove
 * its network stays off. Every provider route answers `unknown`, which is not
 * a proof of anything, so only a firm `no` keeps a route local.
 */
const isRemote = (route: RouteCapabilities): boolean => route.network.answer !== 'no';

/** The requirements a route satisfies, read from the capability facts. */
const satisfiedRequirements = (route: RouteCapabilities): ReadonlySet<AgentRequirement> => {
  const satisfied = new Set<AgentRequirement>();
  for (const [id, rule] of Object.entries(AGENT_REQUIREMENTS))
    if (route[rule.field].answer === rule.needs) satisfied.add(id as AgentRequirement);
  return satisfied;
};

const catalogKnown = (): Map<string, KnownAgent> =>
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

/**
 * No built-in Agent needs shell commands, and no installed route is proved to
 * run them, so the first-route/later-route asymmetry cannot be exercised with
 * the catalogue alone. A user-added specialist that requires shell commands is
 * the realistic way the gap arises, and the contract explicitly allows those.
 */
const shellDefinition: AgentDefinition = {
  protocolVersion: 1,
  id: 'diomedes.shell-worker',
  version: '1.0.0',
  name: 'Shell Worker',
  summary: 'A user-added specialist that runs the commands the job needs.',
  origin: 'user',
  source: 'user:shell-worker.json',
  modes: ['build'],
  role: 'Run the shell commands the task asks for, and nothing else.',
  requires: ['shell-commands'],
  tools: [],
  ruleScopes: ['project'],
  permissionCeiling: 'project',
  models: [],
  handoff: { accepts: [], produces: ['answer.text'] },
  evidence: ['answer.text'],
};
const shellKnown: KnownAgent = {
  version: shellDefinition.version,
  digest: agentDigest(shellDefinition),
  requires: shellDefinition.requires,
  permissionCeiling: shellDefinition.permissionCeiling,
};

// --- fixtures ----------------------------------------------------------------

const refFor = (definition: AgentDefinition, ceiling?: PermissionChoiceId): ProposedAgent => ({
  agentId: definition.id,
  agentVersion: definition.version,
  agentDigest: agentDigest(definition),
  label: definition.name,
  roleOverride: null,
  ceiling: ceiling ?? definition.permissionCeiling,
  provenance: why('Chosen from the catalogue for this job.'),
});

const agentRef = (id: string, ceiling?: PermissionChoiceId): ProposedAgent =>
  refFor(AGENT_CATALOG.find((definition) => definition.id === id)!, ceiling);

const baseTeam: ProposedTeam = {
  id: 'team-weekly-brief',
  name: 'Weekly brief team',
  members: ['diomedes.researcher', 'diomedes.analyst'],
  handoffs: [{ from: 'diomedes.researcher', to: 'diomedes.analyst', artifact: 'findings.list' }],
  runnable: true,
  notRunnableReason: null,
  provenance: why('The brief needs research before it is written.'),
};

const baseProposal: ConfigurationProposal = {
  v: 1,
  organizationId: ORG,
  tenantId: TENANT,
  questionnaireRevision: BUSINESS_SETUP_SCHEMA_REVISION,
  answersDigest: 'sha256:' + 'b'.repeat(64),
  previousConfigurationDigest: null,
  template: { id: 'diomedes.weekly-brief', version: '1.0.0', variantId: 'restaurant-operations' },
  agents: [agentRef('diomedes.researcher'), agentRef('diomedes.analyst')],
  team: baseTeam,
  rules: [
    {
      id: 'brief-keep-short',
      text: 'Keep every draft short enough to read at once.',
      category: 'guidance',
      scope: { projectId: 'ridge-project' },
      provenance: why('The person asked for briefs that fit on one screen.'),
    },
  ],
  requiredConnections: [
    {
      catalogueId: 'email',
      label: 'Email',
      status: 'connected',
      required: false,
      fallback: null,
      provenance: why('The business connected its email during setup.'),
    },
  ],
  contextScopes: [
    {
      id: 'scope-pasted',
      label: 'Pasted notes',
      kind: 'pasted-notes',
      selection: [],
      provenance: why('Notes a person types need no source.'),
    },
    {
      id: 'scope-briefs',
      label: 'Brief folder',
      kind: 'project-folder',
      selection: ['briefs'],
      provenance: why('Where previous briefs live.'),
    },
  ],
  modelPolicy: {
    routes: ['harness-runtime'],
    processing: 'non-sensitive-may-leave',
    fallbackAllowed: false,
    provenance: why('The data-leaving answer allows non-sensitive work to leave.'),
  },
  budget: {
    monthlyCapUsd: 500,
    sharesParentBudget: true,
    changeableBy: 'owner',
    provenance: why('The spend-cap answer, as a proposed upper bound.'),
  },
  approvers: {
    proposedApprovers: ['person-owner'],
    humanRequired: ['sending', 'money'],
    everythingStops: false,
    provenance: why('The human-required answer, before it is confirmed.'),
  },
  expectedOutputs: [
    {
      id: 'weekly-brief',
      label: 'Weekly brief',
      artifact: 'report.markdown',
      destination: 'briefs/weekly.md',
      reviewedBy: 'person',
      provenance: why('The result answer, as a durable output.'),
    },
  ],
  unresolved: [],
  createdAt: AT,
  createdBy: 'person-owner',
  candidateOrigin: 'deterministic',
};

const makeProposal = (overrides: Partial<ConfigurationProposal>): ConfigurationProposal => ({
  ...baseProposal,
  ...overrides,
});

const baseContext = (): ValidationContext => ({
  tenantId: TENANT,
  organizationId: ORG,
  knownAgents: catalogKnown(),
  knownRuleScopeKeys: new Set(Object.keys(ruleScopeSchema.shape)),
  routeRequirements: new Map(
    Object.entries(ROUTE_CAPABILITIES).map(([id, route]) => [id, satisfiedRequirements(route)]),
  ),
  remoteRoutes: new Set(
    Object.keys(ROUTE_CAPABILITIES).filter((id) => isRemote(ROUTE_CAPABILITIES[id]!)),
  ),
  connectedConnections: new Set(['email']),
  maxBudgetUsd: 1000,
  teamExecutionAvailable: true,
});

const makeContext = (overrides: Partial<ValidationContext>): ValidationContext => ({
  ...baseContext(),
  ...overrides,
});

const policy = (overrides: Partial<Omit<ModelPolicy, 'provenance'>>): ModelPolicy => ({
  ...baseProposal.modelPolicy,
  ...overrides,
});

const budget = (monthlyCapUsd: number | null): BudgetPolicy => ({
  monthlyCapUsd,
  sharesParentBudget: true,
  changeableBy: 'owner',
  provenance: why('The owner set a proposed upper bound.'),
});

const withCode = (result: ValidationResult, code: ProblemCode) =>
  result.problems.filter((item) => item.code === code);

// --- the baseline must be clean, or nothing after it means anything ------------

describe('fixtures', () => {
  test('the baseline proposal is clean against the context derived from the real catalogues', () => {
    const result = validateProposal(baseProposal, baseContext());
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.degradedPlan).toBeNull();
    expect(screenCandidate(baseProposal)).toEqual([]);
  });
});

// --- validateProposal ---------------------------------------------------------

describe('validateProposal', () => {
  test('a wrong contract version is a blocking schema problem (1)', () => {
    const result = validateProposal(makeProposal({ v: 2 as 1 }), baseContext());
    expect(result.ok).toBe(false);
    const schema = withCode(result, 'schema');
    expect(schema).toHaveLength(1);
    expect(schema[0]!.severity).toBe('blocking');
    expect(schema[0]!.field).toBe('v');
  });

  test('a proposal for another tenant or organization cannot be activated here (2)', () => {
    for (const overrides of [{ tenantId: 'tenant-other' }, { organizationId: 'org-other' }]) {
      const result = validateProposal(makeProposal(overrides), baseContext());
      expect(result.ok).toBe(false);
      const mismatch = result.problems.find((item) => item.code === 'tenant-mismatch')!;
      expect(mismatch.severity).toBe('blocking');
      expect(mismatch.field).toBe('tenantId');
    }
  });

  test('an unknown agent is refused once, without spurious follow-on problems about it (3)', () => {
    const ghost: ProposedAgent = {
      agentId: 'diomedes.ghost',
      agentVersion: '1.0.0',
      agentDigest: 'sha256:' + 'a'.repeat(64),
      label: 'Ghost Specialist',
      roleOverride: null,
      ceiling: 'review',
      provenance: why('Named in the answers.'),
    };
    const result = validateProposal(
      makeProposal({ agents: [agentRef('diomedes.researcher'), ghost] }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.map((item) => item.code)).toContain('unknown-agent');
    const aboutGhost = result.problems.filter((item) => item.field.startsWith('agents[1]'));
    expect(aboutGhost).toHaveLength(1);
    expect(aboutGhost[0]!.code).toBe('unknown-agent');
    expect(aboutGhost[0]!.severity).toBe('blocking');
  });

  test('a proposal pinned to a stale digest or version is blocked (4)', () => {
    const staleDigest = makeProposal({
      agents: [{ ...agentRef('diomedes.researcher'), agentDigest: 'sha256:' + '0'.repeat(64) }],
      team: null,
    });
    const staleVersion = makeProposal({
      agents: [{ ...agentRef('diomedes.researcher'), agentVersion: '0.9.0' }],
      team: null,
    });
    for (const proposal of [staleDigest, staleVersion]) {
      const result = validateProposal(proposal, baseContext());
      expect(result.ok).toBe(false);
      const stale = withCode(result, 'stale-agent');
      expect(stale).toHaveLength(1);
      expect(stale[0]!.severity).toBe('blocking');
      expect(stale[0]!.field).toBe('agents[0]');
    }
  });

  test('a ceiling above the base definition is blocked; a narrower one is accepted (5)', () => {
    const exceeded = validateProposal(
      makeProposal({ agents: [agentRef('diomedes.general', 'full')], team: null }),
      baseContext(),
    );
    expect(exceeded.ok).toBe(false);
    const ceiling = withCode(exceeded, 'ceiling-exceeded');
    expect(ceiling).toHaveLength(1);
    expect(ceiling[0]!.severity).toBe('blocking');
    expect(ceiling[0]!.field).toBe('agents[0].ceiling');

    const narrowed = validateProposal(
      makeProposal({ agents: [agentRef('diomedes.general', 'review')], team: null }),
      baseContext(),
    );
    expect(narrowed.problems.map((item) => item.code)).not.toContain('ceiling-exceeded');
    expect(narrowed.problems).toEqual([]);
  });

  test('zero agents and more than eight agents are blocking schema problems (6)', () => {
    const empty = validateProposal(makeProposal({ agents: [], team: null }), baseContext());
    expect(empty.ok).toBe(false);
    const emptyAt = empty.problems.find((item) => item.field === 'agents')!;
    expect(emptyAt.code).toBe('schema');
    expect(emptyAt.severity).toBe('blocking');

    const tooMany = validateProposal(
      makeProposal({
        agents: [
          ...AGENT_CATALOG.map((definition) => agentRef(definition.id)),
          agentRef('diomedes.general'),
        ],
        team: null,
      }),
      baseContext(),
    );
    expect(tooMany.problems).toHaveLength(1);
    expect(tooMany.problems[0]!.code).toBe('schema');
    expect(tooMany.problems[0]!.severity).toBe('blocking');
    expect(tooMany.problems[0]!.field).toBe('agents');
    expect(tooMany.problems[0]!.message).toContain(`${MAX_AGENTS}`);
  });

  test('a team member who is not one of the specialists is refused (7)', () => {
    const result = validateProposal(
      makeProposal({
        agents: [agentRef('diomedes.researcher'), agentRef('diomedes.analyst')],
        team: {
          ...baseTeam,
          members: ['diomedes.researcher', 'diomedes.analyst', 'diomedes.reviewer'],
        },
      }),
      baseContext(),
    );
    const unknown = withCode(result, 'handoff-unknown-member');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe('blocking');
    expect(unknown[0]!.field).toBe('team.members');
  });

  test('a handoff naming someone off the team is refused (8)', () => {
    const result = validateProposal(
      makeProposal({
        agents: [agentRef('diomedes.researcher'), agentRef('diomedes.analyst')],
        team: {
          ...baseTeam,
          handoffs: [
            { from: 'diomedes.reviewer', to: 'diomedes.analyst', artifact: 'review.verdict' },
          ],
        },
      }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const at = result.problems.find((item) => item.field === 'team.handoffs[0]')!;
    expect(at.code).toBe('handoff-unknown-member');
    expect(at.severity).toBe('blocking');
  });

  test('a genuine handoff cycle is blocked, and a diamond is not mistaken for one (9)', () => {
    const cycled = validateProposal(
      makeProposal({
        agents: [agentRef('diomedes.researcher'), agentRef('diomedes.general')],
        team: {
          ...baseTeam,
          members: ['diomedes.researcher', 'diomedes.general'],
          handoffs: [
            { from: 'diomedes.general', to: 'diomedes.researcher', artifact: 'answer.text' },
            { from: 'diomedes.researcher', to: 'diomedes.general', artifact: 'answer.text' },
          ],
        },
      }),
      baseContext(),
    );
    expect(cycled.ok).toBe(false);
    const loop = withCode(cycled, 'handoff-loop');
    expect(loop).toHaveLength(1);
    expect(loop[0]!.severity).toBe('blocking');
    expect(loop[0]!.field).toBe('team.handoffs');

    const diamond = validateProposal(
      makeProposal({
        agents: [
          agentRef('diomedes.general'),
          agentRef('diomedes.architect'),
          agentRef('diomedes.debugger'),
          agentRef('diomedes.reviewer'),
        ],
        team: {
          ...baseTeam,
          members: [
            'diomedes.general',
            'diomedes.architect',
            'diomedes.debugger',
            'diomedes.reviewer',
          ],
          handoffs: [
            { from: 'diomedes.general', to: 'diomedes.architect', artifact: 'answer.text' },
            { from: 'diomedes.general', to: 'diomedes.debugger', artifact: 'answer.text' },
            { from: 'diomedes.architect', to: 'diomedes.reviewer', artifact: 'plan.markdown' },
            { from: 'diomedes.debugger', to: 'diomedes.reviewer', artifact: 'proposal.text' },
          ],
        },
      }),
      baseContext(),
    );
    expect(diamond.ok).toBe(true);
    expect(diamond.problems).toEqual([]);
  });

  test('a team that claims to run where team execution does not exist is blocked (10)', () => {
    const result = validateProposal(
      makeProposal({}),
      makeContext({ teamExecutionAvailable: false }),
    );
    expect(result.ok).toBe(false);
    const team = withCode(result, 'unsupported-team');
    expect(team).toHaveLength(1);
    expect(team[0]!.severity).toBe('blocking');
    expect(team[0]!.field).toBe('team.runnable');
  });

  test('a proposal cannot mint enforced policy (11)', () => {
    const result = validateProposal(
      makeProposal({ rules: [{ ...baseProposal.rules[0]!, category: 'enforced' }] }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const enforced = withCode(result, 'enforced-rule-proposed');
    expect(enforced).toHaveLength(1);
    expect(enforced[0]!.severity).toBe('blocking');
    expect(enforced[0]!.field).toBe('rules[0]');
  });

  test('a scope key the rule service does not know is refused (12)', () => {
    const result = validateProposal(
      makeProposal({ rules: [{ ...baseProposal.rules[0]!, scope: { bananas: 'yellow' } }] }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const unknown = withCode(result, 'unknown-rule-scope');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe('blocking');
    expect(unknown[0]!.field).toBe('rules[0].scope');
  });

  test('a rule pointing at another tenant is refused (13)', () => {
    const result = validateProposal(
      makeProposal({
        rules: [{ ...baseProposal.rules[0]!, scope: { tenantId: 'tenant-other' } }],
      }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const mismatch = withCode(result, 'tenant-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.severity).toBe('blocking');
    expect(mismatch[0]!.field).toBe('rules[0].scope');
  });

  test('no route chosen and an unknown route named are both refused (14)', () => {
    const none = validateProposal(
      makeProposal({ modelPolicy: policy({ routes: [] }) }),
      baseContext(),
    );
    expect(none.ok).toBe(false);
    const noneAt = none.problems.find((item) => item.field === 'modelPolicy.routes')!;
    expect(noneAt.code).toBe('unknown-route');
    expect(noneAt.severity).toBe('blocking');

    const unknown = validateProposal(
      makeProposal({ modelPolicy: policy({ routes: ['not-a-route'] }) }),
      baseContext(),
    );
    expect(unknown.ok).toBe(false);
    const unknownAt = unknown.problems.find((item) => item.field === 'modelPolicy.routes[0]')!;
    expect(unknownAt.code).toBe('unknown-route');
    expect(unknownAt.severity).toBe('blocking');
  });

  test('an incapable first route blocks; the same shortfall on a later route only degrades (15)', () => {
    const context = makeContext({
      knownAgents: new Map([...catalogKnown(), ['diomedes.shell-worker', shellKnown]]),
    });
    const result = validateProposal(
      makeProposal({
        agents: [refFor(shellDefinition, 'project')],
        team: null,
        modelPolicy: policy({ routes: ['harness-runtime', 'codex'] }),
      }),
      context,
    );
    expect(result.ok).toBe(false);
    const incapable = withCode(result, 'route-incapable');
    expect(incapable).toHaveLength(2);
    expect(incapable[0]).toMatchObject({ severity: 'blocking', field: 'modelPolicy.routes[0]' });
    expect(incapable[1]).toMatchObject({ severity: 'degraded', field: 'modelPolicy.routes[1]' });
  });

  test('local-only processing cannot name a remote route (16)', () => {
    const result = validateProposal(
      makeProposal({ modelPolicy: policy({ routes: ['codex'], processing: 'local-only' }) }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const conflict = withCode(result, 'processing-conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.severity).toBe('blocking');
    expect(conflict[0]!.field).toBe('modelPolicy.routes[0]');
  });

  test('local-only processing cannot fall back off the computer, even with every route local (17)', () => {
    const result = validateProposal(
      makeProposal({
        modelPolicy: policy({
          routes: ['harness-runtime'],
          processing: 'local-only',
          fallbackAllowed: true,
        }),
      }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const conflict = withCode(result, 'processing-conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.severity).toBe('blocking');
    expect(conflict[0]!.field).toBe('modelPolicy.fallbackAllowed');
  });

  test('a required connection with no fallback blocks; with a fallback it degrades; connected is silent (18)', () => {
    const crm = (fallback: string | null) => ({
      catalogueId: 'crm',
      label: 'Our CRM',
      status: 'catalogue' as const,
      required: true,
      fallback,
      provenance: why('The job reads customer records.'),
    });

    const blocked = validateProposal(
      makeProposal({ requiredConnections: [crm(null)] }),
      baseContext(),
    );
    expect(blocked.ok).toBe(false);
    const missing = withCode(blocked, 'missing-connection');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.severity).toBe('blocking');
    expect(missing[0]!.field).toBe('requiredConnections[0]');

    const degraded = validateProposal(
      makeProposal({ requiredConnections: [crm('Notes a person collects')] }),
      baseContext(),
    );
    expect(degraded.ok).toBe(true);
    const noted = withCode(degraded, 'missing-connection');
    expect(noted).toHaveLength(1);
    expect(noted[0]!.severity).toBe('degraded');

    const connected = validateProposal(
      makeProposal({ requiredConnections: [crm(null)] }),
      makeContext({ connectedConnections: new Set(['email', 'crm']) }),
    );
    expect(connected.problems).toEqual([]);
  });

  test('an empty selection is explained for file scopes and allowed for pasted notes (19)', () => {
    const scope = (kind: 'approved-files' | 'pasted-notes') => ({
      id: 'scope-1',
      label: 'Working notes',
      kind,
      selection: [] as readonly string[],
      provenance: why('The person picked where the material lives.'),
    });

    const empty = validateProposal(
      makeProposal({ contextScopes: [scope('approved-files')] }),
      baseContext(),
    );
    expect(empty.ok).toBe(true);
    const scopeProblem = withCode(empty, 'scope-empty');
    expect(scopeProblem).toHaveLength(1);
    expect(scopeProblem[0]!.severity).toBe('degraded');
    expect(scopeProblem[0]!.field).toBe('contextScopes[0]');

    const notes = validateProposal(
      makeProposal({ contextScopes: [scope('pasted-notes')] }),
      baseContext(),
    );
    expect(notes.problems.map((item) => item.code)).not.toContain('scope-empty');
  });

  test('a selection longer than the bound is a blocking schema problem (20)', () => {
    const result = validateProposal(
      makeProposal({
        contextScopes: [
          {
            id: 'scope-many',
            label: 'Working notes',
            kind: 'project-folder',
            selection: Array.from({ length: MAX_SELECTION + 1 }, (_, index) => `note-${index}`),
            provenance: why('The person selected their material.'),
          },
        ],
      }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    const at = result.problems.find((item) => item.field === 'contextScopes[0]')!;
    expect(at.code).toBe('schema');
    expect(at.severity).toBe('blocking');
    expect(at.message).toContain(`${MAX_SELECTION}`);
  });

  test('a spending cap must be null or a whole number within the ceiling (21)', () => {
    for (const cap of [-1, 100.5, 2000]) {
      const result = validateProposal(makeProposal({ budget: budget(cap) }), baseContext());
      expect(result.ok).toBe(false);
      const range = withCode(result, 'budget-range');
      expect(range).toHaveLength(1);
      expect(range[0]!.severity).toBe('blocking');
      expect(range[0]!.field).toBe('budget.monthlyCapUsd');
    }
    const unlimited = validateProposal(makeProposal({ budget: budget(null) }), baseContext());
    expect(unlimited.ok).toBe(true);
    expect(unlimited.problems.map((item) => item.code)).not.toContain('budget-range');
  });

  test('nothing named as needing a person first is explained, not fatal (22)', () => {
    const result = validateProposal(
      makeProposal({
        approvers: { ...baseProposal.approvers, everythingStops: false, humanRequired: [] },
      }),
      baseContext(),
    );
    expect(result.ok).toBe(true);
    const approver = withCode(result, 'no-approver');
    expect(approver).toHaveLength(1);
    expect(approver[0]!.severity).toBe('degraded');
    expect(approver[0]!.field).toBe('approvers.humanRequired');
  });
});

// --- the blocking/degraded contract -------------------------------------------

describe('the blocking and degraded contract', () => {
  test('only degraded problems: the plan runs with less, and names what runs without it (23)', () => {
    const result = validateProposal(
      makeProposal({
        contextScopes: [
          {
            id: 'scope-1',
            label: 'Working notes',
            kind: 'approved-files',
            selection: [],
            provenance: why('The person picked where the material lives.'),
          },
        ],
        approvers: { ...baseProposal.approvers, everythingStops: false, humanRequired: [] },
      }),
      baseContext(),
    );
    const degraded = result.problems.filter((item) => item.severity === 'degraded');
    expect(degraded.length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(true);
    expect(result.degradedPlan).not.toBeNull();
    for (const item of degraded) expect(result.degradedPlan).toContain(item.message);
  });

  test('any blocking problem: no degraded plan is offered at all (24)', () => {
    const result = validateProposal(
      makeProposal({
        budget: budget(-1),
        contextScopes: [
          {
            id: 'scope-1',
            label: 'Working notes',
            kind: 'approved-files',
            selection: [],
            provenance: why('The person picked where the material lives.'),
          },
        ],
      }),
      baseContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.degradedPlan).toBeNull();
  });
});

// --- screenCandidate ----------------------------------------------------------

describe('screenCandidate', () => {
  const expectRefusal = (
    refusals: readonly CandidateRefusal[],
    code: CandidateRefusalCode,
    field: string,
  ) => {
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.code).toBe(code);
    expect(refusals[0]!.field).toBe(field);
  };

  test('a URL, an installer, a command line and a script tag are each refused at their own field (25, 29)', () => {
    expectRefusal(
      screenCandidate(
        makeProposal({
          rules: [
            {
              ...baseProposal.rules[0]!,
              text: 'Summaries cite https://example.com/page as the source.',
            },
          ],
        }),
      ),
      'unsafe-text',
      'rules[0].text',
    );

    expectRefusal(
      screenCandidate(
        makeProposal({
          agents: [{ ...agentRef('diomedes.general'), label: 'npm install left-pad' }],
        }),
      ),
      'unsafe-text',
      'agents[0].label',
    );

    expectRefusal(
      screenCandidate(
        makeProposal({
          contextScopes: [
            {
              id: 'scope-1',
              label: 'Pasted notes',
              kind: 'pasted-notes',
              selection: ['bash -c collect the notes'],
              provenance: why('Notes a person types need no source.'),
            },
          ],
        }),
      ),
      'unsafe-text',
      'contextScopes[0].selection[0]',
    );

    expectRefusal(
      screenCandidate(
        makeProposal({
          expectedOutputs: [
            {
              ...baseProposal.expectedOutputs[0]!,
              destination: 'briefs/<script>alert(1)</script>.html',
            },
          ],
        }),
      ),
      'unsafe-text',
      'expectedOutputs[0].destination',
    );
  });

  test('a secret-shaped value is refused, not stored (26)', () => {
    expectRefusal(
      screenCandidate(
        makeProposal({
          rules: [{ ...baseProposal.rules[0]!, text: 'sk-live-abcdefghijklmnopqrst' }],
        }),
      ),
      'secret-like',
      'rules[0].text',
    );
  });

  test('a ceiling value this build does not recognise is refused as a grant it cannot make (27)', () => {
    expectRefusal(
      screenCandidate(
        makeProposal({
          agents: [{ ...agentRef('diomedes.general'), ceiling: 'root' as PermissionChoiceId }],
        }),
      ),
      'grant',
      'agents[0].ceiling',
    );
  });

  test('a value too long to review is refused (28)', () => {
    expectRefusal(
      screenCandidate(
        makeProposal({
          rules: [{ ...baseProposal.rules[0]!, text: 'a'.repeat(2001) }],
        }),
      ),
      'too-long',
      'rules[0].text',
    );
  });

  test('screening a clean proposal refuses nothing and touches nothing (30)', () => {
    const before = JSON.parse(JSON.stringify(baseProposal));
    expect(screenCandidate(baseProposal)).toEqual([]);
    expect(JSON.parse(JSON.stringify(baseProposal))).toEqual(before);
  });
});

// --- explainProposal ----------------------------------------------------------

describe('explainProposal', () => {
  test('against nothing, every row is new (31)', () => {
    const rows = explainProposal(null, baseProposal);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.kind === 'new')).toBe(true);
  });

  test('an unchanged proposal is inherited throughout (32)', () => {
    const rows = explainProposal(baseProposal, { ...baseProposal });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.kind === 'inherited')).toBe(true);
  });

  test('a moved ceiling, budget and route list are reported with what they were (33)', () => {
    const changedCeiling = explainProposal(
      makeProposal({ agents: [agentRef('diomedes.general')], team: null }),
      makeProposal({ agents: [agentRef('diomedes.general', 'review')], team: null }),
    );
    const moved = changedCeiling.filter((row) => row.kind === 'changed');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.field).toBe('agent:diomedes.general');
    expect(moved[0]!.was).toBe('diomedes.general @ 1.0.0 · at most approve for me');
    expect(moved[0]!.now).toBe('diomedes.general @ 1.0.0 · at most review changes');

    const changedBudget = explainProposal(baseProposal, makeProposal({ budget: budget(null) }));
    const budgetRow = changedBudget.find((row) => row.field === 'budget')!;
    expect(budgetRow.kind).toBe('changed');
    expect(budgetRow.was).toBe('$500 per month');
    expect(budgetRow.now).toBe('None set');

    const changedRoutes = explainProposal(
      baseProposal,
      makeProposal({ modelPolicy: policy({ routes: ['harness-runtime', 'sample'] }) }),
    );
    const routeRow = changedRoutes.find((row) => row.field === 'modelPolicy')!;
    expect(routeRow.kind).toBe('changed');
    expect(routeRow.was).toBe('harness-runtime — only material that is not sensitive may leave');
    expect(routeRow.now).toBe(
      'harness-runtime, sample — only material that is not sensitive may leave',
    );
  });

  test('a removed agent is reported as removed, not silently dropped (34)', () => {
    const rows = explainProposal(
      makeProposal({
        agents: [agentRef('diomedes.general'), agentRef('diomedes.researcher')],
        team: null,
      }),
      makeProposal({ agents: [agentRef('diomedes.general')], team: null }),
    );
    // The first pass over this contract walked the next proposal only, which
    // meant a dropped specialist left no row of any kind and a reviewer was
    // never told it was gone. Removals now get their own pass.
    const gone = rows.find((row) => row.field === 'agent:diomedes.researcher');
    expect(gone).toMatchObject({ kind: 'removed', now: REMOVED_VALUE, why: REMOVED_WHY });
    expect(gone?.was).toContain('diomedes.researcher');
    // A removal must not also appear as something that carried over.
    expect(rows.filter((row) => row.field === 'agent:diomedes.researcher')).toHaveLength(1);
  });

  test('every unresolved issue becomes exactly one unsupported row (35)', () => {
    const rows = explainProposal(
      null,
      makeProposal({
        unresolved: [
          {
            kind: 'missing-connection',
            what: 'The CRM is not connected.',
            next: 'Connect the CRM, or run without it.',
            blocking: true,
          },
          {
            kind: 'unsupported-schedule',
            what: 'A weekly schedule is not built yet.',
            next: 'Start it manually for now.',
            blocking: false,
          },
        ],
      }),
    );
    const unsupported = rows.filter((row) => row.kind === 'unsupported');
    expect(unsupported).toHaveLength(2);
    expect(unsupported.map((row) => row.field)).toEqual([
      'unresolved:missing-connection',
      'unresolved:unsupported-schedule',
    ]);
    const blocking = unsupported.find((row) => row.field === 'unresolved:missing-connection')!;
    const tolerated = unsupported.find((row) => row.field === 'unresolved:unsupported-schedule')!;
    expect(blocking.now).toBe('Blocks activation');
    expect(tolerated.now).toBe('Runs without it');
    expect(blocking.now).not.toBe(tolerated.now);
  });
});
