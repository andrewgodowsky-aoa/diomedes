# DIOMEDES LIVE ROADMAP

**Roadmap version:** 2026-09-09.3  
**Last reconciled:** September 9, 2026  
**Product:** Diomedes  
**Company direction:** Diomedes Systems  
**Cloud canonical:** Google Doc `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE`  
**Repository mirror:** `docs/DIOMEDES_LIVE_ROADMAP.md`

## 1. Authority and synchronization

This is the current strategic and implementation-sequencing roadmap. It replaces stacked dated amendments and obsolete handoff instructions.

Authority order:

1. Andrew's latest explicit decision.
2. The newest live-roadmap version for product direction and sequencing.
3. Current source plus fresh verification for what actually exists.
4. Newer focused implementation/design documents referenced here.
5. Older plans and reports as historical rationale only.

The Google Doc is the human/cloud canonical copy. This repository file is the implementation mirror. They should carry the same roadmap version and materially equivalent content. A local planning copy such as `F:\Achilles\planning\DIOMEDES-LIVE-ROADMAP.md` is a cache, not a third authority.

Every substantial agent thread should read the newest roadmap before architectural work and finish with `ROADMAP IMPACT`.

## 2. North star

Diomedes is a model-agnostic agent harness/runtime with a polished Windows-first workspace, not merely a chatbot, wrapper, workflow builder or business-automation shell.

Long term it combines:

- a crisp GUI for ordinary and technical users;
- Diomedes-owned runtime semantics;
- external engines such as Codex, Claude Code, OpenCode/Hermes and future agents;
- local, subscription-native, BYO-API and provider-authorized cloud model routes;
- durable tasks/runs, approvals, evidence, recovery and history;
- deterministic workflows plus agent reasoning;
- model-agnostic rules/context injection and evidence-grounded self-improvement;
- skills/capabilities, memory, documents and project workspaces;
- secure remote/device access and later portable execution;
- business/client workspaces using the same Runtime + Trust substrate;
- consulting as an early commercial discovery/delivery layer.

A model or external agent is a participant in Diomedes Runtime, not the runtime itself.

## 3. Product principles

1. **Local-first remains mandatory.** Core personal use must remain useful without a functioning Diomedes cloud account service.
2. **Online accounts are an approved active track.** Accounts may add sync, identity, hosted services, multi-device, teams and Business features, but must not replace the local principal/device model.
3. **Authentication is not authorization.** A valid account/session does not grant every capability, project, tenant, credential or effect.
4. **Human authority where consequences matter.** Approval binds to an exact action and expected base state.
5. **Agents receive capability, not raw secrets, whenever practical.**
6. **No hidden billing/authority fallback.** Local or subscription-backed paths must not silently become separately billed API paths.
7. **Capability honesty.** Queue, steer, stop, retry, resume, reconcile, restore and fork are distinct operations.
8. **Evidence before done.** Claims must match proof.
9. **Performance is product quality.** Startup, RAM/CPU, latency, event growth, rendering, cleanup and local-model lifecycle are acceptance criteria.
10. **GUI-first, not GUI-only.** Technical depth should not require normal users to live in a TUI.
11. **One authority per durable domain.** Avoid parallel runtime, approval, permission, credential or mutation authorities.

## 4. Current implementation checkpoint

### Published GitHub state

The implementation/history checkpoint before roadmap-only commits was `eab162c58151704454867573ce2427c02559cdac`, containing the published native-harness work whose substantive runtime commit is `f6f0460f3e4c1571fa86b95280d191f29e133892`.

`main` now also contains roadmap documentation commits. Do not mistake roadmap commits for runtime implementation changes. Resolve current refs/worktrees before editing.

GitHub Actions still had no workflow runs and GitHub Releases had no releases when last checked. Source publication, CI, packaged artifact, tested package, local installation and public release remain separate statuses.

### VERIFIED / present

- Exact Need approval identity for supported paths: proposal/action/base binding, expiration, durable decision and execution receipts.
- Native harness host integrated after Store recovery.
- Durable harness runs/steps/events, bounded leases/fences and conservative restart behavior.
- Mandatory policy before optional hooks.
- Baseline principal/capability, tenant/project labels, information-flow and budget contracts.
- Pure-prefix forks and bounded event cursors.
- Secret scrubbing on delivered paths.
- Existing guarded document writer, journal, History and restore remain the mutation authority.
- **NR-02 packaged-runtime proof completed locally:** a relocated Windows package was exercised while source/client/fixtures/dist were unavailable. Exact preview, decline, Stop, reload, cursor replay, History and supported restore were covered. The suspected fixture resource problem was reproduced and minimally corrected by shipping/resolving the fixture from the bundled server.
- **NR-03 bounded Codex EngineAdapter proved locally:** one real native ChatGPT turn used synthetic input, durable start admission, run-scoped egress authority, exact proposal review and one recorded write. Host recreation reused the saved observation rather than repeating the provider call.
- The Codex path keeps outbound-data authority, result acceptance, exact write approval and write permission as separate checks.
- Ambiguous provider dispatch does not cause blind redispatch.
- The integrated local tree records **533 passing tests** for the current runtime/Trust combination.
- Opus's corrected prototype Trust seam is integrated in the local runtime tree: synthetic/prototype assurance stays explicit and old references are invalidated across disable/rearm/restart.

### PARTIAL / open

- The newest NR-02/NR-03 runtime changes are **local/uncommitted/unpublished** at this roadmap checkpoint unless a newer source commit says otherwise.
- The full browser suite has one disclosed **order-dependent Usage-chip failure**; isolated Usage and the remaining browser tests pass. Do not claim the entire browser suite is green until this is fixed and rerun.
- The real Codex adapter proof is host/local and synthetic; it is not yet an ordinary authenticated end-user account/session path.
- `HarnessPrincipal` alone is still a policy object supplied by trusted host code, not proof of an authenticated human/device session.
- General credential brokerage, production tenant isolation and broader online-account identity are not yet established in published source.
- Per-run event cursors exist; full authenticated cross-device/project replay remains incomplete.
- General provider-side reconciliation for external effects remains future work beyond bounded `reconcile_required` semantics.
- Native OS containment is not established; worktrees are edit isolation, not a security sandbox.
- No CI run, signed release, production account backend or production migration is implied by the local proofs.

### Historical-doc warning

`docs/harness/CURRENT_STATE.md` describes an older `218f325` checkout. Keep it as historical evidence, not a current inventory. Prefer current source, `RUNTIME_VERIFICATION.md`, `CHANGES.md`, `HARNESS_INTEGRATION_MAP.md`, the NR-02/NR-03 continuation report, and fresh tests.

## 5. Responsibility architecture

These are responsibility boundaries, not instructions to create separate services/databases.

- **Desktop:** human experience; Thread/Board/Team, Workbook/Console until intentionally migrated, inspector, model picker, Ctrl+K, approvals, documents, history, settings/security/devices.
- **Core:** models, agents, routing, profiles, rules/context injection, skills/capabilities, memory, advisor, teams/subagents and learning interfaces.
- **Runtime:** command admission, runs/steps, receipts, events, retries/timeouts, cancellation, waits, workflows, queues/concurrency, budgets, environments, recovery/resume, external-effect reconciliation, replay/forks.
- **Trust:** local principal, devices, authenticated sessions, online accounts, organizations/tenants, agent/workflow principals, delegation, capability grants, exact approvals, credential broker, revocation, least privilege, information-flow policy and package/update trust.
- **Observatory:** structured traces, timings, usage/cost provenance, failures/retries, approvals/corrections, outcomes, replay/evals and evidence-grounded self-improvement.
- **Interop:** MCP, MCP Apps, ACP where useful, A2A, webhooks, APIs and external events.

## 6. Active ownership

### Codex — runtime/build integration

Codex owns the current runtime continuation and run-scoped outbound-data authorization. Its immediate remaining responsibilities are:

1. preserve and verify the local NR-02/NR-03 work without overwriting Opus Trust changes;
2. fix and freshly verify the order-dependent Usage-chip browser failure;
3. reconcile current worktrees/remote refs and prepare the local runtime work for safe integration/publication only when authorized;
4. keep the real Codex adapter on the single runtime/admission/approval/mutation authorities;
5. add minimal credential-free GitHub build/test CI after the local regression state is clean, unless another branch has already done so;
6. keep provider ambiguity and no-blind-redispatch semantics intact.

Codex should not create a competing account/session/credential system while Opus owns Trust/accounts.

### Opus 5 — Identity, Trust and online accounts

Andrew has explicitly authorized **full online-account work**, not only scouting. Opus is running a broad multi-worker research pass and may proceed into implementation.

Until that research is reconciled, do not pre-decide the account/backend provider, exact passkey/recovery design or cloud data architecture.

Opus owns:

- local owner/principal and device identity;
- authenticated local session semantics;
- online Diomedes account linked to, not replacing, local identity;
- sign-in/enrollment/recovery/revocation;
- device enrollment and independent device revocation;
- session lifetime/logout/invalidation;
- the shared principal/delegation contract consumed by Runtime;
- server-side capability/resource authorization;
- agent/workflow delegation;
- credential-broker boundaries and secret storage;
- future organizations/memberships/tenant support;
- offline/account-service-unavailable behavior;
- security/audit identity;
- native-desktop auth UX and browser/IPC boundaries.

Codex and Opus must agree on shared principal/grant/session interfaces and file ownership before both modify those seams. There should be one Trust contract.

### Fable 5.1 — design baseline

Fable's September 8 visual/interaction work remains the product design north star. Preserve the handoff rather than spending the remaining design allowance on another broad redesign. A future Fable pass is best used to review actual onboarding/security/account UX or a specific weak packaged screen.

## 7. Identity/account decisions already made

Provider choice is open, but these decisions are approved:

- **Local Principal:** local human owner; local core works without cloud account dependency.
- **Device Principal:** each trusted device has independently revocable identity/key material.
- **Authenticated Session:** proves a current authenticated user/device context; a client header or caller-supplied ID is not enough.
- **Diomedes Account:** online identity for account-backed features; attaches to local identity rather than replacing it.
- **Organization / Business Tenant:** business/client identity separate from personal identity.
- **Agent / Workflow Principal:** delegated actor with bounded capabilities.

Authorization is server-side and capability/resource scoped; missing or ambiguous authority defaults to denial.

Agents should request typed authenticated operations instead of raw secrets. Provider tokens, refresh tokens and device private keys must not appear in prompts, transcripts, ordinary project state, events, logs or crash reports.

Passkey-first and standards-based native authentication remain preferred directions, subject to Opus research. Third-party native OAuth should prefer system-browser Authorization Code + PKCE over password collection in an embedded webview.

Sensitive changes should support step-up verification, especially device enrollment, recovery/auth changes, high-risk grants and destructive/consequential actions.

## 8. Runtime + Trust invariants

- Requests have durable identity.
- Identical ambiguous retries reconcile; changed payload under the same identity is refused.
- Durable admission persists before dispatch where that guarantee is claimed.
- Exact approval means one exact action against one expected base before expiry.
- Egress authorization is separate from approving a proposed write.
- Revocation blocks future authority but cannot unsend an already dispatched request.
- Uncertain external effects stay uncertain until reconciled; do not blindly repeat consequential non-idempotent effects.
- Event replay is authorization-aware.
- Saved runs must not resurrect revoked identity/grants.
- Prompts/model output do not grant authority.
- Worktrees are not security sandboxes.
- `enforced`, `observed`, `instructional` and `unsupported` remain distinct guarantee labels.
- Store/document mutation authority remains singular unless evidence justifies migration.

## 9. Near-term milestone order

### M1 — close current local runtime regression

Fix and freshly verify the order-dependent Usage-chip browser failure. Re-run the relevant browser suite and deterministic gates against the integrated NR-02/NR-03/Trust tree.

### M2 — safely integrate/publish verified runtime continuation

Once authorized, reconcile the uncommitted NR-02/NR-03 work with current main, preserve Opus Trust changes, rerun fresh gates, and publish without implying CI/release/installation status that does not exist.

### M3 — Identity & Trust + online accounts

Reconcile Opus's research, select the provider/data/recovery architecture, and land the account + local/device/session Trust foundation behind one shared contract. Local/offline operation remains viable.

### M4 — CI / reproducible package gate

Add minimal credential-free GitHub build/test CI. Signed-in provider smoke stays a controlled local/integration gate. Add signing/update infrastructure before broad public release.

### M5 — second-engine model-agnostic proof

Route a second real model/engine through the same Diomedes runtime, Trust, rules, durable task semantics, approvals and evidence. Prefer this over rapidly adding many provider-specific adapters.

### M6 — authenticated remote/device access

Pairing, short-lived sessions, per-device/project capabilities, revocation, authorized event replay, remote status/approval/stop and high-risk rights off by default.

### M7 — durable workflow runtime

Typed deterministic + agent steps, conditions/branches, retries/timeouts, waits/events, approvals and bounded fan-out/fan-in. Runtime semantics before a visual workflow builder.

### M8 — events, queues and resource governance

Event inbox/wakeups, schedules/webhooks, priority/concurrency, token/model/tool/runtime/retry budgets and local GPU/VRAM/RAM awareness aligned with the existing LocalAI supervisor.

### M9 — Observatory, replay/evals and self-improvement

Replay historical cases against changed models/prompts/capabilities/workflows; compare quality, correction rate, latency, cost and failure. Self-improvement is versioned and evidence-gated, never a silent privilege/billing/tenant escalation.

### M10 — Demonstration-to-Automation

Recorded human activity becomes a tested workflow/capability with deterministic steps where stable, semantic/vision reasoning where needed, explicit approvals and verification checks.

### M11 — broader isolation and interop

Environment abstraction/stronger containment, MCP Apps, A2A, snapshot forks/comparison and eventual execution portability once Runtime + Trust semantics are mature.

## 10. Product design direction

Preserve:

- graphite flat surfaces;
- crisp separation;
- sparse semantic cyan;
- DIOMEDES wordmark;
- strong readable typography;
- minimal cards;
- no ambient glow or generic AI chat bubbles;
- restrained esoteric/technical character without cryptic UX;
- contextual inspector;
- current model picker and Ctrl+K;
- Thread / Board / Team as views of one durable work object;
- Living Thread motion driven by real state, not decoration.

Team/conversation views need clear structural separation between threads. Workbook/Console names may remain until an intentional migration.

## 11. Model/engine strategy

Diomedes remains model-agnostic. Do not architect rules, memory, permissions, task state, workflows or evaluation around one provider.

External engines remain useful even as Diomedes owns more runtime semantics. Personal subscription-backed integrations are personal-use routes; commercial hosted/resold offerings require provider-authorized commercial arrangements.

Muse/local models remain candidates, not permanent commitments. Prefer empirical routing/eval evidence.

## 12. Business / consulting track

Product: **Diomedes**. Company: **Diomedes Systems**.

Principle: **Find the weak point. Fix the workflow.**

Lead with measurable outcomes rather than model names: time recovered, repetitive steps removed, faster turnaround, fewer errors, consistent execution, accessible knowledge, approvals and evidence.

The three-restaurant group remains the preferred first controlled design-partner shape. Candidate workflows:

- multi-location management brief;
- marketing drafting + approval;
- SOP/knowledge assistant;
- invoice/vendor variance review;
- labor/scheduling recommendation support.

Initial pilots should be measurable, reviewable and low-to-moderate risk. Do not autonomously perform payroll, payments, hiring/firing/discipline, unapproved posting, vendor ordering or other consequential decisions.

Production client data waits for credible tenant isolation, identity/membership, least privilege, credential protection, auditability, retention/offboarding and recovery. Early pilots prefer exports/lower-risk data over broad admin credentials.

## 13. Security and information flow

Treat prompt injection as systems security: least privilege, secret isolation, provenance, policy, approval and external-effect reconciliation.

The harness already has a baseline label/policy model. Extend from real use cases rather than building a speculative giant taint engine.

Business tenant isolation must eventually apply to files, search, memory, embeddings/retrieval, events/history, private skills, credentials, agents and workflows. Never trust a client-supplied tenant ID as authorization.

Supply-chain trust matters for skills, MCP servers/apps, plugins, adapters, models, workflows and updates. Plan toward signed/trusted packages and capability manifests. Public Diomedes releases/updates must eventually be code-signed.

## 14. Website/deployment boundary

`andrewgodowsky-aoa/diomedes-site` is a separate Astro + Cloudflare Worker/static-assets project. Website deployment is not desktop deployment, and its current forms/D1 setup is not automatically the Diomedes account backend.

Track separately:

- app source published;
- CI verified;
- package built;
- relocated package tested;
- local installation;
- signed/released artifact;
- website deployed;
- account backend deployed;
- production data migration.

One status does not imply another.

## 15. Agent coordination rules

- Read the newest roadmap before substantial architectural work.
- Resolve current repo/worktrees before editing; never reset a newer checkout to a roadmap hash.
- Preserve unrelated user/agent work.
- Use isolated worktrees for parallel implementation.
- Record file/domain ownership where Codex and Opus touch Trust/runtime seams.
- One principal/grant/session authority, one approval authority, one runtime authority and one document-mutation authority.
- Prefer current source + fresh verification over stale planning.
- Do not weaken guards to make tests pass.
- Distinguish fixture proof, real-provider proof, packaged-desktop proof, CI proof and production proof.
- End substantial handoffs with `ROADMAP IMPACT` and the next smallest safe slice.

## 16. Open strategic decisions

- online-account/backend provider and cloud data architecture — **Opus research active**;
- passkey/recovery/account-linking design — **Opus research active**;
- final Windows device-key/secret-storage mechanism;
- organization/membership schema and first Business tenancy rollout;
- whether/when JSON persistence should migrate to SQLite/another store;
- first general external-effect adapter with provider-side reconciliation;
- workflow internal representation;
- Windows containment strategy beyond existing provider controls;
- MCP Apps timing/containment;
- A2A timing;
- release/update signing pipeline;
- managed cloud-worker architecture/pricing;
- default native/local model route;
- first restaurant-pilot workflow/data source after owner discovery.

## 17. Retired stale guidance

Do not use these as current instructions:

- exact-action approvals are missing;
- the native harness is only planned;
- online accounts must wait until later;
- `CURRENT_STATE.md` is the current implementation inventory;
- a client header or serialized `HarnessPrincipal` authenticates a human;
- a worktree is a security sandbox;
- the website is automatically the desktop/account backend;
- older Achilles product naming is current;
- older AionCore-centric host architecture is authoritative.

## 18. Acceptance culture

Runtime/security/account changes need verification proportional to the invariant: deterministic tests, duplicate/lost-response tests, stale/replay tests, concurrency, crash/restart, write-failure injection, authorization denials, revoked/expired identity tests, cross-project/tenant tests, browser/renderer boundaries, packaged smoke, real provider smoke where warranted, performance measurement and explicit proof boundaries.

Use `VERIFIED`, `PARTIAL`, `MISSING`, `DEFERRED`. Never claim a fixture proves real-provider behavior, source tests prove a packaged executable, or login proves authorization correctness.

## 19. Change ledger

- **2026-09-09.3** — Reconciled concurrent Codex updates into the clean roadmap: NR-02 packaged proof complete; bounded real Codex adapter proved locally; 533 integrated tests recorded; Opus prototype Trust correction integrated; one order-dependent browser Usage failure remains; newest runtime changes remain local/uncommitted. Online accounts stay an approved active Opus-owned track. Removed stale duplicated September 8/early-September instructions.
- **2026-09-09.2** — First clean-roadmap rewrite and repository mirror; established Codex/Opus ownership and activated online-account work.
- **2026-09-09.1** — Reconciled published native harness runtime, exact approvals, packaging risk and run-scoped egress direction.
- **2026-09-08.1** — Initial canonical roadmap created from master/replan/business/design/foundation work.

### Next reconciliation trigger

Reconcile when any of these lands: browser Usage regression fix; publication of the local NR-02/NR-03 runtime work; Opus account/Trust research decision or implementation; first GitHub CI run; major host/persistence change; or a new Andrew product decision.
