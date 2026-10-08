/**
 * A Diomedes Agent: a versioned, capability-aware, policy-governed worker
 * identity that runs through interchangeable compatible models.
 *
 * The person picks an Agent, and nothing else decides the kind of work: there is
 * no mode control (DIO-292, Andrew 2026-10-07: "we can use agents instead ...
 * each of those roles have abilities or tools stripped"). Auto is not an Agent;
 * it picks one for each message (`server/agent-pick.ts`). A Model is
 * interchangeable intelligence, and a Team is a composition of Agents.
 *
 * An Agent composes the systems that already exist; it does not restate them.
 * Concretely, every field below is a *reference*:
 *
 * - modes            -> the kind of run it does: its first entry, one of the run
 *                       kinds in `server/modes.ts`, which own the instructions,
 *                       the effort ceiling and Fix's three tries. The kind's
 *                       default Agent (DEFAULT_AGENT) runs on exactly that text.
 * - requires         -> `shared/capabilities.ts` ROUTE_CAPABILITIES facts.
 * - tools            -> the read tools it may use, by the host-run names in
 *                       `server/harness/capabilities/read-scope-tools.ts`. They
 *                       narrow a turn's read scope and never widen it; an Agent
 *                       that lists none reads with its kind's own tools.
 * - ruleScopes       -> `server/rules.ts` scope names.
 * - permissionCeiling-> `shared/permissions.ts` choices, as a *maximum*, never a grant.
 * - models           -> engine catalogue slugs, as a preference, never a lock.
 * - handoff          -> durable artifact identities, so Team orchestration never
 *                       depends on a prompt string.
 *
 * `summary` is the one line the Agent menu shows, in the app's voice. `role` is
 * the worker framing: a non-default Agent sends it with each message
 * (`server/agent-framing.ts`), and loops and the reviewer send it as their
 * guidance. It is guidance, not authority.
 *
 * Changing Agent or Model never grants authority. Trust and Permissions remain
 * authoritative, and a resolution records what is permitted rather than
 * deciding it.
 */
import type { Mode } from './types.js';
import { ROUTE_CAPABILITIES, type RouteCapabilities } from './capabilities.js';
import type { PermissionChoiceId } from './permissions.js';
import type { ProfileResolution } from './agent-profiles.js';

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_MAX_ROLE = 1200;
export const AGENT_MAX_DEFINITIONS = 64;

/**
 * What an Agent needs the execution route to be able to do. Each requirement
 * names one honest capability fact and the answer it needs, so compatibility is
 * computed from the same evidence the permission options use.
 */
export const AGENT_REQUIREMENTS = {
  'text-proposals': {
    field: 'storeOnlyWrites',
    needs: 'yes',
    label: 'Propose text file changes through the recorded writer',
  },
  'no-secret-access': {
    field: 'receivesSecrets',
    needs: 'no',
    label: 'Run without receiving credentials',
  },
  'interceptable-effects': {
    field: 'preExecutionInterception',
    needs: 'yes',
    label: 'Let Diomedes see an effect before it happens',
  },
  'proven-effects': {
    field: 'effectProof',
    needs: 'yes',
    label: 'Prove which effect was applied',
  },
  'revocable-effects': {
    field: 'revocationStopsFutureEffects',
    needs: 'yes',
    label: 'Stop future effects when a grant is revoked',
  },
  'shell-commands': {
    field: 'runsShellCommands',
    needs: 'yes',
    label: 'Run shell commands',
  },
  'network-access': {
    field: 'network',
    needs: 'yes',
    label: 'Reach the network from the run',
  },
  'isolated-environment': {
    field: 'osSandbox',
    needs: 'yes',
    label: 'Run inside an isolated environment',
  },
} as const satisfies Record<
  string,
  { field: keyof RouteCapabilities; needs: 'yes' | 'no'; label: string }
>;
export type AgentRequirement = keyof typeof AGENT_REQUIREMENTS;

/** Durable artifact identities for handoff. Never a prompt string. */
export const AGENT_ARTIFACTS = [
  'answer.text',
  'plan.markdown',
  'proposal.text',
  'findings.list',
  'review.verdict',
  'report.markdown',
] as const;
export type AgentArtifact = (typeof AGENT_ARTIFACTS)[number];

export interface AgentDefinition {
  readonly protocolVersion: 1;
  /** Stable identity. Built-ins are namespaced `diomedes.<name>`. */
  readonly id: string;
  readonly version: string;
  /** The job identity a person recognises, not a system label. */
  readonly name: string;
  readonly summary: string;
  readonly origin: 'built-in' | 'user' | 'project';
  /** Where this definition came from, for provenance. */
  readonly source: string;
  /** The kind of run it does, first. A built-in lists exactly one; an added file
   * may list more, and runs as its first. `auto` is never a member. */
  readonly modes: readonly Exclude<Mode, 'auto'>[];
  /** Worker framing, carried by the existing instruction channel. Guidance only. */
  readonly role: string;
  readonly requires: readonly AgentRequirement[];
  /**
   * The read tools it may use, by their host-run names. They narrow a turn's read
   * scope and never widen it (`server/agent-tools.ts`); none means its kind's own.
   */
  readonly tools: readonly string[];
  /** Rule scope names evaluated by the existing rules service. */
  readonly ruleScopes: readonly string[];
  /** The highest permission choice this Agent may ever work under. A cap, not a grant. */
  readonly permissionCeiling: PermissionChoiceId;
  /** Preference order of model slugs. Absence means the runtime default. */
  readonly models: readonly string[];
  readonly handoff: {
    readonly accepts: readonly AgentArtifact[];
    readonly produces: readonly AgentArtifact[];
  };
  /** What its work is expected to leave behind. */
  readonly evidence: readonly AgentArtifact[];
  /**
   * An internal worker loops and teams use. Never in the Agent menu, never picked
   * by Auto, and not part of the digest.
   */
  readonly internal?: true;
}

const CEILING_ORDER: readonly PermissionChoiceId[] = ['review', 'project', 'auto-review', 'full'];
/** The narrower of two choices. Selecting an Agent may restrict, never widen. */
export function narrowerPermission(
  a: PermissionChoiceId,
  b: PermissionChoiceId,
): PermissionChoiceId {
  return CEILING_ORDER.indexOf(a) <= CEILING_ORDER.indexOf(b) ? a : b;
}

const agent = (
  input: Omit<AgentDefinition, 'protocolVersion' | 'origin' | 'source' | 'version'> &
    Partial<Pick<AgentDefinition, 'version'>>,
): AgentDefinition => ({
  protocolVersion: 1,
  version: input.version ?? '1.0.0',
  origin: 'built-in',
  source: 'diomedes.catalog',
  ...input,
});

const ALL_MODES: readonly Exclude<Mode, 'auto'>[] = ['ask', 'plan', 'build', 'fix'];
const READ_ONLY: readonly AgentRequirement[] = ['no-secret-access'];
/**
 * What a worker that proposes changes needs from the route: a recorded writer
 * and no credentials. It deliberately stops there.
 *
 * Whether those changes may then be applied automatically is a Trust question,
 * answered by a scope grant in `server/trust/scope-grants.ts`, which already
 * refuses every route that cannot intercept, prove and revoke an effect. Repeating
 * those conditions here would build a second policy layer that could disagree
 * with the first, and would stop a route from proposing work for exact review -
 * which every text route can do safely.
 */
const WRITER: readonly AgentRequirement[] = ['text-proposals', 'no-secret-access'];

/** The host-run file tools every reading Agent keeps. */
const READ_TOOLS = ['list_files', 'read_file', 'search_files'] as const;

/**
 * The built-in catalog, in menu order. Names are job identities on purpose: a
 * person picks Reviewer, not a skill list, an MCP server or a rule id. The four
 * that replace the modes keep their ids, so saved threads, profiles and
 * resolutions still name them. Names aren't final, so nothing else spells them.
 */
export const AGENT_CATALOG: readonly AgentDefinition[] = [
  agent({
    id: 'diomedes.researcher',
    version: '2.0.0',
    name: 'Researcher',
    summary: "Answers questions from your files and the web. Doesn't change anything.",
    modes: ['ask'],
    role: 'Answer only from the selected documents and name the document each fact came from. Say plainly when the documents do not answer the question. Never guess to fill a gap.',
    requires: READ_ONLY,
    tools: [...READ_TOOLS, 'fetch_page', 'connector_read'],
    ruleScopes: ['project'],
    permissionCeiling: 'review',
    models: [],
    handoff: { accepts: [], produces: ['answer.text', 'findings.list'] },
    evidence: ['answer.text'],
  }),
  agent({
    id: 'diomedes.architect',
    version: '2.0.0',
    name: 'Planner',
    summary: 'Lays out the steps before any work starts.',
    modes: ['plan'],
    role: 'Establish the approach before the change. Name the trade-offs, the order of work and what would make the approach wrong. Produce a plan, not an implementation.',
    requires: READ_ONLY,
    tools: [...READ_TOOLS, 'fetch_page', 'connector_read'],
    ruleScopes: ['project'],
    permissionCeiling: 'review',
    models: [],
    handoff: { accepts: ['answer.text', 'findings.list'], produces: ['plan.markdown'] },
    evidence: ['plan.markdown'],
  }),
  agent({
    id: 'diomedes.builder',
    version: '2.0.0',
    name: 'Builder',
    summary: 'Makes the changes you ask for.',
    modes: ['build'],
    role: 'Make the change that was asked for and nothing else. Keep each file complete and reviewable, and say what changed in each one.',
    requires: WRITER,
    tools: [],
    ruleScopes: ['project'],
    permissionCeiling: 'auto-review',
    models: [],
    handoff: { accepts: ['plan.markdown', 'findings.list'], produces: ['proposal.text'] },
    evidence: ['proposal.text'],
  }),
  agent({
    id: 'diomedes.debugger',
    version: '2.0.0',
    name: 'Fixer',
    summary: "Finds why something's broken and fixes just that.",
    modes: ['fix'],
    role: 'Find the cause of the one failure described, then change as little as possible to fix exactly that. Say why the change fixes it. Improve nothing else.',
    requires: WRITER,
    tools: [],
    ruleScopes: ['project'],
    permissionCeiling: 'auto-review',
    models: [],
    handoff: { accepts: ['findings.list', 'answer.text'], produces: ['proposal.text'] },
    evidence: ['proposal.text'],
  }),
  agent({
    id: 'diomedes.reviewer',
    version: '2.0.0',
    name: 'Reviewer',
    summary: 'Checks a change against what you asked for.',
    modes: ['ask'],
    role: 'Check the change set against what was asked. Hold anything back that a person would want to see first. You never apply a change yourself.',
    // A reviewer must not be able to become the writer, whatever scope exists.
    requires: READ_ONLY,
    tools: [...READ_TOOLS],
    ruleScopes: ['project'],
    permissionCeiling: 'review',
    models: [],
    handoff: { accepts: ['proposal.text'], produces: ['review.verdict', 'findings.list'] },
    evidence: ['review.verdict'],
  }),
  agent({
    id: 'diomedes.explorer',
    version: '2.0.0',
    name: 'Explorer',
    summary: 'Finds where things are in your project and how they connect.',
    modes: ['ask'],
    role: 'Locate the relevant material and describe how it fits together. Report what is there, with its locations, rather than judging or changing it.',
    requires: READ_ONLY,
    tools: [...READ_TOOLS],
    ruleScopes: ['project'],
    permissionCeiling: 'review',
    models: [],
    handoff: { accepts: [], produces: ['findings.list', 'answer.text'] },
    evidence: ['findings.list'],
  }),
  agent({
    id: 'diomedes.analyst',
    version: '2.0.0',
    name: 'Analyst',
    summary: 'Turns your sales reports and spreadsheets into numbers and charts.',
    modes: ['ask'],
    role: 'Work out the numbers asked for, using only the selected files and the connectors you can read. Lead with the totals and what changed, and use a chart where the numbers read better as one. Never invent a number.',
    requires: READ_ONLY,
    tools: [...READ_TOOLS, 'connector_read'],
    ruleScopes: ['project'],
    permissionCeiling: 'review',
    models: [],
    handoff: { accepts: ['findings.list', 'answer.text'], produces: ['report.markdown'] },
    evidence: ['report.markdown'],
  }),
  agent({
    id: 'diomedes.writer',
    name: 'Writer',
    summary: 'Drafts letters, emails and documents for you to edit.',
    modes: ['build'],
    role: 'Draft the letter, email or document that was asked for as a new text file the person can edit. Match the tone they asked for and keep it short. You never send anything.',
    requires: WRITER,
    tools: [],
    ruleScopes: ['project'],
    permissionCeiling: 'auto-review',
    models: [],
    handoff: {
      accepts: ['answer.text', 'plan.markdown', 'findings.list'],
      produces: ['proposal.text'],
    },
    evidence: ['proposal.text'],
  }),
  agent({
    id: 'diomedes.general',
    name: 'General Assistant',
    summary: 'Handles ordinary requests in this project without a specialism.',
    modes: ALL_MODES,
    role: 'Work on what was asked, in this project, without assuming a specialism. Prefer the plainest useful answer or change.',
    requires: WRITER,
    tools: [],
    ruleScopes: ['project'],
    permissionCeiling: 'auto-review',
    models: [],
    handoff: {
      accepts: ['answer.text', 'plan.markdown', 'findings.list'],
      produces: ['answer.text', 'proposal.text'],
    },
    evidence: ['answer.text', 'proposal.text'],
    internal: true,
  }),
];

/** A kind of run an Agent does. Auto is a choice, never a kind an Agent does. */
export type WorkMode = Exclude<Mode, 'auto'>;
export const AUTO_AGENT = 'auto';
/** Auto's line in every Agent menu. */
export const AUTO_SUMMARY = 'Picks the right agent for each message.';
/**
 * Each kind's default Agent: the one its kind's instructions already describe.
 * It sends no framing of its own, a thread saved before agents reads its mode as
 * this Agent, and an Auto request with no pick resolves to it.
 */
export const DEFAULT_AGENT: Record<WorkMode, string> = {
  ask: 'diomedes.researcher',
  plan: 'diomedes.architect',
  build: 'diomedes.builder',
  fix: 'diomedes.debugger',
};
/** The kind of run an Agent does: its first mode. */
export function runKindOf(definition: Pick<AgentDefinition, 'modes'>): WorkMode {
  return definition.modes[0];
}
/** The Agents a person can pick, in catalog order: never an internal one. */
export function listedAgents<T extends { readonly internal?: true }>(items: readonly T[]): T[] {
  return items.filter((item) => !item.internal);
}

export interface AgentCompatibility {
  readonly ok: boolean;
  readonly unmet: readonly { readonly requirement: AgentRequirement; readonly detail: string }[];
}
/** Computed from the honest route capability facts, never from a preference. */
export function agentCompatibility(
  definition: AgentDefinition,
  routeId: string,
): AgentCompatibility {
  const route = ROUTE_CAPABILITIES[routeId];
  if (!route)
    return {
      ok: false,
      unmet: definition.requires.map((requirement) => ({
        requirement,
        detail: `${routeId} is not a known execution route.`,
      })),
    };
  const unmet: { requirement: AgentRequirement; detail: string }[] = [];
  for (const requirement of definition.requires) {
    const rule = AGENT_REQUIREMENTS[requirement];
    const fact = route[rule.field] as { answer: string; evidence: string };
    if (fact.answer !== rule.needs)
      unmet.push({
        requirement,
        detail: `${route.name} cannot ${rule.label.toLowerCase()}: ${fact.evidence}`,
      });
  }
  return { ok: unmet.length === 0, unmet };
}

/**
 * A resolved execution snapshot: which Agent, which model, which route, and
 * what policy said at that moment. It records authority; it never confers it,
 * which is why `grantsAuthority` is a literal `false` in the type.
 */
export interface AgentResolution {
  readonly protocolVersion: 1;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentName: string;
  readonly agentOrigin: AgentDefinition['origin'];
  readonly agentDigest: string;
  /** Whether the person named this Agent or Auto chose it. */
  readonly agentSelection: 'manual' | 'automatic';
  readonly requestedAgentId: string | null;
  readonly mode: Mode;
  readonly routeId: string;
  readonly requestedModel: string | null;
  readonly modelSelection: 'manual' | 'automatic' | 'runtime-default';
  readonly compatible: boolean;
  readonly unmet: readonly { readonly requirement: string; readonly detail: string }[];
  readonly policy: {
    /** The Agent's own cap. */
    readonly agentCeiling: PermissionChoiceId;
    /** What the person has actually granted for this task right now. */
    readonly granted: PermissionChoiceId;
    /** The narrower of the two: what this run may do. */
    readonly effective: PermissionChoiceId;
    readonly grantId: string | null;
    readonly grantsAuthority: false;
  };
  /**
   * The Agent profile revision this run resolved, pinned at admission (H09).
   * Absent when no profile decided the run. Never recomputed afterwards.
   */
  readonly profile?: ProfileResolution;
  readonly resolvedAt: string;
}
