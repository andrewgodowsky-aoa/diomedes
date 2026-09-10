/**
 * The weekly-brief pack: one approved-files workflow, two synthetic storefronts.
 *
 * A Business answers a short questionnaire; this pack maps those answers onto
 * the governed configuration shape without adding anything the catalogues do
 * not already contain. The two variants — restaurant-operations and
 * professional-services — exist to prove a point about reuse: they share every
 * authority, evidence, model-policy and recovery decision, and differ only in
 * display labels, default selections, output destinations and the wording of
 * one guidance rule. A second feature was rejected on purpose; the pack is the
 * same primitives, worn twice.
 *
 * Everything here is deterministic data handling: no clock, no randomness, no
 * network. Time and attribution arrive in `CompileInput`, and live Agent facts
 * arrive as a map, so the compiler never invents an Agent revision it was not
 * given. Anything the answers cannot support becomes an unresolved issue a
 * person can read, never a silent downgrade and never fictional access.
 */
import {
  BUSINESS_SETUP_SCHEMA_REVISION,
  QUESTION_BY_ID,
  displayValue,
  type AnswerMap,
  type AnswerValue,
  type BusinessAnswer,
} from './business-setup.js';
import { narrowerPermission, type AgentArtifact } from './agents.js';
import {
  CONFIGURATION_CONTRACT_VERSION,
  MAX_LABEL,
  type ApproverPolicy,
  type BudgetPolicy,
  type ConfigurationProposal,
  type ContextKind,
  type ContextScope,
  type ExpectedOutput,
  type KnownAgent,
  type ModelPolicy,
  type ProcessingPolicy,
  type ProposedAgent,
  type ProposedRule,
  type ProposedTeam,
  type Provenance,
  type RequiredConnection,
  type RuleCategory,
  type UnresolvedIssue,
} from './configuration.js';
import type { PermissionChoiceId } from './permissions.js';

export type PackVariantId = 'restaurant-operations' | 'professional-services';

export const WEEKLY_BRIEF_PACK_ID = 'diomedes.weekly-brief';
export const WEEKLY_BRIEF_PACK_VERSION = '1.0.0';

export interface CompileInput {
  organizationId: string;
  tenantId: string;
  answers: AnswerMap;
  answersDigest: string;
  previousConfigurationDigest: string | null;
  variantId: PackVariantId;
  /** Live Agent facts, keyed by agent id, from AgentRegistry. */
  agents: ReadonlyMap<string, KnownAgent>;
  teamExecutionAvailable: boolean;
  connectedConnections: ReadonlySet<string>;
  at: string;
  by: string;
}

// --- the template and its two storefronts -------------------------------------

/**
 * The only ways the two storefronts may differ. Authority, evidence, model
 * policy and recovery live in the shared base below; this record cannot carry
 * them, which is what makes the variant equivalence structural rather than
 * promised.
 */
export interface WeeklyBriefVariant {
  readonly id: PackVariantId;
  readonly scopeLabel: string;
  readonly scopeSelection: readonly string[];
  readonly outputLabel: string;
  readonly destination: string;
  readonly guidanceText: string;
  /** Lowercase keywords that select this variant from free-text answers. */
  readonly keywords: readonly string[];
}

const RESTAURANT_VARIANT: WeeklyBriefVariant = {
  id: 'restaurant-operations',
  scopeLabel: 'Weekly operations exports',
  scopeSelection: ['weekly-operations-exports'],
  outputLabel: 'Weekly operations brief',
  destination: 'weekly-operations-brief.md',
  // The prohibition is the product rule: a brief must never touch payroll or orders.
  guidanceText:
    'Build the brief from the approved exports only. Cover what changed this week and what is now due, without touching payroll or orders.',
  keywords: [
    'restaurant',
    'cafe',
    'café',
    'bistro',
    'diner',
    'catering',
    'bakery',
    'pizzeria',
    'pizza',
    'brasserie',
    'tavern',
    'grill',
    'eatery',
    'food truck',
    'coffeehouse',
  ],
};

const PROFESSIONAL_VARIANT: WeeklyBriefVariant = {
  id: 'professional-services',
  scopeLabel: 'Weekly brief sources',
  scopeSelection: ['weekly-brief-exports'],
  outputLabel: 'Weekly brief',
  destination: 'weekly-brief.md',
  // Same shape as the restaurant rule: a brief must never sign off licensed work.
  guidanceText:
    'Build the brief from the approved exports only. Cover what changed this week and what is now due, without offering licensed or safety-critical sign-off.',
  // The neutral variant is the default, so it claims no keywords of its own.
  keywords: [],
};

export const WEEKLY_BRIEF_VARIANTS: Readonly<Record<PackVariantId, WeeklyBriefVariant>> =
  Object.freeze({
    'restaurant-operations': RESTAURANT_VARIANT,
    'professional-services': PROFESSIONAL_VARIANT,
  });

export interface WeeklyBriefTemplate {
  readonly id: typeof WEEKLY_BRIEF_PACK_ID;
  readonly version: typeof WEEKLY_BRIEF_PACK_VERSION;
  /** Agent ids the pack references. Revisions always come from the live map. */
  readonly agents: readonly string[];
  readonly team: {
    readonly members: readonly string[];
    readonly artifact: AgentArtifact;
  };
  readonly rules: readonly { readonly id: string; readonly category: RuleCategory }[];
  readonly contextKind: ContextKind;
  readonly expectedOutput: {
    readonly artifact: AgentArtifact;
    readonly reviewedBy: ExpectedOutput['reviewedBy'];
  };
}

/** The frozen pack: everything both variants share, decided once. */
export const WEEKLY_BRIEF_TEMPLATE: WeeklyBriefTemplate = Object.freeze({
  id: WEEKLY_BRIEF_PACK_ID,
  version: WEEKLY_BRIEF_PACK_VERSION,
  agents: Object.freeze(['diomedes.analyst', 'diomedes.reviewer']),
  team: Object.freeze({
    members: Object.freeze(['diomedes.analyst', 'diomedes.reviewer']),
    artifact: 'report.markdown' as AgentArtifact,
  }),
  rules: Object.freeze([
    Object.freeze({ id: 'weekly-brief-guidance', category: 'guidance' as const }),
    Object.freeze({ id: 'weekly-brief-correction', category: 'correction' as const }),
  ]),
  contextKind: 'approved-files',
  expectedOutput: Object.freeze({
    artifact: 'report.markdown' as AgentArtifact,
    reviewedBy: 'person-after-reviewer' as const,
  }),
});

// --- shared base: identical for both variants ----------------------------------

const ANALYST_ID = 'diomedes.analyst';
const REVIEWER_ID = 'diomedes.reviewer';
/** The pack proposes text and stops; nothing here may run or send anything. */
const PACK_CEILING: PermissionChoiceId = 'review';
/** The one job this pack covers. Anything else is still briefed, and said so. */
const COVERED_JOBS: readonly string[] = Object.freeze(['recurring-report']);
/** Routes that keep work on this computer. */
const LOCAL_ROUTES: readonly string[] = Object.freeze(['harness-runtime']);
/** Routes available once the business allows material to leave. */
const CLOUD_ROUTES: readonly string[] = Object.freeze(['harness-runtime', 'claude-code']);
const EXPORT_FALLBACK = 'Work from an approved export you choose instead.';

const PACK_SPECIALISTS: readonly {
  readonly id: string;
  readonly label: string;
  readonly roleOverride: string;
}[] = Object.freeze([
  {
    id: ANALYST_ID,
    label: 'Weekly Operations Analyst',
    roleOverride:
      'Prepare the weekly brief from the selected approved exports only. Name the source of each fact and keep it short enough to read at once.',
  },
  {
    id: REVIEWER_ID,
    label: 'Brief Reviewer',
    roleOverride:
      'Check the brief draft against the selected sources. Hold back anything the sources do not support.',
  },
]);

// --- answer readers ------------------------------------------------------------

function emptyValue(value: AnswerValue): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

const usable = (answer: BusinessAnswer | undefined): boolean =>
  !!answer && !answer.unknown && !emptyValue(answer.value);

/** Free text (or a choice id) when the person actually gave one. */
function textOf(answers: AnswerMap, id: string): string | null {
  const answer = answers[id];
  if (!usable(answer) || typeof answer!.value !== 'string') return null;
  return answer!.value.trim();
}

/** A multi-select answer, or null when it was skipped or left unknown. */
function multiOf(answers: AnswerMap, id: string): readonly string[] | null {
  const answer = answers[id];
  if (!usable(answer) || !Array.isArray(answer!.value)) return null;
  return (answer!.value as unknown[]).map((item) => String(item));
}

function moneyOf(answers: AnswerMap, id: string): number | null {
  const answer = answers[id];
  if (!usable(answer) || typeof answer!.value !== 'number') return null;
  const amount = answer!.value;
  return Number.isFinite(amount) ? amount : null;
}

/** Choose the variant from free text. Nothing matches, so the neutral one wins. */
export function variantFor(answers: AnswerMap): PackVariantId {
  const haystack = `${textOf(answers, 'name') ?? ''} ${textOf(answers, 'industry') ?? ''}`
    .toLowerCase()
    .trim();
  if (haystack === '') return 'professional-services';
  return RESTAURANT_VARIANT.keywords.some((keyword) => haystack.includes(keyword))
    ? 'restaurant-operations'
    : 'professional-services';
}

// --- the compiler ----------------------------------------------------------------

/**
 * The host answer belongs in the scope's provenance, and nowhere else. It is
 * free text somebody typed, so it may or may not already end in a full stop;
 * appending one unconditionally produced "weekdays..".
 */
const withHost = (sentence: string, host: string | null): string =>
  host === null ? sentence : `${sentence} Stated host: ${host.replace(/[.\s]+$/, '')}.`;

const answerWhy = (fromQuestion: string, why: string): Provenance => ({
  source: 'answer',
  fromQuestion,
  why,
});
const templateWhy = (why: string): Provenance => ({ source: 'template', why });
const defaultWhy = (why: string): Provenance => ({ source: 'default', why });

function compileAgents(input: CompileInput, unresolved: UnresolvedIssue[]): ProposedAgent[] {
  const agents: ProposedAgent[] = [];
  for (const specialist of PACK_SPECIALISTS) {
    const known = input.agents.get(specialist.id);
    if (!known) {
      // Never invent a revision: omit the specialist and say plainly it blocks.
      unresolved.push({
        kind: 'unsupported-capability',
        what: `The ${specialist.id} specialist is not installed here.`,
        next: 'Install the listed specialist and review the setup again.',
        blocking: true,
      });
      continue;
    }
    agents.push({
      agentId: specialist.id,
      agentVersion: known.version,
      agentDigest: known.digest,
      label: specialist.label,
      roleOverride: specialist.roleOverride,
      // The live ceiling can only narrow the pack's intent, never widen it.
      ceiling: narrowerPermission(PACK_CEILING, known.permissionCeiling),
      provenance: templateWhy('The weekly brief pack works through these two specialists.'),
    });
  }
  return agents;
}

function compileTeam(input: CompileInput, agents: readonly ProposedAgent[]): ProposedTeam | null {
  const members = agents.map((agent) => agent.agentId);
  if (members.length === 0) return null;
  const bothPresent = members.includes(ANALYST_ID) && members.includes(REVIEWER_ID);
  return {
    id: 'weekly-brief-team',
    name: 'Weekly brief team',
    members,
    // A handoff needs both ends on the team; a lone specialist has no one to hand to.
    handoffs:
      bothPresent && WEEKLY_BRIEF_TEMPLATE.team.artifact
        ? [
            {
              from: ANALYST_ID,
              to: REVIEWER_ID,
              artifact: WEEKLY_BRIEF_TEMPLATE.team.artifact,
            },
          ]
        : [],
    runnable: input.teamExecutionAvailable,
    notRunnableReason: input.teamExecutionAvailable
      ? null
      : members.length > 1
        ? 'The two specialists are configured but will not hand work to each other yet. Ask for each step by hand.'
        : 'The specialist is configured but will not hand work to anyone yet. Ask for each step by hand.',
    provenance: templateWhy('The analyst drafts and the reviewer checks before a person reads it.'),
  };
}

function compileRules(input: CompileInput, variant: WeeklyBriefVariant): ProposedRule[] {
  // Rules stay inside this business: the scope names its tenant and nothing else.
  const scope = Object.freeze({ tenantId: input.tenantId });
  return [
    {
      id: 'weekly-brief-guidance',
      text: variant.guidanceText,
      category: 'guidance',
      scope,
      provenance: templateWhy('The pack shapes the brief and nothing else.'),
    },
    {
      id: 'weekly-brief-correction',
      text: 'When a brief states something the selected sources do not support, correct the draft against the sources before it waits for a person.',
      category: 'correction',
      scope,
      provenance: templateWhy('A correction answers an observed failure in the draft.'),
    },
  ];
}

function compileScope(
  variant: WeeklyBriefVariant,
  job: string | null,
  sources: readonly string[] | null,
  host: string | null,
  unresolved: UnresolvedIssue[],
): ContextScope {
  if (job === 'organise-notes') {
    // That job has no source question: asking where notes live has no useful answer.
    return {
      id: 'weekly-sources',
      label: variant.scopeLabel,
      kind: 'pasted-notes',
      selection: [],
      provenance: answerWhy(
        'job',
        withHost('The brief works from notes provided when it runs.', host),
      ),
    };
  }
  if (sources !== null && (sources.includes('files') || sources.includes('shared-drive')))
    return {
      id: 'weekly-sources',
      label: variant.scopeLabel,
      kind: 'approved-files',
      selection: [...variant.scopeSelection],
      provenance: answerWhy(
        'sources',
        withHost('Reads the approved exports the business chose.', host),
      ),
    };
  if (sources === null)
    unresolved.push({
      kind: 'unanswered',
      what: 'Where the information lives is not described yet.',
      next: 'Name where the information for the brief lives, or choose an approved export when the brief runs.',
      blocking: false,
    });
  if (sources?.includes('paper'))
    unresolved.push({
      kind: 'unanswered',
      what: 'Paper or people have no approved export yet.',
      next: 'Choose an approved export to work from when the brief runs.',
      blocking: false,
    });
  // Nothing selected yet: the validator reports the empty scope as degraded, not blocked.
  return {
    id: 'weekly-sources',
    label: variant.scopeLabel,
    kind: 'approved-files',
    selection: [],
    provenance:
      sources === null
        ? defaultWhy(withHost('No source is named yet, so nothing is selected.', host))
        : answerWhy('sources', withHost('Reads the approved exports the business chose.', host)),
  };
}

function compileConnections(
  input: CompileInput,
  job: string | null,
  sources: readonly string[] | null,
): RequiredConnection[] {
  // No source question, no connections: pasted notes reach nothing at all.
  if (job === 'organise-notes' || sources === null) return [];
  const connections: RequiredConnection[] = [];
  if (sources.includes('business-system'))
    connections.push({
      catalogueId: 'business-system',
      label: 'Business system',
      // A named system is a catalogue entry until a live connection says otherwise.
      status: input.connectedConnections.has('business-system') ? 'connected' : 'catalogue',
      required: false,
      fallback: EXPORT_FALLBACK,
      provenance: answerWhy('sources', 'Named as a source. Naming it does not connect it.'),
    });
  if (sources.includes('email'))
    connections.push({
      catalogueId: 'email',
      label: 'Email',
      status: input.connectedConnections.has('email') ? 'connected' : 'requires-authorization',
      required: false,
      fallback: EXPORT_FALLBACK,
      provenance: answerWhy(
        'sources',
        'Named as a source. It needs authorization before it is read.',
      ),
    });
  return connections;
}

function compileModelPolicy(
  dataLeaving: string | null,
  unresolved: UnresolvedIssue[],
): ModelPolicy {
  const processing: ProcessingPolicy =
    dataLeaving === 'yes'
      ? 'may-leave'
      : dataLeaving === 'non-sensitive'
        ? 'non-sensitive-may-leave'
        : 'local-only';
  if (dataLeaving === null)
    unresolved.push({
      kind: 'unanswered',
      what: 'It is not said whether information may leave this computer.',
      next: 'Answer whether information may leave this computer. Until then it stays on it.',
      blocking: false,
    });
  // Unknown values fall closed with the unanswered ones: the risky routes stay shut.
  const localOnly = processing === 'local-only';
  return {
    routes: localOnly ? [...LOCAL_ROUTES] : [...CLOUD_ROUTES],
    processing,
    fallbackAllowed: !localOnly,
    provenance:
      dataLeaving === null
        ? defaultWhy('Not answered, so the work stays on this computer.')
        : answerWhy('data-leaving', 'Decides which routes may carry the work.'),
  };
}

function compileBudget(spendCap: number | null): BudgetPolicy {
  return {
    monthlyCapUsd: spendCap,
    sharesParentBudget: true,
    // The answer carries no owner for the cap, so the conservative one holds it.
    changeableBy: 'owner',
    provenance:
      spendCap === null
        ? defaultWhy('No spending limit was proposed.')
        : answerWhy('spend-cap', 'A proposed upper bound. It cannot authorise spending.'),
  };
}

function compileApprovers(
  input: CompileInput,
  people: string | null,
  humanAnswers: readonly string[] | null,
  unresolved: UnresolvedIssue[],
): ApproverPolicy {
  // Approvers are a proposal only: membership decides, this merely records.
  const proposedApprovers = people === null ? [] : [input.by];
  if (people === null)
    unresolved.push({
      kind: 'unanswered',
      what: 'Who uses this workspace is not described yet.',
      next: 'Say who uses the workspace and who approves changes to it.',
      blocking: false,
    });
  else if (people !== 'just-me')
    unresolved.push({
      kind: 'unanswered',
      what: 'Who else approves is not named yet.',
      next: 'Name one person to review the brief before it is used.',
      blocking: false,
    });
  const selected = humanAnswers ?? [];
  if (humanAnswers === null)
    unresolved.push({
      kind: 'unanswered',
      what: 'What must wait for a person is not described yet.',
      next: 'Say what must always come back to a person before it happens.',
      blocking: false,
    });
  return {
    proposedApprovers,
    humanRequired: selected.filter((id) => id !== 'everything'),
    everythingStops: selected.includes('everything'),
    provenance:
      people === null
        ? defaultWhy('No one is named yet.')
        : answerWhy('people', 'A proposal about who approves. It invites no one.'),
  };
}

function compileOutput(
  variant: WeeklyBriefVariant,
  job: string | null,
  result: string | null,
  unresolved: UnresolvedIssue[],
): ExpectedOutput {
  const jobDisplay = job === null ? null : displayValue(QUESTION_BY_ID['job'], job);
  if (job === null)
    unresolved.push({
      kind: 'unanswered',
      what: 'The first recurring job is not described yet.',
      next: 'Answer what recurring job Diomedes should help with first.',
      blocking: false,
    });
  else if (!COVERED_JOBS.includes(job))
    unresolved.push({
      kind: 'unsupported-capability',
      what: `The weekly brief pack does not cover ${jobDisplay} yet. It still produces a weekly brief.`,
      next: 'Keep the weekly brief as the first job, or describe the other job again after this setup is active.',
      blocking: false,
    });
  if (result === null)
    unresolved.push({
      kind: 'unanswered',
      what: 'What a useful result looks like is not described yet.',
      next: 'Describe what a useful brief contains and who reads it.',
      blocking: false,
    });
  // The variant's output name always leads, so the label stays variant-specific
  // even when the job and result wording fill the rest of the line.
  const raw =
    result !== null
      ? `${variant.outputLabel} — ${jobDisplay !== null ? `${jobDisplay}: ` : ''}${result}`
      : jobDisplay !== null
        ? `${variant.outputLabel} — ${jobDisplay}`
        : variant.outputLabel;
  return {
    id: 'weekly-brief',
    label: raw.length > MAX_LABEL ? raw.slice(0, MAX_LABEL) : raw,
    artifact: WEEKLY_BRIEF_TEMPLATE.expectedOutput.artifact,
    destination: variant.destination,
    reviewedBy: WEEKLY_BRIEF_TEMPLATE.expectedOutput.reviewedBy,
    provenance:
      result !== null
        ? answerWhy('result', 'What the brief should contain.')
        : job !== null
          ? answerWhy('job', 'The job the brief serves.')
          : defaultWhy('The pack produces a weekly brief.'),
  };
}

/**
 * Map one questionnaire onto a proposal. Same input, same output: every
 * choice below reads the answers, the live Agent map or the variant record,
 * and nothing else.
 */
export function compileProposal(input: CompileInput): ConfigurationProposal {
  const variant = WEEKLY_BRIEF_VARIANTS[input.variantId];
  const answers = input.answers;
  const unresolved: UnresolvedIssue[] = [];

  const job = textOf(answers, 'job');
  const result = textOf(answers, 'result');
  const sources = multiOf(answers, 'sources');
  const people = textOf(answers, 'people');
  const humanAnswers = multiOf(answers, 'human-required');
  const dataLeaving = textOf(answers, 'data-leaving');
  const host = textOf(answers, 'host');
  const spendCap = moneyOf(answers, 'spend-cap');
  const firstRun = textOf(answers, 'first-run');

  const agents = compileAgents(input, unresolved);
  const team = compileTeam(input, agents);
  const output = compileOutput(variant, job, result, unresolved);
  const scope = compileScope(variant, job, sources, host, unresolved);
  const connections = compileConnections(input, job, sources);

  const firstRunDisplay =
    firstRun === null ? null : displayValue(QUESTION_BY_ID['first-run'], firstRun);
  // Manual is the only supported start. A schedule is recorded, and stays off.
  if (firstRun !== null && firstRun !== 'manual')
    unresolved.push({
      kind: 'unsupported-schedule',
      what: `A ${firstRunDisplay} start is recorded but stays inactive.`,
      next: 'Ask for each brief by hand until scheduling is available.',
      blocking: false,
    });

  return {
    v: CONFIGURATION_CONTRACT_VERSION,
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    questionnaireRevision: BUSINESS_SETUP_SCHEMA_REVISION,
    answersDigest: input.answersDigest,
    previousConfigurationDigest: input.previousConfigurationDigest,
    template: {
      id: WEEKLY_BRIEF_PACK_ID,
      version: WEEKLY_BRIEF_PACK_VERSION,
      variantId: input.variantId,
    },
    agents,
    team,
    rules: compileRules(input, variant),
    requiredConnections: connections,
    contextScopes: [scope],
    modelPolicy: compileModelPolicy(dataLeaving, unresolved),
    budget: compileBudget(spendCap),
    approvers: compileApprovers(input, people, humanAnswers, unresolved),
    expectedOutputs: [output],
    unresolved,
    createdAt: input.at,
    createdBy: input.by,
    candidateOrigin: 'deterministic',
  };
}
