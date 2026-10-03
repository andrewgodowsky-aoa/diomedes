# Nectovia extension implementation prompts

Status: **Draft follow-up work; not scheduled, implemented or accepted.**
Date: 2026-10-03.
Architecture: [EXT-01](../harness/EXTENSION_CONTRACT.md).

Documentation work order: feature mod-extension-architecture; prompt ID
MOD-EXT.DOC (Gmail research request 1a0ffbeb5f0e0d2c); owner Codex;
branch feature/mod-extension-architecture; worktree
F:/Diomedes/diomedes-wt/mod-extension-architecture; research base
4b17aec4df927425778a9232c19f3e463404f3c3. This lane changes documentation only.

Independent review work order: feature extension-authority-review; prompt ID
MOD-EXT.REVIEW / PR #206; owner Codex; branch feature/extension-authority-review;
worktree F:/Diomedes/diomedes-wt/extension-authority-review; current-main audit base
efcc554b71cd1be6100bda0d2dd1ae9cd7dc82c2; original PR head
c1081506e4df0e1584f0e02fe2f4050af5c053b7. Scope remains documentation only.

These prompts add missing behavior to the current owners. They do not replace
the unified execution program or its completion ledger. Before implementation,
reconcile the live RUN_ORDER.md, RUN_ORDER.json and completion-status.json in the
active package with current main, merged source and open owners. Historical
H05 in the integration map is middleware; unified H05 is the Cursor route.
Use feature names and current contracts instead of assuming equal IDs mean
equal work.

Relevant existing lanes: H11 instruction delivery, H12 mediated effects,
H14 bounded advisors/handoffs, H15 supervision, H16 stream triggers,
H17 verification, H18 context accounting,
P01 manifest contracts, P02 acquisition, P03 lifecycle, P04 on-demand loading
and P09 private capability/skill catalogue and import/export. P08 is optional
syntax/diagnostics/LSP work, not marketplace governance. Reuse merged portions and preserve open
qualification work. Existing roadmap OPEN labels alone are not evidence that
an implementation is absent.

Reuse current protected Personal owner authority, automatic Team qualification,
root collaboration/review bindings, tools-off H14/subscription workers,
person-bound worker consent/reserves, remembered approvals and free manual
Teams. Inspect their host routes/tests at the implementation base; none supplies
an executable-extension sandbox or general-purpose grant.

For each adopted prompt, freeze current base/candidate hashes, claim exact paths
in a feature worktree, preserve other work, and list a bounded write allowlist.
Shared contract, host, Store, account and Console-shell edits must follow live
ownership. Do not install dependencies, enable vendor mods, call paid providers,
change credentials, deploy or replace an installed app as incidental work.
Return exact passed/failed/skipped/unrun counts, source evidence and a proposed
commit message. Use the shared slot for heavy gates and required independent
review before integration; review must use the exact accepted candidate.
Human-only task/Need/Trust/worker-consent operations are absent from the broker
API. Bind requests to the host-issued runner/root envelope; reject caller-authored
principal, role, receipt, authorization and human attribution fields.

## EXT01: Instruction/setup audit and extension inventory

Outcome: an inspectable inventory and a report/patch command, without executable
third-party hooks. This can ship independently as a deterministic improvement.

Inspect instruction-delivery.ts, capability-packs.ts, rule-authority.ts,
instruction-view.ts, task-skills.ts, pack indexes and existing Files/proposal
surfaces. Inventory exact delivered source IDs, scope, precedence, versions,
digests, exclusions and commands. Do not invent a second instruction loader.

Implement deterministic checks for missing paths/commands, stale host/API
references, duplicates, conflicting same-authority requirements, forbidden
authority expansion and declared capabilities unsupported on the selected route.
Optional model suggestions use a recorded evaluation step; the deterministic
audit must work without a model or provider access.

Write a scoped report and exact-base proposed patch through current artifact
and change-review paths. Never apply or delete instruction files automatically.
Keep managed policy and untrusted repository text distinct.
Keep rule-authority precedence and source permissions on reports, caches and
suggestions; a pack, Team role or model finding cannot promote its own guidance
to managed policy. A report command cannot accept a task or approve a phase.

Acceptance: synthetic conflicting guidance is reported with both source refs;
nested rules stay scoped; no forbidden file/model/write sink is invoked;
unavailable model advice is reported without blocking the deterministic audit;
applying a stale patch refuses; no report leaks another Project's text.
Do not retest all native engines merely to prove this data-only slice.

## EXT02: Executable contribution declarations and signed provenance

Depends on: EXT01 inventory and accepted EXT-01 contract.
Outcome: executable artifacts can be inspected and refused safely; no execution.

Extend shared/pack-manifest.ts and the current catalogue/lifecycle/loaders.
Introduce an explicit schema/API revision because v1 is strict. Keep v1
data-only packs unchanged and retain the existing outward-effect restriction.
Define event/field projection, role, transform fields, UI slots, broker requests,
resource limits, config/state versions and immutable dependency locks.

Add detached artifact-signature verification and publisher/key policy through
standard cryptography. Preserve staging, atomic install, verified objects,
append-only operations, per-Project activation and run pins. Enumerate hooks/API
footprints for review without evaluating top-level module code. Digest/signature
validity never changes Trust capabilities.

Acceptance: v1 fixtures still resolve; unsupported revisions, cycles, unlisted
payloads, tampered bytes, namespace impersonation, invalid/revoked signatures
and dependency swaps refuse before activation; failed update preserves previous
state; rollback cannot revive revoked code or authority; installation and
inspection execute no package scripts and consume no model usage.
Cover configuration/dependency capability drift too. Review and required-gate
identities pin that complete closure, not just the package name or entry point.

## EXT03: Isolated contribution runner and existing host broker

Depends on: EXT02.
Outcome: scoped observe-only executable contributions on explicitly qualified
platforms, with every host request mediated by existing services.

Inspect RunService, ToolRegistry, policy.ts, host/bridge, H16 services, account
admission, local-backend/scope-grants/remembered-approvals, agent-team-host,
native-loop/agent-collaboration, subscription-workers, manual-teams, workflow,
paths and recorded writer. Implement a bounded out-of-process event
worker with no scheduler, effect writer, route client or authority store.
Select an OS containment backend using existing facilities; do not install a
new package or virtualization layer without owner authorization.

Send immutable host envelopes and allowed projections. The broker resolves live
authority per call and dispatches only declared existing tool/service operations.
No raw fs/process/http/provider API, secrets, direct project mount or ambient
credentials. Define total wall deadlines, memory/state/I/O bounds, backpressure,
cancellation, deduplication, failure records and a circuit breaker.

Current hooks receive complete copied principal/intent data and run even before
cached observation lookup. Build a separately authorized projection/replay path;
never register third-party callbacks through RunService.use or native-loop's
trusted composition interfaces. Authenticate a host-issued runner connection
bound to contribution digest and parent/root scope. Reject forged authority,
Team tokens, grant/authorization/origin fields and arbitrary endpoint forwarding.
Do not supply owner session credentials or proxy a human local-client header.
Broker reads require scope even where a host tool declares permission:null.
Resolve current Trust at admission, dispatch, result acceptance and later write;
Team role, paid-plan access and copied references do not grant source access.

Acceptance: owned canaries prove host/sibling/private-folder, junction/reparse,
native-module, environment-secret, raw network/process and cross-tenant access
are denied; infinite loop is terminated; invalid messages cannot crash the host;
revocation/account switch cancels access; optional observer failure leaves
authorized work usable with an honest failure record. A platform without proof
reports unsupported and never starts an unsandboxed fallback.
Assert zero grant/Need/phase decisions, human task assignments/acceptance,
worker-consent writes and reviewer substitutions from forged broker messages.
Retain Personal-only worker consent, launch gates, usage reserves and manual
card routing. Both native Team and tools-off worker routes must qualify relevant
vendor built-in behavior rather than treating disabled tool lists as containment.

Also qualify the current Claude adapter's safe-mode/settings/tool controls
against the new installed/built-in mod distinction. Do not enable customer
mods or infer native containment from --tools or a version number alone.

## EXT04: Persisted holds and validated transform candidates

Depends on: EXT03; accepted existing effect/approval boundaries.
Outcome: an executable contribution can request a hold or propose a narrowly
validated pre-admission argument change through the existing effect path.

Extend RunService's hold verdict, step.held event, Need projection and approval
admission. Current per-call hold collection does not enforce a hold after its
hook disappears, and action-only approvals do not bind changed gate requirements.
Persist required gate identity/revision, contribution/configuration digest,
owner, reason/refs, deadline and authorized release before suspension. Extend
the existing validated step/Need/decision reader with explicit version migration;
unknown or missing required records refuse. Check persisted gates on resume,
including when the hook is absent. A receipt must bind current gate requirements
as well as final action; earlier approval or scoped authority alone cannot clear
an unresolved required gate. Rendering a question is not receipt creation.

Add candidate patch processing before final intent admission, never a mutable
handler continuation. Verify expected original digest, allowed fields and
unchanged immutable envelope; recompute canonical targets, label/provenance
joins, required authority, action hash and expected base. Recheck account,
route, grants, spend and task workflow. Changed exact approvals stop counting.
Persist transform inputs/outputs/digests before the effect and bind replay to them.
Keep existing host-bound tool inputs and native-loop beforeTool/afterTool/review
callbacks outside extension ownership. Revalidate remembered patterns and exact
reviewed bytes through their owners. Workflow Full approval grants continuation
only; Stop on phase change parks, acceptance does not start work and child grants
are never copied. An extension cannot skip selected review or impersonate the
person on task/phase endpoints.

Acceptance: forbidden intent is rejected before a hook reads its payload;
path/account/model/payer/effect escalation and label laundering refuse;
changed approved input cannot execute on the old receipt; a valid scoped grant
continues to cover ordinary in-scope work; unanswered/headless/expired holds
never run; disable/restart does not clear a hold; conflict/order drift refuses;
crash after a possibly landed effect leaves reconciliation and no second sink call.
Include a held approval:false step whose hook is removed/restarted, a changed
hold reason/configuration after action approval, stale remembered patterns and
forged reviewer PASS. Each must leave the forbidden sink count at zero. Cached
step replay cannot re-run executable hooks or charge/dispatch model advice.

## EXT05: Console slots and namespaced commands

Depends on: EXT02; executable callbacks require EXT03. Passive declarative
views can precede EXT04.
Outcome: useful pack UI inside the one Console without extension execution
from the renderer or replacement of authoritative controls.

Extend existing pack UI/index/palette and inspector seams. Define a bounded
declarative tree and projection contract, with host-owned origin labels and
accessible controls. Keep approval, Stop, account/payer/model and evidence
controls outside extension ownership.

Commands submit typed authenticated host requests. Bind UI action tokens to
account/Project, contribution digest, view revision, payload, nonce and expiry.
Revalidate and durably consume/deduplicate them on click. A formatter can replace a declared presentation slot;
it cannot replace raw results, status, receipts, policy or effect dispatch.
Use host-owned command mappings, not arbitrary API routing. Host consent views
alone issue Need/grant/phase/workflow/worker decisions; a contributed button
cannot impersonate their actor, submit an approval or select an automatic
reviewer. Commands record truthful origin and ordinary request receipts.

Acceptance: injected HTML/script and counterfeit approval UI are refused;
layout and long content stay usable; stale buttons after restart/update or
account switch cannot invoke another action; drawing invokes no effect; duplicate
or replayed clicks cannot repeat an effect; duplicate command IDs refuse;
headless mode reports unsupported drawing and preserves
required holds. Test only supported Console surfaces, no second application UI.
Test forged approval/grant/accept/assign/approve-phase commands and owner/session
tokens. An extension view must produce zero human-attributed authority mutations.

## EXT06: Model-neutral work advisor

Depends on: EXT01; passive EXT03/EXT05 delivery if offered as a pack extension.
Outcome: optional evidence-linked missed-issue notes through existing recorded
evaluation and supervision paths, without autonomous side effects.

Generalize the advisory role around EvaluationPort/recordEvaluation, not a model's
marketing name. Preserve the current Jev managed route until a separate
route/profile is qualified. The current recordEvaluation step declares external
disclosure; a local port must qualify destination/egress behavior explicitly.
Deterministic detectors select bounded evidence;
debounce by event/evidence digest and apply confidence/novelty thresholds.
Do not stream the whole transcript to a background provider.

Admit each model call under the parent root job with current membership,
data restrictions, paid entitlement, original call/spend ceilings, payer and
usage reservation. Record runtime-reported model, receipt and rejected/uncertain
outcomes. A new route needs schema, pricing, reconciliation and threshold
evidence; local-only evidence never silently moves to a cloud fallback.
Do not treat Personal subscription-worker preference as advisor consent or its
turn as free inference. Retain paid Agent admission, the actual subscription
payer/usage reserve and Personal/Business separation. No extension-selected
helper, Team member, reviewer or changed root ledger is an advisory shortcut.

Return structured source-linked findings with severity, confidence, expiry and
next step. The advisor has no effect tools or approval/grant capabilities.
Apply creates a current proposal; only existing authorized supervision rules
may act on validated findings. Support quiet mode, dismiss/snooze, job Stop,
membership/revocation and budget exhaustion. Analytics opt-in is unrelated.

Acceptance: seeded missed issues are found at measured precision/recall and
false-interruption/cost/latency thresholds; synthetic injection cannot grant,
send or reroute; no extra call after Stop/tenant switch/budget cap; duplicate
events charge once; invalid/rejected response settles or reconciles truthfully;
fixture identities are not presented as real models; replay does not rerun
inference. Real paid route qualification remains a separately authorized gate.
Replay of a completed step does not call the executable advisor again; admission
and source/account changes refuse before any additional request is sent.

## EXT07: Acquisition, marketplace review and opt-in sync

Depends on: EXT02 and the applicable EXT03-EXT06 qualification.
Outcome: a reviewed artifact distribution path and account-scoped preferences
through existing pack/account services; still one Runtime.

Reconcile P02 verified acquisition and P09 private catalogue/import-export
requirements before writing. Public marketplace review and account sync are
proposed extensions to these owners, not a claim that those nodes already
specify or implement them.
Use immutable content-addressed artifacts, verified publisher keys and
dependency closure, signed review receipts and an organization allow/deny policy.
Keep submission/scanning/review/publication separate from download/install/
Project activation/effect authorization.

Review capability expansion, build/license provenance, sandbox/API boundaries,
tenant and prompt injection, failure/replay/headless behavior and authentic UI
on each supported platform. Updated bytes invalidate prior review. Add emergency
artifact/key revocation and safe rollback without grant or receipt restoration.

Sync only verified references and selected bindings through current account/
organization revision checks, with opt-out and per-Project applicability.
Downloaded executable code does not auto-enable background activity. Exclude
credentials, local paths, permission grants, cached approval tokens and credits;
remap/re-authorize on a new device. An offline device cannot resurrect revoked
policy from stale sync.
Do not sync a host lease, Personal worker consent as a fresh-device grant, Team
mail credentials, reviewer decisions or a pending gate's release. Preference
sync cannot accept tasks, advance phases or remove required holds. Recheck policy
and revocation on each broker call, not just download or activation.

Acceptance: tampered distribution and swapped dependency/review digests refuse;
publisher cannot publish unreviewed bytes; organization deny beats install/sync;
cross-account/device replay and conflicting revision writes refuse; failed update
keeps prior state; revocation prevents the next broker effect; rollback preserves
audit and spent credit. Demonstrate with a local fake registry before any live
marketplace deployment. Publication and live rollout require their own concrete
review and owner authorization.

## Original documentation verification for MOD-EXT.DOC

Research/source comparison is against remote main
4b17aec4df927425778a9232c19f3e463404f3c3, rechecked before publication.
The two current architecture homes link to this proposal and EXT-01.
This paragraph retains the original publication evidence; it is not the
current-main review or its gate verdict.

Documentation checks: 36/36 relative links resolve, both new documents pass
formatting and ASCII checks, the write set contains exactly the four declared
documentation files, and whitespace validation passes. These checks do not
qualify executable contributions or a vendor adapter.

No unit, browser, native-engine or paid-provider test ran for this documentation
lane. All four application merge gates and independent implementation review
are unrun. The shared test slot was occupied by another worktree when requested.
Executable support and EXT01-EXT07 remain proposed; no existing program node is
marked DONE by this record.

## Current-main architecture review for MOD-EXT.REVIEW

The independent review of original head c108150 found stale Team/worker/Trust
assumptions, missing required-hold persistence and gate-specific decision
binding, trusted callback/replay exposure and broker impersonation risks.
The contract and all seven prompts now distinguish existing source behavior
from those implementation prerequisites. The four-file documentation allowlist
is retained; no application or test implementation is introduced.

Current-main source baseline is efcc554b71cd1be6100bda0d2dd1ae9cd7dc82c2.
The exact rebased/repaired head, documentation checks, owned authority probes
and required application gates are recorded in
[PR #206](https://github.com/andrewgodowsky-aoa/diomedes/pull/206).
Existing host tests do not establish executable extension containment or broker
acceptance. Independent review of EXT01-EXT07 implementations, platform/native
engine qualification and paid-provider validation remain future work.
