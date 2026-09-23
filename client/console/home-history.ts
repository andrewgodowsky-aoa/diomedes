import {
  CONVERSATION_DEFAULT_ROUTE,
  isConversationRoute,
  routeDisplayName,
} from '../../shared/engines';
import { ownerPinFrom, tierMapFrom } from '../../shared/tier-map';
import type { Route, Turn } from '../../shared/types';
import { DEFAULT_WORK_STYLE, isWorkStyle, type WorkStyle } from '../../shared/work-style';

/**
 * Whether the All projects conversation's earlier messages go with its next message, and the
 * one change the Nectovia page makes to that (0.1.8).
 *
 * Home's typed messages need no grant; its history stays gated (owner rule, 2026-09-23). The
 * page grants and takes back history per route through the Cloud sharing endpoint every project
 * uses, and never touches documents or review packets. At Home the record's `routes` is exactly
 * the set of routes that receive earlier messages, so one switch for every route can never leave
 * history on for a route nobody chose.
 *
 * Pure: DiomedesHome and HomeHistorySharing call it, and tests/home-history.test.ts runs it
 * under Node.
 */

/** The Cloud sharing record, as `GET /projects/:id/cloud-sharing` returns it. */
export interface HomeSharing {
  version: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
  shareReviewPackets: boolean;
}

/** One change, as `PUT /projects/:id/cloud-sharing` takes it. */
export interface HomeSharingChange {
  expectedVersion: number;
  routes: string[];
  documents: string[];
  shareConversationHistory: boolean;
  shareReviewPackets: boolean;
}

/** Whether the next message on `route` carries the earlier ones: the route listed and the switch on. */
export function sharesHistoryWith(policy: HomeSharing, route: string): boolean {
  return policy.shareConversationHistory && policy.routes.includes(route);
}

/** The routes that receive earlier messages now. With the switch off, none do. */
export function historyRoutes(policy: HomeSharing): string[] {
  return policy.shareConversationHistory ? [...policy.routes] : [];
}

/**
 * The change that leaves earlier messages going to exactly `chosen`. The switch is on only while
 * a route is chosen, and a route listed with the switch off (only a direct write can do that at
 * Home) is left out rather than switched on with the rest. Documents and review packets go back
 * exactly as they were read.
 */
export function historyChange(policy: HomeSharing, chosen: readonly string[]): HomeSharingChange {
  const routes = [...new Set(chosen)].filter((route) => route !== 'sample');
  return {
    expectedVersion: policy.version,
    routes,
    documents: [...policy.documents],
    shareConversationHistory: routes.length > 0,
    shareReviewPackets: policy.shareReviewPackets,
  };
}

/** Grant: the routes that have history now, and this one. */
export function shareHistory(policy: HomeSharing, route: string): HomeSharingChange {
  return historyChange(policy, [...historyRoutes(policy), route]);
}

/** Revoke: the routes that have history now, without this one. The last one turns the switch off. */
export function stopSharingHistory(policy: HomeSharing, route: string): HomeSharingChange {
  return historyChange(
    policy,
    historyRoutes(policy).filter((listed) => listed !== route),
  );
}

/** An answered exchange: one of the person's messages with the answer right after it. */
function hasExchange(turns: readonly Turn[]): boolean {
  return turns.some((turn, index) => turn.role === 'you' && turns[index + 1]?.role === 'assistant');
}

/**
 * What the page says while `route` does not receive earlier messages. A model route answers each
 * message on its own; Claude Code refuses a follow-up before it is sent, so it says so.
 */
export function historySentence(route: string): string {
  const name = routeDisplayName(route);
  return route === 'claude-code'
    ? `Earlier messages aren't shared with ${name}, so it can't answer a follow-up.`
    : `Earlier messages aren't shared with ${name}, so each answer stands alone.`;
}

/**
 * The line near the composer, or null. It shows only once the sharing record is read, on a
 * conversation route (never the sample route, which stays on this computer), after at least one
 * answered exchange, and while that route does not receive earlier messages.
 */
export function historyLine(input: {
  policy: HomeSharing | null;
  route: string;
  turns: readonly Turn[];
}): string | null {
  const { policy, route, turns } = input;
  if (!policy || !isConversationRoute(route) || !hasExchange(turns)) return null;
  return sharesHistoryWith(policy, route) ? null : historySentence(route);
}

/**
 * The route the conversation's next message takes, by the host's rules (server/app.ts `tierFor`,
 * `threadRoute`): a thread that pins a model keeps its recorded route; otherwise its tier, or
 * the Settings default tier, sends it where the owner's map or the owner-testing pin says; with
 * no tier it is the recorded route, or the default a first message takes.
 */
export function nextRoute(input: {
  engine: Route | null;
  workStyle: WorkStyle | null;
  requestedModel?: string | null;
  services?: Record<string, unknown>;
}): string {
  const { engine, workStyle, requestedModel, services } = input;
  if (!requestedModel) {
    const saved = services?.workStyle;
    const style = workStyle ?? (isWorkStyle(saved) ? saved : DEFAULT_WORK_STYLE);
    if (style) return ownerPinFrom(services)?.route ?? tierMapFrom(services)[style].route;
  }
  return engine ?? CONVERSATION_DEFAULT_ROUTE;
}
