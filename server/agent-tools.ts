import { CONNECTOR_READ_TOOLS, WEB_READ_TOOLS } from './harness/capabilities/read-scope-tools.js';
import type { ReadScope } from './engines/read-scope.js';

/**
 * One turn's read scope as an Agent may use it (DIO-292). An Agent's `tools` are the most its
 * turn gets: without a web tool it neither searches nor fetches, and without the connector tool
 * it calls no approved connector. File reads stay exactly as the turn chose them. It narrows and
 * never widens, and an Agent that lists no tools reads with its kind's own.
 *
 * The scope decides what each engine offers (`readScopeTools`, and each engine's own web
 * switch), so a narrowed scope removes the tool itself, not just a line in the prompt.
 *
 * The host applies it where a turn has no kept session: every model-API route and every direct
 * request. An engine that keeps its own session pins the scope it opened with
 * (`readScopeDigest`), so there Agents of one kind share that kind's scope rather than restart it.
 */
export function narrowForAgent(scope: ReadScope | undefined, tools: readonly string[]): ReadScope | undefined {
  if (!scope || tools.length === 0) return scope;
  const web = WEB_READ_TOOLS.some((tool) => tools.includes(tool));
  const connectors = CONNECTOR_READ_TOOLS.some((tool) => tools.includes(tool));
  if (web && connectors) return scope;
  return Object.freeze({
    ...scope,
    web: scope.web && web,
    ...(scope.mcp ? { mcp: connectors ? scope.mcp : [] } : {}),
  });
}
