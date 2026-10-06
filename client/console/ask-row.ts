import type {
  Conversation,
  EngineModel,
  IntegrationStatus,
  Mode,
  Route,
  Settings,
  Turn,
} from '../../shared/types';
import type { EngineConnection } from '../../shared/engines';
import { CONVERSATION_ROUTES, isExternalEngine, isRoute, routeDisplayName } from '../../shared/engines';
import { NECTOVIA_ROUTE } from '../../shared/model-api';
import { LOCAL_MODEL_ROUTE } from '../../shared/local-model';
import { isFoundEngine } from '../../shared/conversation-engines';
import { MODE_CEILING, effortFor } from '../../shared/effort';
import {
  DEFAULT_WORK_STYLE,
  WORK_STYLES,
  WORK_STYLE_DESCRIPTIONS,
  WORK_STYLE_LABELS,
  isWorkStyle,
  type WorkStyle,
} from '../../shared/work-style';
import { CONTEXT_SECTION_LABELS, formatTokens } from '../../shared/context-accounting';
import { jobTierOf } from '../../shared/job-caps';

/**
 * The ask box's row (round 2 board N4): Engine, then Model or tier, then Effort on an engine
 * other than Nectovia, then Agent, then the context ring. Everything here is derived from what
 * the host reports: the integrations, the engine connections and catalogues, the thread record
 * and the host's answer for the next request. No model name, effort level or default is typed
 * into the app (Andrew, 2026-10-03: "do not hardcode model names, they must be inferred
 * automatically"). The words for the effort ladder are the one exception, and an engine's level
 * outside them reads as itself.
 */

/** The engines a thread can move to from the row, in the order a person reads them. */
export const ROW_ENGINES = ['codex', 'claude-code', 'opencode', 'oh-my-pi', 'cursor', 'devin'] as const;
/**
 * The engines the Nectovia conversation's row lists after Nectovia (round 2 reskin, slice 2): the
 * conversation routes, not the project engines. Nectovia leads the menu on its own and the local
 * model has its own place, so neither is in this list.
 */
export const CONVERSATION_ENGINES: readonly Route[] = CONVERSATION_ROUTES.filter(
  (id) => id !== NECTOVIA_ROUTE && id !== LOCAL_MODEL_ROUTE,
);

export const LOCAL_MODEL = 'Local model';
export const NECTOVIA_LOCKED = 'Buy credits or upgrade your plan to use Nectovia';
export const NOT_RUNNING = 'Not running';
export const LOCAL_STOPPED = "The local model isn't running. Start it on this computer, or choose a tier.";
/** The free version has no tiers to fall back on, so the way out is another engine. */
export const LOCAL_STOPPED_FREE = "The local model isn't running. Start it on this computer, or choose another engine.";
/** Another of the model's profiles is loaded, so this one needs its own Start. */
export const LOCAL_OTHER = 'The local model is running another profile. Start this one, or choose a tier.';
export const LOCAL_OTHER_FREE = 'The local model is running another profile. Start this one, or choose another engine.';
export const START = 'Start';
/** The Start inside an open menu, beside the grayed choice it wakes. */
export const START_LOCAL = 'Start the local model';
export const STARTING = 'Starting the local model.';

const EFFORT_WORDS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** An effort level as a person reads it. A level the ladder does not know keeps its own name. */
export function effortWord(id: string): string {
  return EFFORT_WORDS[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
}

/**
 * A model running on this computer, offered as a Nectovia option (DIO-201).
 *
 * The contract a binding meets to light it up (Andrew, 2026-10-03: the binding's lane adds the
 * entry): an integration with `kind: 'local'`, a ready adapter and an id that is a route, with
 * `found` saying the model is set up on this computer and `available` saying it is running.
 * The app never calls a loopback address and never names a model: the host's integration status
 * says whether it runs, and that route's catalogue names the model. Hidden when no such
 * integration exists or nothing is set up, unless the thread is already on it. Grayed when set
 * up but not running. Never chosen automatically, never a default, and choosing it changes no
 * tool permission. When it stops, the thread keeps its route: the host refuses the send rather
 * than falling back to a cloud model, and only the person's Start wakes it again.
 *
 * The catalogue (`GET /api/engines/:route/models`) lists the model's profiles, each with its own
 * efforts and its declared context window. `loaded` names the one the running worker has.
 */
export interface LocalModel {
  route: Route;
  /** Set up on this computer. */
  found: boolean;
  running: boolean;
  /** The catalogue entry the running worker has loaded, or null. */
  loaded: string | null;
}

export function localModel(integrations: readonly IntegrationStatus[]): LocalModel | null {
  const entry = integrations.find(
    (item) => item.kind === 'local' && item.adapter === 'ready' && isRoute(item.id),
  );
  if (!entry) return null;
  const running = entry.found && entry.available;
  return { route: entry.id as Route, found: entry.found, running, loaded: running ? (entry.loaded ?? null) : null };
}

/** Whether a send on this catalogue entry would be answered now, with nothing to start first. */
export function localReady(local: LocalModel | null, slug: string | null | undefined): boolean {
  return local !== null && local.running && Boolean(slug) && local.loaded === slug;
}

/**
 * The profile a choice of the local model lands on, and the one its Start loads: the loaded one
 * while the worker runs, else the saved default the catalogue still lists, else its first.
 */
export function localChoice(
  local: LocalModel | null,
  models: readonly EngineModel[],
  saved: unknown,
): EngineModel | null {
  if (!local) return null;
  return models.find((item) => local.running && item.slug === local.loaded) ?? startingModel(models, saved);
}

/** The line under a thread on the local model when its profile isn't loaded; null when it is. */
export function localStoppedLine(local: LocalModel | null, slug: string | null | undefined, free: boolean): string | null {
  if (!local || localReady(local, slug)) return null;
  if (!local.running) return free ? LOCAL_STOPPED_FREE : LOCAL_STOPPED;
  return slug ? (free ? LOCAL_OTHER_FREE : LOCAL_OTHER) : null;
}

/**
 * A profile in words the host declared, for wherever its own name may not show: what it takes
 * and how much context it holds.
 */
export function localProfileLine(model: EngineModel): string {
  const takes = model.inputModalities?.includes('image') ? 'Text and images' : 'Text only';
  return model.contextTokens ? `${takes}, ${formatTokens(model.contextTokens)} context` : takes;
}

/** One row of the local model's profile menu. */
export interface LocalProfileEntry {
  slug: string;
  name: string;
  sub: string;
  /** Loaded and answering now. */
  running: boolean;
}

/**
 * The local model's profiles, in the catalogue's order and words. Where model names may not
 * show, each reads as the Local model with what it declares.
 */
export function localProfileEntries(
  local: LocalModel,
  models: readonly EngineModel[],
  names: boolean,
): LocalProfileEntry[] {
  return models.map((model) => ({
    slug: model.slug,
    name: names ? model.name : LOCAL_MODEL,
    sub: localProfileLine(model),
    running: localReady(local, model.slug),
  }));
}

/** One row of the Engine menu. */
export interface EngineEntry {
  id: Route;
  name: string;
  /** One short line under the name, or empty. */
  sub: string;
  /** Nectovia's line: the managed route is always reachable, so it always reads Online. */
  online: boolean;
  disabled: boolean;
  /** The plan does not include it, so it carries a lock. */
  locked: boolean;
}

export interface EngineInput {
  integrations: readonly IntegrationStatus[];
  settings: Settings;
  connections: Partial<Record<string, EngineConnection>>;
  /** The free version: Nectovia stays listed, grayed, and cannot be picked. */
  free: boolean;
  /** The thread's recorded route. */
  route: Route;
  local: LocalModel | null;
  /** The engines listed after Nectovia, in order. The project row's `ROW_ENGINES` unless given. */
  engines?: readonly Route[];
}

/** Found, every check passed, and turned on in Settings. Sample work needs no switch. */
function integrationReady(id: string, integrations: readonly IntegrationStatus[], settings: Settings): boolean {
  const found = integrations.find((item) => item.id === id);
  if (!found) return false;
  if (found.kind === 'sample') return found.available;
  return found.available && settings.services?.[id] === true;
}

/**
 * Whether the row offers an engine: the same facts the setup screen calls connected, so the
 * row never offers a route Settings > Engines refuses (Picker.tsx `offered`).
 */
export function offeredEngine(
  id: string,
  input: Pick<EngineInput, 'integrations' | 'settings' | 'connections'>,
): boolean {
  if (!isExternalEngine(id)) return integrationReady(id, input.integrations, input.settings);
  return input.settings.services?.[id] === true && isFoundEngine(input.connections[id]);
}

/** An engine's name: the integration's own, else the route registry's. */
export function engineName(id: string, integrations: readonly IntegrationStatus[]): string {
  if (id === NECTOVIA_ROUTE) return routeDisplayName(id);
  return integrations.find((item) => item.id === id)?.name ?? routeDisplayName(id);
}

/**
 * Nectovia first, then every engine this computer offers. An engine turned on that has not
 * passed its own check is listed grayed with where to fix it, so the menu never silently
 * shortens. The thread's own route always has a row, even one this list would not offer.
 */
export function engineEntries(input: EngineInput): EngineEntry[] {
  const { integrations, settings, free, route, local } = input;
  const entries: EngineEntry[] = [
    {
      id: NECTOVIA_ROUTE,
      name: routeDisplayName(NECTOVIA_ROUTE),
      sub: free ? NECTOVIA_LOCKED : 'Uses credits',
      online: true,
      disabled: free,
      locked: free,
    },
  ];
  for (const id of input.engines ?? ROW_ENGINES) {
    if (offeredEngine(id, input))
      entries.push({ id, name: engineName(id, integrations), sub: 'Your own account', online: false, disabled: false, locked: false });
    else if (isExternalEngine(id) && settings.services?.[id] === true)
      entries.push({ id, name: engineName(id, integrations), sub: 'Check it in Settings > Engines', online: false, disabled: true, locked: false });
  }
  const onLocal = local !== null && route === local.route;
  // On the free version Nectovia's tier box cannot open, so a local model is listed as the
  // person's own engine, which Work allows on every plan.
  if (local && free && (local.found || onLocal))
    entries.push({
      id: local.route,
      name: LOCAL_MODEL,
      sub: local.running ? 'Runs on this computer' : NOT_RUNNING,
      online: false,
      disabled: !local.running,
      locked: false,
    });
  // The thread's own route stays listed so the box can name it, with no line under it that would
  // only repeat the name.
  if (!onLocal && !entries.some((entry) => entry.id === route))
    entries.push({
      id: route,
      name: engineName(route, integrations),
      sub: '',
      online: false,
      disabled: false,
      locked: false,
    });
  return entries;
}

/**
 * The engine the closed box names. A local model is a Nectovia option, so a thread on it reads
 * Nectovia, except on the free version, where it is listed as an engine of its own.
 */
export function shownEngine(route: Route, local: LocalModel | null, free: boolean): Route {
  return local && route === local.route && !free ? NECTOVIA_ROUTE : route;
}

export function engineLabel(route: Route, input: Pick<EngineInput, 'integrations' | 'local' | 'free'>): string {
  if (input.local && route === input.local.route) return input.free ? LOCAL_MODEL : routeDisplayName(NECTOVIA_ROUTE);
  return engineName(route, input.integrations);
}

/** One row of Nectovia's tier menu. */
export interface TierEntry {
  id: WorkStyle | 'local';
  name: string;
  sub: string;
  /** How many of the three bars are lit; none for the local model. */
  bars: number;
  disabled: boolean;
}

/**
 * Efficient, Focused and Thorough, then the local model when one is set up or the thread is on
 * it. A model's own name shows only where model names are allowed (Work, or a paid person on
 * their own engine).
 */
export function tierEntries(
  local: LocalModel | null,
  localName: string | null,
  names: boolean,
  onLocal = false,
): TierEntry[] {
  const entries: TierEntry[] = WORK_STYLES.map((style, index) => ({
    id: style,
    name: WORK_STYLE_LABELS[style],
    sub: WORK_STYLE_DESCRIPTIONS[style],
    bars: index + 1,
    disabled: false,
  }));
  if (local && (local.found || onLocal))
    entries.push({
      id: 'local',
      name: LOCAL_MODEL,
      sub: !local.running ? NOT_RUNNING : names && localName ? localName : 'Runs on this computer',
      bars: 0,
      disabled: !local.running,
    });
  return entries;
}

export type TierChoice = WorkStyle | 'local';

/**
 * What the tier box shows: the local model when the thread is on it, else the tier Nectovia's
 * policy runs, resolved as `styleOf` and `tierFor` in server/app.ts do: the thread's style,
 * then the Settings default, then the host's default, and no style runs as Efficient. A model
 * pin never moves a Nectovia thread, so the box never names one.
 */
export function currentTier(
  thread: Pick<Conversation, 'workStyle'>,
  settings: Settings,
  route: Route,
  local: LocalModel | null,
): TierChoice {
  if (local && route === local.route) return 'local';
  const saved = settings.services?.workStyle;
  return jobTierOf(isWorkStyle(thread.workStyle) ? thread.workStyle : isWorkStyle(saved) ? saved : DEFAULT_WORK_STYLE);
}

export function tierLabel(choice: TierChoice): string {
  return choice === 'local' ? LOCAL_MODEL : WORK_STYLE_LABELS[choice];
}

export function tierBars(choice: TierChoice): number {
  return choice === 'local' ? 0 : WORK_STYLES.indexOf(choice) + 1;
}

/**
 * The model the thread runs on another engine: its pin when it has one, else the model the host
 * says the next request resolves to. Null while neither is known.
 */
export function currentModel(
  models: readonly EngineModel[],
  pinned: string | null | undefined,
  resolved: string | null | undefined,
): { slug: string; model: EngineModel | null } | null {
  const slug = pinned || resolved;
  if (!slug) return null;
  return { slug, model: models.find((item) => item.slug === slug) ?? null };
}

/**
 * The model a picked engine starts on. A thread that follows a style can be moved by the
 * owner's tier map, so moving to an engine pins a model to keep it there: the default saved in
 * AI setup when the engine still lists it, else the first model the engine lists. Null when
 * the engine has listed nothing yet; the host then resolves the model.
 */
export function startingModel(models: readonly EngineModel[], saved: unknown): EngineModel | null {
  return models.find((item) => item.slug === saved) ?? models[0] ?? null;
}

export interface EffortState {
  /** The model's levels, weakest first, as the engine listed them. */
  levels: { id: string; description: string }[];
  /** The level chosen for the thread, or the model's own default. */
  wanted: string | null;
  /** What the run uses after the mode's ceiling. */
  runs: string | null;
  capped: boolean;
  ceiling: string | null;
}

/**
 * The effort box: the model's own levels, the thread's choice, and Fix's ceiling over it. Until
 * the engine has listed the model, the thread's choice is shown as it was saved; once it has, a
 * level the model does not list gives way to the model's own default.
 */
export function effortState(
  model: EngineModel | null,
  chosen: string | null | undefined,
  saved: string | null | undefined,
  mode: Mode,
): EffortState {
  const levels = model?.efforts ?? [];
  const ids = levels.map((level) => level.id);
  const usable = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && (model === null || ids.includes(value));
  const pick = [chosen, saved].find(usable);
  const wanted = pick ?? (model?.defaultEffort && ids.includes(model.defaultEffort) ? model.defaultEffort : null);
  const runs = wanted ? effortFor(mode, wanted, wanted) : null;
  return {
    levels,
    wanted,
    runs,
    capped: wanted !== null && runs !== wanted,
    ceiling: MODE_CEILING[mode] ?? null,
  };
}

/** What the ring shows: how full the context was on the latest answer, and what filled it. */
export interface ContextGauge {
  /** Percent of the model's window, or null when no window is declared. */
  percent: number | null;
  /** Tokens sent with the latest answer's first call, by Diomedes' estimate; null before any. */
  tokens: number | null;
  rows: { label: string; tokens: number; percent: number | null }[];
  /** The window the percentages are of, in tokens, or null when none is declared. */
  window: number | null;
}

/**
 * Read from the newest answer's own context record (`Turn.context`), written once when it was
 * answered. Nothing here measures anything: with no record the ring is empty, and with no
 * declared window it counts tokens rather than inventing a percentage. `declared` is the window
 * the thread's current model declares (a local profile's own size), which outranks the one the
 * answer was given under: a thread moved to a smaller profile fills that one.
 */
export function contextGauge(
  turns: readonly Pick<Turn, 'role' | 'context'>[],
  declared: number | null = null,
): ContextGauge {
  const account = [...turns].reverse().find((turn) => turn.role !== 'you' && turn.context)?.context;
  if (!account) return { percent: null, tokens: null, rows: [], window: declared };
  const window = declared ?? account.window.tokens;
  const share = (tokens: number) => (window ? Math.min(100, Math.round((tokens / window) * 100)) : null);
  return {
    percent: share(account.estimatedTokens),
    tokens: account.estimatedTokens,
    rows: account.sections
      .filter((section) => section.estimatedTokens > 0)
      .map((section) => ({
        label: CONTEXT_SECTION_LABELS[section.id],
        tokens: section.estimatedTokens,
        percent: share(section.estimatedTokens),
      })),
    window,
  };
}

/** The window as one line in the ring's popup, or null when none is declared. */
export function contextWindowLine(gauge: ContextGauge): string | null {
  return gauge.window ? `${formatTokens(gauge.window)} token window` : null;
}

/**
 * The ring's one-line name, which is also its tooltip. Without a declared window it says the
 * estimate the way the "Context used" line under an answer does (ContextUsed.tsx).
 */
export function contextLine(gauge: ContextGauge): string {
  if (gauge.tokens === null) return 'No context used yet';
  if (gauge.percent !== null) return `Context ${gauge.percent}% full`;
  return `Context used: ~${formatTokens(gauge.tokens)} estimated`;
}

/** One row of what filled the context: its share of the window, else the estimate. */
export function contextAmount(row: ContextGauge['rows'][number]): string {
  return row.percent !== null ? `${row.percent}%` : `~${formatTokens(row.tokens)}`;
}
