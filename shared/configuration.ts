/**
 * The governed configuration contract — revision 1.
 *
 * A Business answers a short questionnaire; this module turns those answers
 * into something a person can review and a host can activate. It is the same
 * shape as `shared/business-setup.ts` on purpose: pure functions over frozen
 * data, imported by both sides, so the screen cannot draw a readiness the host
 * would not agree to.
 *
 * Three ideas carry the whole file.
 *
 * 1. A proposal is a *reference document*, never executable setup. Every field
 *    names something that already exists — an Agent id from `shared/agents.ts`,
 *    a rule scope from `shared/connection-rules.ts`, a route from
 *    `shared/capabilities.ts`, a tool from the harness registry. Nothing here
 *    creates a capability, and nothing here is run.
 *
 * 2. Whatever produced a proposal, it is an untrusted candidate. A model may
 *    map somebody's words onto this shape; `screenCandidate` then treats the
 *    result exactly as it treats a hand-edited file — registered identifiers
 *    and known actions only, no scripts, no URLs, no installers, no secrets and
 *    no model-authored grants. Answers are data. Model output is data.
 *
 * 3. Readiness is computed, not asserted. A missing *required* capability
 *    blocks activation; an optional gap produces an explained degraded plan.
 *    A catalogue entry is not a working connection, and this file will not
 *    report one as though it were.
 *
 * Persistence, staging and activation live in `server/configuration.ts`. This
 * module has no I/O and no clock of its own beyond what a caller hands it.
 */
import {
  AGENT_ARTIFACTS,
  AGENT_REQUIREMENTS,
  type AgentArtifact,
  type AgentRequirement,
} from './agents.js';
import { containsSecretLikeText } from './business-setup.js';
import type { RouteCapabilities } from './capabilities.js';
import type { PermissionChoiceId } from './permissions.js';

export const CONFIGURATION_CONTRACT_VERSION = 1 as const;

/** A bounded explanation. Enough to justify a field, never a reasoning trace. */
export const MAX_WHY = 240;
export const MAX_LABEL = 120;
export const MAX_AGENTS = 8;
export const MAX_RULES = 24;
export const MAX_SELECTION = 64;

// --- provenance ---------------------------------------------------------------

/**
 * Where one field's value came from. `model-suggested` stays distinguishable
 * from `answer` for the same reason `AnswerOrigin` does: a person can see which
 * parts of their setup they actually said, and which parts something inferred.
 */
export type FieldSource = 'answer' | 'template' | 'inherited' | 'model-suggested' | 'default';

export interface Provenance {
  readonly source: FieldSource;
  /** The question this came from, when it came from one. */
  readonly fromQuestion?: string;
  /** One short line saying why this value is here. */
  readonly why: string;
}

// --- the parts of a proposal --------------------------------------------------

/**
 * One organization specialist. It *references* a maintained base definition and
 * may narrow it; it never copies a prompt or invents an Agent. `roleOverride`
 * is guidance carried by the existing instruction channel, and `ceiling` may
 * only ever be at or below the base definition's own ceiling.
 */
export interface ProposedAgent {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentDigest: string;
  /** What this specialist is called inside the business. */
  readonly label: string;
  /** Bounded worker framing on top of the base role. Guidance, not authority. */
  readonly roleOverride: string | null;
  /** A cap at or below the base definition's ceiling. Never a grant. */
  readonly ceiling: PermissionChoiceId;
  readonly provenance: Provenance;
}

/** Durable artifact identities, so a handoff never depends on a prompt string. */
export interface ProposedHandoff {
  readonly from: string;
  readonly to: string;
  readonly artifact: AgentArtifact;
}

/**
 * A Team is a composition of Agents. Where real Team execution is not available
 * for the chosen route, `runnable` is false and the reason says so — the
 * alternative would be drawing collaboration that does not happen.
 */
export interface ProposedTeam {
  readonly id: string;
  readonly name: string;
  /** Agent ids, each of which must also appear in `agents`. */
  readonly members: readonly string[];
  readonly handoffs: readonly ProposedHandoff[];
  readonly runnable: boolean;
  readonly notRunnableReason: string | null;
  readonly provenance: Provenance;
}

/**
 * Rule categories follow the harness contract: guidance shapes behaviour,
 * correction responds to observed failure, enforced policy blocks
 * deterministically. A proposal may only ever carry `guidance` and `correction`;
 * enforced policy belongs to authorized admins and is not something an intake
 * can mint.
 */
export type RuleCategory = 'guidance' | 'correction' | 'enforced';
export const PROPOSABLE_RULE_CATEGORIES: readonly RuleCategory[] = Object.freeze([
  'guidance',
  'correction',
]);

/**
 * The three categories in words. `guidance` and `correction` are our names for
 * them, not a person's, and a review screen that used the ids as headings would
 * be asking someone to learn our vocabulary to read their own setup.
 */
export const RULE_CATEGORY_TEXT: Readonly<Record<RuleCategory, string>> = Object.freeze({
  guidance: 'How the work is done',
  correction: 'What happens when it goes wrong',
  enforced: 'What is not allowed',
});

export interface ProposedRule {
  readonly id: string;
  readonly text: string;
  readonly category: RuleCategory;
  /** Keys from `ruleScopeSchema`. Values are ids, never patterns. */
  readonly scope: Readonly<Record<string, string>>;
  readonly provenance: Provenance;
}

/**
 * Something the job needs to reach. `catalogue` is the honest default: an entry
 * exists, nothing is connected. Only the host may report `connected`, and only
 * from a live connection rather than from this document.
 */
export type ConnectionStatus = 'connected' | 'catalogue' | 'requires-authorization' | 'unsupported';

/**
 * The same four states in words a person reads. The status ids are for the
 * host; a review screen that printed `catalogue` at somebody would be showing
 * them our vocabulary and calling it an explanation.
 */
export const CONNECTION_STATUS_TEXT: Readonly<Record<ConnectionStatus, string>> = Object.freeze({
  connected: 'Connected',
  catalogue: 'Not connected',
  'requires-authorization': 'Waiting for you to allow it',
  unsupported: 'Not supported here',
});

export interface RequiredConnection {
  readonly catalogueId: string;
  readonly label: string;
  readonly status: ConnectionStatus;
  /** Whether the job can still run without it, and how. */
  readonly required: boolean;
  readonly fallback: string | null;
  readonly provenance: Provenance;
}

/**
 * What the job may read. Selections are proposals: the canonical path policy
 * and the existing writer still decide what any effect may touch.
 */
export type ContextKind = 'approved-files' | 'project-folder' | 'pasted-notes';

/** The three kinds in words, for the same reason as the statuses above. */
export const CONTEXT_KIND_TEXT: Readonly<Record<ContextKind, string>> = Object.freeze({
  'approved-files': 'Files you approved',
  'project-folder': 'A folder in this project',
  'pasted-notes': 'Notes typed when it runs',
});

export interface ContextScope {
  readonly id: string;
  readonly label: string;
  readonly kind: ContextKind;
  readonly selection: readonly string[];
  readonly provenance: Provenance;
}

/**
 * Which routes may carry this organization's work. `processing` comes straight
 * from the data-leaving answer, and `local-only` forbids a cloud fallback — a
 * local job must not become cloud-backed because a model went away.
 */
export type ProcessingPolicy = 'local-only' | 'non-sensitive-may-leave' | 'may-leave';

/**
 * What each policy means for the business's information, said the way the
 * question that produced it was asked.
 */
export const PROCESSING_TEXT: Readonly<Record<ProcessingPolicy, string>> = Object.freeze({
  'local-only': 'nothing leaves this computer',
  'non-sensitive-may-leave': 'only material that is not sensitive may leave',
  'may-leave': 'work may leave this computer',
});

export interface ModelPolicy {
  readonly routes: readonly string[];
  readonly processing: ProcessingPolicy;
  readonly fallbackAllowed: boolean;
  readonly provenance: Provenance;
}

/**
 * A proposed upper bound. Children, advisors, reviewers and correction attempts
 * all draw on the parent's budget; delegation cannot mint credit, which is why
 * `sharesParentBudget` is not a choice.
 */
export interface BudgetPolicy {
  readonly monthlyCapUsd: number | null;
  readonly sharesParentBudget: true;
  readonly changeableBy: 'owner' | 'admin';
  readonly provenance: Provenance;
}

/**
 * Approvers and stop-points as *proposals*. Membership decides who may approve;
 * this records who the business said should, and what must always come back to
 * a person first.
 */
export interface ApproverPolicy {
  readonly proposedApprovers: readonly string[];
  /** Ids from the `human-required` question. */
  readonly humanRequired: readonly string[];
  readonly everythingStops: boolean;
  readonly provenance: Provenance;
}

export interface ExpectedOutput {
  readonly id: string;
  readonly label: string;
  readonly artifact: AgentArtifact;
  /** Where the writer puts it. A path proposal, still subject to path policy. */
  readonly destination: string;
  readonly reviewedBy: 'person' | 'person-after-reviewer';
  readonly provenance: Provenance;
}

export type UnresolvedKind =
  | 'unanswered'
  | 'missing-connection'
  | 'unsupported-capability'
  | 'unsupported-schedule'
  | 'needs-authorization';

export interface UnresolvedIssue {
  readonly kind: UnresolvedKind;
  readonly what: string;
  /** What a person can do about it. Never "contact support". */
  readonly next: string;
  /** True when this alone stops activation. */
  readonly blocking: boolean;
}

// --- the proposal -------------------------------------------------------------

export type CandidateOrigin = 'deterministic' | 'model-assisted';

export interface ConfigurationProposal {
  readonly v: 1;
  readonly organizationId: string;
  /** The tenant these answers were recorded under. A proposal cannot cross tenants. */
  readonly tenantId: string;
  readonly questionnaireRevision: number;
  /** The answers this was formed from, so activation cannot outrun them. */
  readonly answersDigest: string;
  readonly previousConfigurationDigest: string | null;
  readonly template: { readonly id: string; readonly version: string; readonly variantId: string };
  readonly agents: readonly ProposedAgent[];
  readonly team: ProposedTeam | null;
  readonly rules: readonly ProposedRule[];
  readonly requiredConnections: readonly RequiredConnection[];
  readonly contextScopes: readonly ContextScope[];
  readonly modelPolicy: ModelPolicy;
  readonly budget: BudgetPolicy;
  readonly approvers: ApproverPolicy;
  readonly expectedOutputs: readonly ExpectedOutput[];
  readonly unresolved: readonly UnresolvedIssue[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly candidateOrigin: CandidateOrigin;
}

// --- the manifest -------------------------------------------------------------

/**
 * `staged` definitions are inactive by construction. Exactly one manifest per
 * organization is `active`; activating a new one supersedes the old one in the
 * same compare-and-set, so there is never a moment with two.
 *
 * **Nothing in this build produces `failed`.** Every refusal happens before a
 * write, so a rejected activation leaves the previous active manifest exactly
 * as it was and records nothing. The state exists for the case that genuinely
 * needs it — a preparation that half-succeeded against something outside this
 * computer, such as an authorization or an invitation, where the durable record
 * is the only way to know what to resume. That step is not implemented, so the
 * state is currently a definition rather than an outcome. `activate` and
 * `rollback` still refuse a `failed` manifest, so implementing it later cannot
 * accidentally make one activatable.
 */
export type ManifestState = 'staged' | 'active' | 'superseded' | 'failed';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly blocking: readonly ValidationProblem[];
  readonly degraded: readonly ValidationProblem[];
  readonly degradedPlan: string | null;
  readonly checkedAt: string;
}

export interface ConfigurationManifest {
  readonly v: 1;
  readonly organizationId: string;
  readonly tenantId: string;
  /** Monotonic per organization. The value activation compares against. */
  readonly revision: number;
  readonly digest: string;
  readonly state: ManifestState;
  readonly proposal: ConfigurationProposal;
  readonly readiness: ReadinessReport;
  readonly stagedAt: string;
  readonly stagedBy: string;
  readonly activatedAt: string | null;
  readonly activatedBy: string | null;
  /** The caller's idempotency key. A replay returns the recorded result. */
  readonly activationId: string | null;
  readonly supersededAt: string | null;
  /** Why a `failed` preparation failed. The previous active setup stayed intact. */
  readonly failureReason: string | null;
}

// --- validation ---------------------------------------------------------------

export type ProblemSeverity = 'blocking' | 'degraded';

export type ProblemCode =
  | 'schema'
  | 'tenant-mismatch'
  | 'unknown-agent'
  | 'stale-agent'
  | 'ceiling-exceeded'
  | 'unknown-rule-scope'
  | 'enforced-rule-proposed'
  | 'unknown-route'
  | 'route-incapable'
  | 'processing-conflict'
  | 'missing-connection'
  | 'handoff-loop'
  | 'handoff-unknown-member'
  | 'handoff-artifact'
  | 'budget-range'
  | 'no-approver'
  | 'scope-empty'
  | 'unsupported-team';

export interface ValidationProblem {
  readonly code: ProblemCode;
  readonly severity: ProblemSeverity;
  /** A dotted path into the proposal, so a screen can point at the field. */
  readonly field: string;
  readonly message: string;
}

/** What an Agent definition looks like to the validator. */
export interface KnownAgent {
  readonly version: string;
  readonly digest: string;
  readonly requires: readonly AgentRequirement[];
  readonly permissionCeiling: PermissionChoiceId;
}

export interface ValidationContext {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly knownAgents: ReadonlyMap<string, KnownAgent>;
  readonly knownRuleScopeKeys: ReadonlySet<string>;
  /** Route id to the requirements that route satisfies. */
  readonly routeRequirements: ReadonlyMap<string, ReadonlySet<AgentRequirement>>;
  /** Routes that may carry work off this computer. */
  readonly remoteRoutes: ReadonlySet<string>;
  /** Connections with a live, authorized connection behind them. */
  readonly connectedConnections: ReadonlySet<string>;
  readonly maxBudgetUsd: number;
  /** False where the Team runtime cannot actually execute a handoff. */
  readonly teamExecutionAvailable: boolean;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly problems: readonly ValidationProblem[];
  readonly degradedPlan: string | null;
}

/**
 * Whether a route can carry work off this computer.
 *
 * `unknown` counts as remote, and that is the whole reason this function exists
 * rather than each caller reading the fact for itself. A capability nobody
 * measured is not evidence that the network stays shut, and reading it as
 * "local" is exactly how a business that asked to keep its information on this
 * computer quietly stops doing so. The cautious reading costs a route; the
 * optimistic one costs the guarantee.
 */
export function routeIsRemote(capabilities: RouteCapabilities): boolean {
  return capabilities.network.answer !== 'no';
}

/**
 * The Agent requirements a route satisfies, read from its own capability facts
 * rather than from a maintained list. An `unknown` answer satisfies nothing:
 * a requirement is met only where the route says so.
 */
export function satisfiedRequirements(capabilities: RouteCapabilities): Set<AgentRequirement> {
  const satisfied = new Set<AgentRequirement>();
  for (const [id, rule] of Object.entries(AGENT_REQUIREMENTS))
    if (capabilities[rule.field].answer === rule.needs) satisfied.add(id as AgentRequirement);
  return satisfied;
}

const CEILING_ORDER: readonly PermissionChoiceId[] = ['review', 'project', 'auto-review', 'full'];
const atOrBelow = (candidate: PermissionChoiceId, cap: PermissionChoiceId) =>
  CEILING_ORDER.indexOf(candidate) <= CEILING_ORDER.indexOf(cap);

/**
 * The permission names the rest of the product uses, kept in the same words so
 * a ceiling on this screen and a choice in Permissions read as the same thing.
 * They are lower-cased here because they appear mid-sentence.
 */
const CEILING_TEXT: Readonly<Record<PermissionChoiceId, string>> = Object.freeze({
  review: 'review changes',
  project: 'work in this project',
  'auto-review': 'approve for me',
  full: 'full access',
});

const problem = (
  code: ProblemCode,
  severity: ProblemSeverity,
  field: string,
  message: string,
): ValidationProblem => ({ code, severity, field, message });

/**
 * Check a proposal against what actually exists. Blocking problems stop
 * activation; degraded problems are explained and let a narrowed setup through.
 *
 * The distinction is not cosmetic. A job that cannot reach its only source is
 * blocked. A job whose *optional* second route is unavailable can still produce
 * a draft a person reads — and the person is told which part of their setup is
 * not running.
 */
export function validateProposal(
  proposal: ConfigurationProposal,
  context: ValidationContext,
): ValidationResult {
  const problems: ValidationProblem[] = [];

  if (proposal.v !== CONFIGURATION_CONTRACT_VERSION)
    problems.push(
      problem('schema', 'blocking', 'v', 'This setup was written by a different build.'),
    );

  if (proposal.tenantId !== context.tenantId || proposal.organizationId !== context.organizationId)
    problems.push(
      problem(
        'tenant-mismatch',
        'blocking',
        'tenantId',
        'This proposal belongs to a different business and cannot be activated here.',
      ),
    );

  // --- agents -----------------------------------------------------------------
  const proposedIds = new Set<string>();
  proposal.agents.forEach((agent, index) => {
    const at = `agents[${index}]`;
    proposedIds.add(agent.agentId);
    const known = context.knownAgents.get(agent.agentId);
    if (!known) {
      problems.push(
        problem('unknown-agent', 'blocking', at, `No Agent named ${agent.agentId} is installed.`),
      );
      return;
    }
    if (known.digest !== agent.agentDigest || known.version !== agent.agentVersion)
      problems.push(
        problem(
          'stale-agent',
          'blocking',
          at,
          `${agent.label} refers to a revision of ${agent.agentId} that has since changed. Review the setup again.`,
        ),
      );
    if (!atOrBelow(agent.ceiling, known.permissionCeiling))
      problems.push(
        problem(
          'ceiling-exceeded',
          'blocking',
          `${at}.ceiling`,
          `${agent.label} asks for more permission than ${agent.agentId} may ever work under.`,
        ),
      );
    if (agent.roleOverride && agent.roleOverride.length > 1200)
      problems.push(problem('schema', 'blocking', `${at}.roleOverride`, 'That role is too long.'));
  });
  if (proposal.agents.length === 0)
    problems.push(
      problem('schema', 'blocking', 'agents', 'A setup needs at least one specialist.'),
    );
  if (proposal.agents.length > MAX_AGENTS)
    problems.push(problem('schema', 'blocking', 'agents', `At most ${MAX_AGENTS} specialists.`));

  // --- team -------------------------------------------------------------------
  if (proposal.team) {
    const team = proposal.team;
    for (const member of team.members)
      if (!proposedIds.has(member))
        problems.push(
          problem(
            'handoff-unknown-member',
            'blocking',
            'team.members',
            `${member} is on the team but is not one of the specialists in this setup.`,
          ),
        );
    team.handoffs.forEach((handoff, index) => {
      const at = `team.handoffs[${index}]`;
      if (!team.members.includes(handoff.from) || !team.members.includes(handoff.to))
        problems.push(
          problem(
            'handoff-unknown-member',
            'blocking',
            at,
            'A handoff names someone off the team.',
          ),
        );
      if (!(AGENT_ARTIFACTS as readonly string[]).includes(handoff.artifact))
        problems.push(problem('handoff-artifact', 'blocking', at, 'That is not a known artifact.'));
    });
    if (hasCycle(team.members, team.handoffs))
      problems.push(
        problem(
          'handoff-loop',
          'blocking',
          'team.handoffs',
          'These handoffs run in a circle, so the work would never finish.',
        ),
      );
    if (team.runnable && !context.teamExecutionAvailable)
      problems.push(
        problem(
          'unsupported-team',
          'blocking',
          'team.runnable',
          'This setup says the team runs, but team execution is not available on this route.',
        ),
      );
  }

  // --- rules ------------------------------------------------------------------
  proposal.rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (rule.category === 'enforced')
      problems.push(
        problem(
          'enforced-rule-proposed',
          'blocking',
          at,
          'Enforced policy is set by an administrator, not by this setup.',
        ),
      );
    for (const key of Object.keys(rule.scope))
      if (!context.knownRuleScopeKeys.has(key))
        problems.push(
          problem('unknown-rule-scope', 'blocking', `${at}.scope`, `${key} is not a rule scope.`),
        );
    if (rule.scope.tenantId && rule.scope.tenantId !== proposal.tenantId)
      problems.push(
        problem('tenant-mismatch', 'blocking', `${at}.scope`, 'A rule points at another business.'),
      );
  });
  if (proposal.rules.length > MAX_RULES)
    problems.push(problem('schema', 'blocking', 'rules', `At most ${MAX_RULES} rules.`));

  // --- routes and processing --------------------------------------------------
  if (proposal.modelPolicy.routes.length === 0)
    problems.push(
      problem(
        'unknown-route',
        'blocking',
        'modelPolicy.routes',
        'No way of running this work was chosen.',
      ),
    );
  const needed = new Set<AgentRequirement>();
  for (const agent of proposal.agents)
    for (const requirement of context.knownAgents.get(agent.agentId)?.requires ?? [])
      needed.add(requirement);
  proposal.modelPolicy.routes.forEach((routeId, index) => {
    const at = `modelPolicy.routes[${index}]`;
    const satisfied = context.routeRequirements.get(routeId);
    if (!satisfied) {
      problems.push(
        problem('unknown-route', 'blocking', at, `${routeId} is not a way of running work here.`),
      );
      return;
    }
    const missing = [...needed].filter((requirement) => !satisfied.has(requirement));
    if (missing.length > 0)
      problems.push(
        problem(
          'route-incapable',
          index === 0 ? 'blocking' : 'degraded',
          at,
          `${routeId} cannot ${missing.join(', ')}, which this setup's specialists need.`,
        ),
      );
    if (proposal.modelPolicy.processing === 'local-only' && context.remoteRoutes.has(routeId))
      problems.push(
        problem(
          'processing-conflict',
          'blocking',
          at,
          `This business keeps its information on this computer, but ${routeId} sends work off it.`,
        ),
      );
  });
  if (proposal.modelPolicy.processing === 'local-only' && proposal.modelPolicy.fallbackAllowed)
    problems.push(
      problem(
        'processing-conflict',
        'blocking',
        'modelPolicy.fallbackAllowed',
        'A local-only setup cannot fall back to a route that sends work away.',
      ),
    );

  // --- connections ------------------------------------------------------------
  proposal.requiredConnections.forEach((connection, index) => {
    const at = `requiredConnections[${index}]`;
    if (context.connectedConnections.has(connection.catalogueId)) return;
    // A catalogue entry is not a working connection.
    problems.push(
      problem(
        'missing-connection',
        connection.required && !connection.fallback ? 'blocking' : 'degraded',
        at,
        connection.fallback
          ? `${connection.label} is not connected. This setup falls back to ${connection.fallback}.`
          : `${connection.label} is not connected yet.`,
      ),
    );
  });

  // --- context, budget, approvers ---------------------------------------------
  proposal.contextScopes.forEach((scope, index) => {
    if (scope.kind !== 'pasted-notes' && scope.selection.length === 0)
      problems.push(
        problem(
          'scope-empty',
          'degraded',
          `contextScopes[${index}]`,
          `${scope.label} has nothing selected yet.`,
        ),
      );
    if (scope.selection.length > MAX_SELECTION)
      problems.push(
        problem(
          'schema',
          'blocking',
          `contextScopes[${index}]`,
          `At most ${MAX_SELECTION} selections.`,
        ),
      );
  });

  const cap = proposal.budget.monthlyCapUsd;
  if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > context.maxBudgetUsd))
    problems.push(
      problem(
        'budget-range',
        'blocking',
        'budget.monthlyCapUsd',
        'That spending limit is out of range.',
      ),
    );

  if (!proposal.approvers.everythingStops && proposal.approvers.humanRequired.length === 0)
    problems.push(
      problem(
        'no-approver',
        'degraded',
        'approvers.humanRequired',
        'Nothing was named as needing a person first, so everything keeps stopping for review.',
      ),
    );

  const blocking = problems.filter((item) => item.severity === 'blocking');
  const degraded = problems.filter((item) => item.severity === 'degraded');
  return {
    ok: blocking.length === 0,
    problems,
    degradedPlan: blocking.length === 0 && degraded.length > 0 ? explainDegraded(degraded) : null,
  };
}

function explainDegraded(degraded: readonly ValidationProblem[]): string {
  const lines = degraded.map((item) => `- ${item.message}`);
  return `This setup can run with less than was asked for:\n${lines.join('\n')}`;
}

/** Depth-first cycle check over the handoff graph. */
function hasCycle(members: readonly string[], handoffs: readonly ProposedHandoff[]): boolean {
  const edges = new Map<string, string[]>();
  for (const member of members) edges.set(member, []);
  for (const handoff of handoffs) edges.get(handoff.from)?.push(handoff.to);
  const state = new Map<string, 0 | 1 | 2>();
  const walk = (node: string): boolean => {
    const seen = state.get(node);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) if (walk(next)) return true;
    state.set(node, 2);
    return false;
  };
  return members.some((member) => walk(member));
}

// --- screening an untrusted candidate -----------------------------------------

/**
 * Text a proposal may never carry, whatever produced it. These are blunt on
 * purpose: a false refusal costs a rephrase, a missed one puts a URL, an
 * installer line or a live key into durable configuration.
 */
const UNSAFE_PATTERNS: readonly { pattern: RegExp; why: string }[] = Object.freeze([
  { pattern: /\bhttps?:\/\//i, why: 'a web address' },
  { pattern: /\bfile:\/\//i, why: 'a direct file location' },
  {
    pattern: /\b(?:npm|pnpm|yarn|pip|pipx|brew|apt|choco|winget|curl|wget|iwr|irm)\s+\S/i,
    why: 'an install or download command',
  },
  {
    pattern: /\b(?:bash|sh|zsh|pwsh|powershell|cmd|node|python)\s+-[a-z]/i,
    why: 'a command line',
  },
  { pattern: /[;&|]{2}|\$\(|<script\b/i, why: 'executable text' },
  {
    pattern: /\b(?:grant|authorise|authorize|allow)\s+(?:all|full|any|every)\b/i,
    why: 'a grant it cannot make',
  },
]);

export type CandidateRefusalCode = 'unsafe-text' | 'secret-like' | 'too-long' | 'grant';

export interface CandidateRefusal {
  readonly code: CandidateRefusalCode;
  readonly field: string;
  readonly message: string;
}

/** Every free-text field a candidate controls, as `[path, text]`. */
function candidateText(proposal: ConfigurationProposal): [string, string][] {
  const out: [string, string][] = [];
  const push = (field: string, value: string | null | undefined) => {
    if (typeof value === 'string' && value.trim() !== '') out.push([field, value]);
  };
  proposal.agents.forEach((agent, i) => {
    push(`agents[${i}].label`, agent.label);
    push(`agents[${i}].roleOverride`, agent.roleOverride);
    push(`agents[${i}].provenance.why`, agent.provenance.why);
  });
  if (proposal.team) {
    push('team.name', proposal.team.name);
    push('team.notRunnableReason', proposal.team.notRunnableReason);
  }
  proposal.rules.forEach((rule, i) => push(`rules[${i}].text`, rule.text));
  proposal.requiredConnections.forEach((connection, i) => {
    push(`requiredConnections[${i}].label`, connection.label);
    push(`requiredConnections[${i}].fallback`, connection.fallback);
  });
  proposal.contextScopes.forEach((scope, i) => {
    push(`contextScopes[${i}].label`, scope.label);
    scope.selection.forEach((item, j) => push(`contextScopes[${i}].selection[${j}]`, item));
  });
  proposal.expectedOutputs.forEach((output, i) => {
    push(`expectedOutputs[${i}].label`, output.label);
    push(`expectedOutputs[${i}].destination`, output.destination);
  });
  proposal.unresolved.forEach((issue, i) => {
    push(`unresolved[${i}].what`, issue.what);
    push(`unresolved[${i}].next`, issue.next);
  });
  return out;
}

/**
 * Treat a proposal as an untrusted candidate. This runs *before* validation and
 * regardless of who wrote it: a model mapping someone's words, an imported pack
 * and a hand-edited file are all screened the same way.
 *
 * It refuses text rather than sanitising it. Silently stripping a URL out of a
 * rule leaves a rule that means something different from what was reviewed.
 */
export function screenCandidate(proposal: ConfigurationProposal): CandidateRefusal[] {
  const refusals: CandidateRefusal[] = [];
  for (const [field, text] of candidateText(proposal)) {
    if (containsSecretLikeText(text))
      refusals.push({
        code: 'secret-like',
        field,
        message:
          'That looks like a key, password or card number. Configuration is stored as plain text.',
      });
    for (const { pattern, why } of UNSAFE_PATTERNS)
      if (pattern.test(text)) {
        refusals.push({
          code: 'unsafe-text',
          field,
          message: `This setup contains ${why}, which configuration may not carry.`,
        });
        break;
      }
    if (text.length > 2000)
      refusals.push({ code: 'too-long', field, message: 'That value is too long to review.' });
  }
  // A candidate cannot mint permission it was not given.
  proposal.agents.forEach((agent, index) => {
    if (!(CEILING_ORDER as readonly string[]).includes(agent.ceiling))
      refusals.push({
        code: 'grant',
        field: `agents[${index}].ceiling`,
        message: 'That is not a permission this build recognises.',
      });
  });
  return refusals;
}

// --- explaining a proposal ----------------------------------------------------

export type ChangeKind = 'new' | 'inherited' | 'changed' | 'removed' | 'unsupported';

/**
 * What a removed row says instead of a value. A removal has no provenance in
 * the new proposal — nothing chose it — so the row explains itself.
 */
export const REMOVED_VALUE = 'No longer part of this setup';
export const REMOVED_WHY =
  'This was in the setup that is running now and is not in the one you are about to turn on.';

export interface ProposalChange {
  readonly field: string;
  readonly kind: ChangeKind;
  readonly label: string;
  readonly was: string | null;
  readonly now: string;
  readonly why: string;
}

interface Row {
  readonly label: string;
  readonly value: string;
  readonly why: string;
}

function summarise(proposal: ConfigurationProposal): Map<string, Row> {
  const rows = new Map<string, Row>();
  const set = (field: string, label: string, value: string, provenance: Provenance) =>
    rows.set(field, { label, value, why: provenance.why });
  for (const agent of proposal.agents)
    set(
      `agent:${agent.agentId}`,
      agent.label,
      // The identity and revision stay exact — they are what changed if this
      // ever reads as `changed` — but the ceiling is said in words, because it
      // is the part of the line that decides what this specialist may do.
      `${agent.agentId} @ ${agent.agentVersion} · at most ${CEILING_TEXT[agent.ceiling]}`,
      agent.provenance,
    );
  if (proposal.team)
    set(
      'team',
      proposal.team.name,
      `${proposal.team.members.join(' -> ')}${proposal.team.runnable ? '' : ' (not runnable yet)'}`,
      proposal.team.provenance,
    );
  for (const rule of proposal.rules)
    set(`rule:${rule.id}`, RULE_CATEGORY_TEXT[rule.category], rule.text, rule.provenance);
  for (const connection of proposal.requiredConnections)
    set(
      `connection:${connection.catalogueId}`,
      connection.label,
      CONNECTION_STATUS_TEXT[connection.status],
      connection.provenance,
    );
  for (const scope of proposal.contextScopes)
    set(
      `context:${scope.id}`,
      scope.label,
      `${CONTEXT_KIND_TEXT[scope.kind]} · ${scope.selection.length} selected`,
      scope.provenance,
    );
  set(
    'modelPolicy',
    'How work runs',
    // The route ids stay as they are: they name real engines a person sees in
    // Settings. The policy beside them does not, because it is our word for
    // what somebody answered about their own information.
    `${proposal.modelPolicy.routes.join(', ')} — ${PROCESSING_TEXT[proposal.modelPolicy.processing]}`,
    proposal.modelPolicy.provenance,
  );
  set(
    'budget',
    'Spending limit',
    proposal.budget.monthlyCapUsd === null
      ? 'None set'
      : `$${proposal.budget.monthlyCapUsd} per month`,
    proposal.budget.provenance,
  );
  set(
    'approvers',
    'What waits for a person',
    proposal.approvers.everythingStops
      ? 'Everything'
      : proposal.approvers.humanRequired.join(', ') || 'Nothing named',
    proposal.approvers.provenance,
  );
  for (const output of proposal.expectedOutputs)
    set(
      `output:${output.id}`,
      output.label,
      `${output.artifact} -> ${output.destination}`,
      output.provenance,
    );
  return rows;
}

/**
 * What a person reads before they activate: what is new, what carried over
 * unchanged, what moved, what is gone, and what this build cannot do.
 *
 * Removals get their own pass over the previous proposal. Walking only the new
 * one is the obvious implementation and the wrong one: every row it produces is
 * correct, and a specialist that was quietly dropped never appears at all. A
 * review that cannot show a removal is not a review.
 *
 * Unresolved issues come through as `unsupported` rather than being folded into
 * the rest, because "we did not build that" and "you changed that" are
 * different sentences.
 */
export function explainProposal(
  previous: ConfigurationProposal | null,
  next: ConfigurationProposal,
): ProposalChange[] {
  const before = previous ? summarise(previous) : new Map<string, Row>();
  const after = summarise(next);
  const changes: ProposalChange[] = [];
  for (const [field, row] of after) {
    const was = before.get(field);
    if (!was)
      changes.push({
        field,
        kind: 'new',
        label: row.label,
        was: null,
        now: row.value,
        why: row.why,
      });
    else if (was.value !== row.value)
      changes.push({
        field,
        kind: 'changed',
        label: row.label,
        was: was.value,
        now: row.value,
        why: row.why,
      });
    else
      changes.push({
        field,
        kind: 'inherited',
        label: row.label,
        was: was.value,
        now: row.value,
        why: row.why,
      });
  }
  for (const [field, row] of before)
    if (!after.has(field))
      changes.push({
        field,
        kind: 'removed',
        label: row.label,
        was: row.value,
        now: REMOVED_VALUE,
        why: REMOVED_WHY,
      });
  for (const issue of next.unresolved)
    changes.push({
      field: `unresolved:${issue.kind}`,
      kind: 'unsupported',
      label: issue.what,
      was: null,
      now: issue.blocking ? 'Blocks activation' : 'Runs without it',
      why: issue.next,
    });
  return changes;
}

// --- the view the host returns ------------------------------------------------

export interface ConfigurationView {
  readonly organization: { readonly id: string; readonly name: string };
  readonly active: ConfigurationManifest | null;
  readonly staged: ConfigurationManifest | null;
  readonly changes: readonly ProposalChange[];
  /** The revision an activation must send back. Null when nothing is active. */
  readonly expectedActiveRevision: number | null;
  readonly canActivate: boolean;
  readonly whyNot: string | null;
}

export const ACTIVATION_CONFLICT =
  'This setup moved while you were reading it. Look at the current one before activating.';
export const ANSWERS_MOVED =
  'The answers changed after this setup was proposed. Review it again so you activate what you read.';
export const ROLLBACK_LIMITS =
  'Going back restores the previous setup on this computer. It cannot undo invitations, connections or anything already sent, and it cannot bring back access that was taken away.';
