# ADR: Local Infrastructure inside the existing Diomedes runtime

Status: Strategic direction accepted by owner brief; interfaces below are proposed, not shipped.
Date: September 15, 2026
Decider: Andrew; implementation must conform to H01 and shared Trust contracts.

## Context and decision

Private AI needs model/runtime/hardware lifecycle without creating a second agent runtime. The September 13 runtime decision already places direct models inside the Diomedes-owned loop through the planned AI SDK plane; external agents conform to H01, with ACP as preferred external transport. Preserve that decision.

```text
Capability/workload + current organization/project/location scope
    -> existing execution admission and model-routing policy
    -> direct-model provider plane OR external-agent H01 adapter
    -> inference runtime adapter (where local inference is used)
    -> customer-owned host/hardware

Local Infrastructure: inventory, model artifacts/profiles, runtime lifecycle,
health/capacity and operating-policy observations feeding those existing paths.
Trust: authority, data destination, credentials and effect admission.
Harness/RunService: durable work, cancellation, reconciliation and recovery.
Store/History: recorded changes, Needs/receipts and auditable evidence.
Remote host: existing planned pairing/device/session/revocation boundary.
```

An inference runtime serves model requests. An agent runtime owns tool use and work. They are distinct; a llama.cpp/MLX/vLLM/SGLang/Ollama or future engine adapter must not absorb agent sessions, permissions or workflow state. These are adapter candidates, not supported products. Select versions and verify capabilities before implementation.

## Live source inventory for this pass

Initially read against main `212106e` plus the user's existing working changes, then reconciled against publication base `7d2eb10`. The inventory paths below are unchanged across those commits except Store's additive task-admission receipts and source-document reference; those changes preserve the documented durable-work boundary. This is static source verification, not live local inference or release certification.

| Existing source | What it supports | Limit to preserve |
| --- | --- | --- |
| `server/local/hardware.ts`, `tests/hardware.test.ts` | OS/CPU/RAM, GPU/backend/VRAM observations, disk and installed-runtime discovery, disclosed commands, unsupported fields | Detection only; no install/launch. Current runtime IDs are a bounded discovery list, not a Core model taxonomy. Unified-memory/telemetry support is not inferred from a GPU name. |
| `server/discovery.ts`, `server/integrations.ts` | Installed engine/runtime probes, bounded local-service discovery | Detecting a running local model server does not make it a driven inference route. |
| `server/models.ts`, `shared/engines.ts` | Engine-reported catalogs, selected model/effort validation, adapter inspection | Agent-engine catalog entries do not describe model artifacts, quantization or hardware compatibility. |
| `shared/execution.ts`, `server/execution.ts`, `shared/configuration.ts` | Separate entitlement/Trust/budget gates, payer attribution, processing policy and `chooseFallback` | Local-only refuses a candidate marked remote. No managed local model exists; correctness of the remote-route classification and all dispatch rechecks remain prerequisites. |
| `server/engines/contract.ts`, `server/harness/codex-engine.ts` | Existing text adapter and harness model adapter | H01 convergence and AI SDK direct-model plane are settled planning, not a completed universal implementation. |
| `server/harness/run-service.ts`, `server/harness/host.ts`, `server/store.ts` | Durable work, cancellation/recovery, Needs/receipts and recorded writes | Not a production fleet scheduler, identity service or unrestricted background process manager. |
| `shared/capability-packs.ts`, `server/capability-packs.ts` | Versioned pack declaration and project activation with `grantsAuthority: false` | Only the current registered pack is implementation evidence; restaurant deployments remain composed work to build. |
| `shared/workspaces.ts`, `server/workspaces.ts`, `server/trust/` | Workspace/organization references and existing authority paths | These foundations do not certify multi-client hosted isolation or production location-based access. |
| Live roadmap section 8 and H01/SDKR direction | Remote paired hosts, explicit host availability, device identity, short sessions/revocation, phone status/approval/stop | Architecture target only; no new remote shell or competing host registry in this pass. |

## Proposed data and adapter boundaries

Keep domain descriptors data-only, versioned and separate from grants. Do not add a second catalog, router or persistent registry until its consumer exists in the H01/direct-model integration slice.

| Concept | Minimum contract and owner |
| --- | --- |
| Host observation | Reference the remote-host identity (or explicit local host), checkedAt, OS/architecture, CPU, physical RAM, per-device dedicated memory, shared/unified memory topology, storage and observed backends. Preserve unknown/unavailable states and source provenance. Do not add RAM and shared GPU memory twice. Discovery belongs under `server/local/`. |
| Inference runtime adapter | Stable adapter ID and version; declared support for inspect/setup/start/stop/restart/model-list/health/telemetry. Unsupported actions are explicit. Runtime-specific commands/protocols remain here, never in packs or business copy. Effects use the existing broker and approved installation path. |
| Model artifact | Opaque model ID/revision and digest, origin/license metadata, format, quantization, architecture metadata (including unknown/future), modalities, storage size and dependencies. Separate downloaded, verified, compatible, loaded and healthy facts; a file existing is not readiness. |
| Model profile | Artifact reference(s), runtime/config revision, context configuration, role/capabilities, limits and evaluation references. One workload may use several models; generation, embedding, reranking, vision and speech are separate capabilities. Profiles declare needs, never grant rights. |
| Compatibility result | Adapter version + host observation + artifact/profile digests, supported/unsupported/unknown, reasons and tested limits. CPU offload, several GPUs and unified memory need actual backend evidence. A static memory estimate is advisory. |
| Placement/capacity observation | Host/runtime endpoint, current health, load, available capacity, allowed concurrency and readiness provenance. Work admission consumes it; it does not admit work itself. Future multi-machine placement retains the same contract. |
| Operating policy | Manual/continuous/business-hours/service-window and optional supported sleep/wake, timezone/DST rules, maintenance window, idle behavior, drain deadline and recovery policy. Policy is configuration, not an authorization or independent schedule queue. |
| Verification record | Exact input/config versions, workload fixture/digest, evaluation criteria, repeats, failures, output quality, timing, concurrency, resource/power observations with unknowns, author/date and evidence links. Claims are scoped to this record. |

User-facing default: capabilities, available/unavailable, active work, understandable failures and recovery options. Technical view: model/artifact, quantization, runtime, memory/context and logs. Do not expose GGUF filenames or architecture terminology in the business flow.

## Security, routing and location scope

- Route by capability and workload quality first, then policy, compatibility, capacity, latency and cost. Model size or family never grants preference by itself. Local/cloud/hybrid is deployment intent; actual route admission resolves current data policy, destination, account/payer, entitlement and budget for each workload and its child/reviewer calls.
- For private-only work, unknown locality is not private. Customer-owned LAN inference is a separate host destination, not loopback. Extend classification through the shared routing owner before enabling it; do not weaken the existing `local-only` meaning to enable remote access.
- Recheck current authority/revocation and destination at dispatch, output acceptance and every later effect. A health failure, restart, model update or fallback cannot widen scope, change payer silently or revive a saved grant. Uncertain dispatched effects reconcile rather than blindly replay.
- Organization/tenant ID, location scope, project and pack/context version follow the existing execution envelope. Enforce isolation on files, retrieval/embeddings, caches, prompts, queues, logs, telemetry and support views. Organization-wide knowledge needs a deliberate visibility rule; a location cannot gain another location's data through summaries or model caches.
- Remote health projects existing records: online/offline, runtime/model availability, active jobs, failures, resource/storage pressure, alerts, maintenance, restart requests and audit history. Pair and revoke through the remote-host design. No normal-user unrestricted shell. A restart is a typed, scoped action on a known host/runtime, not arbitrary command text.

## Lifecycle and failure behavior

Discovery is disclosed/read-only; downloads and installation require explicit existing authority, trusted source/version/digest/license review, bounded storage and rollback. Do not download a model because a pack mentions it. Use customer-owned storage through the Files/path authority. Configuration and audit records reference credentials; they do not embed them.

Start only supported runtimes and track process/service ownership. Never kill a user's independently started model process. Safe restart drains or pauses work according to policy, records effects, reacquires authority and verifies health before admission resumes. Partial downloads, disk-full, corrupt artifacts, OOM, thermal pressure, failed health checks, interrupted starts and unknown process identity produce explicit states, not optimistic readiness.

Business-hours schedules require timezone/DST, overlap and missed-window behavior; sleep/wake capability is measured per host. Prefer always-on with idle/unloaded models when appropriate. Maintenance, reboot and power-loss recovery use durable run identity, idempotency and existing recovery; avoid duplicated jobs after reconnect. A sleeping job need not pin a model in memory. No HA promise follows from auto-restart.

Backup/recovery covers artifact/config inventory, necessary customer data, credentials through the existing secure mechanism, restore verification and offboarding. Keep purchased local operation functional after support termination; revoke support authority and paid services separately. Offline entitlement rules remain an open product decision and cannot erase local data or existing license rights.

## Alternatives and consequences

| Option | Advantage | Cost / decision |
| --- | --- | --- |
| Extend existing seams with inference adapters | Preserves Runtime/Trust, model independence and capability packs | Chosen; requires H01/direct-model and remote-host coordination before implementation |
| Separate hardware/fleet product | Fast independent prototype | Rejected: competing identity, queue, authority and work lifecycle |
| Bind product to one model/runtime/appliance | Small initial surface | Rejected: lock-in, weak workload sizing and rapid obsolescence |

Deliberately no Core production code in this pass. Hardware discovery and policy foundations already exist; an unconsumed parallel schema or daemon would create ownership before the real consumer is ready. Foundational implementation begins with LI-01/02 under H01 and the existing installation/Trust paths. Work items define the tests and gates; website changes have their own browser/build tests.

Conflicts resolved: older setup prices do not price full infrastructure; "local SaaS" describes delivery rather than inference; a local endpoint is not necessarily private; remote-host and H01 direction is reused rather than duplicated. No pillar, Trust preset, runtime timeout, paid inference route or published license changes here.
