/**
 * The routes bound to each tier, with the provider price each would be checked at against the credit
 * price table's ceiling (`shared/credit-prices.ts`). Staff publishing a table, and staff publishing a
 * routing policy, both refuse a result that leaves a bound route over the ceiling, by name.
 *
 * A route is bound when a current routing record would send a tier's call to it: the global record's
 * legacy tier map (priced by the provider registry row it resolves to), the global record's versioned
 * routing, and every account scope's own versioned routing (an inheriting scope adds nothing of its
 * own). A versioned tier's backups count only while its fallback is on, because only then can they
 * serve. The typed-evaluation route serves every tier's advisor calls, so it is bound to all three.
 */
import { JOB_TIERS, type JobTier } from '../../../shared/managed-usage.js';
import { ceilingFailures, type CeilingFailure, type CreditPriceTable, type PriceFields } from '../../../shared/credit-prices.js';
import { routingScopeKey, type AccountScope, type RoutingConfiguration } from '../../../shared/routing-policy.js';
import type { CommercialTransaction, RouteEntry } from './commercial.js';
import { AccountError } from './errors.js';
import { evaluationProvider, MANAGED_PROVIDERS, registryRow, type EvaluationProviderRow, type ProviderRegistryRow } from './managed-providers.js';

export interface BoundRoute {
  readonly tier: JobTier;
  readonly routeId: string;
  readonly price: PriceFields;
}

function versioned(routing: RoutingConfiguration, routes: readonly RouteEntry[], out: Map<string, BoundRoute>) {
  for (const tier of JOB_TIERS) {
    const policy = routing[tier];
    if (!policy) continue;
    const ids = policy.primary === null ? [] : [policy.primary, ...(policy.fallbackEnabled ? policy.backups : [])];
    for (const id of ids) {
      const route = routes.find(r => r.id === id);
      if (route?.binding) out.set(`${tier}\u0000${id}`, { tier, routeId: id, price: route.binding.price });
    }
  }
}

/** Every tier and route a current routing record binds, each once, with the provider price it is checked at. */
export async function boundRoutes(tx: CommercialTransaction, options: {
  registry?: readonly ProviderRegistryRow[];
  evaluationProvider?: EvaluationProviderRow | null;
} = {}): Promise<BoundRoute[]> {
  const routes = await tx.routes();
  const out = new Map<string, BoundRoute>();
  const recordFor = (scopeKey: string) => tx.policy(undefined, scopeKey);
  const global = await recordFor('global');
  if (global?.routing) versioned(global.routing, routes, out);
  else if (global) {
    for (const tier of JOB_TIERS) {
      const resolved = global.tiers[tier];
      const entry = resolved && routes.find(r => r.id === resolved.entryId);
      const row = entry && registryRow(entry, options.registry ?? MANAGED_PROVIDERS);
      if (entry && row) out.set(`${tier}\u0000${entry.id}`, { tier, routeId: entry.id, price: row.rate });
    }
  }
  const scopes: AccountScope[] = [
    ...(await tx.organizations('', 10_000)).map(r => ({ kind: 'organization' as const, id: r.organization.id })),
    ...(await tx.individuals('', 10_000)).map(r => ({ kind: 'individual' as const, id: r.id })),
  ];
  for (const scope of scopes) {
    const own = await recordFor(routingScopeKey(scope));
    if (own && !own.inherit && own.routing) versioned(own.routing, routes, out);
  }
  const evaluation = options.evaluationProvider === undefined ? (global?.systemOne ? evaluationProvider(global.systemOne, global.revision) : null) : options.evaluationProvider;
  if (evaluation) for (const tier of JOB_TIERS) out.set(`${tier}\u0000${evaluation.id}`, { tier, routeId: evaluation.id, price: evaluation.rate });
  return [...out.values()];
}

/**
 * Every bound route the table leaves over its ceiling. A tier with no charge has nothing to compare:
 * its calls are refused as `tier_unpriced` instead.
 */
export function overCeiling(table: Pick<CreditPriceTable, 'tiers' | 'ceilingMicroUsdPerCredit'>, bound: readonly BoundRoute[]): CeilingFailure[] {
  return bound.flatMap(b => {
    const charge = table.tiers[b.tier];
    return charge ? ceilingFailures({ tier: b.tier, routeId: b.routeId, price: b.price, charge, ceilingMicroUsdPerCredit: table.ceilingMicroUsdPerCredit }) : [];
  });
}

/** One sentence naming the first few failures, for a refusal staff read. */
export function ceilingRefusal(failures: readonly CeilingFailure[]): string {
  const named = failures.slice(0, 4).map(f => f.message).join(' ');
  return failures.length > 4 ? `${named} And ${failures.length - 4} more.` : named;
}

const failureKey = (f: CeilingFailure) => `${f.tier}\u0000${f.routeId}\u0000${f.tokenClass}\u0000${f.aboveInputTokens ?? ''}`;

/**
 * Run a routing change (a route saved, a routing record published or rolled back) inside the caller's
 * transaction, and refuse it when it leaves a bound route over the active table's ceiling that was not
 * over it before. Failures that were already there are the table's to fix, not this change's. With no
 * table published there is nothing to compare, and the change runs unchecked.
 */
export async function withinCeiling<T>(tx: CommercialTransaction, change: () => Promise<T>): Promise<T> {
  const table = await tx.priceTable();
  if (!table) return change();
  const before = new Set(overCeiling(table, await boundRoutes(tx)).map(failureKey));
  const result = await change();
  const added = overCeiling(table, await boundRoutes(tx)).filter(f => !before.has(failureKey(f)));
  if (added.length) throw new AccountError(422, ceilingRefusal(added), 'over_cost_ceiling');
  return result;
}
