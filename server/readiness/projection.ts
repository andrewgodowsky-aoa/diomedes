import { ADAPTER_CAPABILITIES } from '../harness/adapters.js';
import { ROUTE_CONTRACTS } from '../harness/route-contract.js';
import {
  READINESS_AXES,
  READINESS_CONTRACT_VERSION,
  type FreshnessState,
  type ProductKnowledgeBundle,
  type ProductKnowledgeConflict,
  type ReadinessAxis,
  type ReadinessAxisName,
  type ReadinessCapability,
  type ReadinessProjection,
  type ReadinessRuntimeSnapshot,
  type ReadinessSource,
  type ReadinessValue,
  type WorkflowBlocker,
  type WorkflowReadiness,
} from '../../shared/readiness.js';

const ENGINE_FRESH_MS = 5 * 60 * 1000;
const isFreshAt = (current: string, observed: string, staleAfterMs: number) => {
  const age = Date.parse(current) - Date.parse(observed);
  return (
    Number.isFinite(age) &&
    Number.isFinite(staleAfterMs) &&
    staleAfterMs > 0 &&
    age >= 0 &&
    age <= staleAfterMs
  );
};

const freshness = (
  state: FreshnessState,
  observedAt: string | null = null,
  staleAfterMs: number | null = null,
) => ({ state, observedAt, staleAfterMs });

const axis = (
  value: ReadinessValue,
  source: ReadinessSource,
  state: FreshnessState,
  detail: string,
  observedAt: string | null = null,
  staleAfterMs: number | null = null,
): ReadinessAxis => ({
  value,
  source,
  freshness: freshness(state, observedAt, staleAfterMs),
  detail,
});

const affected = (conflict: ProductKnowledgeConflict, scope: string) =>
  conflict.scopes.includes('product') || conflict.scopes.includes(scope);

const blockers = (axes: Record<ReadinessAxisName, ReadinessAxis>) =>
  READINESS_AXES.filter((name) => axes[name].value !== 'yes').map(
    (name) => `${name}: ${axes[name].detail}`,
  );

const capability = (
  kind: ReadinessCapability['kind'],
  id: string,
  axes: Record<ReadinessAxisName, ReadinessAxis>,
): ReadinessCapability => {
  const missing = blockers(axes);
  return { kind, id, axes, ready: missing.length === 0, blockers: missing };
};

function routeCapabilities(
  snapshot: ReadinessRuntimeSnapshot,
  knowledge: ProductKnowledgeBundle,
  now: string,
  conflicts: ProductKnowledgeConflict[],
): ReadinessCapability[] {
  return Object.values(ROUTE_CONTRACTS)
    .sort((a, b) => a.routeId.localeCompare(b.routeId))
    .map((contract) => {
      const routeScope = `route:${contract.routeId}`;
      const runtime = snapshot.engines.find((item) => item.engine === contract.engine.id);
      const staticLocal = ['sample', 'native-fixture', 'harness-runtime'].includes(
        contract.routeId,
      );
      const settingsValue = snapshot.settings.services[contract.engine.id];
      const resource = knowledge.resources.find((item) =>
        item.resource.routes.some((route) => route.routeId === contract.routeId),
      );
      const claim = resource?.resource.routes.find((route) => route.routeId === contract.routeId);
      if (claim && claim.contractVersion !== contract.contractVersion)
        conflicts.push({
          code: 'contract-mismatch',
          detail: `Knowledge names route contract ${claim.contractVersion}; the build exposes ${contract.contractVersion}.`,
          scopes: [routeScope],
          source: `resources/product-knowledge/${resource!.path}`,
        });
      if (claim && claim.engineVersion !== contract.engine.version)
        conflicts.push({
          code: 'engine-version-mismatch',
          detail: `Knowledge names engine ${claim.engineVersion}; the route contract exposes ${contract.engine.version}.`,
          scopes: [routeScope],
          source: `resources/product-knowledge/${resource!.path}`,
        });
      const knowledgeConflict = conflicts.some((item) => affected(item, routeScope));
      const evidence = snapshot.validatedEvidence?.find(
        (item) => item.kind === 'route' && item.id === contract.routeId,
      );
      const evidenceMatches =
        evidence?.buildVersion === snapshot.build.version &&
        evidence.contractVersion === contract.contractVersion &&
        evidence.engineVersion === contract.engine.version;
      const evidenceFresh = evidence
        ? isFreshAt(now, evidence.validatedAt, evidence.staleAfterMs)
        : false;

      let installed: ReadinessAxis;
      let healthy: ReadinessAxis;
      if (staticLocal) {
        installed = axis(
          'yes',
          { kind: 'build', id: snapshot.build.source, digest: snapshot.build.digest },
          'static',
          'This route runs inside the installed build.',
        );
        healthy = axis(
          'yes',
          { kind: 'build', id: snapshot.build.source, digest: snapshot.build.digest },
          'static',
          'This deterministic in-process route has no external health dependency.',
        );
      } else if (runtime) {
        const observed = runtime.checkedAt;
        const age = observed ? Date.parse(now) - Date.parse(observed) : Number.POSITIVE_INFINITY;
        const isFresh = Boolean(observed) && age >= 0 && age <= ENGINE_FRESH_MS;
        installed = axis(
          runtime.installation === 'found'
            ? 'yes'
            : runtime.installation === 'missing'
              ? 'no'
              : 'unknown',
          { kind: 'engine-status', id: `EngineService.status:${runtime.engine}` },
          observed ? (isFresh ? 'fresh' : 'stale') : 'unknown',
          runtime.installation === 'found'
            ? 'The cached inventory found this engine.'
            : runtime.detail,
          observed,
          ENGINE_FRESH_MS,
        );
        healthy = !isFresh
          ? axis(
              'unknown',
              { kind: 'engine-status', id: `EngineService.status:${runtime.engine}` },
              observed ? 'stale' : 'unknown',
              'Recheck this engine before treating its health as current.',
              observed,
              ENGINE_FRESH_MS,
            )
          : axis(
              runtime.installation === 'found' &&
                runtime.compatibility === 'supported' &&
                runtime.authentication === 'signed-in' &&
                runtime.models.length > 0
                ? 'yes'
                : 'no',
              { kind: 'engine-status', id: `EngineService.status:${runtime.engine}` },
              'fresh',
              runtime.detail,
              observed,
              ENGINE_FRESH_MS,
            );
      } else {
        installed = axis(
          'unknown',
          { kind: 'engine-status', id: `EngineService.status:${contract.routeId}` },
          'unknown',
          'No cached installation observation exists for this route.',
        );
        healthy = axis(
          'unknown',
          { kind: 'engine-status', id: `EngineService.status:${contract.routeId}` },
          'unknown',
          'No cached health observation exists for this route.',
        );
      }

      let authorized: ReadinessAxis;
      if (contract.authentication === 'none' || contract.authentication === 'development-fixture')
        authorized = axis(
          'yes',
          { kind: 'build', id: `route-contract:${contract.routeId}` },
          'static',
          'This route declares no account authorization requirement.',
        );
      else if (settingsValue !== true)
        authorized = axis(
          'no',
          { kind: 'settings', id: `services.${contract.engine.id}` },
          'fresh',
          'Turn this route on in Settings before use.',
          snapshot.settings.observedAt,
        );
      else if (!runtime)
        authorized = axis(
          'unknown',
          { kind: 'settings', id: `services.${contract.engine.id}` },
          'unknown',
          'Settings selects this route, but no cached account authorization observation is available.',
          snapshot.settings.observedAt,
        );
      else
        authorized = axis(
          runtime.authentication === 'signed-in'
            ? 'yes'
            : runtime.authentication === 'signed-out'
              ? 'no'
              : 'unknown',
          { kind: 'engine-status', id: `EngineService.status:${runtime.engine}` },
          runtime.checkedAt
            ? isFreshAt(now, runtime.checkedAt, ENGINE_FRESH_MS)
              ? 'fresh'
              : 'stale'
            : 'unknown',
          runtime.authentication === 'signed-in'
            ? 'Settings selects this route and the cached engine status reports a signed-in account.'
            : runtime.authentication === 'signed-out'
              ? 'The cached engine status reports that sign-in is required.'
              : 'Cached account authorization is unknown.',
          runtime.checkedAt,
          ENGINE_FRESH_MS,
        );
      const verified = knowledgeConflict
        ? axis(
            'unknown',
            {
              kind: 'product-knowledge',
              id: resource?.path ?? 'index.json',
              digest: resource?.sha256,
            },
            'stale',
            'Shipped product knowledge conflicts with this build or is stale.',
          )
        : !evidence
          ? axis(
              'unknown',
              { kind: 'validated-evidence', id: `route:${contract.routeId}` },
              'unknown',
              'No trusted validated evidence snapshot names this route.',
            )
          : !evidenceMatches || !evidenceFresh
            ? axis(
                'unknown',
                { kind: 'validated-evidence', id: evidence.evidenceId },
                evidenceFresh ? 'unknown' : 'stale',
                evidenceFresh
                  ? 'Validated evidence does not match this build, contract and engine version.'
                  : 'Validated route evidence is stale.',
                evidence.validatedAt,
                evidence.staleAfterMs,
              )
            : axis(
                'yes',
                { kind: 'validated-evidence', id: evidence.evidenceId },
                'fresh',
                `Validated evidence: ${evidence.source}.`,
                evidence.validatedAt,
                evidence.staleAfterMs,
              );
      return capability('route', contract.routeId, {
        implemented: axis(
          'yes',
          {
            kind: 'build',
            id: `ROUTE_CONTRACTS:${contract.routeId}`,
            digest: snapshot.build.digest,
          },
          'static',
          `Route contract ${contract.contractVersion} is present in build ${snapshot.build.version}.`,
        ),
        installed,
        authorized,
        verified,
        healthy,
      });
    });
}

function connectorCapabilities(
  snapshot: ReadinessRuntimeSnapshot,
  knowledge: ProductKnowledgeBundle,
  now: string,
  conflicts: ProductKnowledgeConflict[],
): ReadinessCapability[] {
  return [...snapshot.connectors.manifests]
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    .map(({ manifest, digest }) => {
      const scope = `connector:${manifest.id}`;
      const instances = snapshot.connectors.instances.filter(
        (item) => item.connectorId === manifest.id,
      );
      const instance = instances[0];
      const observations = instance
        ? snapshot.connectors.observations.filter(
            (item) =>
              item.connectionId === instance.id &&
              item.generation === instance.generation &&
              item.projectId === instance.projectId &&
              instance.resources.some((resource) => resource.id === item.observation.resourceId),
          )
        : [];
      const latest = observations.sort(
        (a, b) => Date.parse(b.observation.receivedAt) - Date.parse(a.observation.receivedAt),
      )[0]?.observation;
      const resource = knowledge.resources.find((item) =>
        item.resource.connectors.some((entry) => entry.connectorId === manifest.id),
      );
      const claim = resource?.resource.connectors.find(
        (entry) => entry.connectorId === manifest.id,
      );
      if (claim && (claim.version !== manifest.version || claim.manifestDigest !== digest))
        conflicts.push({
          code: 'manifest-mismatch',
          detail: 'The qualified connector version or digest differs from the installed manifest.',
          scopes: [scope],
          source: `resources/product-knowledge/${resource!.path}`,
        });
      const knowledgeConflict = conflicts.some((item) => affected(item, scope));
      const evidence = snapshot.validatedEvidence?.find(
        (item) => item.kind === 'connector' && item.id === manifest.id,
      );
      const evidenceMatches =
        evidence?.buildVersion === snapshot.build.version && evidence.manifestDigest === digest;
      const evidenceFresh = evidence
        ? isFreshAt(now, evidence.validatedAt, evidence.staleAfterMs)
        : false;
      const authorization = instance
        ? snapshot.connectorAuthorizations?.find(
            (item) =>
              item.connectorId === manifest.id &&
              item.connectionId === instance.id &&
              item.generation === instance.generation &&
              item.projectId === instance.projectId,
          )
        : undefined;
      const authorizationFresh = authorization
        ? isFreshAt(now, authorization.authorizedAt, authorization.staleAfterMs)
        : false;
      const manifestMatches = Boolean(
        instance && instance.version === manifest.version && instance.manifestDigest === digest,
      );
      const observedAt = latest?.receivedAt ?? instance?.lastReconciledAt ?? null;
      const age = observedAt ? Date.parse(now) - Date.parse(observedAt) : Number.POSITIVE_INFINITY;
      const isFresh = Boolean(instance && observedAt && age >= 0 && age <= instance.staleAfterMs);
      return capability('connector', manifest.id, {
        implemented: axis(
          'yes',
          { kind: 'manifest', id: manifest.id, digest },
          'static',
          `Connector manifest schema ${manifest.schemaVersion} is present.`,
        ),
        installed: axis(
          instance ? 'yes' : 'no',
          { kind: 'connection', id: instance?.id ?? manifest.id },
          instance ? 'fresh' : 'unknown',
          instance ? 'A connection instance exists.' : 'No connection instance exists.',
          instance?.lastEventAt ?? null,
        ),
        authorized: !instance
          ? axis(
              'unknown',
              { kind: 'connection', id: manifest.id },
              'unknown',
              'No instance can establish authorization.',
            )
          : instance.status === 'authorization-required'
            ? axis(
                'no',
                { kind: 'connection', id: instance.id },
                'fresh',
                'The connection requires authorization.',
                instance.lastEventAt,
              )
            : instance.status !== 'connected' || !authorization || !authorizationFresh
              ? axis(
                  'unknown',
                  { kind: 'connection', id: instance.id },
                  authorization ? 'stale' : 'unknown',
                  instance.status !== 'connected'
                    ? `The ${instance.status} state does not prove current authorization.`
                    : authorization
                      ? 'The trusted authorization observation is stale or has an invalid time.'
                      : 'Persisted connected state does not prove current authorization.',
                  authorization?.authorizedAt ?? instance.lastEventAt,
                  authorization?.staleAfterMs ?? null,
                )
              : axis(
                  'yes',
                  { kind: 'connection', id: authorization.source },
                  'fresh',
                  'A current trusted observation proves authorization for this connection generation and project.',
                  authorization.authorizedAt,
                  authorization.staleAfterMs,
                ),
        verified: knowledgeConflict
          ? axis(
              'unknown',
              {
                kind: 'product-knowledge',
                id: resource?.path ?? 'index.json',
                digest: resource?.sha256,
              },
              'stale',
              'Connector product knowledge conflicts with the installed manifest.',
            )
          : !evidence
            ? axis(
                'unknown',
                { kind: 'validated-evidence', id: `connector:${manifest.id}` },
                'unknown',
                'No trusted validated evidence snapshot names this connector.',
              )
            : !evidenceMatches || !evidenceFresh
              ? axis(
                  'unknown',
                  { kind: 'validated-evidence', id: evidence.evidenceId },
                  evidenceFresh ? 'unknown' : 'stale',
                  evidenceFresh
                    ? 'Validated evidence does not match this build and manifest digest.'
                    : 'Validated connector evidence is stale.',
                  evidence.validatedAt,
                  evidence.staleAfterMs,
                )
              : axis(
                  'yes',
                  { kind: 'validated-evidence', id: evidence.evidenceId },
                  'fresh',
                  `Validated evidence: ${evidence.source}.`,
                  evidence.validatedAt,
                  evidence.staleAfterMs,
                ),
        healthy: !instance
          ? axis(
              'unknown',
              { kind: 'observation', id: manifest.id },
              'unknown',
              'No connector observation exists.',
            )
          : !manifestMatches
            ? axis(
                'unknown',
                { kind: 'manifest', id: manifest.id, digest },
                'static',
                'The connection instance version or manifest digest does not match the current manifest.',
              )
            : !isFresh
              ? axis(
                  'unknown',
                  { kind: 'observation', id: instance.id },
                  observedAt ? 'stale' : 'unknown',
                  observedAt
                    ? 'The latest connector observation is stale.'
                    : 'No connector observation exists.',
                  observedAt,
                  instance.staleAfterMs,
                )
              : axis(
                  instance.status === 'connected' && instance.problem === null ? 'yes' : 'no',
                  {
                    kind: 'observation',
                    id: latest ? `${latest.resourceId}:${latest.key}` : instance.id,
                  },
                  'fresh',
                  instance.problem ?? `The connection reports ${instance.status}.`,
                  observedAt,
                  instance.staleAfterMs,
                ),
      });
    });
}

function workflows(
  knowledge: ProductKnowledgeBundle,
  snapshot: ReadinessRuntimeSnapshot,
  routes: readonly ReadinessCapability[],
  connectors: readonly ReadinessCapability[],
  conflicts: readonly ProductKnowledgeConflict[],
): WorkflowReadiness[] {
  const definitions = knowledge.resources.flatMap((item) => item.resource.workflows);
  return definitions.map((definition) => {
    const scope = `workflow:${definition.id}`;
    const workBlockers: WorkflowBlocker[] = [];
    if (conflicts.some((item) => affected(item, scope)))
      workBlockers.push({
        code: 'knowledge-conflict',
        requirement: scope,
        detail: 'Shipped knowledge for this workflow is conflicting or stale.',
      });
    const requirements = definition.requirements.map((requirement) => {
      const found =
        (requirement.kind === 'route' ? routes : connectors).find(
          (item) => item.id === requirement.id,
        ) ?? null;
      const key = `${requirement.kind}:${requirement.id}`;
      if (!found)
        workBlockers.push({
          code: 'capability-missing',
          requirement: key,
          detail: 'The required capability is absent from the derived build/runtime projection.',
        });
      else {
        for (const name of READINESS_AXES)
          if (found.axes[name].value !== 'yes')
            workBlockers.push({
              code: 'axis-missing',
              requirement: `${key}:${name}`,
              detail: found.axes[name].detail,
            });
        if (requirement.kind === 'route') {
          const contract = ROUTE_CONTRACTS[requirement.id];
          for (const command of requirement.commands)
            if (!contract || contract.commands[command].support === 'unsupported')
              workBlockers.push({
                code: 'command-unsupported',
                requirement: `${key}:${command}`,
                detail: contract?.commands[command].note ?? 'No route contract exists.',
              });
          const controls = ADAPTER_CAPABILITIES[
            requirement.id as keyof typeof ADAPTER_CAPABILITIES
          ] as Record<string, unknown> | undefined;
          for (const [name, expected] of Object.entries(requirement.controls))
            if (controls?.[name] !== expected)
              workBlockers.push({
                code: 'control-missing',
                requirement: `${key}:${name}`,
                detail: `This route reports ${String(controls?.[name] ?? 'unknown')}; ${expected} is required.`,
              });
        } else if (requirement.operations.length) {
          const manifest = snapshot.connectors.manifests.find(
            (item) => item.manifest.id === requirement.id,
          )?.manifest;
          const offered = new Set(manifest?.operations.map((operation) => operation.id) ?? []);
          for (const operation of requirement.operations)
            if (!offered.has(operation))
              workBlockers.push({
                code: 'operation-missing',
                requirement: `${key}:${operation}`,
                detail: 'The installed connector manifest does not declare this operation.',
              });
        }
      }
      return { ...requirement, capability: found };
    });
    return {
      id: definition.id,
      title: definition.title,
      requirements,
      ready: workBlockers.length === 0,
      blockers: workBlockers,
      routeSwitch: 'explicit-only',
      selectedAlternatives: [],
    };
  });
}

/** A pure, deterministic view over existing registries and injected cached facts. */
export function projectReadiness(input: {
  snapshot: ReadinessRuntimeSnapshot;
  knowledge: ProductKnowledgeBundle;
  now?: string;
}): ReadinessProjection {
  const now = input.now ?? new Date().toISOString();
  const conflicts = [...input.knowledge.conflicts];
  const routes = routeCapabilities(input.snapshot, input.knowledge, now, conflicts);
  const connectors = connectorCapabilities(input.snapshot, input.knowledge, now, conflicts);
  return {
    contractVersion: READINESS_CONTRACT_VERSION,
    generatedAt: now,
    build: input.snapshot.build,
    knowledge: { bundleSha256: input.knowledge.bundleSha256, conflicts },
    routes,
    connectors,
    workflows: workflows(input.knowledge, input.snapshot, routes, connectors, conflicts),
  };
}
