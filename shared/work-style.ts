import type { EngineModel, Mode } from './types.js';
import { EFFORT_ORDER, effortFor, effortRank } from './effort.js';
import { routeDisplayName } from './engines.js';

/**
 * A WorkStyle is how much care a thread asks for, in words a person without a
 * model vocabulary can choose between (NC-2026-09-22.1). It is not a permission
 * mode, a model id, a payer or a persona: Ask, Plan, Build and Fix keep their
 * restrictions under every style, a style never grants a tool, and the route
 * (and so who pays) is whatever the thread is already on. The style only picks,
 * from the models that route already offers, which one leads and how hard it
 * reasons.
 */
export const WORK_STYLES = ['efficient', 'focused', 'thorough'] as const;
export type WorkStyle = (typeof WORK_STYLES)[number];

/** The one place the styles are named. Rename here and every surface follows. */
export const WORK_STYLE_LABELS: Record<WorkStyle, string> = {
  efficient: 'Efficient',
  focused: 'Focused',
  thorough: 'Thorough',
};

/** One plain line each, for the picker. */
export const WORK_STYLE_DESCRIPTIONS: Record<WorkStyle, string> = {
  efficient: 'Quick and low cost. Everyday conversation, brainstorming and intake.',
  focused: 'Steady, careful work on a task that needs attention.',
  thorough: 'The most care, for demanding reasoning and checks.',
};

/**
 * The style a thread follows when neither it nor Settings names one. Null keeps
 * every existing thread on the model its route already runs (the Settings
 * default or the engine's own); an owner decision can make one style the
 * managed default here.
 */
export const DEFAULT_WORK_STYLE: WorkStyle | null = null;

export function isWorkStyle(value: unknown): value is WorkStyle {
  return typeof value === 'string' && (WORK_STYLES as readonly string[]).includes(value);
}

/**
 * The models a style is written in terms of. None of these is an id: each is
 * matched against the list the selected route itself reported, so a route that
 * does not list one simply does not have it.
 */
export type LogicalModel = 'luna' | 'sol' | 'muse-standard' | 'opus-5.5' | 'astra' | 'terra';

export const LOGICAL_MODEL_NAMES: Record<LogicalModel, string> = {
  luna: 'Luna',
  sol: 'Sol',
  'muse-standard': 'Muse Standard',
  'opus-5.5': 'Opus 5.5',
  astra: 'Astra',
  terra: 'Terra',
};

/**
 * How each logical model is recognised in a route's own list: by slug or
 * display name. Catalogue order is kept, so where a route lists two Lunas
 * (`gpt-6-luna`, `gpt-5.6-luna`) the one the route ranks first wins.
 * Muse Standard deliberately excludes the Contributor tier, which trades a
 * customer's data for price and is never a default (Pillar 09).
 */
const MATCHERS: Record<LogicalModel, (m: EngineModel) => boolean> = {
  luna: (m) => /(^|[^a-z])luna([^a-z]|$)/i.test(`${m.slug} ${m.name}`),
  sol: (m) => /(^|[^a-z])sol([^a-z]|$)/i.test(`${m.slug} ${m.name}`),
  'muse-standard': (m) =>
    /(^|[^a-z])muse([^a-z]|$)/i.test(`${m.slug} ${m.name}`) &&
    !/contributor/i.test(`${m.slug} ${m.name}`),
  // Claude Code reports either the `opus` shorthand or a dated id, and only
  // names the version in its display name or description. An Opus that names
  // another version is not Opus 5.5.
  'opus-5.5': (m) => {
    const all = `${m.slug} ${m.name} ${m.description}`;
    if (!/opus/i.test(all)) return false;
    const version = all.match(/opus[\s_-]*(\d+(?:[.-]\d+)?)/i)?.[1];
    return version === undefined || version.replace('-', '.') === '5.5';
  },
  astra: (m) => /(^|[^a-z])astra([^a-z]|$)/i.test(`${m.slug} ${m.name}`),
  terra: (m) => /(^|[^a-z])terra([^a-z]|$)/i.test(`${m.slug} ${m.name}`),
};

/**
 * Which logical models may lead each style, best first. The first entry is the
 * owner's named preference; any later entry is a qualified alternative used
 * only when the route lacks the first, and the result says it was substituted.
 * Nothing below a style's tier appears in its list, so a missing preferred
 * model never quietly becomes a weaker one: it becomes a question.
 */
export const STYLE_LEADS: Record<WorkStyle, readonly LogicalModel[]> = {
  efficient: ['luna', 'muse-standard'],
  focused: ['sol'],
  thorough: ['opus-5.5', 'astra', 'terra'],
};

/** Where a style's reasoning starts, before the mode and the task move it. */
export const STYLE_BASE_EFFORT: Record<WorkStyle, string> = {
  efficient: 'low',
  focused: 'medium',
  thorough: 'high',
};

export type TaskKind = 'greeting' | 'ordinary' | 'demanding';

const GREETING =
  /^(hi|hello|hey|hiya|yo|thanks|thank you|thx|ok|okay|cool|great|good (morning|afternoon|evening|night)|morning|bye|goodbye|see you)( there| again| nectovia| all)?[\s!.,?:)]*$/i;

/**
 * A rough reading of what one message asks for. A greeting or a thank-you is
 * cheap in every style; a long, many-part message is demanding. Everything
 * else is ordinary. This only moves effort and, for a greeting, which model
 * answers; it never changes what the thread may do.
 */
export function classifyTask(text: string | null | undefined): TaskKind {
  const t = (text ?? '').trim();
  if (!t) return 'ordinary';
  if (t.length <= 40 && GREETING.test(t)) return 'greeting';
  const lines = t.split(/\n+/).filter((line) => line.trim()).length;
  if (t.length > 1200 || lines > 12) return 'demanding';
  return 'ordinary';
}

export interface WorkStyleInput {
  /** The thread's style, or null to follow the route's saved default. */
  style: WorkStyle | null | undefined;
  mode: Mode;
  /** Any route id, including ones this module has never heard of. */
  route: string;
  /** Exactly what the route reported. Nothing outside this list is ever returned. */
  availableModels: readonly EngineModel[];
  hints?: { text?: string | null; kind?: TaskKind };
  /** An explicit expert choice for this thread. It always wins over the style. */
  pin?: { model: string; effort?: string | null } | null;
  /** The route's default saved in Settings: a model the person already authorized. */
  savedModel?: string | null;
  /** The person asked for lower cost; lets Focused lead with Muse Standard. */
  preferLowerCost?: boolean;
  /** Policy approves Muse Standard as Focused's backup when Sol is missing. */
  backupApproved?: boolean;
  /** Policy lets a demanding Efficient task move up to Sol. */
  escalationApproved?: boolean;
  /**
   * The route may run its own default when it has listed nothing yet. True
   * only for ChatGPT, which writes its list after its first run.
   */
  routeDefaultAllowed?: boolean;
  /**
   * Effort must not move with the message: a model-API conversation binds its
   * effort into the saved context, so it follows style and mode only.
   */
  stableEffort?: boolean;
}

export interface WorkStyleResolution {
  /** `ask`: nothing qualified is offered, so the person chooses; nothing is sent. */
  outcome: 'run' | 'ask';
  /** A slug from `availableModels`, or null for the route's own default. */
  model: string | null;
  effort: string | null;
  /** One plain sentence for the details line. */
  reason: string;
  /**
   * Null when the style chose. Every call in a run is its lead call today —
   * nothing here delegates substeps — so a pin covers all of them.
   */
  pinScope: 'lead-only' | 'all-calls' | null;
  /** True when the route lacked the preferred model and a qualified other ran. */
  substituted: boolean;
  /** How the model was chosen, in the attribution record's own words. */
  selection: 'manual' | 'automatic' | 'runtime-default';
  style: WorkStyle | null;
  logical: LogicalModel | null;
  kind: TaskKind;
  /** A demanding Efficient task that could move up to Sol with approval. */
  escalation: 'applied' | 'needs-approval' | null;
}

function find(models: readonly EngineModel[], logical: LogicalModel): EngineModel | undefined {
  return models.find(MATCHERS[logical]);
}

/** Which logical model a listed model is, if any. */
export function logicalModelOf(model: EngineModel): LogicalModel | null {
  for (const logical of Object.keys(MATCHERS) as LogicalModel[])
    if (MATCHERS[logical](model)) return logical;
  return null;
}

function step(effort: string, by: number): string {
  const rank = effortRank(effort);
  if (rank === -1) return effort;
  return EFFORT_ORDER[Math.max(0, Math.min(EFFORT_ORDER.length - 1, rank + by))];
}

/**
 * Hold a wanted level to what the model offers: the highest level it lists at
 * or below the one wanted, else its lowest. A model that lists no ladder (every
 * route but ChatGPT and AWS today) takes no level at all.
 */
function fit(model: EngineModel | undefined, wanted: string): string | null {
  if (!model) return null;
  const ids = model.efforts.map((e) => e.id);
  if (ids.length === 0) return null;
  if (ids.includes(wanted)) return wanted;
  const rank = effortRank(wanted);
  const below = ids
    .filter((id) => effortRank(id) !== -1 && effortRank(id) <= rank)
    .sort((a, b) => effortRank(b) - effortRank(a));
  return below[0] ?? ids[0];
}

function inferEffort(
  style: WorkStyle,
  mode: Mode,
  kind: TaskKind,
  model: EngineModel | undefined,
): string | null {
  let wanted = STYLE_BASE_EFFORT[style];
  if (kind === 'greeting') wanted = 'low';
  else {
    if (mode === 'plan') wanted = step(wanted, 1);
    if (kind === 'demanding') wanted = step(wanted, 1);
  }
  const fitted = fit(model, wanted);
  if (fitted === null) return null;
  // Fix keeps its ceiling under every style: the smallest change, not a deeper one.
  return fit(model, effortFor(mode, fitted, fitted));
}

function routeLabel(route: string): string {
  return routeDisplayName(route) || route;
}

/**
 * Turn a style into the model and reasoning level one request runs with, using
 * only what the route offers. Pure: the same input always gives the same
 * answer, and the answer never names a model the route did not list.
 */
export function resolveWorkStyle(input: WorkStyleInput): WorkStyleResolution {
  const models = input.availableModels;
  const style = input.style ?? null;
  const kind = input.hints?.kind ?? classifyTask(input.hints?.text);
  const effortKind: TaskKind = input.stableEffort ? 'ordinary' : kind;
  const base = { style, kind, escalation: null } as const;

  // 1. An explicit pin always wins, and is never swapped for something else.
  if (input.pin?.model) {
    const listed = models.find((m) => m.slug === input.pin!.model);
    if (models.length > 0 && !listed)
      return {
        ...base,
        outcome: 'ask',
        model: null,
        effort: null,
        reason: `The chosen model ${input.pin.model} is no longer offered on ${routeLabel(input.route)}. Choose another model or return to a style.`,
        pinScope: 'all-calls',
        substituted: false,
        selection: 'manual',
        logical: null,
      };
    const wanted = input.pin.effort ?? listed?.defaultEffort ?? null;
    return {
      ...base,
      outcome: 'run',
      model: input.pin.model,
      effort: wanted === null ? null : effortFor(input.mode, wanted, wanted),
      reason: 'Chosen model. It runs every call in this thread.',
      pinScope: 'all-calls',
      substituted: false,
      selection: 'manual',
      logical: listed ? logicalModelOf(listed) : null,
    };
  }

  // 2. No style: the route's saved default, or the engine's own.
  if (style === null) {
    const saved = input.savedModel ? models.find((m) => m.slug === input.savedModel) : undefined;
    return {
      ...base,
      outcome: 'run',
      model: input.savedModel ?? null,
      effort: saved?.defaultEffort ?? null,
      reason: input.savedModel ? 'The default saved in Settings.' : 'The engine’s own default.',
      pinScope: null,
      substituted: false,
      selection: input.savedModel ? 'manual' : 'runtime-default',
      logical: saved ? logicalModelOf(saved) : null,
    };
  }

  const label = WORK_STYLE_LABELS[style];
  const leads = STYLE_LEADS[style];
  let chain: { logical: LogicalModel; substitute: boolean }[] = leads.map((logical, i) => ({
    logical,
    substitute: i > 0,
  }));
  let escalation: WorkStyleResolution['escalation'] = null;
  if (style === 'focused') {
    if (input.preferLowerCost) chain = [{ logical: 'muse-standard', substitute: false }, ...chain];
    else if (input.backupApproved) chain = [...chain, { logical: 'muse-standard', substitute: true }];
  }
  if (style === 'efficient' && kind === 'demanding' && find(models, 'sol')) {
    if (input.escalationApproved) {
      chain = [{ logical: 'sol', substitute: false }, ...chain];
      escalation = 'applied';
    } else escalation = 'needs-approval';
  }
  // A greeting is cheap in every style: the cheapest qualified model answers it.
  if (kind === 'greeting' && style !== 'efficient')
    chain = [
      { logical: 'luna', substitute: false },
      { logical: 'muse-standard', substitute: false },
      ...chain,
    ];

  for (const link of chain) {
    const model = find(models, link.logical);
    if (!model) continue;
    const name = LOGICAL_MODEL_NAMES[link.logical];
    const reason =
      kind === 'greeting' && style !== 'efficient' && !leads.includes(link.logical)
        ? `${label}, answering a greeting cheaply with ${name}.`
        : escalation === 'applied' && link.logical === 'sol'
          ? `${label}, moved up to Sol for a demanding task within approved limits.`
          : link.substitute
            ? `${label} prefers ${LOGICAL_MODEL_NAMES[leads[0]]}, which ${routeLabel(input.route)} does not offer; ${name} is the qualified alternative.`
            : escalation === 'needs-approval'
              ? `${label} with ${name}. This task could move up to Sol with approval.`
              : `${label} with ${name}.`;
    return {
      ...base,
      escalation,
      outcome: 'run',
      model: model.slug,
      effort: inferEffort(style, input.mode, effortKind, model),
      reason,
      pinScope: null,
      substituted: link.substitute,
      selection: 'automatic',
      logical: link.logical,
    };
  }

  // Efficient is the floor: any model the person already authorized for this
  // route is at least as capable, so the saved default qualifies.
  if (style === 'efficient' && input.savedModel) {
    const saved = models.find((m) => m.slug === input.savedModel);
    if (saved || models.length === 0)
      return {
        ...base,
        escalation,
        outcome: 'run',
        model: input.savedModel,
        effort: inferEffort(style, input.mode, effortKind, saved),
        reason: `${label} prefers Luna, which ${routeLabel(input.route)} does not offer; the default saved in Settings runs instead.`,
        pinScope: null,
        substituted: true,
        selection: 'automatic',
        logical: saved ? logicalModelOf(saved) : null,
      };
  }

  // A route that has listed nothing yet cannot be shown to lack anything. Only
  // a route whose own default is allowed runs it; the rest ask.
  if (models.length === 0 && input.routeDefaultAllowed)
    return {
      ...base,
      escalation,
      outcome: 'run',
      model: null,
      effort: null,
      reason: `${routeLabel(input.route)} has not listed its models yet, so its own default runs.`,
      pinScope: null,
      substituted: true,
      selection: 'runtime-default',
      logical: null,
    };

  const wanted = leads.map((l) => LOGICAL_MODEL_NAMES[l]).join(' or ');
  return {
    ...base,
    escalation,
    outcome: 'ask',
    model: null,
    effort: null,
    reason: `${label} needs ${wanted}, which ${routeLabel(input.route)} does not offer. Choose a model under Advanced, another style or another route.`,
    pinScope: null,
    substituted: false,
    selection: 'automatic',
    logical: null,
  };
}
