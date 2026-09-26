/**
 * H20: every route contract this build advertises, in one list.
 *
 * The registry in `server/harness/route-contract.ts` holds the engine,
 * session and harness routes; the five model-API contracts live beside their
 * adapters (the same five `server/durable-controls.ts` reads). The Work routes
 * a person can pick (`ROUTES` in `shared/engines.ts`) must each have one; a
 * route advertised with no contract is refused here by name rather than left
 * off the matrix.
 *
 * The H08 control fixture is deliberately absent: it is mounted only in test
 * mode and is not a route a person can use.
 */
import type { AdapterRouteContract } from '../../shared/adapter-contract.js';
import { ROUTES } from '../../shared/engines.js';
import { ROUTE_CONTRACTS } from '../harness/route-contract.js';
import { AWS_MODEL_CONTRACT } from '../harness/aws-model-adapter.js';
import { AZURE_MODEL_CONTRACT } from '../harness/azure-model-adapter.js';
import { NECTOVIA_MODEL_CONTRACT } from '../harness/nectovia-model-adapter.js';
import { OPENROUTER_MODEL_CONTRACT } from '../harness/openrouter-model-adapter.js';
import { VERTEX_MODEL_CONTRACT } from '../harness/vertex-model-adapter.js';

export function advertisedContracts(): AdapterRouteContract[] {
  const contracts = [
    ...Object.values(ROUTE_CONTRACTS),
    AWS_MODEL_CONTRACT,
    AZURE_MODEL_CONTRACT,
    OPENROUTER_MODEL_CONTRACT,
    VERTEX_MODEL_CONTRACT,
    NECTOVIA_MODEL_CONTRACT,
  ];
  const ids = new Set(contracts.map((contract) => contract.routeId));
  const missing = ROUTES.filter((route) => !ids.has(route));
  if (missing.length) throw new Error(`Routes advertised with no contract: ${missing.join(', ')}.`);
  return contracts;
}
