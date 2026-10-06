# Operations, migration, rollback and acceptance runbook

This is a build requirement, not an executed deployment. All environments begin with synthetic owned data. Hosting, providers and native engines require their actual authorization and compatibility proof.

## Data ownership and deployment

Keep local memory under the correct installed profile with user-private filesystem permissions. A same-user unrestricted shell is not a strong tenant isolation boundary; shared-host business isolation requires an appropriate execution identity and existing Trust controls. Do not advertise encrypted memory merely because the host disk might be encrypted. Use the existing credential/encryption facilities and explicitly record the achieved protection.

Managed records live behind existing server identity/tenant authorization, not a desktop-supplied organization ID. Use constrained database roles, composite tenant references, bounded pagination and request/response limits. Large retained sources use the approved source/object layer; never place raw blobs into analytics. Region and provider-retention requirements apply to every auxiliary inference operation.

Use existing cloud infrastructure first. AWS credits are not a reason to provision an idle GPU or duplicate the control plane. Use existing PostHog metadata analytics, flags and errors as appropriate; do not enable content capture or session replay of memory bodies by default. No credit eligibility or unmetered inference is assumed.

## Migration and backup sequence

Before a schema change, snapshot the existing schema/version, test upgrades from supported prior versions on disposable stores, prove backup restoration and reserve current migration ownership. Store source/code/version digests and rollback compatibility. Never renumber or edit historical applied cloud migrations.

A rollback can revert compatible software/index generation, not revoke a newer deletion or restore an expired permission. Apply the current access/deletion suppression frontier before exposing restored records. A database older than the required frontier must stay inaccessible until reconciliation. Disclose what backup payloads retain and when authorized expiration occurs.

Treat search/embedding/graph projections as rebuildable. Read from the last qualified compatible index when allowed; otherwise fall back to scoped exact/text or transparently report unavailable. Do not restore stale derived facts as current because an index version is convenient.

## Queue and worker controls

One admitted owner per maintenance scope, bounded retry and lease/fence checks. Job identity binds scope, source watermark, method/model revision and expected output generation. Do not hold global locks during network/model work. Slow tenants must not block every other tenant; use per-scope queues with existing resource ceilings.

Stop prevents further effectful/model steps as supported; an already transmitted provider input cannot be recalled. Reconcile uncertainty instead of retrying blindly. A single-host scheduler records missed/deferred work; an always-on managed host is a separately qualified deployment, not an implied capability.

## Proposed rollout flags

Use existing feature-flag/configuration infrastructure for separately controlled `memory_capture`, `memory_recall`, `context_continuation`, `context_exhaustive`, `memory_maintenance`, `memory_hybrid` and `memory_amr_export`. Names are proposed and must map to existing conventions. A flag enables code availability, not data access, paid entitlement or spending.

Roll out: internal synthetic → approved test profile → small explicitly opted-in tenant cohort → broader qualified support. Record release candidate identity and exact supported model/engine/platform matrix. Keep core read/edit/forget functionality available if a quality accelerator is disabled.

## Incidents

**Wrong fact:** deactivate the operative revision, retain appropriate correction provenance, invalidate derivatives/caches, inspect use receipts and affected outputs, and rerun only authorized affected work. Do not silently edit historical receipts.

**Source/tenant disclosure:** halt affected processing, revoke capability/session access, preserve minimum incident evidence securely, determine disclosure scope and follow existing incident responsibilities. Disabling search is not sufficient if a kept model session still holds the content.

**Forgotten content reappears:** stop the old queue generation, inspect suppression frontier and restore path, invalidate active derivatives and verify replay defenses before resuming.

**Compaction drift:** suspend optional model compaction, use a validated deterministic capsule and rehydrate sources. Compare lost constraints against original evidence; do not repair by generating another unsupported summary.

**Unexpected cost:** stop new capture/maintenance, preserve uncertain holds, aggregate all model iterations/children and compare actual provider receipts. Do not equate missing usage to zero or refund unresolved external spend.

**Incomplete exhaustive result:** mark result partial, retain manifest/frontier and isolate missing partitions. Resume with idempotent reducers and reconcile source versions before publishing a new complete result.

## Offboarding and user controls

Export only what the requesting principal can read, with selected current-state scope. Warn explicitly when Git history or remote export increases retained copies. Provide correction/forget/search controls independent from the modeling provider. Disconnecting a provider does not by itself delete memory, and deleting active memory does not erase previously transmitted data elsewhere.

Record completion separately for active-store deletion, derivative cleanup, queue suppression, replicas, permitted backups, exports and external provider limitations. No blanket compliance certification follows from an API returning success.

## Release sign-off

Check all W00–W11 evidence, 96 specified case mappings, independent review, successful restore and purge tests, local platform packaging, managed-role tests, exact route/engine proof, latency/cost/quality reports, and truthful user disclosures. Mark unqualified combinations disabled or unsupported, never implicitly green. Publishing requires the owner's applicable explicit authorization.
