# Nectovia Proactive Visualizations and Connected Workspace

Package NC-VIS-2026-10-07.1

Prepared for Andrew and the Nectovia implementation team on 7 October 2026

## Package navigation

- [Implementation plan](implementation-plan.md): V00–V11 and 42 planned acceptance cases.
- [Astra prompt pack](astra-prompts.md): kickoff, continuation, delegation, and independent review.
- [Sources and evidence](sources.md): 59 references, evidence limits, and supplied-file hashes.
- [Native report in Drive](https://docs.google.com/document/d/1LFLW1t-RHDAjvh1kd1g7L5HTZNCOOHRad6O8VoB2kbE).
- [Drive package folder](https://drive.google.com/drive/folders/1U1vlHfF0J_lltXSTqP3YG3gRBVkz3UBC).
- [Notion feature record and full package](https://app.notion.com/p/3f292213bac9819699b6fc25c44c5ae9).
- [Linear DIO-273 and linked work items](https://linear.app/diomedesdevs/issue/DIO-273/nc-vis-proactive-visualizations-and-connected-workspace).

This is a documentation package. Application implementation, paid evaluations, merge, deployment, and release are separate work.

## 1 Decision and intended outcome

Nectovia should proactively turn suitable business questions into interactive visual answers. A person asking where stock will run short, why margin changed, which work is delayed, or how a proposed schedule would perform should receive a useful visual when the available evidence supports one. They should not have to know which chart to request or ask the agent to visualize information it has already gathered.

The recommended implementation starts with validated reports rendered by Nectovia and faithful previews of actual created work, connected to existing tools and work records. A separately isolated surface can later support generated interfaces. These capabilities extend the current artifact system and preserve Core, Runtime, Trust, the shared Console, and Board or Work authority. The native report path can ship while file-format support and generated-interface execution mature independently.

The initial experience should support one complete business journey: ask a question, inspect a source-backed visual, adjust a local view or scenario, examine the affected records, prepare an authorized action, and follow its progress through the existing work system. The broader direction is a connected workspace where users can create, render, inspect, revise, and act on work without repeatedly switching applications. The experience must remain model independent. Standard reports should be usable by smaller local models as well as stronger managed or customer-provided models.

This report incorporates the T3 Code screenshots and implementation review, the current application source, the canonical Drive plans, and the newly located overlap in Linear. It defines the proposed product behavior, architecture, implementation sequence, and acceptance requirements. It is an implementation specification, not a statement that the proposed capabilities have shipped.

### Scope and priorities

The first priority is dependable interactive reports: good graph design, local controls, stable artifact identity, deterministic calculations, and source inspection. Shared preview and revision contracts then support the next concrete outcome: inspecting and revising a real saved file inside Nectovia, beginning with PDF. Connected-service proposals join that review loop through supported tools. Generated interactive HTML follows qualification of its separate execution and network boundary. Work actions, pinning, refresh, and reusable views connect these capabilities to ongoing operations.

The generic capability should serve manufacturing, construction, restaurants, retail, property management, professional services, software work, and Personal use. Inventory is the first concrete integration case because a relevant workstream already exists. This package does not change plan entitlements, select a new paid model route, authorize paid evaluations, or make a particular industry the mandatory market entry point.

## 2 Current evidence and source precedence

The application baseline is `andrewgodowsky-aoa/diomedes` at `bae249b60ffafa3934d775c6d59fbac80990a83e`. A fresh check found no source changes since the preceding visualization review. The T3 implementation baseline inspected is `10f39eb9ac80c9a4b7f5097575dd2addc3b6f631`. Current source and task ownership take precedence over the historical snapshots in older documents. [R01, R02]

The canonical roadmap and Core pillars retain version 2026-10-06.1. The ART-05 feature brief remains part of the self-configuration and feature package SC-2026-09-26.1. The roadmap contains dated historical checkpoints; its older statement that no pull requests were open is not a current repository claim. At the reconciliation read, GitHub listed eleven open pull requests. [R03, R04, R05]

The September 4 and 5 archives and Achilles business documents establish historical interest in artifact canvases, reusable capabilities, and business reporting. They do not override current Nectovia naming, Personal support, source permissions, native runtime ownership, or current cross-industry positioning. Their relevant contents were inspected as historical context. The source catalog records the supplied file identities and hashes.

Keep product authority separate from implementation evidence. Current explicit user decisions and applicable repository instructions govern the work, with the current Core pillars, roadmap, and project memory defining intended behavior in their established order. Current source and fresh verification establish what is implemented. Code can expose a gap against a product constraint; it does not override that constraint. Linear records current work ownership. This specification extends those authorities, while dated research remains context. A newer task description does not prove implementation, and merged source does not prove release or installed-platform behavior.

### Existing work that must retain ownership

**DIO-140 owns the inventory query and dashboard integration.** Its proposal uses a host-computed dataset, a closed query vocabulary, a host-minted query reference in an app card, and local filtering with no model calls. It requires a synthetic fixture with 25,000 SKUs and 250,000 movements across two or three sources, independent-reference totals, preservation of unknown values, refusal of forged references, and restart persistence. The model receives summaries and result references rather than raw rows. These requirements should be reused, not recreated as a second inventory dashboard project. Its dated implementation snapshot and unresolved decisions must be reconciled before dependent work begins. [R06]

**DIO-252 and DIO-265 own the current reskin and pinned-chart design work.** New report components should fit the approved design and respect active claims on shared UI files. A visualization feature does not authorize replacing those approved screens or bypassing their design review. [R07, R08]

**DIO-259 owns business appearance authoring and delivery.** Staff create a business look in Operations, the owner approves its exact version, and the accounts service controls publication and delivery. The desktop consumes the approved theme while preserving personal palette, text-size, contrast, and reduced-motion choices. This report consumes that theme runtime; it does not restore customer-side Design Center authoring. [R09]

Related plugin, workflow-graph, memory, and runtime work should be composed through existing interfaces where qualified. A complete runtime rewrite is not a prerequisite for visual reports. Existing owners should resolve shared-file integration, while independent visual policy, schema, and evaluation work continues.

## 3 What T3 Code provides

T3's inline HTML feature merged on 5 October 2026 in PR 15968. The first containing release verified in this research was the nightly `v0.0.46-nightly.20261005.2702`. This establishes a merged feature and a nightly distribution, not a claim that every stable installation already includes it. [R10, R11]

The first supplied screenshot shows a composed analytical answer with metrics, a composition chart, a weekday and hour heatmap, and hover detail. The second shows alternative interface designs in the conversation. Its text explicitly identifies the mocks as hand-built from a screenshot. It does not establish that T3 automatically renders its production components or implements an option when selected.

The implementation accepts a complete HTML document with styling and JavaScript. `html_preview` produces a browser preview and diagnostics; `html_render` presents the document as an inline attachment. Tool output carries a small reference to the rendered attachment instead of embedding a second full document into the visible answer. The mechanism is not a special chart-fence parser and does not mandate a particular charting library. [R12]

The rendering guide supplies host typography and theme variables, chart colors, responsive layout expectations, and content-sizing rules. Agent instructions encourage a preview, inspection, correction, and presentation loop when a visual would help. These instructions and the viewer integration contribute as much to the result as the individual chart styles. [R13, R14]

T3's viewer uses an iframe that permits scripts and forms while omitting same-origin permission. It supports host context, link handling, and size messages. The published document and embedded assets remain attached to the conversation. Persisting the document does not establish that every subsequent filter selection is persisted; that is a separate state contract. [R15, R16]

### Methods worth adopting

Adopt cohesive report composition, theme-aware output, local interaction, preview feedback, attachment persistence, source inspection, and live content sizing. Keep visual content close to the question and relevant action. Avoid wrapping every visual in an extra dashboard shell when the conversation already provides the surrounding context.

A follow-up T3 change addressed a mismatch between preview height and client height that could create nested scrolling. Nectovia should measure the content in the actual viewer, handle changes after fonts and charts settle, and test narrow and wide layouts. A successful screenshot at one width is insufficient. [R17]

The preview tool's documented inputs do not include a general interaction-testing sequence. Nectovia can strengthen the method by testing primary controls and numeric invariants and by binding the preview receipt to the exact revision subsequently presented. Those are proposed improvements, not capabilities attributed to T3.

### Capabilities that are separate work

T3's full MCP Apps hosting PR 16236 was still open at the fresh check. The shipped theme and link bridge uses some MCP Apps message names, but that should not be confused with a complete host for arbitrary third-party application tool calls. Nectovia can preserve a compatible message boundary while evaluating full application hosting separately. [R18, R19]

The preview browser's isolation and public-network handling are distinct from the client iframe's resource policy. Nectovia must apply its own source grants and network restrictions to each environment. It should not inherit a policy that permits public access merely because generated HTML requests it.

T3 Code's repository is MIT licensed. If implementation copies licensed code, preserve the applicable copyright and license notice and record the exact source revision. Conceptual inspiration does not require transplanting the T3 application architecture or introducing its runtime dependencies. [R20]

## 4 Nectovia capability audit

### Structured visuals and rendering

The current `visual` format is provider independent and strictly validated. It supports bar, line, area, pie, stat, table, progress, and app forms. Its existing limits include 32 KiB per block, eight visuals per reply, eight series, two hundred points, twelve pie slices, six stat values, twelve table columns, and fifty table rows. The app variants currently accept host-backed keys such as `update-progress` and `run-status`; the model cannot supply arbitrary live-state values. Preserve these existing contracts unless a versioned change explicitly extends them. [R21]

The renderer uses custom SVG and already includes useful foundations: accessible summaries, underlying data tables, theme handling, and reduced-motion support. The charts do not yet provide the proposed point inspection, series selection, filtering, zoom, or drilldown. Current horizontal positions are categorical or index-based, so a true continuous time axis is a meaningful addition. Filled area output is not the same as stacked area output. [R22]

The artifact panel uses the same visual renderer. Its deterministic Chart this action can build a chart from a numeric table column without another model call. That is a useful precedent for immediate local behavior. [R23]

### Identity and persistence

Artifacts are derived from durable turn or file content through the existing artifact system. Several markup forms support declared identities and versions. Structured visuals currently lack a declared identity, so a changed visual becomes a separate artifact rather than a revision of a stable report. The proposed identity extension should remain within the existing artifact lifecycle. [R24]

The pinned-chart logic chooses the newest eligible assistant bar, line, or area chart and retains a snapshot. Its activity display is not evidence of live data refresh. The proposed behavior should pin a particular artifact identity and label the data freshness explicitly. [R25]

Artifact saving already uses the document and Files write path, conflict checks, and history. Artifact evidence records source hashes and can indicate changes after recording. A hash proves byte identity; it does not independently prove that an aggregation or business conclusion is correct. Source-row and transformation provenance must be added where reports claim source-backed numerical results. [R26, R27]

### Execution and authority

Current model-authored markup is rendered without scripts or network access. The artifact-frame source documents an earlier WebRTC/STUN observation that motivated the scriptless boundary despite CSP. This is a recorded reason for the present restriction, not a newly reproduced vulnerability in current source. Interactive generated HTML requires a separately qualified execution boundary. [R28]

The existing tool registry owns tool names, schemas, effect classification, permission and approval behavior, limits, targets, and costs. Its name grammar supports names such as `visual_preview` and `visual_present`; dotted names are not valid in the inspected registry. Current durable controls and Work views already reflect authoritative application records. A visual should request actions through those mechanisms. [R29, R30]

Completed valid visual blocks can appear during a streaming response, while durable artifact actions wait for recorded content. Preserve that responsiveness while ensuring incomplete markup or partially received scripts never execute. Agent-format changes must retain instruction-digest compatibility and the separate Build/Fix response contract. [R31, R32]

### Actual file and service preview baseline

The connected-workspace direction adds concrete missing capabilities. Current file preview behavior must not be mistaken for full document rendering. [R41, R42]

| Current surface | Verified behavior |
| --- | --- |
| Pictures and CSV or TSV | Real image or tabular previews are available |
| PDF | Metadata only; instructs the user to open externally; no in-app page viewer or shell handoff |
| XLSX | First-sheet saved values; no formula recalculation or date formatting; other sheets are named only |
| DOCX and PPTX | Not supported import or preview kinds in the inspected file-drop path |
| Text document editing | Existing main-stage DocumentEditor with draft recovery and conflict handling |
| File identity | History-derived path, SHA, version ID, and entry ID; references do not follow renames |

The Files side pane is a reader; the main-stage editor owns text writing through the existing document-write endpoint and base-SHA check. Bind review actions to scope, project, path, SHA, and available history identifiers. Moving a file creates a new path while old references can resolve retained bytes; a new logical report ID must not silently change this historical behavior. [R43, R44]

Current desktop connection wiring includes synthetic Toast and compiler demonstrations. The inspected MCP read path extracts text from owner-approved tools rather than supplying rich plugin views. The native Codex configuration disables browser and computer-use tools. These observations do not establish that Nectovia has a live POS editor or a controlled service browser today. Those capabilities need separate integration and qualification. [R45, R46, R47]

## 5 Proactive visualization policy

### Default behavior

The business-focused agent should actively consider a visual whenever it is answering an analytical or operational question. If a visual materially improves comparison, diagnosis, spatial understanding, scheduling, explanation of relationships, or safe exploration of alternatives, it should produce one using available authorized evidence. It should not ask whether the user wants a chart when that presentation choice is routine and reversible.

Proactive presentation is part of answering an authorized request or reporting an already-authorized workflow. Selection should occur within the existing answer pass, without a separate model classifier by default. Normal generation uses the admitted task and model budget; it does not expand that budget or change the route or payer. It also does not authorize background polling, new scheduled work, expanded data collection, or an external action. Existing work admission and grants continue to govern those operations.

The policy should be layered. A compact general instruction teaches the agent to notice useful opportunities. Task and capability instructions supply domain-specific examples and source requirements. A host validator checks capabilities, data references, allowed controls, limits, and action authority. Evaluation measures whether the visual was useful and correct. Prompt wording alone is not an enforcement mechanism.

### When to produce a visual automatically

Produce a visual when one or more of the following conditions are central to the user's task and the necessary data is available:

- Comparing several items across a meaningful measure, especially when the ranking, spread, or exceptions are difficult to scan in prose.
- Explaining change over time, seasonality, a shift in composition, or a difference between periods.
- Finding shortages, capacity constraints, overdue work, outliers, or conflicting records.
- Understanding schedules, dependencies, location, workflow, or resource allocation.
- Testing assumptions or comparing alternatives where local controls reduce repeated conversation turns.
- Reviewing an interface, document layout, or workflow design that is easier to evaluate by seeing and operating it.
- Reporting a material change in an already-existing report, where a new revision makes the change easier to understand.

These are decision rules rather than a mandate to create a chart for every collection of numbers. The visual must answer the question and expose the relevant evidence. A larger number of panels is not a quality measure.

### When prose or a table is better

Use a concise answer for a single fact, a simple confirmation, a one-step instruction, or a result whose relationship is already obvious. Use a table for exact mappings, a short set of records, or a comparison in which every field must remain visible at once. Explicit text-only and table-only requests take precedence.

Do not create an analytical chart from incomplete data if its appearance would imply complete coverage. State the missing source or restricted scope. If partial data still supports a useful visual, show the scope and unknowns directly and avoid unsupported totals or rankings. Fictional demonstrations and scenario assumptions must be visibly labeled.

Avoid decorative dashboards, invented health scores, filler metrics, and a second chart that communicates the same relationship without adding information. Avoid re-rendering an unchanged report because the agent produced another message. Preserve one report identity and update it when there is a meaningful new revision.

### Preferences and cadence

Recommend an Auto default with a user preference to favor concise text. A specific request for a visual overrides the normal presentation preference when supported and safe. Persist an explicit preference at the personal or project scope the user identifies; a correction for this answer is temporary. Do not silently turn one person's behavior into an organization-wide preference. Do not add a maze of visualization settings before the core experience is useful. Accessibility preferences and the user's active theme apply to every report.

Within a turn, prefer one coherent report with a dominant visual and only the supporting views required by the question. The existing eight-visual limit remains a compatibility ceiling, not a target. During long work, update at material milestones, completion, a decision point, or a confirmed change in the underlying dataset. Do not stream a growing sequence of almost-identical charts.

Reusable report patterns can be learned through the existing skill and capability lifecycle after evaluation. A successful visualization can suggest a reusable pattern; it does not grant permission to record unrestricted source data, promote an unreviewed skill, or train on a customer's records.

### Presentation instruction to adapt into the harness

For business analysis and operational work, proactively choose a visual when it helps the user compare, diagnose, plan, or decide. Use the smallest useful report and actual authorized source data. Prefer validated native components for ordinary charts, tables, timelines, and scenarios. Keep view changes local where possible. State the snapshot time, scope, units, assumptions, and important unknowns. Inspect the preview and primary interactions before presenting the checked revision. Connect relevant selections to existing authorized tools. Use concise prose or a table when those communicate the answer more clearly. Do not invent data, create unnecessary panels, or ask permission for routine presentation choices.

This policy is an implementation starting point. Its placement and examples should be adapted to the existing answer-format and capability architecture, with versioned instruction fixtures and regression cases. It should not be pasted into every turn as a large repeated instruction block.

## 6 Report architecture and data flow

### One artifact system with two renderers

Use the existing artifact system as the common lifecycle for two rendering paths. Native reports consume validated specifications and host-owned data. Generated interfaces consume immutable HTML and asset revisions through an isolated execution surface. Both should share identity, source references, preview evidence, history, export behavior, and the action bridge where supported.

The native report is the default for common business questions. It offers consistent behavior, predictable limits, accessibility, and deterministic numeric output. Generated interfaces are appropriate when the question needs an interaction that the native vocabulary cannot express. A stronger model can create an unusual interface without making that model a prerequisite for ordinary reports.

### Proposed contract boundaries

The following are proposed logical records, not claims that these types already exist. Resolve their exact module placement and reuse equivalent types during the source-reconciliation work item.

| Record | Responsibility |
| --- | --- |
| Visual artifact identity | Stable identity within account, workspace, project, and artifact scope |
| Visual revision | Immutable specification or document, data snapshot references, assets, renderer version, and content digest |
| Dataset result reference | Host-minted reference to an authorized query result with schema, units, coverage, and provenance |
| Viewer state | Local filters, selected rows, range, expanded detail, and temporary scenario inputs |
| Preview receipt | The exact revision digest, viewer build, checks performed, results, and preview reference |
| Visual action intent | Declared action, artifact revision, selected record references, parameters, and idempotency key |

Neither an artifact ID nor a query ID is a permission grant. Resolve them under the current principal and scope. Bind caches and asynchronous responses to the same scope. Switching business or account, revocation, or a stale response must not reveal data from the previous context.

The model-facing report should remain compact. A typed specification can reference a result, choose approved fields, request a supported layout, and declare allowed controls. It must not accept arbitrary source URLs, scripts, executable chart formatters, or raw database expressions through a configuration field.

### Host calculations and source coverage

The host should perform supported joins, filtering, grouping, arithmetic, and reconciliation over structured data. Validate field existence, type, units, cardinality, and permitted operations before calculation. Preserve nulls, unavailable sources, duplicate identifiers, and partial coverage as explicit states.

Separate an observed value from a scenario input and a derived result. In the illustrative parts scenario, assume available stock is on-hand stock minus reservations and scenario demand is fixed daily demand multiplied by the chosen workday window. Production reports must use the owner-approved source mappings and business definitions. Shortages are calculated per part before being aggregated, so excess stock for one part cannot offset a different part's shortage.

Every displayed number should be traceable to the relevant result and transform. A drilldown should identify the records or bounded source evidence used, subject to current permissions. DIO-140's prohibition on raw rows entering model context remains intact: authorized UI inspection of a bounded result is not the same as sending those rows to the model.

Avoid pretending that top-k retrieval is an exhaustive scan. An all-record reconciliation needs a known snapshot or honest observation interval, row counts, completed partitions or cursors, duplicate handling, and a deterministic reducer. Use the existing data and coverage contracts where available. The visualization reports the completeness of that calculation; it cannot repair missing source coverage by adding a confidence badge.

### Snapshot scenario and live behavior

A snapshot is an immutable recorded view of a particular data state. A scenario is a calculation using stated temporary assumptions. A live view is connected to changing source data through a host-owned subscription or refresh process. Show the applicable state and timestamp.

Refreshing creates a new data snapshot and report revision. Historical answers remain inspectable. DIO-140's proposal to rerun a saved dashboard on reopen should be reconciled as an explicit refresh behavior that preserves the previous revision, rechecks authorization, and records the new result. Reopening should not silently rewrite a past answer.

Keep viewer state separate from revision history. Selecting a series or opening a detail should not create a shared content revision. Saving a scenario as an explicit new report is a distinct operation. If a shared report later supports collaborative view state, define its ownership and conflict rules independently.

## 7 Graph and interaction design

Native reports should follow Nectovia's existing theme runtime and approved component design. The first increment should improve point inspection, touch selection, series toggling, table sorting, filtering, and source drilldown. Add true time axes and comparison ranges where the data is temporal. Use stacked charts for composition, heatmaps for patterns across two categorical or temporal dimensions, and waterfalls for contributions to a change.

Timelines and dependency graphs should use existing task and run identities when they represent work. A chart of a workflow should not become a second scheduler or a new source of task status. Dense force-directed graphs should be reserved for a relationship question that actually benefits from them.

Recommend evaluating one packaged Apache ECharts adapter behind the validated native schema. Its documented event model, reusable datasets, and SVG and Canvas support fit the proposed needs. Keep the existing simple SVG renderer where it remains appropriate. Verify dependency fit, license, bundle size, accessibility, and measured performance in the application before committing to the adapter. This is a candidate implementation choice, not an assertion that T3 uses ECharts. [R33, R34, R35]

Use clear units and date boundaries, stable colors, direct labels, and restrained grid lines. Show denominators for rates and percentages. Preserve ordering where it has meaning. For dense plots, aggregate or downsample using an explicit rule and make the detailed data available where authorized. A visual approximation must not replace exact values in a decision that depends on them.

Controls should use the same selection state across metrics, charts, and detail. Touch users must be able to inspect values without hover. Keyboard users need an intelligible route through the controls and a textual alternative. Motion should clarify state changes, honor reduced motion, and avoid looping activity effects that imply data freshness.

### Cross-industry examples

| Question | Useful visual | Relevant next action |
| --- | --- | --- |
| Which parts will prevent next week's builds | Shortage chart with a demand scenario and source drilldown | Prepare a transfer or purchasing task |
| Which crews are over capacity | Resource timeline and conflict detail | Propose a schedule adjustment |
| Why did food cost change | Category variance and purchasing comparison | Inspect supplier or recipe changes |
| Which locations need stock | Location and item comparison | Prepare an authorized replenishment |
| Which properties have unresolved maintenance | Aging and workload view | Create or route existing work orders |
| Where are appointments leaving gaps | Availability timeline and demand distribution | Propose revised staffing or booking rules |
| Which project dependencies are delaying delivery | Task dependency view tied to current records | Open or update the responsible task |
| Which interface option should we build | Interactive alternatives tied to exact revisions | Start the existing build workflow with the selected option |

These are proposed workflow examples, not claims that the connectors or actions are already installed. Their shared requirement is a useful connection between evidence, selection, and authorized work.

## 8 A connected workspace for creating and reviewing work

### Product direction

Nectovia should let the user stay with the work while the agent moves between the necessary tools and services. A conversation identifies the goal and carries decisions. An artifact or connected view shows the current result. Existing task and run records explain what is happening. Source links, revisions, and receipts make the result inspectable. The user should be able to move from an overview to a detailed review without losing the conversation or opening a collection of unrelated windows.

This direction includes documents, interfaces, diagrams, spreadsheets, schedules, images, service configurations, and work results. A restaurant menu booklet is one document example. A construction proposal, retail catalog, maintenance schedule, client presentation, or software interface needs the same create, inspect, revise, and deliver loop. The product should share that loop across industries instead of implementing a separate miniature application for every business category.

Proactivity should extend to created work. When the agent creates or materially revises a visual deliverable, it should offer the relevant in-app preview as part of its answer. A person requesting a menu redesign should see the booklet pages; a person requesting a proposed POS organization should see the proposed organization. The agent should choose the preview format that represents the output faithfully, with the relevant revision and action state visible.

### Distinguish what the user is looking at

| Preview type | What it represents | Appropriate claim |
| --- | --- | --- |
| Rendered file | Pages or frames rendered from the exact saved document, presentation, PDF, image, or other artifact revision | This is the rendered output for this file revision |
| Structured proposal | A host-rendered view of proposed records or configuration changes, with source IDs and a change set | This is the proposed change before application |
| Generated mockup | An interactive explanation or design exploration authored for review | This is a mockup, with stated assumptions and limitations |
| Connected service view | A currently authorized source-backed view supplied through a supported integration | This reflects the connected source at the shown time |
| Controlled computer view | A qualified browser or desktop session showing the application being operated | This is the observed application state in this session |

These types can look equally polished, but they support different conclusions. A generated mockup is not evidence of the current POS layout. A rendered PDF page is evidence of that PDF's appearance, not proof that every printer will reproduce it identically. A connected view can become stale. A controlled computer session should show its target and action status. These distinctions should be clear in product language without exposing irrelevant internal plumbing.

### Example of a document creation loop

An owner asks for a reorganized menu booklet. The agent retrieves authorized menu data and approved brand assets, preserves source facts such as item names and prices, and creates a real document artifact. The app renders the saved revision into page previews. The owner can inspect page order, zoom into text, select a section, and ask for a change while the conversation remains available.

The next revision is created through the existing document and Files path. A comparison can show what changed, and the preview receipt identifies the version actually inspected. Export or delivery uses that same revision. If the user changes a price after the preview, the file receives a new revision and any approval or preview claim tied to the earlier version remains attached to that earlier version.

The same flow applies to a proposal, booklet, invoice layout, training guide, slide deck, or product catalog. Native editing capabilities should be introduced where they help common workflows, while the agent remains able to perform deeper changes through the appropriate authoring tools. A generic app need not duplicate every feature of a dedicated document editor to provide a useful review and revision experience.

### Example of a connected configuration loop

A user asks to reorganize an operational interface such as a POS menu, CRM pipeline, product catalog, or scheduling setup. The agent reads the supported source configuration and its stable identifiers. It proposes a change set and displays the organization as a structured proposal. The user can inspect categories, ordering, associations, and affected items in the app.

Applying the proposal requires a supported write path, current source authority, and the relevant authorization. The host rechecks that the source has not changed incompatibly and submits the exact reviewed change set through the existing tool. It then reads back the service result and records what was applied. Unsupported operations remain visible as unsupported; a convincing mockup must not imply that a connector can apply changes it cannot perform.

This distinction lets Nectovia provide value before every connector has complete visual embedding or write support. It can show an accurate proposal, prepare an export where supported, or operate a qualified application session. Each path should identify its fidelity and authority honestly.

### Workspace composition

Begin with inline previews and the existing expanded artifact panel. Keep the conversation available while an artifact is enlarged, inspected, compared, or pinned. Support a small number of relevant working objects associated with the current task rather than opening a new permanent dashboard for every output. Navigation should retain artifact revision, selection, source context, and current task. Compose this behavior with the approved wide-window and multitask design, including its panel fit and single-instance rules. Files retains browsing and reference duties; the existing main stage hosts editing without discarding unsaved work. [R43, R48]

The common commands should reflect user intent: inspect, compare, revise, refresh, export, and apply where supported. Their implementation can differ by artifact type, but their connection to source and history should be consistent. An action should receive structured context such as a page, field, record, selected option, or revision, rather than the entire generated interface as a new instruction.

Over time, capability packs can supply specialized viewers and actions through a controlled contract. The host should own scope, lifecycle, available actions, accessibility requirements, and evidence. Plugin content should not receive ambient access to the desktop or every connected account. Full MCP Apps hosting remains an optional interoperability layer, not a replacement for native artifact or tool authority. [R37]

### Practical boundary

The goal is to remove unnecessary switching during the common workflow. Embedding permissions, authentication, service APIs, desktop behavior, and vendor-supported operations need to be checked for each integration. Electron iframes retain browser embedding restrictions; its main-process-controlled WebContentsView is a candidate for a separately qualified browser surface. Google prohibits OAuth authorization through developer-controlled embedded user agents, and Microsoft Entra blocks interactive authentication in iframes. Support the required system-browser or popup login and return the person to the same task. [R49, R50, R51, R52]

The next workspace milestone after the native-report foundation should prove a genuine file-preview and revision loop, followed by a source-backed structured proposal. Broader live-service views and controlled computer surfaces should follow qualified integration paths. Existing ART-01 through ART-06 already describe document work, data, artifact review, browser verification, visual deliverables, and brokered panels; this direction refines their sequence and interfaces. It does not create another broad platform owner. [R05]

## 9 Preview presentation and exact revision guarantees

Introduce `visual_preview` and `visual_present` through the existing tool registry, or extend a current equivalent discovered during reconciliation. Treat the names as proposed until that check is complete. The same canonical validation should support the current fenced format for model routes without the new tool path.

The preview request should resolve an immutable visual or file revision under the current scope. It should include the renderer capability and the checks appropriate to that output. The response should return a compact receipt identifying the revision digest, renderer build, asset and data dependencies, preview reference, diagnostics, and checks actually performed. Large documents and datasets remain in the existing artifact or Files storage path.

For a native report, check schema validity, numerical invariants, source coverage, and important controls. For generated HTML, check script diagnostics, resource policy, content sizing, and the primary interactions. For a document, render the exact output and inspect the relevant pages. The preview result should state which checks were unavailable rather than substituting a successful image creation for behavioral verification.

Presentation should reference the checked revision and receipt. It should not accept changed content under the same successful receipt. If any specification, data snapshot, asset, renderer dependency, or file byte changes, create a new revision and digest that needs its own receipt. The earlier receipt remains evidence for the exact historical revision it checked. This is also the basis for binding an approval or apply action to the work the user actually reviewed.

Use idempotency across tool retries, delivery retries, and the transition from streamed content to durable artifacts. A repeated request for the same artifact revision should not produce duplicate cards or duplicate actions. A model emitting both a fence and a presentation tool result should resolve to one canonical artifact when they identify the same revision.

Preview the actual client environment and supported layouts. Include narrow layouts, zoom, text scaling, keyboard focus, touch detail, and content resizing after fonts or charts load. Avoid nested scroll traps, clipped labels, and viewport-height assumptions. Unsupported clients should receive a readable static representation or data table with an honest capability notice.

### Bounded correction

Use a proposed default of an initial preview plus at most one automatic correction attempt within the already-admitted task budget. This is an implementation starting value to evaluate, not a measured optimum. Stop early once the required checks pass. If the attempt or cost budget is exhausted, retain a useful validated fallback and identify the unverified portion. Source queries and host computation can still consume resources; zero model calls for local controls does not imply that every refresh is cost-free.

Do not automatically invoke a larger model or a paid browser service merely to improve decorative quality. The existing route, privacy, funding, and task budget govern any escalation. Local view changes and deterministic redraws should not trigger inference. Long-running preview work should support the current cancel and timeout mechanisms.

## 10 Execution isolation and action authority

Keep native report components as the first interactive path. They can provide substantial interaction through app-owned code without granting execution to model-authored markup. Generated interfaces require a separate execution surface whose operating-system, process, network, storage, and native-bridge boundaries have been verified on each supported platform.

Retain Electron's existing context isolation, disabled Node integration, process sandboxing, permission handling, and navigation restrictions. Restrict IPC to known message schemas and validate the sending surface. CSP is an additional control, not proof of complete network isolation. The source-documented WebRTC/STUN experience is a concrete reason to verify egress independently. [R28, R36]

Package approved chart and interface dependencies where practical. Resolve permitted assets through host-owned references, with size and type validation. Do not give generated content account tokens, unrestricted authenticated fetch, filesystem paths with broad read access, or a generic native method dispatcher. An external-resource requirement should follow the existing source and network policy.

The action bridge should accept a closed intent with an action key, immutable artifact revision, selected record or option references, validated parameters, and an idempotency key. The host resolves the actual tool and checks current membership, source access, target, effect class, and standing authorization. Text inside an artifact is data; it is not a new instruction channel with the user's authority.

Presentation controls and business actions should remain distinct. Sorting a table, changing a local scenario, or selecting an option can be immediate. Updating a service, changing a schedule, writing a file, or sending a message uses the same authorization that would apply to the equivalent request in conversation. Existing standing grants should apply without a redundant visualization-specific approval step.

Before applying a reviewed change, recheck the relevant source version and content digest. Detect stale proposals and concurrent edits. Provide an understandable conflict state and create a revised proposal when necessary. A successful click animation is not completion evidence; completion comes from the existing tool result, durable receipt, and relevant readback.

Export has its own contract. An HTML file opened outside Nectovia does not automatically retain the in-app sandbox. Choose a safe static export where appropriate or explicitly identify executable exports and their dependencies. Recheck export permissions for sensitive source-derived artifacts and preserve provenance without embedding unnecessary source records or credentials.

## 11 Models context budgets and operations

The harness should expose the same report and action contracts across eligible models and engines. A small local model can select an approved report pattern and refer to a host result. A larger model can handle more complex interpretation or bespoke interface design when the task and route permit it. Provider-specific tool or rendering support should be handled in adapters and capability negotiation.

Keep renderer capabilities separate from model capabilities. A model may support tool calls while the current client cannot execute HTML. A client may render a typed report even when the model route uses a validated text fence. Decide the available presentation path from both sides, with a readable fallback.

Avoid repeating a large HTML document or dataset in every model turn. Keep compact artifact references, revision summaries, source handles, and relevant selection context. Retrieval of a visual's content or evidence should be deliberate and scoped. A previously generated chart is not independent evidence for a later factual claim; follow its source references and current validity.

Use existing task, usage, and error reporting for preview work. Recommended events include presentation chosen or declined, reason category, rendering mode, preview outcome, correction count, local control use, source inspection, revision refresh, and action outcome. Record latency and attributable cost. Avoid recording raw business rows, rendered private text, or full screenshots in broad analytics by default.

Compare usefulness against a text or static baseline on the same tasks. More visuals, more clicks, or longer engagement are not sufficient success measures. Measure whether users identify the correct issue, make the intended decision, require fewer clarification turns, and reach an accurate completed result.

Roll out native reports behind the existing feature and release controls, with configuration appropriate to the supported client and account. Qualify generated-interface execution separately. Disable a failing renderer without losing the underlying artifact, history, or plain answer. A renderer failure should not silently mark the overall business action complete.

## 12 Evaluation and acceptance

Evaluation needs two layers: deterministic correctness and behavioral usefulness. Deterministic fixtures establish whether calculations, references, revisions, permissions, and actions behave correctly. Model evaluations establish whether the agent chooses a helpful presentation and explains its limits. Human review assesses legibility and whether the visual supports the task.

The acceptance matrix should include both opportunities where the agent ought to visualize and cases where it ought to stay concise. Otherwise a system can appear proactive simply by adding unnecessary charts everywhere. Preserve held-out tasks and use the same input sources, model routes, and budgets when comparing alternatives.

Measure false-positive visualization rate as unnecessary proactive visuals on adjudicated no-visual cases divided by all adjudicated no-visual cases. Also measure the unnecessary share of all proactive visuals, missed required-visual opportunities, and redundant new visuals on unchanged follow-ups. Report numerator, denominator, uncertainty, and domain and model-route slices. Choose numerical rollout thresholds after a representative baseline and review of label agreement; an average usefulness score cannot excuse source fabrication, data exposure, false freshness, or unauthorized action.

Hard negative examples include just this invoice total, an explicitly requested exact table, an unchanged follow-up, a missing denominator, an invented forecast interval, and a source whose visual layout is unavailable. The last should produce a clearly labeled proposal or a limitation, never a fabricated service capture. Include a file rename or move between preview and export because current file references do not follow moves.

### Required evaluation groups

| Group | Required evidence |
| --- | --- |
| Proactive selection | Useful visuals for comparisons, trends, bottlenecks, scenarios, and created outputs; concise handling of single facts and text-only requests |
| Data integrity | Independent-reference totals, null handling, compatible units, correct denominators, time-zone boundaries, duplicate keys, and explicit partial coverage |
| Report interaction | Shared selection state, local filter and scenario behavior, correct drilldown, zero model calls for presentation-only controls |
| Artifact continuity | Stable IDs, immutable revisions, personal view state, meaningful refresh, restart persistence, and retry deduplication |
| Preview fidelity | Exact file or visual revision, invalidated receipts after changes, honest mock and proposal labels, layout and interaction checks |
| Permissions and actions | Cross-tenant and stale-reference refusal, revocation, current source checks, standing-grant behavior, conflict handling, and durable receipts |
| Platform and accessibility | Supported desktop platforms, narrow client layouts, text scale, contrast, keyboard, touch, reduced motion, and readable fallbacks |
| Cost and usefulness | Bounded correction, cancellation, measured latency and cost, fewer unnecessary clarification turns, and correct task outcomes |

Include DIO-140's large synthetic inventory fixture under its existing owner. For generic reports, use small independent fixtures where expected values can be inspected easily. Include a case where stock surplus for one SKU must not offset another SKU's shortage and a missing source that prevents a complete total. A source correction should produce a new report revision and mark the earlier result as superseded for current use, while retaining its original captured data, provenance, and preview evidence.

For document previews, verify that a changed page is reflected in the new rendered file and that export uses the reviewed revision. For service proposals, test a stale source version, unsupported write capability, repeated application request, and post-apply readback. For generated interfaces, test forbidden resource access and a forged host action independently of visual appearance.

Report passed, failed, skipped, and unrun checks accurately, with the source and artifact revision used. Existing defects or known demonstrations are regression material, not fresh held-out evidence. Paid model evaluations need an admitted budget; local deterministic checks can proceed without that expenditure.

## 13 Delivery sequence

The implementation plan supplies exact ownership, interfaces, and verification steps for the work items. The sequence should produce usable outcomes before the broad connected-workspace vision is complete.

1. Reconcile current source, work ownership, instruction versions, approved design, and available renderer capabilities.
2. Extend artifact identity and report contracts while preserving existing valid visuals and host-only app data rules.
3. Connect authorized host results and deterministic transforms to native reports, composing with DIO-140 for inventory.
4. Add the first useful interactions and chart improvements in the approved Console design.
5. Add proactive selection policy, preferences, compact guidance, and positive and negative evaluation cases.
6. Add exact-revision preview and presentation receipts, bounded corrections, and retry deduplication.
7. Connect selections to existing work actions, with current authority and conflict handling.
8. Complete pinning, refresh, history, and relevant export behavior.
9. Prove a real-file preview and revision loop in the existing artifact panel, plus a structured connected-service proposal.
10. Apply model, accessibility, platform, security, and usefulness evaluations to each supported capability; use existing release controls to deliver native reports and subsequent file-preview capabilities as their own gates pass.
11. Separately qualify isolated generated interfaces and their host bridge on supported platforms. This branch does not gate the native release.

The first useful release should demonstrate a source-backed interactive report with inspectable provenance and stable revisions. Actual-file previews, executable HTML, additional external services, and a full MCP Apps host each retain their own acceptance gates; they do not delay that native foundation. The first complete file milestone must demonstrate a genuine create, render, revise, and review loop. The current Board and Runtime continue to own execution throughout.

## 14 Decisions to resolve during implementation

Several choices have enough direction for work to begin but require current evidence before commitment.

**Chart adapter.** Evaluate the packaged ECharts approach against current bundle, renderer, and accessibility needs. Keep the model-facing contract independent of that choice.

**Inventory storage and query integration.** Reconcile DIO-140's dataset location, engine, approved mappings, source order, and existing implementation before adding a shared data adapter. Do not silently select a new storage subsystem through the visualization feature.

**Commercial scope.** The generic presentation capability should follow current Personal and Business rules. DIO-140's older Business-only question remains a commercial decision until current product authority resolves it. Proactive rendering does not change Agent entitlement or inference funding.

**Execution isolation.** Select and qualify the concrete generated-interface runtime for each supported platform. A functioning iframe or successful CSP check does not close this decision.

**External service fidelity.** Each integration should state whether it supports a read-backed proposal, actual embedded service, controlled application view, export, and direct application of changes. Do not promise universal embedding or write access.

**Evaluation budget.** Use local fixtures first. A model bake-off, paid preview service, or production-data trial needs its own admitted budget and source scope. No cost or performance advantage is claimed before measurement.

## 15 Astra implementation prompts

The accompanying prompt pack adapts current official Astra guidance to this repository. The guidance favors clear outcomes and relevant context, explicit follow-through expectations, selective delegation, and verification tied to actual risk. The package applies those principles through a concise kickoff and focused continuation, worker, and review prompts. It does not rely on a provider-specific reasoning ritual or a request for hidden chain-of-thought. [R38, R39, R40]

The lead prompt directs the implementer to reconcile current repository instructions, active claims, task ownership, source versions, and this package, then begin the first eligible implementation slice. It keeps existing decisions and architecture intact, continues independent work when a dependent decision is blocked, and requires an accurate final account of what was changed and tested.

Use the implementation prompt in a session where implementation is intended. Its instruction to begin work is distinct from this report-publication task. The implementer should honor the actual session's authorization for commits, pushes, merge, deployment, paid calls, and external effects, while avoiding repeated requests for already-authorized routine work.

## 16 Completion and evidence boundaries

Completion of this research package means the report, implementation plan, prompts, source references, and evaluation requirements are available in the requested destinations. Product completion requires the implementation and acceptance evidence described above. A documentation pull request or a completed mockup does not close the feature.

The earlier in-conversation parts concept uses fictional data. Its calculations and local control-state behavior were checked across three scenarios and four parts. Browser pixel layout and actual pointer or touch behavior were not verified because no working browser executable was available. It is a design aid, not proof of current product behavior.

The recommended direction is a coherent connected workspace: the agent understands the goal, the app shows the work faithfully, the user can inspect and revise it in context, and existing tools perform authorized actions with durable evidence. Proactive visual reports and artifact previews are the first concrete implementation of that direction.

## 17 Source references

Sources were inspected on 7 October 2026. Repository references are pinned to the audited source revisions. The companion source catalog records each source’s evidence limits, canonical document versions, and supplied-file hashes. Publication does not establish application implementation or release.

**R01 — Nectovia application baseline.** [Pinned commit bae249b60ffafa3934d775c6d59fbac80990a83e](https://github.com/andrewgodowsky-aoa/diomedes/commit/bae249b60ffafa3934d775c6d59fbac80990a83e)

**R02 — T3 Code implementation baseline.** [Pinned tree 10f39eb9ac80c9a4b7f5097575dd2addc3b6f631](https://github.com/pingdotgg/t3code/tree/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631)

**R03 — Canonical live roadmap.** [Nectovia Live Roadmap](https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit)

**R04 — Canonical Core Pillars.** [Nectovia Core Pillars](https://docs.google.com/document/d/1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4/edit)

**R05 — Feature briefs, including ART-05.** [80 individual feature research and build briefs](https://drive.google.com/file/d/1AEGUH0F3-k5S5Vu5u15pDjDrm7mCFeao/view)

**R06 — Existing inventory work owner.** [DIO-140 — Inventory live dashboard: trusted query binding on inline visuals](https://linear.app/diomedesdevs/issue/DIO-140/inventory-live-dashboard-trusted-query-binding-on-inline-visuals)

**R07 — Reskin work owner.** [DIO-252 — App-wide reskin](https://linear.app/diomedesdevs/issue/DIO-252/app-wide-reskin-bring-every-remaining-screen-to-the-round-2-design-so)

**R08 — Pinned-chart design owner.** [DIO-265 — Every screen boards: pinned chart and empty Home](https://linear.app/diomedesdevs/issue/DIO-265/every-screen-boards-row-22-the-pinned-chart-the-empty-home-and-the)

**R09 — Business appearance authoring direction.** [DIO-259 — Design Center moves to Operations](https://linear.app/diomedesdevs/issue/DIO-259/design-center-moves-to-operations-staff-make-each-businesss-look-the)

**R10 — T3 HTML replies merge.** [T3 PR #15968](https://github.com/pingdotgg/t3code/pull/15968)

**R11 — First containing T3 release verified.** [v0.0.46-nightly.20261005.2702](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261005.2702)

**R12 — T3 HTML tool contract and handlers.** [apps/server/src/mcp/toolkits/html/tools.ts](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/apps/server/src/mcp/toolkits/html/tools.ts); [apps/server/src/mcp/toolkits/html/handlers.ts](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/apps/server/src/mcp/toolkits/html/handlers.ts)

**R13 — T3 rendering guide and shared HTML support.** [packages/shared/src/htmlRender.ts](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/packages/shared/src/htmlRender.ts)

**R14 — T3 agent instructions.** [apps/server/src/provider/T3OrchestrationInstructions.ts](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/apps/server/src/provider/T3OrchestrationInstructions.ts)

**R15 — T3 client document frame.** [apps/web/src/components/files/BrowserDocumentFrame.tsx](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/apps/web/src/components/files/BrowserDocumentFrame.tsx)

**R16 — T3 user documentation for HTML renders.** [docs/user/html-renders.md](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/docs/user/html-renders.md)

**R17 — T3 sizing correction.** [T3 PR #16283](https://github.com/pingdotgg/t3code/pull/16283)

**R18 — T3 full MCP Apps hosting proposal.** [T3 PR #16236](https://github.com/pingdotgg/t3code/pull/16236)

**R19 — T3 MCP Apps bridge naming change.** [T3 PR #16196](https://github.com/pingdotgg/t3code/pull/16196)

**R20 — T3 license.** [LICENSE](https://github.com/pingdotgg/t3code/blob/10f39eb9ac80c9a4b7f5097575dd2addc3b6f631/LICENSE)

**R21 — Nectovia visual protocol.** [shared/visual-spec.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/visual-spec.ts#L1-L35)

**R22 — Native visual renderer.** [client/console/InlineVisual.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/InlineVisual.tsx)

**R23 — Shared artifact panel.** [client/console/ArtifactPane.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/ArtifactPane.tsx#L328-L421)

**R24 — Artifact parsing, indexing and identity.** [shared/artifacts.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/artifacts.ts)

**R25 — Pinned chart selection.** [client/console/pinned-chart.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/pinned-chart.ts)

**R26 — Artifact save path.** [client/console/artifact-save.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/artifact-save.ts)

**R27 — Artifact output evidence.** [client/console/artifact-evidence.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/artifact-evidence.ts); [server/harness/artifact-steps.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/harness/artifact-steps.ts)

**R28 — Static artifact execution boundary.** [client/console/artifact-frame.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/artifact-frame.ts#L1-L40)

**R29 — Existing tool registry.** [server/harness/tools.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/harness/tools.ts)

**R30 — Existing controls and Work projection.** [server/durable-controls.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/durable-controls.ts); [client/console/work-view.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/work-view.ts)

**R31 — Turn rendering and streaming behavior.** [client/console/TurnBody.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/TurnBody.tsx)

**R32 — Answer-format and visual instruction seams.** [server/answer-format.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/answer-format.ts); [server/modes.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/modes.ts#L21-L35); [server/instruction-digests.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/instruction-digests.ts); [server/lineage-continuity.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/lineage-continuity.ts)

**R33 — Apache ECharts events.** [Event and Action](https://echarts.apache.org/handbook/en/concepts/event/)

**R34 — Apache ECharts datasets.** [Dataset](https://echarts.apache.org/handbook/en/concepts/dataset/)

**R35 — Apache ECharts rendering options.** [Canvas vs. SVG](https://echarts.apache.org/handbook/en/best-practices/canvas-vs-svg/)

**R36 — Electron security guidance.** [Security](https://www.electronjs.org/docs/latest/tutorial/security/)

**R37 — MCP Apps primary documentation.** [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)

**R38 — Official GPT-6 Astra guidance.** [Using GPT-6 — Astra prompting best practices](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices)

**R39 — Official Astra skills/prompt article.** [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

**R40 — Official repository instructions and prompting guidance.** [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md); [Prompting](https://learn.chatgpt.com/docs/prompting)

**R41 — Actual Files preview capability.** [client/console/FilePreview.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/FilePreview.tsx#L17-L199)

**R42 — File-drop kinds and limits.** [shared/file-drops.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/file-drops.ts)

**R43 — Existing text editor and Files routing.** [client/console/DocumentEditor.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/DocumentEditor.tsx#L8-L30); [client/console/FilesPane.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/FilesPane.tsx#L417-L458)

**R44 — File identity.** [shared/file-identity.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/file-identity.ts#L1-L24)

**R45 — Desktop connection composition.** [server/connections/desktop.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/connections/desktop.ts#L1-L49)

**R46 — Approved MCP and model-API reads.** [server/harness/capabilities/mcp-read-client.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/harness/capabilities/mcp-read-client.ts); [server/harness/capabilities/read-scope-tools.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/harness/capabilities/read-scope-tools.ts#L1-L48)

**R47 — Native Codex configuration.** [server/integrations.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/integrations.ts#L173-L205)

**R48 — Approved wide-window and multitask design.** [docs/superpowers/specs/2026-10-03-wide-windows-and-multitask-mode-design.md](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/docs/superpowers/specs/2026-10-03-wide-windows-and-multitask-mode-design.md)

**R49 — Browser framing restrictions.** [MDN — CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)

**R50 — Electron embedding options.** [Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)

**R51 — Google authentication restrictions.** [OAuth 2.0 policies — Use secure browsers](https://developers.google.com/identity/protocols/oauth2/policies#use-secure-browsers)

**R52 — Microsoft iframe authentication limits.** [Using MSAL in iframed apps](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/iframe-usage)

**R53 — Repository operating instructions.** [AGENTS.md](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/AGENTS.md)

**R54 — Canonical project memory.** [Nectovia Project Memory](https://docs.google.com/document/d/13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw/edit)

**R55 — File preview/read/write implementation support.** [server/file-drops.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/file-drops.ts); [server/xlsx-preview.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/xlsx-preview.ts); [shared/delimited.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/delimited.ts); [server/app.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/app.ts#L2568-L2638)

**R56 — Existing exact-version review.** [client/console/VersionCompare.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/VersionCompare.tsx)

**R57 — Existing capability contribution and execution contracts.** [shared/pack-contributions.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/pack-contributions.ts); [server/pack-contributions.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/pack-contributions.ts); [server/software-pack/tools.ts](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/server/software-pack/tools.ts)

**R58 — Appearance preview fidelity.** [client/console/design-center/Preview.tsx](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/client/console/design-center/Preview.tsx#L1-L19)

**R59 — Retired chart grammar / visual convergence.** [docs/product/2026-09-22-model-artifacts.md](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/docs/product/2026-09-22-model-artifacts.md#L14-L21); [docs/product/2026-09-23-visual-convergence.md](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/docs/product/2026-09-23-visual-convergence.md#L8-L20)

