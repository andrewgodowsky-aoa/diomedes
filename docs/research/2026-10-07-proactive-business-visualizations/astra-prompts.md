# Nectovia proactive visualizations and connected workspace — Astra prompt pack

Package NC-VIS-2026-10-07.1

**Prepared:** 7 October 2026.  
**Status:** implementation guidance and reusable prompts; this document is not evidence that the proposed application changes have been implemented.  
**Repository baseline checked:** [andrewgodowsky-aoa/diomedes at bae249b60ffafa3934d775c6d59fbac80990a83e](https://github.com/andrewgodowsky-aoa/diomedes/tree/bae249b60ffafa3934d775c6d59fbac80990a83e), committed 7 October 2026 at 03:56:08 UTC. Reconcile with the current checkout when using the prompts.

## How to use this pack

Give the implementation agent the current implementation report, this pack, and the appropriate prompt below. Use the lead prompt to begin work; use the continuation prompt in an existing implementation session; give a bounded work order to each delegated worker; give the review prompt to an independent reviewer. Do not concatenate every prompt into one permanent system instruction.

The repository package is `docs/research/2026-10-07-proactive-business-visualizations/` with `README.md`, `implementation-plan.md`, `astra-prompts.md`, and `sources.md`. Read the implementation plan alongside this pack. Publishing this document package is separate from implementing the application: the lead prompt begins scoped application work when the user gives it to an implementation agent in that later session.

“Astra-style” means our project-specific adaptation of OpenAI's published GPT-6 Astra guidance. It is not an official OpenAI prompt template or an Astra-only application architecture. Keep the user's selected model, provider, billing route, and runtime attribution unless the user authorizes a change. The product capability must work through the same host contracts across supported models, including local models.

## Official guidance and what we adapted

OpenAI's Astra guidance addresses initiative, sensitivity to instruction files, writing style, delegation, and verification. This pack translates those concerns into a concrete implementation outcome, explicit ownership and authority boundaries, bounded parallel work, and evidence-based completion. Its Nectovia architecture, issue dependencies, acceptance criteria, and security decisions come from the project investigation and our design work, not from OpenAI.

The developer article recommends narrower skill triggers, selective loading of supporting instructions, and clear completion boundaries. Accordingly, the prompts point to relevant current documents and source seams without prescribing a full-repository reread after every change. The general prompting documentation recommends specifying the result, useful context, and material boundaries. The AGENTS.md documentation explains the layered discovery of repository instructions. These sources support the prompt structure; they do not grant repository or publication permissions.

### Official primary sources

| Reference | Official source | Retrieved | Use in this pack |
|---|---|---|---|
| O1 | [Using GPT-6 — Prompting best practices](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices) | 7 October 2026, approximately 05:50 UTC | Completion, bounded initiative, instruction conflicts, delegation, proportionate verification. Only the Astra prompting section was used as model-specific guidance. |
| O2 | [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), Eric Provencher, 11 September 2026 | 7 October 2026 | Relevant context, concise skill triggers, explicit stopping boundaries. |
| O3 | [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | 7 October 2026 | Discover the applicable instruction chain before changing repository files. The developers.openai.com Codex guide redirected here. |
| O4 | [Prompting](https://learn.chatgpt.com/docs/prompting) | 7 October 2026 | Define the outcome, relevant inputs, constraints, and verification; describe behavior not visible in screenshots. The developers.openai.com Codex prompting page redirected here. |

The local OpenAI Docs skill and its bundled prompting reference were inspected first. The model-specific reference pointed to the live Astra guide, which was then fetched. The public sources above were verified on official OpenAI domains; the prompt text below is original project-specific wording.

## Current implementation brief

### Product outcome

Nectovia's direction is an agent working inside a connected workspace: users can create, inspect, preview, revise, and act on their work in the app without managing a collection of separate windows. A POS reorganization or a menu booklet are examples of the wider cross-industry need. The platform should proactively show useful previews of created or revised outputs and make the next revision or action refer to the exact thing the user inspected.

The first implementation remains bounded: a useful visual report in the existing Console, such as a small KPI row, related charts, and a source-backed table; generic artifact identity and preview metadata; and a proactive presentation policy. Reports retain historical evidence, allow deterministic local exploration, and expose refresh or an action through the existing runtime. Reuse existing file readers, editors, and service capabilities. Full document renderers, service adapters, and executable UI mockups can follow as separate capabilities.

Every preview must state its fidelity: a rendered saved output, a structured proposal or generated mockup, or a live service view. Record the target identity, revision, renderer or adapter, and freshness appropriate to that type. A menu layout mock does not prove the exported booklet's pagination; a POS proposal does not prove that the live POS was changed. A structured proposal carries its source identities and reviewed change set; a generated mockup communicates an idea and does not establish live service state or an applicable service change set. A partial reader must identify its limits. Route revision requests through the existing host proposal and runtime flow with an expected revision, so later edits cannot silently apply to a different version.

### Product authority and implementation evidence

Keep two tracks distinct. **Product authority** comes from current explicit user decisions and the applicable canonical pillars, roadmap, and project memory, subject to applicable repository instructions and actual scope/ownership rules. **Implementation evidence** comes from current source, observed tests, runtime records, and released or installed behavior. Source can establish that a historical implementation-status note is stale; it cannot authorize a product behavior that contradicts a current canonical constraint. An issue status, source merge, preview, or prior approval does not confer permission for a different action.

If product decisions conflict, identify the specific decision and owner and defer only the dependent work. If source diverges from the agreed product behavior, record that as an implementation gap. Use the report and prompts as proposed implementation guidance within these authorities, not as a replacement for them.

### Proactive defaults for the product

- Choose whether and how to visualize **inside the existing answer pass**. Do not introduce a separate model classifier call for presentation selection.
- Normal generation and the preview loop stay inside the current admitted task, selected model route, payer, privacy boundary, and budget. Presentation choice does not authorize a new route, payer expansion, funded evaluation, background polling, or scheduled work.
- Use an initial preview and **at most one optional automatic correction-and-recheck cycle**. Stop as soon as the necessary checks pass. If a valid result still cannot be produced within that budget, return the best validated fallback with its limitations. This product default does not replace the implementation team's required verification gates.
- Local filters, sorting, selected series, and other supported presentation controls make **zero model calls**. Refresh, new interpretation, or an external effect uses its existing admission and authority path.
- Respect the user's explicit text-only or table-only request and the applicable scope-specific presentation/accessibility preferences. A preference for one project or business does not silently become a global preference or change data scope. Proactively preview created or materially revised outputs when a supported faithful preview helps; avoid redundant panels and unchanged re-renders.

### Reconcile these existing work items

- **DIO-140 owns the inventory query/dashboard implementation.** Its target includes a synthetic fixture of 25,000 SKUs and 250,000 movements across two or three sources; a closed-vocabulary host inventory_query; a bounded summary and result ID to the model rather than raw rows; and an inventory-view card that accepts only a host-minted queryId. The host validates filters without model calls. Totals, unknowns, forged IDs, and restart behavior require proof. Reuse this work through its owner and current interfaces.
- **DIO-140 has unresolved decisions.** Do not choose its business-only entitlement, storage engine, mapping approval, or funded evaluation on behalf of their owner. Those decisions block only their dependent work; generic report contracts can proceed.
- **DIO-252 and DIO-265 hold design approval work.** Reuse the currently approved design and exact theme version.
- **DIO-259 moves design authoring to Operations.** Its owner-approved theme version, staff publication/accounts delivery, and personal overrides remain authoritative. Do not introduce a customer Design Center or a second design-authoring surface in the Console.

Issue identifiers locate decisions to verify; an old status, approval, or quoted summary does not establish current implementation ownership or authorization.

### Architecture and compatibility

Retain the existing validated visual JSON and app-owned SVG renderer for small charts. Add stable artifact identity, immutable report revisions, source snapshot references, composed native reports, and separate viewer state. Historical results remain tied to their captured data. A live Board-derived view and an optional saved filter are different records.

Use the existing Project/Files/artifact primitives, Core Runtime, Trust, RunService, and tool registry. The proposed registry-compatible names `visual_preview` and `visual_present` must become typed host operations with an external MCP adapter over the same implementation. Preserve the existing visual fence as a compatible transport through the same validation path.

Keep existing file identity and version comparison as the basis for document round trips. Current file identity is projected from History as path, sha, versionId, and entryId; it has no independent fileId and does not follow renames. Bind file actions to the exact project/scope, path, and sha plus available history identifiers. Add report identity deliberately without silently changing historical file-reference behavior. A History entry does not guarantee that older bytes are still retained: the current service can return an unavailable-version state. Preserve that truth instead of substituting current bytes for an older reference.

The Files side pane remains a reader; text writing uses the existing main-stage editor. The current preview/import paths have these limits:

| Format or view | Source-verified current boundary |
|---|---|
| PDF | Metadata only; no in-app page renderer in the inspected build. |
| DOCX/PPTX | No qualified preview or authoring path in the inspected Files flow; these formats are absent from its supported binary import/preview kinds. A generated HTML approximation does not establish Office-file fidelity. |
| XLSX | A bounded page of the first sheet's saved values; no recalculation, dates remain serial numbers, and this is not a full workbook editor or rendered workbook layout. |
| History | Exact path/SHA identity, with history identifiers where recorded; no rename following and no guarantee that unretained historical bytes can be reopened. |
| Connected service | Toast/compiler wiring is synthetic demo behavior; the current MCP read client extracts text and does not host rich plugin UI. Declared pack UI contribution surfaces do not prove interactive app panels are implemented. |

These are explicit capability gaps, not existing high-fidelity previews. Reuse supported adapters and current access. Broad file rendering, arbitrary SaaS embedding, and a new service host are outside the native first slice.

Ask/Plan may receive visual authoring guidance. Build/Fix must retain their strict proposal output contract. An additive artifact side channel must not append visual fences or prose to a proposal or silently loosen its parser. Any change to model-visible instructions must follow the existing composition, digest, and lineage path.

Local filters, selected series, sorting, and presentation controls use bounded deterministic logic. Refreshes, new interpretation, and effects use the current runtime, tools, data scope, and grants. No model call is required for local presentation changes, and no new blanket approval loop should replace existing scoped authority.

One packaged ECharts adapter may be added later for advanced charts, behind a validated product schema. Do not expose arbitrary ECharts option objects, remote script URLs, or model-authored formatter/evaluation functions as the product contract.

Executable HTML for dynamic UI/mockups needs a separately verified isolation and network boundary. The current frame source records a prior STUN/WebRTC escape observed during earlier work; this investigation did not reproduce it. Preserve the current scriptless boundary: CSP alone is not proof of network isolation. Native reports can be completed and released through the existing process before executable HTML is available.

For future embedded views, keep the basic theme, size, and open-link bridge compatible with MCP Apps where useful. Full third-party app hosting is a separate capability and is not required for native reports or existing file previews.

### Source map to refresh when needed

| Concern | Current source seam |
|---|---|
| Visual specification and legacy transport | shared/visual-spec.ts |
| SVG rendering and accessibility | client/console/InlineVisual.tsx; tests/inline-visuals.test.ts |
| Artifact identity/indexing and display | shared/artifacts.ts; shared/turn-blocks.ts; client/console/ArtifactPane.tsx |
| Durable artifact/evidence path | shared/recorded-artifact.ts; server/harness/artifact-steps.ts |
| Run and step lifecycle | server/harness/run-service.ts |
| Host-owned tools, schemas, limits and effects | server/harness/tools.ts |
| Authority and grants | server/trust/authority.ts; server/trust/scope-grants.ts; server/trust/types.ts; server/workspaces.ts |
| Answer and mode instructions | server/answer-format.ts; server/modes.ts |
| Instruction evidence | server/instruction-digests.ts; server/lineage-continuity.ts |
| Conversation versus strict proposals | server/app.ts; server/native-work.ts |
| Existing frame boundary | shared/app-csp.ts; client/console/artifact-frame.ts; client/console/artifact-frames.tsx; tests/artifact-frame.test.ts |
| Board-derived views | client/console/board-model.ts; client/console/pinned-chart.ts; tests/pinned-chart.test.ts |
| Existing preview fidelity | client/console/FilePreview.tsx, PDF metadata at lines 109–150 and XLSX saved values at lines 153–199 |
| File reader and revision workflow | client/console/FilesPane.tsx, lines 417–450; client/console/DocumentEditor.tsx; shared/file-identity.ts; client/console/VersionCompare.tsx |
| Import, workbook, and historical-byte limits | shared/file-drops.ts; server/file-drops.ts; server/xlsx-preview.ts |
| Service boundary and current transport limits | server/connections/desktop.ts; server/harness/capabilities/read-scope-tools.ts; server/harness/capabilities/mcp-read-client.ts; shared/pack-contributions.ts; server/integrations.ts |

The current root AGENTS.md also names canonical documents, ownership coordination, protected shared files, required verification, and approval rules for commits/pushes/releases. Discover the applicable current version; this map does not transfer another worker's claims or authorize those publication actions.

## Implementation work IDs

Use the implementation plan's work IDs in claims, checkpoints, delegated orders, and review evidence. They identify scope; they do not require independent tasks to wait unnecessarily. V11 verification applies to each relevant candidate and does not wait for optional HTML work.

| ID | Work | Boundary |
|---|---|---|
| V00 | Reconciliation and contracts | Resolve product authority, current implementation, owner interfaces, and the ready native slice. |
| V01 | Identity | Additive host-owned report identity and immutable revisions. |
| V02 | Evidence and data | Deterministic source-bound results; preserve DIO-140 ownership. |
| V03 | Native reports | Composed native renderers and deterministic local controls. |
| V04 | Proactive policy | Existing answer pass, admitted budget, applicable preferences, and instruction lineage. |
| V05 | Preview/present | Registry-compatible tools, exact-revision receipts, bounded correction, and idempotence. |
| V06 | Actions | Revision-bound intents through existing proposals, tools, RunService, and Trust. |
| V07 | Refresh/history/export | Historical snapshots, current-grant refresh, version-aware export, and explicit unavailable states. |
| V08 | Actual-file previews | Separate renderer/format qualification; current PDF/DOCX/PPTX/XLSX limitations remain visible until addressed. |
| V09 | Service proposals/handoffs | Supported source-bound proposals and qualified integrations; no implied live POS support. |
| V10 | Optional HTML | Separate executable isolation/network qualification and brokered interaction. |
| V11 | Evaluation and rollout | Evidence for the current candidate; product delivery follows the actual applicable release authority. |

## Prompt 1 — Lead execution: reconcile, then implement

Copy the following prompt into the implementation session with this pack and the implementation report available.

~~~~text
Implement the native proactive-visualization foundation in Nectovia. The north star is an agent inside a connected workspace that creates, renders, previews, and revises work in the app, with a clear path from the exact preview to the user's next action. Begin implementation in this session after a bounded reconciliation of the current repository, canonical decisions, and active ownership. A plan is an intermediate aid; the required outcome is working, verified, reviewable code for the ready native-report and generic artifact-identity slice.

Use the implementation report, implementation plan, and the “Current implementation brief” in the accompanying Astra prompt pack as the requested direction. Start V00, then implement the ready native V01–V07 work in dependency order, with the applicable V11 verification. Use the plan IDs in your checkpoint. Reconcile product authority separately from implementation evidence: current explicit user decisions and canonical pillars/roadmap/memory determine the intended behavior; current source and observed tests establish what exists and what remains. Source does not override canonical constraints. Do not assume the 7 October 2026 baseline is still current. Reuse an existing capability and continue from its actual remaining gap.

START WITH THE CURRENT STATE

Read applicable AGENTS.md instructions and the current coordination record. Resolve the relevant current user and pillar/roadmap/memory decisions and design approvals; separately check the runtime verification/change records as implementation evidence. Read only the source paths and supporting documents needed for this slice. Identify the current base commit, implementation owner, claimed paths, hot-file integration owner, and appropriate verification commands.

Inspect the existing Files reader, main-stage editor, History-derived file identity, version comparison, and relevant preview/service adapters before adding a parallel mechanism. File actions currently bind to project/scope, path, and sha with history identifiers; there is no independent fileId or rename-following identity, and some historical bytes may be unavailable. Record the fidelity actually available: PDF metadata is not rendered pages; the inspected Files flow has no qualified DOCX/PPTX preview or authoring path; its first-sheet XLSX saved values and serial dates are not recalculation or workbook layout; the Toast/compiler demo is not a live POS transport. The broader workspace direction should have its own follow-on work record; do not rebuild every service in this slice.

Reconcile DIO-140 before touching its inventory_query, inventory-view, dataset, or filter work. Its owner retains that implementation. Preserve its host-minted queryId contract, summary/result-ID-only model exposure, deterministic filters, and unresolved entitlement/storage/mapping/evaluation decisions. Reuse the approved design/theme from DIO-252/265 and the Operations authoring boundary in DIO-259.

Record any concrete mismatch and its consequence. An unavailable document or blocked owner decision should defer its dependent action, not stop unrelated work. Do not rewrite project instructions to remove a constraint. If an actual applicable rule blocks a step, name its source, explain the exact conflict, and keep permitted work moving.

IMPLEMENT THIS READY OUTCOME

Create an end-to-end native report path that joins the existing typed visual renderer to durable artifact identity and host-bound source evidence:

1. Extend the existing artifact model additively with host-owned stable report/artifact identity, immutable revision, renderer/schema version, source snapshot references, provenance, and preview-fidelity metadata. Reuse recorded-artifact and artifact-step evidence, exact file references, and existing version/history records. Treat any new logical file identity as a separate deliberate contract; preserve the current path-and-SHA historical resolution. Do not create a second file store, task lifecycle, or permission authority.

2. Support composed native reports using existing SVG visuals, KPI/table/text blocks where justified, and the approved Console visual system. Keep a historical report's captured result separate from live Board-derived state and optional saved viewer filters. Preserve source values, units, timezone, aggregation, unknowns, and denominator semantics.

3. For source-bound reports, resolve authorized host results and derive charts deterministically. A model may select a permitted presentation, but it may not fabricate source rows or substitute embedded data for a host-minted reference. Keep the current legacy visual contract working for its existing uses.

4. Add the proposed visual_preview and visual_present capabilities through the existing typed tool registry, or extend an equivalent current capability discovered in V00. These underscored names fit the inspected registry; retain them in code and tool descriptions. The MCP adapter and legacy fence transport must converge on the same validation and publication logic. Keep tools unavailable where the active mode or authority does not permit their operation.

5. Preview the same prepared revision that will be presented. Bind the receipt to the artifact/file identity, revision, specification, source snapshot, assets, renderer version, and fidelity. Make publication idempotent across retries, resume, and duplicate transport delivery. Return one authoritative artifact reference. Clearly distinguish an actual rendered output, a structured proposal or generated mockup, and a live service view; identify partial or unavailable rendering. Represent failures honestly and provide a useful static, file, or textual fallback. Use one initial preview and at most one optional automatic correction-and-recheck cycle, staying inside the admitted task/model budget. Stop when the checks pass; do not escalate the model, route, payer, or service to improve the preview.

6. Add a concise proactive-presentation policy through the current answer-format/mode composition path. Select presentation in the existing answer pass, with no separate model classifier. Use the already-admitted task, selected model route, payer, privacy boundary, and budget. Respect text-only, table-only, and applicable scope-specific preferences. Use a visual when it improves understanding, and offer the available faithful preview when creating or materially revising an output. Use supported renderers and adapters; label structured proposals, generated mockups, and live views accurately. Preserve source uncertainty, make the result inspectable in the app where supported, and avoid redundant panels or unchanged re-renders. Keep policy in one place. Refresh instruction digests and lineage evidence using the existing mechanism. Preserve strict Build/Fix proposal parsing.

7. Implement local, schema-validated presentation controls with zero model calls. Bind revision requests, option selections, and actions to the inspected artifact ID/revision or the exact project/scope/path/sha file reference, plus the relevant selected item. Route them through the existing host proposal and RunService/Trust/tool path with current data scope and grants. Detect a stale expected revision and resolve it through the current conflict behavior. Old artifact references, saved filters, model text, or generated callbacks do not confer new authority.

Native reports are the first deliverable. Do not make V01–V07 depend on broad file rendering in V08, service-host work in V09, or optional executable HTML in V10. Keep advanced packaged chart support, new high-fidelity output renderers, supported service adapters, and isolated mockups as subsequent slices governed by the implementation plan. Do not loosen scriptless frames, add a customer Design Center, or silently select DIO-140's unresolved business decisions.

WORK AS A TEAM WITHOUT DUPLICATING WORK

Claim the exact paths you own and use the repository's supported isolated-worktree workflow. Delegate independent tests, renderer work, or a bounded compatibility audit when that improves progress. Each worker gets a concrete outcome, owned paths, interface assumptions, and acceptance criteria. Integrate shared hot files through their current owner. A stale claim is not permission to take it. Use the existing shared heavy-test slot.

Continue through implementation, relevant verification, inspection, and fixes. If a later ready slice is already authorized and fits the established contracts, keep going. Do not stop just because the first code pass exists. Pause only for a material unresolved decision or action that actually lacks authorization, after making the result concrete and completing independent work.

EARN COMPLETION

Exercise the acceptance checks in this pack that apply to the native slice. Cover historical reload, idempotent publish, source-reference validation, preview fidelity, stale-revision handling, zero-model-call local filters, denied refresh, legacy fences, unsupported renderers, accessibility, and strict Build/Fix output. Run meaningful tests for changed behavior and the current repository's required gates. Do not repeat a successful broad run without a new change, failure, or unresolved risk. Use owned fixtures and processes; do not introduce paid live-model evaluation without the required authority.

Inspect the working UI using the existing development workflow and approved theme at the documented viewport boundaries. Record the exact commands, results, base/candidate state, and evidence paths. Do not label skipped or inaccessible checks as passed. Obtain a bounded independent review, resolve substantiated in-scope defects, and rerun the checks affected by those fixes.

Finish with implemented behavior, evidence, compatibility implications, remaining dependent decisions, and the next ready slice. Keep build, packaging, publication, and deployment status distinct. Update the implementation record and prepare any necessary canonical-document patches. Perform a commit, push, merge, remote document update, package delivery, or deployment only when the current session's authorization and project rules cover that specific action. This prompt authorizes the scoped implementation and its local verification; it does not independently authorize deployment.
~~~~

## Acceptance and evidence for the native slice

Use these as observable outcomes, adapting test placement to the current implementation. They are not instructions to rerun every test after every edit.

| Outcome | Evidence that earns the claim |
|---|---|
| Legacy behavior survives | Existing accepted visual kinds and valid fences render; incomplete streaming blocks remain incomplete; malformed or excessive input fails gracefully; user text remains text. |
| Proposal protocol survives | Build/Fix still accepts its valid proposal and rejects appended visual/prose output; Ask/Plan uses the current visual guidance; instruction digest/lineage checks cover the change. |
| Proactive defaults stay bounded | Selection runs in the existing answer pass with no classifier call; text-only/table-only and scope-specific preferences are respected; task, model route, payer and budget stay unchanged; preview allows at most one optional correction-and-recheck cycle. |
| One durable artifact | A new native report has a stable identity and immutable revision; a reload/restart resolves its captured result through the existing record/store path; another project cannot forge its source reference. An unavailable older file version is identified explicitly instead of replaced with current bytes. |
| Same preview and publication | The preview receipt binds the prepared revision and renderer; an altered revision cannot reuse that receipt as proof. |
| Preview fidelity is honest | Actual rendered output, structured proposal, generated mockup, live view, partial reader and unavailable preview are distinguishable. The record identifies the inspected version and appropriate freshness; a mock or metadata reader cannot satisfy a claim of rendered-file verification. |
| Revision/action round trip is exact | A request carries the inspected identity, revision and selected item through the current proposal/runtime path; a concurrent change produces the established conflict handling instead of silently editing another version. |
| No duplicate publication | Retry, resume, and duplicate tool/fence delivery produce one authoritative publication rather than two cards. |
| Historical evidence is stable | A data refresh produces a new captured result/revision; the previous report retains its original totals and provenance. A live Board view is visibly and structurally distinct. |
| Local controls are deterministic | Supported filters/selection/sort modify only permitted viewer state and render the expected captured data, with zero model invocations. |
| Scope is enforced | Unknown/forged/expired result references and invalid filters are handled explicitly; refresh uses current scope/grants and records its run; a saved artifact does not revive revoked authority. |
| Numbers mean what they say | Empty, zero, unknown, negative, large and percentage values follow declared semantics; charts and accessible tables agree; rendering emits no invalid numeric geometry. |
| Native UX is usable | Keyboard navigation, focus, accessible names/table alternative, theme contrast, narrow layout, loading, empty, error and unsupported-renderer fallbacks are inspected. |
| Ownership remains intact | DIO-140 interfaces are consumed or extended through their owner; no duplicate inventory engine, query schema or parallel raw-data dashboard has appeared. |
| Verification is attributable | Fresh applicable gate results identify the tested base/candidate, commands, counts and evidence. Unperformed packaging, funded evaluation and deployment remain unclaimed. |

DIO-140's large inventory fixture belongs to its owner's acceptance work. Use its verified contract/results where available. A generic report fixture is not proof that the full inventory acceptance target has passed.

## Prompt 2 — Continue an implementation session

~~~~text
Continue the Nectovia proactive-visualization implementation from the latest verified V00–V11 checkpoint. The objective and boundaries in the lead prompt and accompanying implementation brief still apply unless the user's newer instructions change them.

Recover the current work ID, branch/base, working diff, ownership claims, selected source snapshot, artifact/schema versions, instruction lineage changes, and completed verification from the actual repository and evidence records. Reconcile new product decisions separately from implementation evidence; code does not override a canonical product constraint. Identify what landed since the checkpoint. Preserve completed work; do not restart the investigation or reimplement DIO-140.

Choose the highest-value ready gap in the native-report slice, then implement it. If native identity, source-bound composition, preview/presentation, fidelity labeling, revision binding, and proactive policy already meet acceptance, continue the next explicitly authorized ready slice from the report. Preserve the connected-workspace direction while reusing existing readers, editors, and supported service adapters. Keep executable-HTML isolation independent of native delivery and preserve the existing scriptless boundary until its separate acceptance has passed.

Keep proactive selection in the current answer pass, honor the active text/table and scope-specific preferences, preserve the admitted route/payer/budget, and retain the initial-preview-plus-one-optional-correction default. Local controls continue to make zero model calls.

A missing approval, owner decision, source, or integration claim blocks only the dependent action. Explain that boundary accurately and complete independent compatible work. Do not infer authority from a previous patch's approval, stale issue status, a saved filter, or an earlier model's summary.

Update only the tests/evidence affected by new changes and run any current required gate that remains outstanding for this candidate. Do not repeat passing broad checks merely because context was compacted. Review fresh failures, fix the defects within scope, and verify the fixes. Keep historical test output attributed to its original run.

At the end of a meaningful slice, update the checkpoint with: base and candidate identity; changed and owned files; artifact/schema decisions; source/provenance and instruction-lineage implications; exact verification results; blocked dependencies and their owner; uncommitted or unpublished work; and the next concrete action. Keep implementing until the authorized ready work is complete or a real dependency prevents further progress.
~~~~

## Prompt 3 — Bounded delegated implementation task

The lead fills the short work-order fields. A worker receives only the relevant source and acceptance subset.

~~~~text
Work order: [V00–V11 work ID and specific outcome]
Base/candidate: [repository path, branch, base SHA, relevant uncommitted patch identity]
Owned paths: [exact paths confirmed available through current coordination]
Integration owner: [lead/current owner]
Dependencies/interfaces: [accepted types, registry seam, renderer or snapshot contract]
Required acceptance: [observable outcomes for this task]
Evidence destination: [existing repository evidence/implementation path]

Implement this outcome within the owned paths and report a reviewable result. Read the applicable instructions, relevant canonical decisions, and just the source needed to resolve this work order. Keep product authority separate from evidence about the current implementation. Confirm the base and claims before editing. Treat unrelated changes and other workers' files as owned by those workers.

Preserve the project constraints relevant to your work: the existing Core/Runtime/Trust and tool-registry authority; additive legacy visual compatibility; strict Build/Fix proposal output; source-bound report data; immutable historical evidence; truthful preview fidelity and exact revision/action binding; bounded proactive selection and correction under the current route/payer/budget and applicable preferences; and the existing instruction digest/lineage path. Reuse existing file readers, main-stage editing, identity/history, and supported service adapters. DIO-140 inventory contracts and approved theme/design ownership remain with their recorded owners. Do not modify their semantics as a local implementation shortcut.

Use the current interfaces or coordinate a specific proposed interface change with the integration owner. If a shared hot file is needed, return an exact patch or integration request for its owner rather than editing it in parallel. Do not widen your assignment or another worker's permissions.

Run focused verification that distinguishes correct behavior from the failure being fixed or prevented. Use the shared heavy-test slot when needed, and avoid duplicating a broad run already owned by the lead. Do not claim completion from code inspection alone when your task requires a working behavior.

Return: implemented outcome; exact changed files; interface assumptions; test commands and observed results; evidence paths; concrete remaining concerns; and any patch awaiting the integration owner. Do not publish, merge, deploy, or change model/billing configuration unless this work order explicitly includes that authorization.
~~~~

## Prompt 4 — Independent review of the actual candidate

~~~~text
Independently review this Nectovia visualization candidate.

Candidate: [base SHA and exact candidate SHA or patch digest]
Scope: [V00–V11 work IDs and native report / actual-file preview / service proposal / isolated mockup slice]
Implementation record and evidence: [paths]
Current owners and approved decisions: [paths or current issue references]

Inspect the candidate itself, the relevant current contracts and canonical constraints, and the cited evidence. Product decisions establish the intended behavior; code/tests establish implementation evidence. A divergence is not permission to discard a canonical constraint. Do not treat the implementation summary, historical test totals, or a screenshot as proof of all acceptance criteria. Review is read-only unless a separate work order authorizes a fix.

Prioritize failures that would misstate data or preview fidelity, lose historical evidence, duplicate publication, revise a version the user did not inspect, break legacy visual or Build/Fix behavior, bypass current authority, or leave the claimed user flow incomplete. Check preview/publication parity, source/query reference binding, expected-revision conflicts, local filter semantics, current-grant refresh, unsupported renderer behavior, instruction lineage, and approved theme/accessibility requirements as they apply to this candidate. Verify the asserted output using its real renderer or adapter; a layout mock, metadata card, or synthetic connector does not prove a delivered file or live-service change. Check that presentation selection adds no classifier call, honors text/table and scope-specific preferences, stays inside the admitted route/payer/budget, and permits only one optional correction after the initial preview. Local presentation controls must make zero model calls.

For an inventory integration, verify that DIO-140 remains host-query-bound, exposes only the permitted summary/result ID to the model, rejects model-embedded raw data and forged query IDs, and validates local filters without model calls. For executable mockups, require evidence for the actual isolation/network boundary; CSP or a new iframe name alone is not acceptance.

Run the smallest useful independent checks that resolve a concrete uncertainty, respecting the shared test slot. State which evidence you inspected and which checks you ran yourself. Required gates that were skipped or run against a different candidate remain outstanding.

Return substantiated findings in severity order with the affected path/location, observable failure, conditions or reproduction, and a specific correction. Separate blocking defects from optional improvements and unresolved product decisions. If no blocking issue is found, say what you examined and what remains unverified. Do not manufacture findings to fill a quota, propose a broad rewrite without necessity, or mark the feature shipped. The implementation lead should fix verified in-scope defects and rerun affected checks; no indefinite review loop is required.
~~~~

## Optional short user follow-up

Use this only when the same session already holds the lead prompt, current report, and verified checkpoint:

~~~~text
Continue the authorized visualization work from the current candidate. Reconcile only new source/decision/ownership changes, preserve DIO-140 and the existing Runtime/Trust/proposal contracts, and implement the next ready acceptance gap. Verify what changed and keep working through substantiated fixes. Do not restart the completed audit or ask whether to begin.
~~~~

## T3 reference status rechecked for this pack

Rechecked through the official pingdotgg/t3code repository on 7 October 2026, approximately 05:51 UTC:

| Reference | Observed status | Implication |
|---|---|---|
| [#15968: HTML replies](https://github.com/pingdotgg/t3code/pull/15968) | Merged 5 October 2026; 677d1527c3d96b90b2294d9a0aed7d8c8874b29b | General HTML preview/publication is a shipped T3 reference. |
| [#16196: MCP Apps bridge names](https://github.com/pingdotgg/t3code/pull/16196) | Merged into the feature branch before launch; 87a7ca49e93e90cb8541d9d9917d0c50593991ed | Theme/link compatibility is present without full third-party app hosting. |
| [#16283: live size correction](https://github.com/pingdotgg/t3code/pull/16283) | Merged 6 October 2026; 64275ae39653379e63f49f87be021c190fd20e81 | Account for real client sizing and historical embedded-bootstrap versions. |
| [#16234: opt-in visual beta](https://github.com/pingdotgg/t3code/pull/16234) | Open, unmerged | Do not cite the default-off setting as shipped behavior. |
| [#16236: full MCP Apps hosting](https://github.com/pingdotgg/t3code/pull/16236) | Open, unmerged | Treat full app hosting as separate work; it is not a prerequisite for native Nectovia reports. |

The first containing release verified during this investigation was [v0.0.46-nightly.20261005.2702](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261005.2702), published 5 October 2026 at 23:58:57 UTC as a prerelease. Merged code and a nightly release do not establish stable-channel availability.

T3 is a reference implementation, not Nectovia's authority or a requirement to adopt arbitrary generated HTML. Its repository's [MIT license](https://github.com/pingdotgg/t3code/blob/main/LICENSE) permits reuse under its stated notice conditions. Any copied substantial code must retain the applicable notice.
