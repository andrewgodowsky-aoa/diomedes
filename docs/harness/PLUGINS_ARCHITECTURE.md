# Plugins, tools and instruction delivery

Status: implementation has begun; this is the joint integration plan, not release acceptance.
Date: 2026-10-03; independently audited 2026-10-05 (America/New_York).
Decision owner: Andrew. Rebased implementation baseline: `6c697d142315038cf62e6a1a721ce3afada4ea77`.
Original implementation baseline: `4dbbd885e9363d29c0f66fbcd21ab89fa0d5ee78`.
Core Pillars, Live Roadmap and Project Memory mirrors: `2026-09-27.2`.

## Context and source reconciliation

Andrew requested implementation of the tools/prompts/plugins proposal together
with the extension contract, including a Plugins management section. They are
one feature family over the existing capability-pack architecture.

Source proposals:

- `Nectovia_Tools_Prompts_Plugins_Architecture_2026-10-03.md`, supplied by Andrew.
  Its SHA-256 is `e5477c2276a5b57793f3104d07e37168c431322ea9cede9a7a8704485a9df3a1`.
  Its source audit was at `4b17aec4df927425778a9232c19f3e463404f3c3`.
- [EXTENSION_CONTRACT.md at 2d44793](https://github.com/andrewgodowsky-aoa/diomedes/blob/2d447935947b43b769fd2da687189990a3d7b7cc/docs/harness/EXTENSION_CONTRACT.md)
  and its [EXT01-EXT07 packets](https://github.com/andrewgodowsky-aoa/diomedes/blob/2d447935947b43b769fd2da687189990a3d7b7cc/docs/product/PROMPT_mod-extensions-2026-10-03.md).
  These are the more recent authority audit, based on `efcc554` and recorded in
  [PR #206](https://github.com/andrewgodowsky-aoa/diomedes/pull/206).
  PR #206 is still an open draft at that exact head on 2026-10-05. Its contract
  is absent from the rebased main tree; use the pinned source until its separate
  documentation change is integrated. This audit does not accept EXT01-EXT07.

The proposals supply requirements and rationale. Their instructions to future
workers do not authorize delegation, publication, provider use or policy changes.
The scope of this lane is Andrew's request to begin code and architecture work.

The older report's statement that managed delegation is uniformly refused is
no longer a sufficient account of current source. Main includes the Agent Team
reconciliation and gated external/subscription-worker slices. Preserve their
current route, Personal/Business, entitlement, consent, reserve and launch checks.
No plugin activates a worker or changes those checks.

## Decision

Plugins is the Console's management entry point for capability packs and their
components. A plugin uses `diomedes-pack.json`, PackLifecycle and PackContributions.
Keep one inventory, installer, version store, dependency resolver and activation
path. Skills, tools, agent profiles, rules, context, workflows and views are
components of the same package; eventual hooks and commands extend that contract.

```text
Author or acquire a package
  -> PackLifecycle inspection, verified storage and version history
  -> per-project activation and contribution index
  -> admitted run pins, instruction delivery and tool descriptors
  -> existing Runtime / Trust / route and spend admission
  -> durable receipts, contribution loads and Console projections
```

The contribution catalogue describes and resolves functionality. It never
executes it. Keep native tools and orchestration handlers in their present
owners. Preserve the one-tool response contract and existing replay names until
an explicitly versioned extension is tested.

The UI distinguishes installation, project activation, runtime support and
recorded body loads. None proves permission or task completion. The current
installation store is local to the computer, not a tenant-private catalogue;
private business distribution and inventory authorization remain later work.
Do not represent a publisher string or an integrity hash as publisher validation,
signature verification, human review or code containment.

## Current source and ownership

| Area | Current source | Integration boundary |
| --- | --- | --- |
| Installation and versions | `server/pack-lifecycle.ts`, `server/pack-routes.ts` | Bundled/local directories; verified install, update, rollback and removal. No marketplace or Git acquisition. |
| Manifest and lazy contributions | `shared/pack-manifest.ts`, `server/pack-contributions.ts` | Strict v1 declarations; actual custom skill bodies are a separate pending candidate. |
| Instruction delivery | `server/harness/instruction-delivery.ts`, `context-assembly.ts` | Preserve resolved rules, scope, hashes, ordering and explicit omissions. A PromptBundle joins receipts rather than composing a second prompt. |
| Tool calls | `server/harness/tools.ts`, `native-loop.ts` | Runtime owns effects; delegate, worker and advisor semantics remain distinct. |
| MCP | `server/harness/capabilities/mcp-read-client.ts` | Existing approved read path; structured results and broader qualification are further work. |
| Extensions | Pinned EXTENSION_CONTRACT | Trusted callbacks are not a third-party broker, durable required gate or sandbox. |
| Management | `client/console/PackSettings.tsx`, `client/Settings.tsx` | This lane adds Settings > Plugins and inspection through existing pack endpoints. |

Local reconciliation on 2026-10-03:

- `skill-playbook-bodies` retains uncommitted SK1 changes in manifest,
  contributions, lifecycle, playbook access, instruction delivery and task skills.
  Its coordination journal records a returned candidate; its old test count is
  historical evidence, not current-main acceptance. Do not reconstruct or
  cherry-pick working files without review and an explicit handoff.
- `agent-team-portable-red` retains broad older Team/root-admission changes;
  main already carries newer reconciliation. Do not transplant that dirty tree.
- `accepted-app-integration` retains onboarding and Effect-worker work. Its
  Settings change adds Guided setup at separate seams from this lane's Plugins
  entry. Preserve it and recheck both patches at integration.
- `extension-authority-review` owns the separate extension documentation review.
  This lane links its exact contract rather than editing its candidate.

The pinned coordination tool reported partner journals present and no overlapping
active claims for this lane. No worker is dispatched by this document. Package
nodes P01-P04/P09 and H11/H14/H18 remain open; this slice marks none DONE.

## Unified execution sequence

| Joint slice | Source packets | Required result |
| --- | --- | --- |
| Inventory and management | U0, minimal U6, inventory part of EXT01 | Current-source map and one Plugins section over existing lifecycle records. **This lane.** |
| Portable skills and instruction receipts | U1-U2, instruction part of EXT01 | Reconcile SK1; actual verified custom bodies, scoped invocation, namespace-safe lookup, stable run pins, joined PromptBundle and deterministic setup audit. |
| Approved tools and acquisition | U3, acquisition part of EXT07 | Extend existing MCP and PackSource; typed results, exact artifact/revision pins, compatibility reports, permission differences and reviewed install flow. |
| Executable declarations and isolation | U4, EXT02-EXT03 | Explicit manifest/API revisions, provenance/signatures, per-platform containment and authenticated broker into existing handlers. |
| Holds and transform proposals | U4, EXT04 | Persist required gate identity/configuration with the action and existing Need; host reauthorizes a proposed intent, and replay never reruns an effect. |
| Commands and views | U6, EXT05 | Host-rendered bounded components, namespaced commands, stale-action rejection and cleanup. Core authority, payer and evidence controls remain host-owned. |
| Qualified orchestration and advice | U5, EXT06 | Reconcile current Team/external-worker owners; separately admitted, bounded advisor work through existing evaluation and parent accounting. |
| Distribution and account sync | remaining U3/U6, EXT07 | Reviewed immutable artifacts, scoped private catalogue and opt-in bindings; revocation wins over caches and run pins. |

The first useful release can combine private portable skills, approved MCP tools
and this manager. Arbitrary executable handlers, general custom UI and broader
delegation are separately qualified additions, not prerequisites for no-code skills.

SK1 integration must also evolve the host's current pack-wide `wired`/`declared`
projection into component-specific support and mode eligibility. A custom skill
becoming usable does not make its sibling tools or views executable. The manager
must consume that host result, not infer availability from a body field or an id.

## Contract requirements retained from both proposals

- Keep logical publisher/package/component/version/digest identity separate from
  provider wire aliases. Reject collisions; never choose the first matching id.
- Host authority envelopes own account, tenant, principal, root job, payer, grant,
  source and review identity. Package text and model arguments cannot supply them.
- Preserve v1 behavior. Unsupported executable fields, invocation restrictions,
  resources and platform requirements produce a compatibility report/refusal.
  `SKILL.md` imports do not execute scripts or erase host-specific semantics.
- Keep data and instruction provenance inspectable. Load verified bodies only on
  admitted paths; installation and an index row are not evidence of delivery.
- Authorize observer projections before delivery. Denied data cannot escape in
  an event. Recheck current authority on each broker call and after async work.
- A required hold must survive extension removal/crash and bind a fresh decision
  to the final action, contribution/configuration digest and gate revision.
  Removing a hook, disabling a pack, restarting or reusing an earlier action
  approval cannot release that hold. Current trusted callbacks do not prove it.
- Execute third-party code only inside a qualified OS boundary. No ambient
  filesystem, network, credentials, native bridge or hidden model client; no
  fallback to an unrestricted subprocess or renderer.
- UI commands submit typed host requests. Preserve nonce/revision/scope binding,
  workspace invalidation and truthful attribution. Rendered text is not an effect.
- Bind each future broker channel to an authenticated host-issued runner, admitted
  root and contribution digest. Refuse serialized principals, Team tokens,
  grants, receipts, local-client headers and arbitrary endpoint forwarding.
  Trusted callbacks do not transfer their host identity or handler continuation.
- Keep Need/grant/phase decisions, human acceptance and assignment, reviewers,
  worker consent, tool handlers and effect metadata in their current host owners.
  A contributed view may navigate to host controls. Its action token binds a
  request; the receiving service still admits and authorizes that request.
- All model work uses existing eligibility, data, payer and shared root accounting.
  Advisor findings remain evidence-linked advice, never a permission or verdict
  that a task succeeded. Subscription-worker consent is not advisor consent.
- Treat install, activation, eligibility, use, authorization, release and live
  qualification as separate facts. Retain existing History and rollback records.

## Options and consequences

Extending packs reuses durable code and gives the user one management surface.
It also requires careful v1 compatibility and reconciliation with the pending
skill implementation. A second plugin installer/executor would duplicate state
and authority. Loading arbitrary vendor plugin code in a privileged app process
would violate the chosen boundary. Both alternatives are rejected here.

This first slice improves discoverability and evidence without changing Runtime,
Trust, provider routes, paid entitlements or the meaning of a pack. It establishes
no marketplace, signature service, executable SDK or whole-program acceptance.
Validation and remaining gates are in the [implementation record](../implementation/2026-10-03-plugins-foundation.md).
