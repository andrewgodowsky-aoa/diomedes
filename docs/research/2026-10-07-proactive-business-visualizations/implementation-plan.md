# Nectovia Proactive Visualizations and Connected Workspace Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when implementing this plan under the actual session’s authorization. Execute and review one bounded work item at a time; parallelize only independent, claimed paths.

**Goal:** Deliver useful proactive native reports and faithful previews of actual work, connected to existing authorized actions and durable evidence.

**Architecture:** Extend the existing Console, artifact index, Files/history, tool registry, and Runtime/Trust contracts. Native reports bind host-owned results and use deterministic controls; exact-revision preview receipts serve both reports and real files. Generated executable HTML is an optional separate execution lane and is never a native-release prerequisite.

**Tech stack:** Existing TypeScript, React, Zod, Vitest, Playwright, and Electron boundaries. Evaluate a packaged chart adapter only against demonstrated requirements; qualify the PDF renderer in V08 and executable-HTML runtime in V10 separately.

**Spec:** main report (`REPORT.md` in downloads; `README.md` in the repository), package `NC-VIS-2026-10-07.1`, with its source catalog and canonical product references. This is a proposed implementation plan; no application tests or implementation were performed while preparing it.

## Global constraints

- Reconcile the audited baseline `bae249b60ffafa3934d775c6d59fbac80990a83e` with current source. Current explicit decisions and canonical product authority govern intent; source and fresh verification establish implementation.
- Use one Console, Project/Files authority, and Runtime/Trust lifecycle. Preserve truthful model/application attribution and existing action grants; presentation alone requires no new approval.
- Keep legacy visual blocks and scriptless artifacts valid. Initial limits remain 32 KiB/block, eight visuals/reply, eight series, 200 points, twelve pie slices, six stats, twelve table columns, and fifty table rows.
- Host result identifiers are references, never grants. Validate current principal/scope on access, caches, asynchronous responses, previews, exports, and actions. DIO-140 keeps raw inventory rows out of model context.
- Local selection, filtering, and scenarios make zero model calls. Normal generation stays in the admitted task budget and route. Default correction budget is **initial preview plus one optional correction**, stopping sooner when checks pass.
- Preserve inspected tool hard caps: 60,000 ms per call, 64 KiB canonical JSON input, and 512 KiB JSON output; return preview/result references rather than embedding binary assets. Tighten limits where needed; do not widen them through the visual lane.
- Source inputs, scenario assumptions, and derived results remain distinct. Unknown is not zero; incompatible units and missing denominators cannot produce confident totals.
- DIO-140 owns inventory query/binding implementation. DIO-252/265 own adjacent reskin/pinning work; DIO-259 owns approved theme publication from Operations. Reuse those owners and contracts.
- Preserve existing text/Markdown editing. PDF has no current in-app viewer; DOCX/PPTX are unsupported; XLSX shows first-sheet cached values. Live browser/computer views are not currently implemented or enabled in the inspected Codex configuration.
- Do not decide commercial entitlement, paid evaluations, source mappings, or release authority implicitly. Continue independent work around unresolved dependencies.

## Review focus

These five risks have explicit owning cases below:

1. A late query or cached result crosses an account/workspace switch or revocation: A01–A02, V02/V11.
2. A scenario rewrites source facts or surplus hides another item’s shortage: N02–N03/N05, V02/V03.
3. File edits or moves make a preview refer to different bytes than export: F02–F04, V05/V08.
4. Delivery/action retries duplicate cards or external effects: A05/L01, V05/V06/V07.
5. A helpful-visual preference creates spam, extra approvals, or unbounded inference: P01–P07, V04.

## Execution conventions and shared interfaces

Paths marked **existing** were inspected or independently confirmed. Every **new** path below is proposed and must be checked for collisions and owner conventions in V00. Repository-relative paths refer to the app repository, not the research workspace. Do not create a file merely because this plan names it if an equivalent owned implementation now exists.

V00 freezes these proposed boundaries; names are design choices, not existing APIs:

| Contract | Required shape/responsibility |
|---|---|
| `ViewContext` | Adapter over existing host principal, workspace/project, run, and authority context; injected by the host, never supplied as model-granted authority. |
| `VisualEnvelopeV2` | `{schemaVersion:2, id, title?, body}`. `id` is a scoped declared identity. V01 initially wraps existing `VisualSpec`; V03 adds validated composed bodies. |
| `ReportRevision` | Host-resolved identity, immutable revision/digest, original source digest, producer/run references, result/asset dependencies, and renderer version. Do not change the meaning of existing source hashes. |
| `VisualResult` | Host result ID, source versions, fields/types/units, grain, coverage, observation time, permitted transforms, and evidence references. Raw rows stay outside the model where policy requires. |
| `ViewState` | Local selection, filters, expanded detail, and explicit scenario inputs; separate from shared content revisions. |
| `PreviewReceipt` | Revision digest, renderer/build, dependency digests, preview reference, checks performed/results, and unavailable checks. |
| `VisualActionIntent` | Closed action key, revision, selected record references, validated parameters, and idempotency key; resolves through existing tool dispatch. |
| `FilePreviewRef` | Outer host scope/project plus existing `FileIdentity {path,sha,versionId,entryId}`. Do not add a fabricated persistent file ID or automatic rename following. |

Each task follows a checkable cycle: add the named failing fixture/assertions, implement its bounded interface, run focused verification, and record exact results. A commit follows only when the session already authorizes it. Preserve active claims and required repository gates; this planning/publication task does not authorize application changes.

Verified commands are `npm test -- <paths>` (`vitest run`), `npm run check`, `npm run build`, `npm run test:ui -- <filter>`, and `npm run test:journey -- <filter>`. V00 confirms browser test discovery before creating proposed browser paths. Focused checks run per task; broader required gates run on the exact integration candidate. Paid model calls require an admitted budget; fixture tests do not imply live-route qualification.

## Work-item dependency map

| ID | Deliverable | Dependencies |
|---|---|---|
| V00 | Reconciled source/owners and frozen contracts/acceptance | Current specification |
| V01 | Stable report identities/revisions and legacy compatibility | V00 |
| V02 | Host-bound data/provenance adapter | V00; DIO-140 interface coordination |
| V03 | Composed native reports and local interactions | V01, V02 |
| V04 | Proactive selection/preferences/cadence/budget and lineage | V00; advertise later capabilities only when ready |
| V05 | Exact-revision preview/presentation workflow | V01; consume V02/V03 capabilities as available |
| V06 | Selection-to-authorized-action bridge | V01, V02, V05 |
| V07 | Pin/refresh/history/export | V01, V02, V05 |
| V08 | Actual-file preview and revision loop | V01, V05; existing Files/history |
| V09 | Connected-service proposals and contextual handoff | V02, V05, V06 |
| V10 | Optional isolated generated HTML | Separate qualified scope; V05; V06 only if actions exposed |
| V11 | Evaluation/accessibility/platform/rollout gates | Fixtures start with V00; gate each supported release |

After V00, V01/V02 can proceed on distinct claims. Compatible static policy in V04 and V11 fixtures can proceed early. V03, V05, V07, and V08 consume frozen interfaces; coordinate shared artifact files. Release native reports after their own V11 capability gates, without waiting for V08 file previews, V09 service proposals, or V10 generated HTML. File previews and service proposals release separately after their respective V11 gates; optional generated HTML requires its own qualification.

## V00 — Reconcile source, owners, and acceptance

**Existing:** `AGENTS.md`, `server/modes.ts`, `server/answer-format.ts`, `shared/visual-spec.ts`, `shared/artifacts.ts`, `shared/harness.ts`, `package.json`; canonical documents and active ownership records.

**New:** `docs/implementation/2026-10-07-visual-report-contracts.md`, `tests/fixtures/visual-reports/acceptance.json`.

**Interface:** Produces the resolved contract/path/owner manifest and case IDs consumed by every task.

- [ ] Read current authority/source; record baseline, active claims, actual preference storage, tool registration composition, file routes, test configuration, and DIO-140 interface owner. Distinguish blocked decisions from independent work.
- [ ] Freeze the interfaces above, legacy handling, first supported controls, renderer capability advertisement, revision rules, and exact new/test paths. Keep DIO-140’s storage/commercial questions unresolved unless current evidence resolves them.
- [ ] Define the 42-case matrix below as planned fixtures with owner, expected result, and gate; validate case IDs and dependencies in review. Record current version-one artifact examples for later regression assertions.
- [ ] Review the manifest against the report and current repository rules. No application tests or implementation are required to complete this documentation/reconciliation item.

## V01 — Stable report identity and compatibility

**Existing:** `shared/artifacts.ts`, `shared/visual-spec.ts`, `shared/recorded-artifact.ts`, `server/harness/artifact-steps.ts`, `client/console/artifact-evidence.ts`; `tests/artifact-pane.test.ts`, `tests/inline-visuals.test.ts`.

**New:** `shared/report-artifact.ts`, `tests/report-artifact.test.ts`.

**Interfaces:** `parseVisualEnvelope(input: unknown)` returns a validated legacy spec or `VisualEnvelopeV2`; `reportRevision(context, envelope, dependencies)` returns `ReportRevision` using the existing artifact/history authority.

- [ ] Add N01, L01, and revision fixtures: legacy artifacts round-trip unchanged; repeated declared identity groups revisions; equal bytes do not create duplicate revisions; source digest and composite revision digest remain distinguishable.
- [ ] Implement the additive envelope/indexing path, scoped identity resolution, and backward-compatible evidence reader. Initially accept existing `VisualSpec` bodies; V03 extends the union.
- [ ] Run `npm test -- tests/report-artifact.test.ts tests/artifact-pane.test.ts tests/inline-visuals.test.ts` and `npm run check`; verify historical content still renders and replay is idempotent.

## V02 — Host-bound results and provenance

**Existing:** `shared/visual-spec.ts`, `shared/harness.ts`, `server/harness/tools.ts`, `server/harness/artifact-steps.ts`; DIO-140’s existing workstream, whose current query/result implementation must be reconciled before integration.

**New:** `shared/visual-data.ts`, `server/visual-data.ts`, `tests/visual-data.test.ts`.

**Interfaces:** `resolveVisualResult(context: ViewContext, resultId: string): Promise<VisualResult>`; `transformVisualResult(result, transform)` accepts only versioned, closed-vocabulary operations and produces deterministic values/evidence.

- [ ] Add N02–N04 and A01–A03/A07 fixtures for independent totals, unknowns, incompatible units, forged IDs, stale asynchronous scope, and data-carrying app-spec rejection.
- [ ] Adapt current source/query ownership; enforce result scope before access and after asynchronous completion. Preserve source versions, units, grain, denominator, omissions, and transform parameters. Do not create another inventory store or send DIO-140 raw rows to models.
- [ ] Run `npm test -- tests/visual-data.test.ts tests/inline-visuals.test.ts` and `npm run check`. Record independent calculation results; coordinate DIO-140’s large fixture under its existing owner rather than declaring it passed here.

## V03 — Composed native reports and local interaction

**Existing:** `shared/visual-spec.ts`, `client/console/InlineVisual.tsx`, `client/console/TurnBody.tsx`, `client/console/ArtifactPane.tsx`; `tests/inline-visuals.test.ts`.

**New:** `shared/report-view.ts`, `client/console/NativeReport.tsx`, `tests/report-view.test.ts`, proposed browser `tests/ui/visual-reports.spec.ts`.

**Interfaces:** `ComposedReportV2` contains approved panels, shared result bindings, and closed control definitions; `reduceReportView(state: ViewState, event)` returns local state without model calls or source writes.

- [ ] Add N04–N07: shared selection updates every dependent panel; source detail matches the selected record; scenario inputs leave baseline rows unchanged; dates preserve actual elapsed spacing.
- [ ] Implement a compact composed report and approved select/filter/scenario controls. Retain simple SVG where suitable; evaluate a packaged chart adapter before adding it. Reject scripts, formatters, raw expressions, unsupported controls, and fabricated progress.
- [ ] Run `npm test -- tests/report-view.test.ts tests/inline-visuals.test.ts`, `npm run check`, and the discovered `npm run test:ui -- visual-reports` suite. Verify keyboard/touch values and numeric invariants, not just screenshots.

## V04 — Proactive behavior, preferences, budget, and lineage

**Existing:** `server/modes.ts`, `server/answer-format.ts`, `server/instruction-digests.ts`, `server/lineage-continuity.ts`, `server/harness/capabilities/native-loop.ts`; preference/context seam frozen by V00.

**New:** `shared/visual-policy.ts`, `tests/visual-policy.test.ts`; versioned instruction fixtures in their reconciled existing location.

**Interface:** `choosePresentation(input)` returns `{action: 'create'|'reuse'|'revise'|'text'|'table', reason, capability}` from task intent, explicit format, scoped preference, evidence sufficiency, existing artifact, capabilities, and admitted budget.

- [ ] Add P01–P07, including useful unrequested views, single-number/table-only negatives, scoped corrections, unchanged follow-ups, no extra approval, and repair exhaustion.
- [ ] Add compact guidance and host validation in supported answer/report composition. Default to one useful report, selection in the existing model pass, zero-model local controls, and initial preview plus one optional correction. Do not change payer/route or strict Build/Fix JSON.
- [ ] Update instruction digests/fixtures without silently changing known lineages. Run `npm test -- tests/visual-policy.test.ts` plus the instruction suites located in V00, then `npm run check`; record model-call counts and preference scope assertions.

## V05 — Exact-revision preview and presentation

**Existing:** `server/harness/tools.ts`, `server/harness/artifact-steps.ts`, `shared/recorded-artifact.ts`, `client/console/artifact-evidence.ts`, `client/console/ArtifactPane.tsx`.

**New:** `shared/visual-preview.ts`, `server/visual-preview.ts`, `tests/visual-preview.test.ts`.

**Interfaces:** `visual_preview` resolves an immutable revision and returns `PreviewReceipt`; `visual_present` resolves that revision/receipt under current scope. Register through existing `ToolRegistry` composition, preserving its effect/cost/limits contracts.

- [ ] Add F02/F03, A05, and P06: changed bytes/assets/data/renderer invalidate receipt applicability; retries and fence-plus-tool delivery produce one artifact; one optional correction is the ceiling.
- [ ] Implement canonical digest validation, truthful performed/unavailable checks, cancellation, timeout, bounded correction, and idempotent presentation. Preserve streamed completed native blocks and legacy behavior; do not gate old content on nonexistent receipts.
- [ ] Run `npm test -- tests/visual-preview.test.ts tests/artifact-pane.test.ts` and `npm run check`. Presenting changed content with an earlier successful receipt must fail or explicitly identify an unverified revision.

## V06 — Selection-to-authorized-action bridge

**Existing:** `server/harness/tools.ts` (`DispatchRequest`, `ToolRegistry`), `server/durable-controls.ts`, `client/console/work-view.ts`, `client/console/TurnBody.tsx`.

**New:** `shared/visual-actions.ts`, `server/visual-actions.ts`, `tests/visual-actions.test.ts`.

**Interface:** `resolveVisualAction(context, intent: VisualActionIntent)` returns a validated existing tool dispatch request or a precise conflict/unsupported result; it never creates a parallel execution lifecycle.

- [ ] Add S03–S05 and A04–A05: standing authorization is reused, stale source versions block incompatible application, hostile action keys fail, and retry/readback uncertainty cannot duplicate effects.
- [ ] Map only approved action keys and selected record references to existing tools. Recheck principal, source/target revision, effect, grant, and idempotency immediately before dispatch; return existing run/task receipts.
- [ ] Run `npm test -- tests/visual-actions.test.ts` and `npm run check`. “Explain the shortage” and a scenario selection must produce no transfer; an already authorized transfer must not gain a chart-specific approval prompt.

## V07 — Pinning, refresh, history, and export

**Existing:** `client/console/pinned-chart.ts`, `client/console/artifact-save.ts`, `client/console/ArtifactPane.tsx`, `shared/artifacts.ts`; `tests/pinned-chart.test.ts`, `tests/artifact-pane.test.ts`.

**New:** `shared/report-lifecycle.ts`, `tests/report-lifecycle.test.ts`.

**Interfaces:** `pinReport(revisionRef)`, `refreshReport(context, reportId)`, and `exportReport(context, revisionRef, format)` preserve explicit identity; refresh resolves a new authorized result through V02.

- [ ] Add L01–L04: pinned identity survives newer unrelated charts; refresh/reopen retains old snapshots; view changes create no shared revision; exports use the selected revision.
- [ ] Implement honest snapshot/scenario/refreshed labeling and scoped saved views. Reconcile DIO-140’s rerun-on-reopen contract explicitly; do not add background polling. Distinguish static exports from executable HTML outside the app boundary.
- [ ] Run `npm test -- tests/report-lifecycle.test.ts tests/pinned-chart.test.ts tests/artifact-pane.test.ts` and `npm run check`; verify restart, revocation, and historical export behavior.

## V08 — Actual-file preview and revision loop

**Existing:** `shared/file-identity.ts`, `client/console/FilePreview.tsx`, `client/console/FilesPane.tsx`, `client/console/DocumentEditor.tsx`, `client/console/VersionCompare.tsx`, `server/file-drops.ts`, `server/app.ts` document routes.

**New:** `shared/file-preview.ts`, `server/pdf-preview.ts`, `client/console/PdfPreview.tsx`, `tests/pdf-preview.test.ts`, proposed browser `tests/ui/file-preview.spec.ts`.

**Interface:** `renderFilePreview(context, ref: FilePreviewRef)` returns page assets/text alternatives and a V05 receipt for exact version bytes. Reuse `versionBytes`, existing History, and `FileIdentity`; retain text saves with `{path,text,baseSha}` through the current recorded writer.

- [ ] Add F01–F07: real PDF pages, byte/receipt equality, edit/export invalidation, historical version, move behavior, malformed/encrypted files, and explicit unsupported formats.
- [ ] Qualify and package a PDF renderer with explicit page/pixel/memory bounds, abort handling, and disabled active content/external loads; freeze those renderer-specific limits before browser acceptance. Route preview inside existing Files/artifact UI. Preserve `DocumentEditor`, conflict/rescue behavior, and XLSX’s honest cached-first-sheet label. DOCX/PPTX require later format-specific qualification.
- [ ] Run `npm test -- tests/pdf-preview.test.ts`, `npm run check`, and `npm run test:ui -- file-preview`. Inspect the actual generated pages. A renamed path must not silently resolve to different bytes; preserve the old historical reference or show a precise missing-reference state.

## V09 — Connected-service proposals and contextual handoff

**Existing:** `shared/connections.ts`, `server/connections/desktop.ts`, `server/connections/mcp-projection.ts`, `server/integrations.ts`, `client/console/ArtifactPane.tsx`; V06 action dispatch.

**New:** `shared/service-proposal.ts`, `client/console/ServiceProposal.tsx`, `tests/service-proposal.test.ts`.

**Interface:** `ServiceProposal` contains source identity/version, typed field/relationship changes, fidelity label, supported actions, and selection context; `handoffContext(proposalRef, selection)` preserves task and revision without exposing credentials.

- [ ] Add S01–S07 using a synthetic connector: exact source-to-proposal mapping, unsupported layout/write paths, stale change conflicts, readback, and return-context preservation.
- [ ] Implement one generic structured proposal viewer and supported handoff adapter. Clearly separate proposed state, observed service data, mockup, and actual application capture. Do not enable currently disabled browser/computer tools or promise live POS embedding.
- [ ] Run `npm test -- tests/service-proposal.test.ts tests/visual-actions.test.ts` and `npm run check`. A convincing proposed layout must remain unapplied until actual tool/result evidence establishes the change.

## V10 — OPTIONAL isolated generated HTML

**Existing:** `client/console/artifact-frame.ts`, `shared/app-csp.ts`, `desktop/main.mjs`, `server/harness/tools.ts`; `tests/artifact-frame.test.ts`.

**New, only after qualification:** `docs/implementation/2026-10-07-interactive-html-boundary.md`, an owner-approved runtime adapter, `tests/generated-interface-isolation.test.ts`.

**Interface:** A capability-negotiated `IsolatedInterfaceRenderer` consumes immutable HTML/assets and produces V05 receipts. Any actions use V06; absence of qualification advertises the capability as unavailable.

- [ ] Define an adversarial probe and resource/egress/navigation/storage/native-bridge expectations with runtime owners; preserve the current scriptless path.
- [ ] Produce supported-platform evidence, including A06, before selecting an implementation adapter. CSP success or a screenshot alone is insufficient. A negative feasibility finding completes the investigation without shipping execution.
- [ ] If separately authorized and qualified, implement the approved adapter and run its isolation suite plus `npm test -- tests/artifact-frame.test.ts`. Record actual platform results; V11 native release does not wait for this item.

## V11 — Evaluation, accessibility, platform, and rollout

**Existing:** The four verified artifact/visual test files above; current Vitest, Playwright, journey, build, and release controls.

**New:** `tests/fixtures/visual-reports/`, `tests/visual-acceptance.test.ts`, proposed browser suites above, `docs/implementation/visual-report-acceptance.md`.

**Interface:** Acceptance records carry case, candidate commit, fixture/source revision, renderer/route, checks/results, and cost/call counts. Log concise decision categories through existing run/usage evidence, excluding raw business data.

- [ ] Begin fixture authoring with V00; implement each owning case as its feature lands. Use the 42 cases below before expanding evaluation scope.
- [ ] Run focused suites, then required `npm test`, `npm run check`, `npm run build`, discovered `npm run test:ui`, and `npm run test:journey` gates on the exact candidate under repository coordination rules. Report real counts, failures, skips, and unrun checks.
- [ ] Qualify model behavior with a small paired subset under an explicit existing/admitted budget; no 490-task paid bake-off is an initial prerequisite. Include managed/local/connected routes only when actually eligible and available.
- [ ] Gate native release on relevant data, authority, fidelity, accessibility, and budget cases; roll out by existing controls. Preserve artifacts/plain answers on renderer rollback. Qualify V10 and additional file/service adapters independently.

## Planned acceptance matrix — 42 cases, not executed

N = native; P = proactive; F = file/preview; S = service; A = authority; L = lifecycle/release. Subcases may share fixtures but every listed outcome needs explicit evidence. The fictional four-part fixture uses on-hand `[180,140,130,100]`, reserved `[30,20,10,20]`, and daily demand `[40,30,20,10]`, all in individual pieces; assign stable source rows and explicit snapshot metadata. It is not real Nectovia performance data.

| Case | Owner | Input and required result |
|---|---|---|
| N01 | V01 | Legacy chart/app fixtures and limits still parse/render; unknown v2 fields fail. |
| N02 | V02 | Four-part fixture: five days requires 500, covers 420, shorts 80, coverage 84%; surplus cannot cross SKUs. |
| N03 | V02 | Null, zero denominator, mixed cases/pieces, missing source stay distinct; unsupported aggregate refused. |
| N04 | V03 | Dates one then three days apart preserve a 1:3 interval; partial periods labeled. |
| N05 | V03 | Three/five/ten-day scenarios yield shortages 0/80/530; original source rates/stock unchanged. |
| N06 | V03 | Selection and filters update all panels/detail; zero model calls and source writes. |
| N07 | V03 | Unknown control/script/formatter refused; exact data alternative remains readable. |
| P01 | V04 | Unrequested warehouse/crew/service comparisons get useful compact views. |
| P02 | V04 | Single invoice total, confirmation, and one-step instruction remain concise. |
| P03 | V04 | Table-only/text-only and missing-denominator/unsupported-forecast cases abstain appropriately. |
| P04 | V04 | Personal/project visual preference persists; explicit current correction wins; no tenant-wide inference. |
| P05 | V04 | Unchanged follow-up reuses artifact; no new query, revision, or approval. |
| P06 | V04/V05 | Initial preview plus one failed correction stops; fallback retained; no route/payer switch. |
| P07 | V04 | Old lineage stays compatible; Build/Fix JSON valid; no separate classifier-model call. |
| F01 | V08 | Actual multi-page PDF renders readable correct pages with page/text alternatives. |
| F02 | V05/V08 | Editing a price changes bytes; old preview receipt cannot validate new export. |
| F03 | V05/V08 | Asset/data/renderer change invalidates receipt applicability, preserving old evidence. |
| F04 | V08 | Move/rename during preview/export never substitutes new-path bytes for historical identity. |
| F05 | V08 | Current text editor save/conflict/history survives; exact old revision remains inspectable. |
| F06 | V08 | DOCX/PPTX remain explicitly unsupported; XLSX not claimed fully recalculated or multi-sheet. |
| F07 | V08 | Corrupt, disguised, encrypted, or oversized PDF yields bounded honest failure. |
| S01 | V09 | Proposed POS/catalog structure preserves source IDs, names, prices, and associations. |
| S02 | V09 | Missing layout/write capability shows labeled proposal/unsupported action, never fake live UI. |
| S03 | V06 | Already-authorized application reuses grant; display-only question performs no external action. |
| S04 | V06 | Concurrent source edit conflicts before dispatch; revised proposal binds new source version. |
| S05 | V06/V09 | Apply success requires real result/readback; ambiguous result is not reported completed. |
| S06 | V09 | Supported external handoff returns to task, source, revision, and relevant selection. |
| S07 | V09 | Disabled browser/computer capability stays unavailable; no mock impersonates a session capture. |
| A01 | V02 | Forged/wrong-tenant result, artifact, and preview IDs fail without data disclosure. |
| A02 | V02 | Revocation/account switch rejects stale cache and late asynchronous result. |
| A03 | V02 | Malicious source text and model-data-carrying app spec cannot alter query scope or facts. |
| A04 | V06 | Forged action key/parameters/target cannot bypass existing registry/grant checks. |
| A05 | V05/V06 | Repeated tool/fence delivery and action retry produce one card/effect or explicit reconciliation. |
| A06 | V10 | Optional HTML cannot escape qualified resource, navigation, native, and egress boundary. |
| A07 | V02/V11 | DIO-140 raw rows stay out of model/analytics; bounded authorized UI inspection remains possible. |
| L01 | V01/V07 | Restart/replay preserves identity, recorded revisions, and idempotency. |
| L02 | V07 | Saved-view refresh creates explicit new result; old snapshot remains; no unrequested polling. |
| L03 | V07 | Pin targets chosen artifact/revision; unrelated new chart does not replace it. |
| L04 | V07 | Export matches selected revision; executable export boundary identified; source access rechecked. |
| L05 | V03/V08/V11 | Tested widths, text scale, themes, reduced motion, keyboard/touch pass without clipped labels/traps. |
| L06 | V11 | Small paired route evaluation records correct decisions, unnecessary visuals, misses, latency/cost, and unrun routes. |
| L07 | V11 | Renderer rollback preserves evidence/plain answer; cancellation stops work; analytics exclude private rows. |

Measure false-positive rate as unnecessary proactive visuals divided by adjudicated no-visual cases; also report unnecessary share of generated visuals, missed required visuals, and duplicate frequency. The small initial suite establishes regression behavior, not narrow statistical confidence. Report denominators and uncertainty; do not claim population targets satisfied from a handful of examples. Data fabrication, unauthorized action/disclosure, and false artifact/live claims independently fail acceptance.

## Completion record

For every work item, record changed paths, interface revisions, actual commands/counts, case evidence, remaining conflicts, and unrun platform/model checks. Product release requires the exact integrated candidate and applicable repository gates; a merged plan, successful mockup, or rendered screenshot alone does not establish feature completion. Keep DIO-140 and optional V10 status separately attributed.
