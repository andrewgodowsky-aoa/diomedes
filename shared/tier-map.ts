import type { EngineModel, Mode } from './types.js';
import { isModelApiProvider, MODEL_API_PROVIDERS, type ModelApiProvider } from './model-api.js';
import { isRoute, routeDisplayName } from './engines.js';
import {
  classifyTask,
  inferEffort,
  WORK_STYLE_LABELS,
  WORK_STYLES,
  type TaskKind,
  type WorkStyle,
} from './work-style.js';

/**
 * The owner's tier map (owner decisions 2026-09-23). A customer chooses only a
 * tier — Efficient, Focused or Thorough — and never a route or a model: "they're
 * not really going to know the difference". Which company account (route) and
 * which model serve each tier is the owner's configuration, set in AI setup,
 * saved in Settings and validated on the host. The routes exist because each
 * provider gave trial credits, so a tier maps to one of the company-account
 * model-API routes.
 *
 * A tier whose mapped route is not connected and turned on is refused by name,
 * with a pointer to AI setup. Nothing here falls back to another route, and so
 * to another payer.
 */
export const TIER_ROUTES = MODEL_API_PROVIDERS;

export interface TierAssignment {
  /**
   * A route id, kept as a string and checked against the routes this build knows when a tier
   * is used: a mapped route this build does not have yet (Google Vertex AI, landing on its own
   * branch) is refused by name, and starts working when the route lands.
   */
  route: string;
  /** The model id exactly as the route lists it. Null: the owner has not chosen one yet. */
  model: string | null;
}
export type TierMap = Record<WorkStyle, TierAssignment>;

/**
 * The AWS Bedrock route's one model today (`AWS_LUNA_MODEL` in
 * server/engines/aws-bedrock.ts; a test asserts the two spellings agree). The
 * owner calls it GPT-6 Luna; the connection serves this id and it is never renamed.
 */
export const TIER_AWS_LUNA_MODEL = 'us.openai.gpt-6-luna';
/**
 * The Google Vertex AI route's id, as the Vertex branch names it. Not yet in
 * `MODEL_API_ROUTES` on every build, so it is a plain string here.
 */
export const TIER_VERTEX_ROUTE = 'google-vertex';
/**
 * Gemini 3.8 Flash, as `@ai-sdk/google-vertex@5.0.88` lists it in its
 * `GoogleVertexModelId` type (checked 2026-09-23). Owner-editable in AI setup.
 */
export const TIER_GEMINI_FLASH_MODEL = 'gemini-3.8-flash';

/**
 * The defaults the owner set on 2026-09-23, with Efficient moved to GPT-6 Luna
 * on 2026-09-25 when its AWS model id and price were recorded. GPT-6 Sol on AWS
 * Bedrock is not qualified yet, so Thorough has no model: it is refused by name
 * until the owner chooses one. GPT-6 Sol is named in the copy and never sent.
 * This map routes the owner's own routes; a Nectovia conversation's tier is
 * answered by the account service's published policy instead.
 */
export const DEFAULT_TIER_MAP: TierMap = {
  efficient: { route: 'aws-bedrock', model: TIER_AWS_LUNA_MODEL },
  focused: { route: TIER_VERTEX_ROUTE, model: TIER_GEMINI_FLASH_MODEL },
  thorough: { route: 'aws-bedrock', model: null },
};

/** Names for tier routes this build may not know yet, so a refusal still names them. */
const PENDING_ROUTE_NAMES: Record<string, string> = { [TIER_VERTEX_ROUTE]: 'Google Vertex AI' };
/** A tier route as a person reads it, including one this build does not have yet. */
export function tierRouteName(route: string): string {
  const name = routeDisplayName(route);
  return name && name !== route ? name : (PENDING_ROUTE_NAMES[route] ?? route);
}

/**
 * The model the owner intends for each tier, as copy only. Never sent: what is
 * sent is the map's model id, and a tier without one is refused.
 */
export const TIER_INTENT: Record<WorkStyle, string> = {
  efficient: 'GPT-6 Luna',
  focused: 'Gemini 3.8 Flash',
  thorough: 'GPT-6 Sol',
};
/** One line per tier default for AI setup, saying what runs today and what is intended. */
export const TIER_DEFAULT_NOTES: Record<WorkStyle, string> = {
  efficient: 'GPT-6 Luna on AWS Bedrock.',
  focused: 'Gemini 3.8 Flash on Google Vertex AI.',
  thorough: 'Meant for GPT-6 Sol on AWS Bedrock, which is not qualified yet. No model is sent until you choose one.',
};

/** A model id as a route lists it: a slug, a Bedrock profile id or a vendor/model path. */
export const TIER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/** The Settings keys the map is saved under: `efficientRoute`, `efficientModel`, and so on. */
export const tierRouteKey = (style: WorkStyle) => `${style}Route`;
export const tierModelKey = (style: WorkStyle) => `${style}Model`;
/** The owner-testing override (decision 7): one route, and optionally one model, for every tier. */
export const OWNER_PIN_ROUTE_KEY = 'ownerPinRoute';
export const OWNER_PIN_MODEL_KEY = 'ownerPinModel';
export const TIER_SETTING_KEYS: readonly string[] = [
  ...WORK_STYLES.flatMap((style) => [tierRouteKey(style), tierModelKey(style)]),
  OWNER_PIN_ROUTE_KEY,
  OWNER_PIN_MODEL_KEY,
];

/**
 * One saved tier setting, checked on the host. Null when the value is fine;
 * otherwise the sentence that says why it was refused.
 */
export function tierSettingRefusal(key: string, value: unknown): string | null {
  const style = WORK_STYLES.find((candidate) => key === tierRouteKey(candidate) || key === tierModelKey(candidate));
  if (style && key === tierRouteKey(style))
    return isModelApiProvider(value)
      ? null
      : `${WORK_STYLE_LABELS[style]} runs on a company account this build has: choose ${MODEL_API_PROVIDERS.map(routeDisplayName).join(', ')}.`;
  if (style || key === OWNER_PIN_MODEL_KEY)
    return typeof value === 'string' && TIER_MODEL.test(value.trim())
      ? null
      : 'Enter the model id exactly as the route lists it, up to 120 characters.';
  if (key === OWNER_PIN_ROUTE_KEY)
    return isRoute(value) && value !== 'sample' ? null : 'Choose a route to pin for owner testing.';
  return 'That is not a tier setting.';
}

/** The owner's map as saved, with the owner's defaults wherever nothing is saved. */
export function tierMapFrom(services: Record<string, unknown> | undefined): TierMap {
  const map = structuredClone(DEFAULT_TIER_MAP);
  for (const style of WORK_STYLES) {
    const route = services?.[tierRouteKey(style)];
    const model = services?.[tierModelKey(style)];
    if (isModelApiProvider(route)) {
      const changed = route !== map[style].route;
      map[style] = { route, model: typeof model === 'string' && model ? model : changed ? null : map[style].model };
    } else if (typeof model === 'string' && model) map[style] = { ...map[style], model };
  }
  return map;
}

export interface OwnerPin {
  route: string;
  model: string | null;
}
/** The owner-testing override, or null when none is set. */
export function ownerPinFrom(services: Record<string, unknown> | undefined): OwnerPin | null {
  const route = services?.[OWNER_PIN_ROUTE_KEY];
  if (!isRoute(route) || route === 'sample') return null;
  const model = services?.[OWNER_PIN_MODEL_KEY];
  return { route, model: typeof model === 'string' && model ? model : null };
}

/** What the host knows about one route when a tier is resolved. */
export interface TierRouteState {
  /** Turned on and connected (an account route is saved). */
  ready: boolean;
  /** Exactly what the route reported. Empty when it has listed nothing. */
  models: readonly EngineModel[];
  /** The route's saved default model, used only by an owner pin that names no model. */
  savedModel?: string | null;
}

export type TierResolution =
  | {
      outcome: 'run';
      style: WorkStyle;
      route: string;
      model: string;
      effort: string | null;
      /** One plain sentence for the details line. */
      reason: string;
      /** True when the owner-testing override decided the route, not the tier map. */
      ownerPin: boolean;
      kind: TaskKind;
    }
  | { outcome: 'refuse'; style: WorkStyle; route: string; model: string | null; reason: string; ownerPin: boolean; kind: TaskKind };

/**
 * The route, model and level one request of a tier runs with. Pure: the same
 * input always gives the same answer. The owner's pin, when set, wins over the
 * map, and says so; otherwise the map decides both the route and the model. A
 * mapped route that is not ready, a model it does not list or a tier with no
 * model yet is a refusal by name, never another route.
 */
export function resolveTier(input: {
  style: WorkStyle;
  mode: Mode;
  map: TierMap;
  state(route: string): TierRouteState;
  pin?: OwnerPin | null;
  hints?: { text?: string | null; kind?: TaskKind };
}): TierResolution {
  const { style } = input;
  const label = WORK_STYLE_LABELS[style];
  const kind = input.hints?.kind ?? classifyTask(input.hints?.text);
  // A model-API conversation binds its level into the saved context, so the level
  // follows the tier and the mode, never the words of one message.
  const effortKind: TaskKind = 'ordinary';
  const pinned = input.pin ?? null;
  const target = pinned ? { route: pinned.route, model: pinned.model } : input.map[style];
  const name = tierRouteName(target.route);
  const state = input.state(target.route);
  const refuse = (reason: string): TierResolution => ({
    outcome: 'refuse',
    style,
    route: target.route,
    model: target.model,
    reason,
    ownerPin: Boolean(pinned),
    kind,
  });
  if (!state.ready)
    return refuse(
      pinned
        ? `Owner testing pins every tier to ${name}, which is not connected and turned on. Connect it in AI setup or clear the pin under Advanced.`
        : `${label} runs on ${name}${target.model ? ` (${target.model})` : ''}, which is not connected and turned on. Connect ${name} in AI setup. Nectovia does not move this work to another provider.`,
    );
  const model = target.model ?? (pinned ? (state.savedModel ?? null) : null);
  if (!model)
    return refuse(
      pinned
        ? `Owner testing pins every tier to ${name}, which has no model saved. Choose one in AI setup.`
        : `${label} is meant for ${TIER_INTENT[style]} on ${name}, which is not qualified yet. Choose the ${label} model in AI setup.`,
    );
  const listed = state.models.find((entry) => entry.slug === model);
  if (state.models.length > 0 && !listed)
    return refuse(
      pinned
        ? `Owner testing pins ${model} on ${name}, which that connection does not offer. Change the pin in AI setup.`
        : `${label} is set to ${model} on ${name}, which that connection does not offer. The owner can add it there or change ${label} in AI setup.`,
    );
  return {
    outcome: 'run',
    style,
    route: target.route,
    model,
    effort: inferEffort(style, input.mode, effortKind, listed),
    reason: pinned ? `Owner testing: ${model} on ${name}, for every tier.` : `${label}: ${model} on ${name}.`,
    ownerPin: Boolean(pinned),
    kind,
  };
}

/** Whether a route id can be the target of a tier in this build (a company-account route). */
export function isTierRoute(value: unknown): value is ModelApiProvider {
  return isModelApiProvider(value);
}
