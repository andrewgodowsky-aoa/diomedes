# FD03 grounded readiness projection

FD03 adds a read-only projection over authorities that already exist. It does not add a route, adapter, connector, credential, proof registry, or execution path.

## Sources

- Implemented route and lifecycle-command facts come from `ROUTE_CONTRACTS`.
- Route controls come from `ADAPTER_CAPABILITIES`.
- Installed engine, sign-in and health facts are cached `EngineService.status()` rows. A readiness read never calls `discover()` or `check()`.
- Route selection comes from current Settings.
- Connector implementation comes from the existing manifest. Installation and authorization come from its connection instance. Health observations must match the same connection id, generation and project.
- Product descriptions come from the indexed files in `resources/product-knowledge`. The index binds every accepted file to an exact SHA-256 and named scopes.

Each capability keeps five separate axes: implemented, installed, authorized, verified and healthy. Every axis includes its source and freshness. Readiness is true only when all five are `yes`. Unknown and stale evidence remain visible and block readiness.

Shipped route descriptions are deliberately marked `unverified`. A resource that describes a route does not certify its own acceptance, even if future resource bytes label their own qualification verified. The verified axis reads only the separately injected `validatedEvidence` snapshot and stays unknown until a trusted reader supplies a current record for the exact build, contract and engine version or manifest digest. No acceptance-evidence reader is invented in this item. Likewise, a selected Settings route does not prove account authorization; cached engine status must report the account signed in. Paused and disconnected connector fixtures do not prove current authorization.

## Product knowledge

`index.json` names the knowledge-set version, build version, resource hashes and affected scopes. Loading fails closed per scope for a missing or invalid index, missing or altered bytes, build mismatch, duplicate resource identity, invalid schema, stale qualification, route-contract mismatch, engine-version mismatch or connector-manifest mismatch. Conflicts do not turn unrelated capabilities unavailable.

The instruction assembler includes whole, relevant resource statements only. It subtracts their exact rendered UTF-8 size from the existing instruction budget. If the section does not fit or its applicable knowledge conflicts, it is omitted whole.

The session receipt has three states:

- `prepared`: exact outbound section bytes and SHA-256 were assembled, but submission is not yet claimed.
- `omitted`: no section was included, with the reason recorded.
- `sent-and-response-returned`: `generate()` returned a provider response after receiving the prompt containing that exact section.

Provider errors retain `prepared`; they never become sent evidence. A successful response writes the existing session and History stores only. The receipt grants no authority.

## HTTP integration

Mount the routes with:

```ts
mountReadinessRoutes(app, {
  snapshot(req): Promise<ReadinessRuntimeSnapshot>,
  knowledge(): Promise<ProductKnowledgeBundle>,
  now?(): string,
});
```

`GET /api/readiness` returns the whole projection. `GET /api/readiness/workflows/:workflowId` returns one shipped workflow. A workflow lists only its declared requirements, blocks on every missing axis, command, control or connector operation, and reports `routeSwitch: "explicit-only"`; it never selects an alternative route.

The app integrator supplies cached Settings, engine and connection facts through `snapshot`. The product-knowledge loader is local-file-only. Neither GET route has a network, discovery, authentication or mutation callback.

## Verification boundary

Focused deterministic coverage is in `tests/fd03-readiness.test.ts`. It covers the five independent axes, stale engine facts, exact workflow scope, unsupported commands, all four A07 conflicts, altered bytes, connector authorization and observation isolation, read-only HTTP behavior, exact instruction hashing, successful receipt transition and provider-failure retention.

The live-model tier, packaged route mounting and browser presentation are not run by this implementation lane.
