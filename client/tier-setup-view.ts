import { ROUTES } from '../shared/engines';
import { MODEL_API_PROVIDERS } from '../shared/model-api';
import {
  DEFAULT_TIER_MAP,
  OWNER_PIN_MODEL_KEY,
  OWNER_PIN_ROUTE_KEY,
  ownerPinFrom,
  tierMapFrom,
  tierModelKey,
  tierRouteKey,
  tierRouteName,
  type TierMap,
} from '../shared/tier-map';
import { WORK_STYLES, type WorkStyle } from '../shared/work-style';

/** What the owner edits for one tier: the route and the model id, as typed. */
export type TierDraft = Record<WorkStyle, { route: string; model: string }>;

/** The saved map as the form starts. An unset model is an empty field. */
export function tierDraftFrom(services: Record<string, unknown> | undefined): TierDraft {
  const map = tierMapFrom(services);
  return Object.fromEntries(
    WORK_STYLES.map((style) => [style, { route: map[style].route, model: map[style].model ?? '' }]),
  ) as TierDraft;
}

/**
 * The routes a tier may be mapped to here: the company-account routes this
 * build has, plus the tier's own current route when it is one this build does
 * not have yet (Google Vertex AI before its branch lands), so the form never
 * hides what the tier is set to.
 */
export function tierRouteChoices(current: string): { id: string; name: string }[] {
  const ids: string[] = [...MODEL_API_PROVIDERS];
  if (!ids.includes(current)) ids.push(current);
  return ids.map((id) => ({ id, name: tierRouteName(id) }));
}

/**
 * The services map with the owner's tier choices written in. A tier left on
 * the owner's default is stored as nothing, so the default can move with a
 * later release and a route this build does not know is never written.
 */
export function withTierDraft(
  services: Record<string, boolean | string> | undefined,
  draft: TierDraft,
): Record<string, boolean | string> {
  const next: Record<string, boolean | string> = { ...services };
  for (const style of WORK_STYLES) {
    const route = draft[style].route;
    const model = draft[style].model.trim();
    const fallback = DEFAULT_TIER_MAP[style];
    delete next[tierRouteKey(style)];
    delete next[tierModelKey(style)];
    if (route !== fallback.route) next[tierRouteKey(style)] = route;
    const defaultModel = route === fallback.route ? (fallback.model ?? '') : '';
    if (model && model !== defaultModel) next[tierModelKey(style)] = model;
  }
  return next;
}

/** Every route the owner may pin for testing: anything but the sample. */
export const OWNER_PIN_ROUTES = ROUTES.filter((route) => route !== 'sample');

/** The services map with the owner-testing pin set, or cleared when `route` is empty. */
export function withOwnerPin(
  services: Record<string, boolean | string> | undefined,
  route: string,
  model: string,
): Record<string, boolean | string> {
  const next: Record<string, boolean | string> = { ...services };
  delete next[OWNER_PIN_ROUTE_KEY];
  delete next[OWNER_PIN_MODEL_KEY];
  if (route) {
    next[OWNER_PIN_ROUTE_KEY] = route;
    if (model.trim()) next[OWNER_PIN_MODEL_KEY] = model.trim();
  }
  return next;
}

/** The pin as the form starts. */
export function ownerPinDraft(services: Record<string, unknown> | undefined): { route: string; model: string } {
  const pin = ownerPinFrom(services);
  return { route: pin?.route ?? '', model: pin?.model ?? '' };
}

export type { TierMap };
