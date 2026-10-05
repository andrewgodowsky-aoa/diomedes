import { createHandler } from '../../src/worker.js';
import { AccountService } from '../../src/account-service.js';
import { RouteChecksService, workerFetch } from '../../src/route-checks.js';
import type { AuditEvent, CommercialRepository, CommercialTransaction, Operator, RouteEntry } from '../../src/commercial.js';
import { FAUX_AWS_CONNECTION, fauxRouteCheckRoutes } from '../../src/faux/route-checks.js';
import { MemoryRepository } from '../support/memory.js';
import { now as fixtureNow, validEnv, verifier } from '../support/fixtures.js';

/**
 * Local regression harness for POST /ops/routes/:id/checks (DIO-217), never the deployed entry point.
 * The Worker's own handler answers the request. Only its stores are memory stand-ins: the staff
 * sign-in, the route registry and the audit log, made again for every request, so no promise outlives
 * the request that made it. The route checks transport is the Worker's own `workerFetch`, so workerd's
 * global fetch makes every provider call, redirect mode included, and the smoke's outbound handler
 * answers them at the runtime boundary. The answer carries the audit rows the run wrote.
 */
const FIXTURE_KEY = 'runtime-fixture-provider-key-not-a-secret';

function memoryCommercial(routes: RouteEntry[], audits: AuditEvent[]): CommercialRepository {
  const tx = {
    async operator(personId: string): Promise<Operator> {
      return { v: 1, personId, role: 'routing', state: 'active', addedAt: '2026-10-01T00:00:00.000Z', addedBy: personId,
        updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: personId };
    },
    async routes() { return structuredClone(routes); },
    async audit(row: AuditEvent) { audits.push(structuredClone(row)); },
  };
  return { transaction: async <T>(action: (tx: CommercialTransaction) => Promise<T>) => action(tx as unknown as CommercialTransaction) };
}

export default {
  async fetch(request: Request) {
    const at = new Date().toISOString();
    const routes = fauxRouteCheckRoutes(at).filter((entry) => entry.provider === 'aws-bedrock')
      .map((entry): RouteEntry => ({ v: 1, ...entry, revision: 1, updatedAt: at, updatedBy: 'person_runtime' }));
    const audits: AuditEvent[] = [];
    const repository = new MemoryRepository();
    const handler = createHandler(() => new AccountService(repository, verifier, { now: () => fixtureNow }), undefined, {
      createRouteChecks: (_config, accounts) => new RouteChecksService({
        accounts,
        commercial: memoryCommercial(routes, audits),
        spend: { read: async () => ({ companyMicroUsd: 0, routeChecksMicroUsd: 0 }) },
        transport: workerFetch,
      }),
    });
    const env = { ...validEnv, MANAGED_CONNECTIONS: JSON.stringify([FAUX_AWS_CONNECTION]), BEDROCK_API_KEY: FIXTURE_KEY,
      MANAGED_SPEND_CEILING_MICRO_USD: '5000000' };
    const answer = await handler(request, env);
    const text = await answer.text();
    return Response.json({ status: answer.status, body: text ? JSON.parse(text) : null, audits, keyInAnswer: text.includes(FIXTURE_KEY) });
  },
};
