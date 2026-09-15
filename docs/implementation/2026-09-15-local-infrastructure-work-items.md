# Local Infrastructure work items

Version: 2026-09-15.1
Status: Planned implementation backlog. No row below is shipped by this document.
Sources: owner Private AI brief; `docs/product/2026-09-15-local-infrastructure.md`; existing H01/SDKR and remote-host direction.

## Sequencing and acceptance

The narrow restaurant pilot, measured case study and repeatable hospitality offer remain the immediate commercial sequence. Infrastructure work can establish reusable boundaries now; customer equipment purchases follow workload evidence. Owners below name existing responsibilities, not a newly assigned person or a competing service.

| ID / priority | Scope and owner | Dependencies | Acceptance required before completion |
| --- | --- | --- | --- |
| LI-01 / P1 | Discovery/compatibility observations under `server/local/`; inventory owner | H01/direct-model consumer contract review | CPU/GPU/RAM/storage and per-adapter runtime probes; unknown and unsupported fields explicit; shared/unified memory not double-counted; CPU-only, multiple GPUs, missing tools and malformed output fixtures; disclosure; no installation side effects |
| LI-02 / P1 | Versioned model artifacts, storage and profiles; existing Files/configuration owners | LI-01; existing guarded path and approved-install mechanism | Digest/version/license/provenance, modalities/quantization/context and role metadata; atomic download/rollback, interruption/corruption/disk-full checks; profiles cannot grant access; remove only owned unreferenced artifacts through explicit policy |
| LI-03 / P1 | First driven local inference adapter in the H01/direct-model plane | H01 + SDKR consumer ready; LI-01/02; Trust broker | Configurable runtime adapter with owned start/stop/restart, health and cancellation; representative generation plus separate retrieval model path where supported; no model-family constants; live single-host inference and truthful engine/model attribution; no user-process takeover |
| LI-04 / P1 | Policy-governed workload routing and fallback; existing execution/Trust owners | LI-03; provider destination and payer classification | Quality/capability/context/concurrency eligibility; local-only blocks remote and unknown locality; approved hybrid route preserves data classes/payer and budget; revoke-between-admission-and-send tests; outage never leaks context; child/reviewer costs included |
| LI-05 / P1 | Workload sizing, benchmark and evaluation record | LI-03; representative approved/synthetic tasks | Repeatable quality and latency criteria, prompt/generation timings, concurrency, memory, optional power, context, version/digest and failure evidence; test dense/MoE and specialized model profiles without family preference; no capacity guarantee inferred from VRAM |
| LI-06 / P2 | Operating windows, maintenance and restart; existing host/RunService owners | LI-03/04; durable scheduler admission available | Manual/always-on/business-hours policies, timezone/DST and missed-window tests; safe drain, owned restart, low-power idle; supported/unsupported sleep/wake; power loss/reboot/reconnect recovery with no duplicate effects, orphan processes or revived grants |
| LI-07 / P1 before shared use | Organization/location boundary enforcement; identity/Trust and retrieval owners | Production organization identity; remote-host scope; LI-04 | Shared knowledge with explicit location visibility; cross-client and cross-location denial across files, retrieval, embeddings, caches, logs, jobs and support views; audit records identify tenant, location, data and job; revoked membership denied |
| LI-08 / P2 | Remote health and typed maintenance actions; existing remote-host/Observatory owners | Pairing/device/session/revocation contract; LI-06/07 | Health, offline age, runtime/model state, jobs, failures, storage/resources/temperature where available, alerts and maintenance; restart bounded to owned host/runtime through Trust; no shell; stale/offline/revoked device cannot report ready or act |
| LI-09 / P1 before deployment handover | Customer ownership, backup/restore and support offboarding; Store/Trust and service-delivery owners | LI-02/03; explicit software/license and service terms | Customer-run start/recovery and backup restoration rehearsal; retain local/BYO workflow/data/configuration after Managed cancellation; revoke support access and paid cloud entitlement separately; no artificial disablement or hidden ongoing dependency |
| LI-10 / P2 | Cloud/local/hybrid TCO assessment tool; business and website owners | Measured workload inputs from LI-05; explicit supported quote terms | Editable assumptions; 3/5-year horizons; setup/equipment/power/support/replacement/retained cloud costs; no-break-even and cloud-preferred outcomes; reject invalid inputs, expose uncertainty and distinguish nonfinancial benefits; deterministic calculation tests; no invented benchmark defaults |
| LI-11 / P2 | Diomedes Verified Local evidence publication; verification owner | LI-05 plus release/privacy consent for each artifact | Reproducible workload method, exact configuration, results and failures, tested scale/stability window, raw evidence and limitations; no certified SKU or cherry-picked synthetic headline; repeat after meaningful model/runtime/hardware change |
| LI-12 / P3 | Multiple machines/advanced deployment; existing placement/remote-host owners | Demonstrated capacity need; LI-04 through LI-09 | Measured placement and concurrency; tenant isolation through failure/reconnect; multi-host recovery tests. HA/SLA/enterprise controls require separate design and evidence before any promise |

## Pass delivered here

- Strategy and commercial scope: `docs/business/2026-09-15-private-ai.md`.
- Existing-code inventory and architecture decision: `docs/product/2026-09-15-local-infrastructure.md`.
- Roadmap and project-memory amendments; pricing revision 2026-09-15.3 preserves Starter/pilot.
- Website Private AI page, homepage introduction, pricing/services and trust links, assessment form and planned registry entries.
- Runtime remains unchanged. No install, model download, GPU purchase, provider call, Core packaging or live-instance changes.

Each implementation item needs scoped tests plus the repository's applicable gates before merge. Static contracts are not local-inference, multi-location, recovery or offboarding certification. Website verification is recorded in the pass report.
