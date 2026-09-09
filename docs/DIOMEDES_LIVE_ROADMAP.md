# DIOMEDES LIVE ROADMAP

**Roadmap version:** 2026-09-09.2  
**Last reconciled:** September 9, 2026  
**Product:** Diomedes  
**Company direction:** Diomedes Systems  
**Cloud canonical:** Google Doc `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE`  
**Repository mirror:** `docs/DIOMEDES_LIVE_ROADMAP.md`

## 1. Purpose and authority

This is the current strategic and implementation-sequencing roadmap for Diomedes. It replaces the old pattern of stacking dated amendments and leaving obsolete build instructions in the same document.

Use this authority order when sources disagree:

1. Andrew's latest explicit decision or instruction.
2. The current version of this live roadmap for product direction, sequencing, and approved architecture.
3. The current repository plus fresh verification evidence for what actually exists.
4. Newer focused implementation/design documents referenced by the roadmap.
5. Older planning packages and historical reports as rationale/evidence only.

The roadmap says what Diomedes is trying to become. Source and verification say what Diomedes is today. Never upgrade a PROPOSED or PARTIAL item to VERIFIED merely because it appears here.

Every substantial implementation thread should read the newest available roadmap before architectural work and end with a `ROADMAP IMPACT` section stating what changed, what was verified, what remains open, and whether the roadmap needs reconciliation.

### Canonical synchronization rule

The Google Doc is the human/cloud canonical copy. This repository file is the implementation-friendly mirror. They must carry the same roadmap version and materially equivalent content. If versions differ, do not silently merge assumptions: reconcile the newer changes explicitly. A local planning copy such as `F:\Achilles\planning\DIOMEDES-LIVE-ROADMAP.md` is a cache, not a third authority.

## 2. North star

Diomedes is not merely a chatbot, GUI wrapper, workflow builder, or business automation shell. It is intended to become a genuine model-agnostic agent harness/runtime with a polished Windows-first human workspace.

The product should combine:

- a crisp GUI for ordinary users and technical power users;
- Diomedes-owned runtime semantics rather than permanent dependence on another harness;
- external engines such as Codex, Claude Code, OpenCode/Hermes and future agents where useful;
- local, subscription-native, BYO-API and provider-authorized cloud model routes;
- durable tasks/runs, approvals, evidence, recovery and history;
- deterministic workflows plus agent reasoning;
- model-agnostic rules/context injection and evidence-grounded self-improvement;
- skills/capabilities, memory, documents and project workspaces;
- secure remote/device access and eventually portable execution;
- business/client workspaces using the same underlying runtime and Trust model;
- consulting as an early commercial discovery and delivery layer.

A model or external agent is a participant in Diomedes Runtime. It is not the runtime itself.

## 3. Product principles

1. **Local-first remains mandatory.** Core personal/local use must remain useful without requiring a Diomedes cloud account or a functioning account service.
2. **Online accounts are now an approved active track.** They are not deferred merely because local-first exists. Accounts should add identity, sync, multi-device, hosted, team and Business capabilities without replacing the local principal/device model.
3. **Human authority where consequences matter.** Approval binds to one exact action and expected base state.
4. **Authentication is not authorization.** A valid account/session does not automatically grant every capability, project, tenant, credential or external effect.
5. **Capability honesty.** Start, queue, steer, stop, cancel, retry, resume, reconcile, restore and fork are distinct operations and should be represented truthfully.
6. **No hidden cost/authority fallback.** Local or subscription-native routes must not silently become separately billed API routes.
7. **Agents receive capability, not raw secrets, whenever practical.** Credentials belong behind a broker/adapter boundary.
8. **Evidence before done.** Claims should match observable proof.
9. **Performance is product quality.** Startup, RAM/CPU, latency, long sessions, event growth, rendering, process cleanup and local-model lifecycle are acceptance criteria.
10. **GUI-first, not GUI-only.** Technical depth can exist without forcing normal users into a TUI.
11. **One authority per durable domain.** Do not create parallel stores, approval systems, permission systems or execution authorities without evidence that the current owner must change.

## 4. Published implementation checkpoint

### GitHub state inspected September 9

Before roadmap-only documentation changes, remote `main` and `codex/harness-runtime-20260908` both pointed to implementation/history checkpoint `eab162c58151704454867573ce2427c02559cdac`. That merge connects the prior source history and includes the native harness delivery whose substantive runtime commit is `f6f0460f3e4c1571fa86b95280d191f29e133892`.

Roadmap/documentation commits after that hash do not themselves mean the runtime implementation changed. Agents must resolve current refs again before editing.

The repository currently records a successful local verification report for the harness delivery: type checking plus 483 Vitest tests across 18 files. That is recorded evidence from the delivering agent, not a fresh CI run by this roadmap reconciliation.

At reconciliation time:

- GitHub Actions reported **0 workflow runs** for the app repository.
- GitHub Releases reported **no releases**.
- Source publication, CI, packaged artifact, tested packaged artifact, local installation and public release remain separate statuses.

### VERIFIED/PRESENT in the published harness foundation

- Exact Need approval identity for supported paths: proposal/action/base binding, absolute expiration, durable decision receipts and execution receipts.
- A native harness host integrated into `createApp` after Store recovery.
- A real deterministic `format-report` vertical slice using harness run state, tools, exact approval, `Store.writeRecorded`, Session/Task mirroring and History.
- Durable harness run/step records and versioned per-run events.
- Bounded leases/fences and conservative restart behavior.
- `reconcile_required` handling for unknown/ambiguous effects in the bounded runtime.
- Mandatory policy checks before optional hooks.
- Baseline principal/capability, tenant/project label, information-flow and budget contracts.
- Pure-prefix fork support in the harness boundary.
- Cursor-based reconnect for the bounded per-run event route.
- Secret scrubbing for the delivered paths.
- The existing guarded document writer, write journal and restore/history mechanisms remain the mutation authority.

### PARTIAL / MISSING at this checkpoint

- The shipped harness vertical slice uses a scripted fixture adapter, not a real model.
- The real Codex route is not yet proven as a harness `EngineAdapter` under the new runtime authority.
- The new fixture start path does not yet carry the same durable Work-start command receipt contract as the earlier strict Work path.
- Per-run event cursors exist, but authenticated cross-device/project event replay is not complete.
- `HarnessPrincipal` is a policy object supplied by the trusted host; it is not yet proof of an authenticated human/device session.
- General credential brokerage, online account identity, device enrollment/revocation, and production tenant isolation are not established in the published source.
- General external-effect provider reconciliation is not implemented beyond the bounded `reconcile_required` semantics.
- A native OS containment backend is not established; worktrees are isolation for edits, not security sandboxes.
- The September 9 harness packet did not rebuild/prove the Windows package or browser UI for that exact source.
- The suspected packaged fixture resource-path issue remains **unconfirmed until reproduced**.

### Historical-doc warning

`docs/harness/CURRENT_STATE.md` is an older source audit of the `218f325` era. Keep it as historical evidence, but do not treat its implementation inventory as current. Prefer `docs/harness/RUNTIME_VERIFICATION.md`, `docs/harness/CHANGES.md`, `docs/harness/HARNESS_INTEGRATION_MAP.md`, current source, and fresh tests.

## 5. Responsibility architecture

These are responsibility boundaries, not instructions to create six services or six databases.

### Diomedes Desktop

Human experience: projects, Thread/Board/Team views, Workbook/Console until intentionally migrated, contextual inspector, model/route picker, Ctrl+K, approvals, documents/artifacts, history, settings/security/devices, and later Business surfaces. Desktop consumes durable truth; rendering state does not make it authoritative.

### Diomedes Core

Models, agents and capabilities: native agent behavior, external adapters, model routing, profiles, layered rules/context, skills/capabilities, memory, project semantics, advisor behavior, teams/subagents, and learning interfaces.

### Diomedes Runtime

Durable execution authority: command admission, runs/steps, receipts, events, checkpoints, retries/timeouts, cancellation, waits/wakeups, workflow execution, queues/concurrency, priorities/resource budgets, environment allocation, external-effect reconciliation, recovery/resume, replay and forks.

### Diomedes Trust

Identity and authority: local principal, device principal, authenticated session, online account, organization/tenant, agent/workflow principal, delegation, capability grants, exact approvals, credential broker, revocation, least privilege, tenant isolation, provenance/information-flow policy, audit identity, and package/update trust.

### Diomedes Observatory

Structured evidence and evaluation: traces, timings, model/tool usage and costs where available, retries/errors, approvals/corrections, outcomes, replay/evals, model/prompt/skill/workflow comparisons, regressions and evidence-grounded self-improvement. Do not depend on hidden chain-of-thought.

### Diomedes Interop

MCP tools/resources, MCP Apps embedded UI, ACP where appropriate, A2A, webhooks, APIs, external event triggers and future remote-agent interoperability.

## 6. Active work ownership — September 9

This is coordination guidance, not a permanent model preference.

### Codex — runtime/build integration owner

Current assignment:

1. Reconcile remote/local refs and active worktrees without destroying another agent's work.
2. Close the packaged-runtime proof gap in an isolated profile/output.
3. Reproduce or disprove the suspected fixture resource-path problem; fix only if reproduced.
4. Exercise the actual built UI/package for the delivered harness flow: progress, exact approval, decline, stop, reload/reconnect, History and supported restore behavior.
5. Implement the real Codex `EngineAdapter` described in `HARNESS_INTEGRATION_MAP.md`, reusing `askCodex` and the current pinned/supported protocol rather than creating a second provider integration.
6. Add the narrow run-scoped egress authority required for sending selected context to Codex.
7. Reuse the common durable start/admission authority for the model-backed entry path.
8. Preserve ambiguity: no blind redispatch after an uncertain provider outcome.
9. Add a minimal credential-free GitHub build/test workflow after the local packaged path is proven, unless a newer branch has already added one.

Codex owns runtime integration and the current run-scoped outbound-data authorization implementation. It should not independently invent a full account service or a competing Trust subsystem while Opus is working that track.

### Opus 5 — Identity, Trust and online-account owner

Andrew has explicitly approved **full online-account work**, not only scouting.

Opus is currently running a broad multi-worker research pass. Until its report is reconciled, the account/backend provider, exact passkey/recovery design and cloud data architecture remain undecided. Research findings do not become architecture by majority vote; they must be reconciled with the runtime, local-first requirement, security boundaries and operating cost.

Opus may proceed from research into implementation. Its track should cover the system as a whole rather than merely a login screen:

- local owner/principal and device identity;
- authenticated local session semantics;
- optional Diomedes online account linked to, not replacing, local identity;
- account enrollment/sign-in/recovery/revocation;
- device enrollment and independent device revocation;
- session lifetime, logout and invalidation;
- the shared principal/delegation contract consumed by Runtime;
- server-side capability/resource authorization;
- agent/workflow delegation;
- credential broker boundaries and secret storage;
- future organization/membership/tenant support;
- offline/account-service-unavailable behavior;
- security events and audit identity;
- native-desktop authentication UX and browser/IPC boundaries.

The online account may become important for sync, hosted services, Business, teams and multi-device identity, but core local use must not become unusable merely because the cloud account service is unavailable.

Codex and Opus must agree on shared interfaces/file ownership before both edit principal/grant/session authority. There should be one Trust contract, not a Codex permission system plus an Opus permission system.

### Fable 5.1 — design baseline, not current runtime owner

Fable's September 8 visual/interaction work remains the approved product design north star. Preserve its design decisions and handoff material; do not spend the remaining design capacity on another sweeping redesign while runtime/account foundations are moving.

A later Fable pass is best used to review actual packaged implementation, onboarding/account/security UX, or a specific weak screen against the established language.

## 7. Identity and account architecture — decisions already made

The provider/backend choice is pending Opus research, but these product/security decisions are already approved:

### Identity classes

- **Local Principal:** the local human owner. Core local use works without an online account.
- **Device Principal:** each trusted desktop/phone/device has independently revocable identity/key material.
- **Authenticated Session:** proves a current authenticated user/device context. A client header or caller-supplied ID is not sufficient by itself.
- **Diomedes Account:** online identity for account-backed features. It attaches to local identity; it does not erase it.
- **Organization / Business Tenant:** separate business/client identity with memberships and scoped data.
- **Agent / Workflow Principal:** durable delegated actor with only the capabilities needed for its work.

### Authorization

Roles can exist for understandable Business UX, but enforcement should be capability/resource scoped and server-side. Missing or ambiguous authority defaults to denial.

A consequential action should eventually answer:

1. Who requested it?
2. From which authenticated device/session?
3. Which agent/workflow acted for them?
4. Under which delegated capability/policy?
5. Against which project/resource/tenant?
6. What evidence proves the result?

### Credentials

Agents should request typed capabilities rather than receive raw API keys or refresh tokens. Secrets must not be placed in prompts, transcripts, ordinary project JSON, event attributes, crash reports or roadmap files.

Use OS-protected storage where appropriate, but do not confuse encryption-at-rest with authentication or process isolation. The final Windows key/vault mechanism must be selected from compatibility/security evidence.

### Account UX/security direction

Passkey-first and standards-based native authentication remain preferred directions, but Opus's current research may refine the exact provider and recovery design. For third-party OAuth from a native desktop application, prefer system-browser Authorization Code + PKCE patterns rather than collecting provider passwords in an embedded webview.

Sensitive operations should support step-up verification, especially device enrollment, recovery/auth changes, high-risk capability grants and destructive/consequential actions.

## 8. Runtime and Trust invariants

Preserve these as the system expands:

- A request has durable identity.
- Identical ambiguous retries reconcile; changed payload under the same identity is refused.
- Admission is persisted before dispatch where the runtime claims durable admission.
- Exact approval means one exact action against one expected base before expiry.
- Sending context to a provider is separate authority from approving the provider's proposed file write.
- Revocation blocks future authority; it cannot unsend an already dispatched request.
- An uncertain external effect remains uncertain until safely reconciled; do not blindly replay consequential non-idempotent actions.
- Event replay is authorization-aware.
- A saved old run must not resurrect a revoked identity/grant.
- Prompts/model output do not grant authority.
- A worktree is not an OS security sandbox.
- `enforced`, `observed`, `instructional` and `unsupported` guarantees remain distinct.
- Store/document mutation authority remains singular unless evidence justifies migration.

## 9. Near-term milestone sequence

Codex and Opus may work in parallel where interfaces are coordinated.

### M1 — packaged runtime proof

Demonstrate the current harness vertical slice in the actual relocated Windows package using synthetic data and an independent profile. Resolve the fixture-resource risk based on reproduction, not assumption.

### M2 — real provider under Diomedes Runtime

Run one real Codex-backed task through the harness step authority with durable start identity, narrow run-scoped egress, truthful provider guarantees, exact proposal review, recoverable write, and ambiguity-safe behavior.

### M3 — Identity & Trust + online account foundation

Land the Opus-researched account architecture and the local/device/session Trust foundation behind one shared contract. Full online account implementation is authorized; preserve offline/local operation. Reconcile Opus's report into this roadmap before locking provider-specific choices.

### M4 — CI / reproducible package gate

Add a minimal credential-free GitHub workflow for deterministic build/test gates. Signed-in provider smoke remains a separately controlled local/integration gate. Later add signed release/update infrastructure before broad public distribution.

### M5 — prove model-agnostic harness behavior

Route a second real model/engine through the same Diomedes rules, durable task semantics, Trust boundary, approvals and evidence. Avoid provider-specific duplication. This is a stronger harness proof than adding many adapters at once.

### M6 — authenticated remote/device access

Build pairing, short-lived sessions, per-device/project capabilities, revocation, authorized event replay, remote status/approval/stop, and high-risk rights off by default. Remote access builds on Trust; it does not bypass it.

### M7 — workflow/runtime substrate

Typed durable workflows with deterministic and agent steps, conditions/branches, retries/timeouts, waits/events, approvals and bounded fan-out/fan-in. Runtime semantics before a visual workflow-builder product.

### M8 — events, queues and resource governance

Event inbox/wakeups, schedules/webhooks, queueing, priorities, concurrency, token/model/tool/runtime/retry budgets and local GPU/VRAM/RAM awareness aligned with the existing LocalAI supervisor.

### M9 — Observatory, replay/evals and self-improvement

Replay historical cases against new model/prompt/capability/workflow versions; measure quality, corrections, latency, cost and failure. Self-improvement proposes versioned changes and earns adoption through evidence; it never silently escalates permissions, tenant access, billing class or secrets.

### M10 — Demonstration-to-Automation

Recorded human activity becomes a tested capability/workflow: deterministic steps where stable, semantic/vision reasoning where needed, generation where needed, explicit approval boundaries and verification checks.

### M11 — broader isolation/interoperability

Execution environment abstraction, stronger local containment, MCP Apps, A2A, snapshot-based forks/comparison, and eventual execution portability/teleportation. Implement when preceding runtime/Trust semantics are mature enough to support them honestly.

## 10. Product design direction

Preserve the September 8 approved language:

- graphite flat surfaces;
- sharp/crisp separation;
- sparse semantic cyan;
- DIOMEDES wordmark;
- strong readable typography;
- minimal cards;
- no ambient glow;
- no generic AI chat-bubble styling;
- restrained esoteric/technical character without becoming cryptic;
- contextual inspector;
- the current strong model picker and Ctrl+K interaction;
- Thread / Board / Team as views of one durable work object;
- Living Thread motion that follows actual state rather than decorative animation.

Team/conversation views need clear structural separation between threads; floating labels/words alone are not enough.

Current implementation names such as Workbook and Console may remain until a deliberate migration. Do not destabilize runtime work for terminology churn.

## 11. Model/engine strategy

Diomedes remains model-agnostic. Do not architect rules, memory, permissions, task state, workflows or evals around one provider.

External engines may remain useful even as Diomedes owns more harness semantics. Personal subscription-backed integrations are personal-use routes; commercial hosted/resold offerings require provider-authorized commercial arrangements.

Muse and local models remain candidates, not architectural commitments. Prefer empirical routing/eval evidence over benchmark marketing alone.

## 12. Business / consulting track

Product: **Diomedes**. Company direction: **Diomedes Systems**.

Business principle: **Find the weak point. Fix the workflow.**

Lead with measurable outcomes rather than model names or token counts: time recovered, repetitive steps removed, faster turnaround, fewer errors, cross-location consistency, accessible knowledge, approvals and evidence.

The locally owned three-restaurant group remains the preferred first controlled design-partner shape. Candidate workflows:

- multi-location management brief;
- marketing drafting + approval;
- SOP/knowledge assistant;
- invoice/vendor variance review;
- labor/scheduling recommendation support.

Initial pilots should be high-frequency, measurable, reviewable and low-to-moderate risk. Do not autonomously perform payroll, payments, hiring/firing/discipline, unapproved public posting, vendor ordering or other consequential decisions in the first pilot.

Production client data waits for credible tenant isolation, identity/membership, least privilege, credential protection, auditability, retention/offboarding, backup/recovery and incident-response expectations. Early pilots should prefer exports/lower-risk data over broad production admin credentials.

## 13. Security and information flow

Treat prompt injection as a systems-security problem, not a prompt-writing problem. Least privilege, secret isolation, provenance, capability policy, approval and external-effect reconciliation all matter.

The harness already has a baseline label/policy model. Extend it based on real paths rather than creating a speculative giant taint engine. Preserve source/destination/provenance so stronger policy remains possible.

Business tenant isolation must eventually apply to files, search, memory, embeddings/retrieval, events/history, private skills, credentials, agents and workflows. Never trust a client-supplied tenant ID as authorization.

Supply-chain trust matters because Diomedes may install or execute skills, MCP servers/apps, plugins, adapters, models, workflow packages and updates. Plan toward signed/trusted packages plus capability manifests. Diomedes releases/updates must eventually be code-signed before serious public distribution.

## 14. Website and deployment boundary

`andrewgodowsky-aoa/diomedes-site` is a separate public website project using Astro and Cloudflare Workers/static assets. Website deployment is not desktop deployment and its current forms/D1 setup is not automatically the Diomedes account backend.

Opus may recommend using parts of the web stack for accounts after research, but that is an explicit architecture decision, not an assumption.

Track these separately:

- app source published;
- CI verified;
- package built;
- package tested after relocation;
- package installed locally;
- signed/released artifact;
- website deployed;
- account backend deployed;
- production data migration.

One status does not imply another.

## 15. Agent coordination rules

- Read this roadmap before substantial architectural work.
- Resolve current repository/worktree state before editing; do not reset a newer checkout to a roadmap hash.
- Preserve unrelated user/agent work.
- Use isolated worktrees for parallel implementation.
- Record domain/file ownership when Codex and Opus touch adjacent Trust/runtime seams.
- One principal/grant/session authority, one approval authority, one durable runtime authority and one document mutation authority.
- Use current source and fresh verification over stale historical planning.
- Do not weaken guards to make a test pass.
- Distinguish synthetic fixture proof, real-provider proof, packaged-desktop proof, CI proof and production proof.
- End substantial handoffs with `ROADMAP IMPACT` and the next smallest safe slice.

## 16. Open strategic decisions

Do not invent answers before the relevant research/evidence lands:

- online-account/backend provider and cloud data architecture — **Opus research active**;
- exact passkey/recovery/account-linking design — **Opus research active**;
- final Windows device-key/secret-storage mechanism;
- exact organization/membership schema and first Business tenancy rollout;
- whether/when the current JSON stores need a migration to SQLite/another persistence layer;
- first general external-effect adapter with provider-side reconciliation;
- exact durable workflow internal representation;
- Windows containment/sandbox strategy beyond existing provider controls;
- MCP Apps timing and UI containment;
- A2A timing;
- release/update signing pipeline;
- managed cloud-worker architecture and pricing;
- first default native/local model route;
- exact first restaurant-pilot workflow/data source after owner discovery.

## 17. Retired / stale guidance

The following directions are no longer current and must not drive new implementation:

- “Exact-action approvals are still missing.” They landed for supported paths before the September 9 harness delivery.
- “The native harness/runtime is only planned.” A bounded native harness foundation is published; extend it rather than recreating it.
- “Online accounts are later; do not build them.” **Retired.** Andrew has authorized Opus to research and implement the online-account track now, while preserving local-first behavior.
- “`CURRENT_STATE.md` is the current implementation inventory.” It is historical.
- “A local client header or serialized HarnessPrincipal proves an authenticated human.” It does not.
- “A worktree is a security sandbox.” It is not.
- “The website deployment is the desktop/account backend.” It is a separate project unless a later architecture deliberately connects them.
- Older Achilles product naming is historical only; current product naming is Diomedes. Historical filesystem paths may remain where renaming would create risk.
- Older AionCore-centric host architecture is historical rationale, not the current host authority.

## 18. Acceptance culture

Foundation/runtime/security/account changes need verification proportional to the invariant: deterministic tests, duplicate/lost-response tests, stale/replay tests, concurrency, crash/restart, write-failure injection, authorization denial, revoked/expired identity tests, cross-project/tenant tests, browser/renderer boundaries, packaged desktop smoke, real provider smoke where warranted, performance measurement and explicit proof boundaries.

Use `VERIFIED`, `PARTIAL`, `MISSING`, and `DEFERRED`. Never claim a fixture proves real-provider behavior, source tests prove a packaged executable, or an account login proves authorization correctness.

## 19. Change ledger

- **2026-09-09.2** — Replaced the stacked September 8/9 roadmap with one current document; reconciled published native harness state; removed stale approval/runtime/account deferrals; made online accounts an approved active Opus-owned track; preserved local-first as a compatibility requirement; established Codex/Opus ownership boundaries; prioritized packaged proof, real Codex EngineAdapter, Trust/accounts, CI and second-engine harness proof; added a repository roadmap mirror for local agents.
- **2026-09-09.1** — Reconciled the published native harness runtime, exact approvals, packaging proof gap, run-scoped egress direction and roadmap synchronization requirements.
- **2026-09-08.1** — Initial canonical roadmap created from the September 4/5 plans, business track, design direction, durable Work Admission and missing-harness feature audit.

### Next reconciliation trigger

Reconcile this roadmap when any of the following lands: Codex packaged-runtime proof; real Codex EngineAdapter; Opus account/Trust research decision or implementation; first GitHub CI run; major persistence/host change; or an explicit new Andrew product decision.
