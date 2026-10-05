/**
 * Who funds one piece of work, where it is recorded and shown (subscription-aware
 * orchestration, IMPLEMENTATION.md 4.2).
 *
 * Two older payer types stay exactly as they are: `shared/execution.ts` `Payer` is the
 * evidence a handoff envelope carries, and `shared/managed-usage.ts` `Payer` is the
 * gateway's admission outcome. Stored records are never rewritten; a record without a
 * funding field has none.
 *
 * Pure: no clock, no disk, no request. Client and server share it.
 */
import { BONSAI_ROUTE } from './bonsai.js';
import { LOCAL_ROUTES as MANAGED_LOCAL_ROUTES } from './managed-usage.js';
import { isModelApiRoute, NECTOVIA_ROUTE } from './model-api.js';
import { isExternalWorkerRoute, type ExternalWorkerRoute } from './team-delegation.js';

export type FundingSource =
  /** Nectovia's managed inference, metered against the account's included usage or bought credits. */
  | { readonly kind: 'nectovia-credits' }
  /** The person's own subscription, reached only through that engine's own installed coding tool. */
  | { readonly kind: 'person-subscription'; readonly engine: ExternalWorkerRoute; readonly accountRoute: string | null }
  /** A provider key the person connected on this computer. */
  | { readonly kind: 'person-key'; readonly route: string }
  /** A provider key a business connected for its own work. */
  | { readonly kind: 'company-key'; readonly route: string }
  /** Work that never leaves this computer. */
  | { readonly kind: 'local'; readonly route: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type FundingKind = FundingSource['kind'];

/**
 * What an engine reported about tokens for one child, or that it reported nothing.
 * An engine that reports nothing reads as unknown, never as zero.
 */
export interface UsageObservation {
  readonly tokens: { readonly total: number; readonly input: number | null; readonly output: number | null } | null;
  readonly confidence: 'reported' | 'unknown';
  /** Where the reading came from, for example `codex`, or `not reported`. */
  readonly source: string;
}

/**
 * Routes that never leave this computer: the Diomedes loop's script, the sample route and the
 * local model routes the gateway already treats as local (`shared/managed-usage.ts`).
 */
const LOCAL_ROUTES: readonly string[] = Object.freeze([
  'native-fixture',
  'sample',
  'harness-runtime',
  // The local model route: its calls go to a model on this computer, never to a provider.
  BONSAI_ROUTE,
  ...MANAGED_LOCAL_ROUTES,
]);

/**
 * The funding a route implies for one role. A business workspace's own provider key is the
 * company's; everywhere else a connected key is the person's. An external engine is the
 * person's own subscription, signed in on this computer.
 */
export function fundingForRoute(
  route: string,
  context: { readonly business: boolean; readonly accountRoute?: string | null },
): FundingSource {
  if (LOCAL_ROUTES.includes(route)) return { kind: 'local', route };
  if (route === NECTOVIA_ROUTE) return { kind: 'nectovia-credits' };
  if (isExternalWorkerRoute(route))
    return { kind: 'person-subscription', engine: route, accountRoute: context.accountRoute ?? null };
  if (isModelApiRoute(route)) return context.business ? { kind: 'company-key', route } : { kind: 'person-key', route };
  return { kind: 'unknown', reason: `No funding rule covers the ${route} route.` };
}

/**
 * The label a worker row shows (`shared/work-rows.ts` `WorkerRowPayer`). A company key and a
 * person's key both read as a key the account connected.
 */
export function workerRowPayerOf(kind: FundingKind): 'nectovia-credits' | 'your-subscription' | 'your-key' | 'local' | 'unknown' {
  switch (kind) {
    case 'nectovia-credits':
      return 'nectovia-credits';
    case 'person-subscription':
      return 'your-subscription';
    case 'person-key':
    case 'company-key':
      return 'your-key';
    case 'local':
      return 'local';
    case 'unknown':
      return 'unknown';
  }
}
