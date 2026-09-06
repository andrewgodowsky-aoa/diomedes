# Achilles — review of Fable's v3 replan and v4 carry-forward

Date: 2026-09-05  
Status: review and recommended amendments; not implementation authorization  
Inputs: Fable's `2026-09-05-v3-replan.zip`, the original master-plan documents it references, Andrew's stated requirements, and the v4 business strategy package.

## Verdict

Keep Fable's v3 replan as the technical baseline. It is sufficiently concrete to justify an isolated foundation proof; another whole-platform replan is not the next useful step. Do not execute its existing `06-astra-handoff-v3.md` verbatim: the first implementation bundle is too broad, the source-to-release mapping is unresolved, and several contracts need tighter acceptance tests.

The strongest candidate remains an independent Achilles client over a replaceable host integration, using AionCore for the engine/session mechanisms it actually provides and adopting selected Nimbalyst editing mechanisms. This is a recommendation to test, not a claim that AionCore has passed on Andrew's Windows installation.

The technical package is v3. The separate business amendment is v4. Those numbers refer to different documents; v4 does not silently approve or supersede all technical choices in v3.

## What this review did and did not verify

Read the executive recommendation, recheck, contracts, architecture, decisions, roadmap/tests, Astra handoff, commercialization note, source-inspection ledger, command ledger, design studies, and relevant inherited original-plan sections. Inspected static layouts rendered from eight supplied design boards with network scripts and external fonts blocked.

This review did not execute AionCore, Codex, Claude, Hermes, or a local model; did not access Andrew's Windows machine; did not independently validate upstream source claims; and did not run any of Fable's T01–T21 acceptance tests. The package itself marks those tests **not run**. Layout inspection here is not a Windows font-rendering or interactive-performance test.

Sources below are copies of the supplied documents, not external verification of their claims.

## Keep these decisions

1. **Independent clients, host-owned work.** Closing the desktop should detach the client, not own the fate of a running task. Phone access uses the same host and task identity.
2. **AionCore as a replaceable candidate.** Pin and test an exact build; do not assume a stable SDK from the architecture diagram. A native-protocol fallback remains a decision after evidence, not a second host to build in parallel.
3. **View versus Work Mode.** Viewing existing work changes presentation. Work Mode sets next-request behavior and tools within previously granted authority. Changing an active run requires a supported, explicit transition.
4. **Capability honesty.** Instructions, observed events, enforcement, unsupported controls, steering, queued messages, interruption, and resume must remain distinct.
5. **Project-first Home and editable artifacts.** Keep Quick Chat available without requiring Git or a project. Files, plans, tasks, and conversations should form one coherent workspace.
6. **Nimbalyst mechanisms rather than wholesale app fusion.** The package usefully distinguishes file watching/review from actual prevention of conflicting writes.
7. **Local models and native subscription routes as alpha requirements.** A successful Codex-only demo is not the completed personal product.
8. **Production isolation.** Retain the reported current profile names and route roster as dated findings; rediscover before touching any configuration. Do not restore historical profile names or model aliases from chat memory.
9. **Learning, advisor, skills, and rooms remain in scope.** Their implementation can be staged; they are not dropped because the first proof is small.
10. **Hermes remains a separate, update-resilient lane.** Skills discoverability and readability can deliver a useful dev-home improvement without making the Achilles runtime depend on a modified production checkout.

Sources: [executive](sources/fable-v3/00-executive-recommendation.md), [contracts](sources/fable-v3/02-contracts-modes-host-remote-local-liveedit.md), [architecture](sources/fable-v3/03-architecture-and-reuse-matrix.md), [recheck](sources/fable-v3/01a-recheck-2026-09-05.md).

## Amendments before the next implementation milestone

### R01 — Bind inspected source to the exact runnable artifact

**Source finding.** The research ledger identifies `a7cc6de` as AionCore's default-branch head dated September 3 and `v0.2.1` as a release dated September 1. The rest of the package frequently pairs the release name and that head as though they identify one verified build. The ledger also says a Codex steering correction is present **at head**.

**Why it matters.** These entries do not establish which commit produced the proposed Windows release binary. A feature seen in the inspected head cannot automatically be treated as present in an earlier release. The same caution applies to identifying an unversioned local Nimbalyst copy with an upstream commit merely because its package version matches.

**Change.** Record repository, release tag, tag target/peeled full commit, asset identifier, digest, and executable-reported version separately. Inspect required protocol types and permission paths at the release commit. Mark provenance unknown where it cannot be established. Compare byte digests for individual Nimbalyst files before claiming exact correspondence. Do not generate a 41-module DTO mirror from a different head.

**Proof.** One manifest plus real protocol results from the exact pinned artifact. A mismatch calls for an explicit artifact or contract decision, not a silent upgrade to latest.

Source: [source ledger §0, §2.4](sources/fable-v3/research/source-inspection-2026-09-05.md).

### R02 — Prove the Achilles controls through AionCore, not merely in Codex documentation

**Source finding.** V0.5 primarily proves login, streaming, an approval, reconnect, and process cleanup. V1-A then depends on per-thread permission overrides, policy delivery, a scoped host `plan.write` MCP tool, and Codex steering.

**Change.** The foundation proof must establish whether those controls are reachable through the proposed AionCore route. Specifically: a genuinely read-only Plan run; a separate path for writing only plan artifacts; an explicitly authorized implementation write; and a reliable control/approval round-trip. Native Codex supporting an operation does not establish that the selected host forwards the needed settings.

Try implementation writes through both a file-edit path and a command capable of writing, using only disposable fixture files. Test path escapes and unexpected externally connected tools where they are present. Inspect effective policy, not a checkbox or only a capability declaration. A required mechanism that cannot be configured without changing global files is a blocked design dependency, not permission to weaken it.

Keep tests bounded. A transient subscription failure is not automatically evidence that AionCore is architecturally unsuitable; classify account/provider unavailability separately from adapter failure.

Source: [architecture §5](sources/fable-v3/03-architecture-and-reuse-matrix.md), [handoff §§4–6](sources/fable-v3/06-astra-handoff-v3.md).

### R03 — Move the shell comparison before the large frontend build

**Source finding.** Electron is selected for V1, while a Tauri comparison is optional in V2.5, after remote access and engine/local parity.

**Recommended change.** Make one representative Electron-versus-Tauri comparison an early decision gate, before committing to a large desktop implementation. Reuse the same minimal client and synthetic stream/document fixture; do not build two complete products. Toolchain downloads still require a bounded approval.

The decision should consider full relevant process-tree memory, startup, visible streaming delay, input/scroll responsiveness, file dialogs, clipboard, lifecycle, and Windows accessibility/scaling. Tauri is a serious candidate, not a guaranteed cure for leaks. React versus Svelte is a separate question: retain React if actual component reuse makes it worthwhile; do not rewrite the frontend merely to change the shell.

If the early comparison cannot run, record Electron as a temporary unmeasured choice and keep shell-specific code small. Do not declare the comparison completed or permanently defer the user's performance concern.

Source: [architecture §6](sources/fable-v3/03-architecture-and-reuse-matrix.md), [roadmap V2.5](sources/fable-v3/05-roadmap-and-acceptance-matrix.md).

### R04 — Split V1-A into verifiable deliveries

**Source finding.** The named first slice includes a gateway, event store, receipts, policy system, revision broker, task store, resource ledger, five client surfaces, desktop wrapper, and numerous integration tests. That is a meaningful milestone, not a small first implementation.

**Recommended sequence.**

- **Proof A:** exact artifact, real Codex session, required control surfaces, recovery classification, owned-process cleanup. Throwaway test tooling only.
- **Proof B:** same representative client fixture in the two shell candidates, measured once the toolchain scope is approved. Independent of business features.
- **First working product slice:** selected client/shell; Home; one real conversation; one editable Markdown plan; one authorized task; visible approval and review; preserved state across client detach/reopen. Build only the storage and policy pieces needed for this flow.
- **Early remote slice:** same task/session from a paired phone, including scoped new work as well as supervision.
- **Personal parity and expansion:** required Claude/Go/local routes, skills library, then advising, scoped learning, rooms, and richer artifacts. Run narrow feasibility checks for mandatory engines early enough that a Codex-only implementation cannot conceal an unsuitable foundation.

No new universal scheduler, complete Notion clone, generic plugin marketplace, or payment stack in the first product slice.

Source: [roadmap](sources/fable-v3/05-roadmap-and-acceptance-matrix.md).

### R05 — Phone access must include the ability to do work

**Source finding.** The phone study explicitly says it cannot start a run. The proposed device capability list names approvals, steering, stop, and files, but does not explicitly include new conversations or starting tasks.

**Recommended change.** Keep a supervision-only device preset, but add an explicitly granted owner-device preset with scoped `conversation.create`, `message.send`, and `task.start` operations. Those are proposed names, not existing AionCore fields. The device may operate only on its granted projects, profiles, routes, and budgets. Starting a run does not require granting a general-purpose terminal.

**Acceptance.** With the desktop closed and the host running, the paired owner phone can start a conversation, send a new request, start one already-authorized task, review/stop it, and receive truthful results. A lower-privilege device cannot do those things. No remote client may wake or start an offline host implicitly.

Source: [contracts §3.3](sources/fable-v3/02-contracts-modes-host-remote-local-liveedit.md), [design §5.7](sources/fable-v3/design/DESIGN_STUDIES.md).

### R06 — Define disconnections and uncertain outcomes before claiming durability

**Source finding.** An append-only gateway log and client command receipts are proposed, while AionCore event replay is unverified. The contracts say offline client commands may queue; the phone study says there are no queued commands.

**Change.** Separate loss of phone connectivity from loss of gateway-to-AionCore connectivity and from either process crashing. The gateway can replay only what it recorded or can reconstruct from authoritative history. If a command may have been accepted but the result cannot be established, persist **outcome unknown / reconciliation required** rather than resending it or calling it failed. Do not promise exactly-once external effects solely because the UI has UUIDs.

For the initial phone version, retain unsent text and document drafts locally. Do not silently queue approvals, stale steering, purchases, or other consequential actions while disconnected. Already-sent commands reconcile their receipts. Revalidate permissions, revisions, and approval expiry on reconnect. Distinguish **host unreachable** from **host confirmed stopped**; the host could still be working through a network outage.

Bound event/log retention and sanitize sensitive fields before persistence. Do not load the entire event history into every client or keep duplicate unbounded raw payload caches.

Source: [contracts §§3.2, 6.9](sources/fable-v3/02-contracts-modes-host-remote-local-liveedit.md), [architecture F2](sources/fable-v3/03-architecture-and-reuse-matrix.md).

### R07 — Do not label maintenance or a global pin as a complete local-model control plane

**Source finding.** The ledger describes maintenance begin/end, implicit route swapping, and a Boolean resident pin, while also stating that explicit load/unload/metrics endpoints are absent. The contract labels the composed maintenance path “Drain and unload.”

**Change.** Inspect the actual supervisor implementation before asserting that maintenance unloads a resident. Until proven, distinguish **drain/pause** from **unload**. A Boolean pin also does not establish multi-client ownership: record a pre-existing pin and never clear it simply because an Achilles task ended. A gateway-only queue does not protect against an external Hermes request; do not claim machine-wide exclusion without a supervisor-enforced lease or equivalent mechanism.

Initial implementation remains GET-only. Write controls are a separate approved supervisor change, with fixtures, concurrency tests, failure recovery, and rollback. A minimal completion used to load a route is an explicit inference action, not a harmless status check.

Mode context numbers (60k/120k/160k) are proposed ceilings, not verified model capacities. Derive actual budgets from the selected route's verified limit, output/tool reserve, and capability constraints; do not silently change quantization, template, or residency policy.

Source: [contracts §§2, 4](sources/fable-v3/02-contracts-modes-host-remote-local-liveedit.md), [source ledger §6](sources/fable-v3/research/source-inspection-2026-09-05.md).

### R08 — Test stream display and memory growth, not just a static transcript

**Source finding.** T20 covers a 10,000-message fixture, input/scroll/resize, startup, and process-tree memory. That is useful, but it does not alone diagnose the long-session leaks and delayed output Andrew described.

**Add.** A bounded multi-stream fixture; large tool messages kept outside the main render tree; repeated open/close/cancel cycles; a sustained streaming soak; slow-reader/backpressure handling; and timestamps at upstream delta receipt, host forwarding, client receipt, and visible paint. Report upstream model delay separately from UI delay.

Report warm-up separately from post-warm-up growth. Compare equivalent workloads and idle/reset states. Use consistent memory accounting and identify shared processes rather than blindly summing shared memory. Log temporary peaks and retained private memory after sessions close. A short test with no observed growth is not proof of “no memory leaks.”

A useful initial diagnostic target is p95 client-receipt-to-visible-update <= 50 ms under the agreed fixture; this is a proposed target, not a measured result or promise. Establish process baselines before choosing a memory ceiling. Tests that miss required targets remain failures/deferred gates, not passing tests just because a report was produced.

Source: [roadmap targets and T20](sources/fable-v3/05-roadmap-and-acceptance-matrix.md).

### R09 — Preserve an actual Notion-style product surface without building Notion

The v4 consulting/workspace idea is not fully reflected in this pre-v4 replan. Carry it forward as a product requirement, not another engine rewrite.

The early information model should distinguish workspace, stable document/page identity, artifact/revision, canonical task, conversation, run, data source, and permission scope. A page should be able to reference a task and its evidence. A later table and Kanban view should use the same records, not duplicate them. Do not introduce a universal database builder, hosted sync, or new formula engine into the first release.

Instrument is a good visual baseline to test. Keep the document-led strengths already proposed from Fieldbook. Later demonstrate a restaurant operations page with an attached report, linked tasks, and a review queue using synthetic data. Keep the technical inspectors optional. No client operational data is authorized by the planning package.

### R10 — Storage, credentials, cleanup, and startup must follow actual ownership

The recheck reports F: 40.4 GB free, D: 122.1 GB free, and C: 27.7 GB free at the observation time. That does not establish storage speed or justify using D: for all live databases/worktrees. Rediscover medium, free space, and intended workload. Prefer suitable SSD storage for latency-sensitive working data when available; large cold fixtures may belong elsewhere. No automatic cleanup or movement of existing data.

Do not initialize a repository solely to run a disposable probe. If the later application repository includes state, logs, fixtures, or vendor downloads, define exclusions before any commit. Never bulk-stage credentials or engine transcripts.

“No credential reads” applies to the assistant and custom glue; the legitimate native agent may use its own existing authentication store. Native sessions may produce their ordinary metadata writes; disclose them rather than promise literally zero writes outside the project while using that engine. Never copy, print, or transplant its credentials. Clear conflicting API override variables for the test child only without logging their values; do not modify global settings.

The source notes managed-resource downloading as an AionCore default. Discover a supported restricted/offline mode or fail closed on unexpected resource installation. Approving one release download is not blanket permission for a dependency installer.

Cleanup uses an ownership manifest of created paths and spawned process identities. Preserve test reports. Do not delete all of `apps`, `vendor`, or a fixture parent if it contained pre-existing work; never terminate all processes named Codex, Node, or AionCore.

Source: [recheck](sources/fable-v3/01a-recheck-2026-09-05.md), [source ledger §2.2](sources/fable-v3/research/source-inspection-2026-09-05.md), [handoff](sources/fable-v3/06-astra-handoff-v3.md).

### R11 — Reconcile inherited contracts and a small UI mistake

The v3 architecture changes the Achilles board owner to the gateway while saying the original Hermes lane is unchanged. The inherited H3/T6 text describes a shared-board arrangement where Hermes dispatches. Update those specific references: no dual dispatcher for the same workspace, and no unapproved production-board migration. Include any retained v2 sections the implementation actually depends on rather than requiring an absent parent folder.

The design notes disable Commit because there is no remote. A local Git commit does not require a remote; gate Commit on local repository/review/conflict conditions, and gate Push/Publish on their separate requirements. This is a small correction, not a reason to restart the design.

Source: [v3 board decision](sources/fable-v3/04-decision-gap-register.md), [original H3/T6](sources/fable-v2/05-phased-roadmap-and-evaluation.md), [design §5.5](sources/fable-v3/design/DESIGN_STUDIES.md).

### R12 — Keep business strategy parallel and evidence-led

Fable received v4 separately. Its v3 commercialization note is deliberately narrow, so lack of a complete restaurant plan in this ZIP is not a failure to follow that later input.

Keep the restaurant pilot separate from the personal-product engineering critical path. A permitted export-based weekly report can validate the consulting offer before the full Achilles desktop is finished. Do not require a finished universal platform to speak with management or test one administrative workflow.

Use one-user-first, business-ready boundaries. A personal profile is not a commercial tenant boundary; roles, account ownership, data separation, consent, revocation, support, and offboarding need explicit work before real client deployment. Keep client data out of the development fixtures and out of shared cross-profile learning.

Measure **net time saved** after preparation, review, corrections, and maintenance. Report released capacity separately from actual avoided expense; do not automatically call every recovered salaried-manager hour a cash saving. Three locations offer reuse potential, not automatic triple savings.

Treat v4 market statements as research inputs to verify before publication. Do not use Fable's phrase “the only lawful shape” as a legal conclusion. Provider arrangements, licenses, branding, distribution permissions, and eventual commercial access need a separate current review; no payment system or subscription resale is part of the next engineering task.

Sources: supplied v4 business strategy and pilot; [v3 commercialization note](sources/fable-v3/07-commercialization-note.md).

## Decisions recommended to Andrew

- Proceed with a **bounded feasibility proof of Approach 2**, not unconditional adoption.
- Use **Instrument as a provisional visual baseline**, subject to actual-size review on Andrew's displays. Do not treat fallback-font renders here as type approval.
- Make the **shell comparison early and real**; do not pre-decide either Electron or Tauri from reputation alone.
- Permit a future **owner-phone preset that starts scoped work**, alongside a supervision-only preset.
- Keep business-ready objects and permissions in the design, with the restaurant pilot and v4 integration in parallel.
- Leave production Hermes, LocalAI, bots, startup entries, and unrelated tools untouched.

No approval is inferred from this document. The Astra prompt asks for one consolidated authorization after read-only preflight and stops after the foundation proof. The larger application build, Tauri/toolchain installation, Claude/local-model probes, and remote listener each remain separately scoped until approved.

## Recommended immediate action

Give Astra `01-Astra-foundation-proof-prompt.md` and the source subset in this package. Give Fable `02-Fable-v4-integration-note.md` to reconcile its pending v4 update without another broad replan. The first evidence we need is a real native-agent/control round-trip and an honest foundation verdict, not additional mock controls.
