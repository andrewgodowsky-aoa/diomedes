# Diomedes business plugins: research and product design

Date: September 6, 2026. Audience: Diomedes product owner, implementers, and prospective business pilot partners.

Status: researched proposal. This package defines features and development gates; it does not install plugins or make the current app ready for business operations. Numerical examples and performance targets are illustrative. No client exports, installed business systems, API entitlements, or physical stock were inspected.

## The recommendation

Build a small, first-party plugin system with two initial business packages: **Restaurant Operations** and **Custom Cabinetry and Remodeling**. Each package should include a guided business assessment, industry vocabulary, typed records, operational screens, validated calculations, scoped assistant tools, integration mappings, and acceptance fixtures. The common platform should own identity, permissions, durable transactions, audit history, data provenance, and deployment.

The product promise is: **Diomedes helps a business record its work, understand its current position, investigate problems, and carry out authorized improvements through one shared workspace.** The assistant makes that workspace easier to use. Records and validated operations determine what it can truthfully answer and change.

Make both plugins available with synthetic demonstrations and setup checks. Enable live capabilities only when their required records and integrations are ready. An installed Restaurant plugin with no counts can explain how to investigate food usage; it cannot truthfully claim to know current stock. A Cabinetry plugin with a cutting list can calculate planned demand; it cannot certify that the material is physically on the rack.

This recommendation extends Diomedes from a personal working book into an optional shared business service. The desktop product remains useful on its own. Several iPads should connect to one business authority rather than each maintain an independent copy of the business.

## Reading guide

- [Industry playbooks: restaurant and cabinetry workflows, screens, diagnostics, and pilot cases](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/industry-playbooks.md)
- [Development roadmap: sequenced features, dependencies, and release criteria](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/development-roadmap.md)
- [Research evidence: source ledger, present-code findings, limitations, and discovery questions](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/research-evidence.md)

The rest of this document defines the shared architecture and plugin contract. All proposed names and manifests below are design examples, not existing APIs.

## What exists today, and what must change

The inspected repository is `F:\Achilles\diomedes`, with HEAD `284a11a` and additional working-tree changes. This research did not run the app's test suite or reproduce prior release proofs.

| Area | Current evidence | Proposed extension |
|---|---|---|
| User experience | Book and Desk, projects, documents, tasks, conversations, approvals, file history | Business pages organized around a person's location, job, and duties |
| Runtime | Electron starts a loopback service and shuts it down on exit | Optional independently running business host, reachable by authenticated clients |
| Persistence | JSON-backed application state, serialized local writes, file recovery/history | Transactional operations database with auditable stock/time records and protected attachments |
| Assistant tools | In-house MCP team tools and a native Codex integration | Industry tools exposed through a provider-neutral application boundary |
| Identity | Assistant-member authentication on team MCP routes | Separate identities for employees, devices, integrations, and assistants; location and job grants |
| Business records | No inventory, recipe, manufacturing, or timesheet subsystem in the inspected application | Shared inventory/time foundations plus industry-owned models |
| Client devices | Windows desktop and browser prototype | Responsive authenticated iPad web app, followed by explicitly tested offline capture |
| Extensions | No general business plugin loader or registry found | Versioned first-party catalog, contribution validation, enablement and migration lifecycle |

Evidence: [desktop lifecycle](/F:/Achilles/diomedes/desktop/main.mjs:20), [local store](/F:/Achilles/diomedes/server/store.ts:182), [team tools](/F:/Achilles/diomedes/server/team/mcp.ts:28), [member authentication](/F:/Achilles/diomedes/server/team/routes.ts:49), [application types](/F:/Achilles/diomedes/shared/types.ts:1), and [current scope](/F:/Achilles/diomedes/README.md).

The distinction between assistant identities and employee identities is essential. A helper slot authenticated to a project is not a restaurant manager authorized to see payroll or another location's stock. Existing file approvals also do not define the approval semantics of a material issue, customer change, or timesheet correction.

Earlier [business planning](/F:/Achilles/planning/2026-09-05-v4-business/08-business-architecture-and-workspace.md) proposed capability manifests and per-client deployments, but also assumed an AionCore-based foundation and CSV-oriented operations. Current code has an in-house team service. Retain the useful capability and isolation concepts; do not copy the old assumed runtime. This proposal deliberately introduces structured operational storage, which is an expansion beyond those earlier CSV-oriented plans. Original plans remain preserved.

## Product choices and tradeoffs

| Approach | Strength | Cost or limitation | Decision |
|---|---|---|---|
| Knowledge-only industry packs | Fast assessment, useful questions and document analysis | No reliable shared stock or operational write path | Include as the first usable mode |
| First-party business plugins over shared services | Reusable foundations, coherent UX, controlled data and actions | Requires identity, transactions, integrations, and support | Recommended target |
| Arbitrary executable marketplace extensions | Broad ecosystem potential | Adds code isolation, supply-chain, compatibility and support burden before workflow proof | Defer |

For each customer's existing system, decide separately whether Diomedes reads it, writes it through a supported API, or becomes the owner of a bounded record type. A connector can make an existing operational package usable without reproducing all its internals. Conversely, an unusable stock process may justify Diomedes-owned records while payroll and accounting remain in existing products.

One record type must have one declared authoritative owner. Define ownership at field or operation level when necessary: the POS owns order/refund facts, Diomedes may own ingredient counts, and the payroll system owns finalized pay runs. Mirrored data carries source identifiers and synchronization state. Avoid unrestricted two-way editing with competing authorities.

Do not choose a vendor or promise integration until the business identifies its software, version, export/API access, and workflow. Official documentation establishes possible capabilities, not this customer's entitlement or data quality.

## What a business plugin contains

Treat a plugin as a versioned business package with eight contributions:

1. **Assessment playbooks.** Questions, required evidence, workflow maps, suspected failure patterns, and supported conclusions.
2. **Domain definitions.** Typed records and rules that give words such as stock, yield, job, recipe, waste, and hours precise meanings.
3. **Screens and actions.** Host-rendered forms, lists, job sheets, exception views, and direct entry tools.
4. **Deterministic operations.** Calculations, validation, reservation, posting, reconciliation, and approval transitions.
5. **Assistant guidance and tools.** Industry instructions, structured read tools, proposal tools, and explicitly authorized commands.
6. **Connectors and import mappings.** Source adapters, data dictionaries, unit conversions, identity mapping, reconciliation and freshness rules.
7. **Examples and evaluations.** Synthetic businesses, sample questions, expected calculations, adversarial access cases, and failure scenarios.
8. **Lifecycle metadata.** Host compatibility, schema versions, dependencies, migrations, requested permissions, release notes, and recovery instructions.

A prompt file contributes knowledge. An MCP endpoint contributes a tool transport. Neither supplies a complete stock ledger, employee identity system, or upgrade lifecycle. MCP defines discoverable tools with schemas and structured outputs; Diomedes should put the business contract behind that interface. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Use explicit extension contributions and host-version compatibility as established design patterns. VS Code's manifest demonstrates these concepts, but its extension runtime is not a proposed dependency or a Diomedes security boundary. [VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest)

### Proposed package descriptor

```json
{
  "schemaVersion": 1,
  "id": "diomedes.cabinetry",
  "version": "0.1.0",
  "hostApi": "^1.0.0",
  "displayName": "Custom Cabinetry and Remodeling",
  "dependencies": ["inventory@1", "time@1", "documents@1", "approvals@1"],
  "contributions": {
    "assessments": ["job-cost-leakage", "stock-readiness"],
    "pages": ["my-jobs", "job-sheet", "materials", "exceptions"],
    "queries": ["cabinetry.material_availability", "cabinetry.job_variance"],
    "commands": ["inventory.reserve", "inventory.issue", "time.record"],
    "diagnostics": ["unallocated-time", "revision-mismatch"],
    "fixtures": ["five-sheet-run", "pooled-nest", "site-return"]
  },
  "requestedCapabilities": ["inventory.read", "inventory.reserve", "time.record.self"],
  "optionalConnectors": ["csv-import", "approved-cam-export"],
  "dataSchemaVersion": 1
}
```

The analogous Restaurant package depends on the same inventory, time, document and approval services, and contributes recipes, prep batches, sales mapping and location-close workflows. It should not depend on the Cabinetry package. Identifiers above are proposed contracts; declaring a capability requests it and does not grant it.

For the first release, package code with reviewed Diomedes releases. Permit customer-specific configuration and approved mappings, not executable code uploaded through a document. Use host-owned UI components for declarative contributions. Add external executable extensions only after a separately tested process isolation design exists. A worker process alone is not a sandbox; signatures establish origin, not harmless behavior.

### Plugin lifecycle

Proposed lifecycle: available, installed, configured, validated, enabled, paused, update-pending, incompatible, retired. Expose these in ordinary language, with a clear next action.

Enabling a plugin runs data and permission checks. Disabling it removes its actions and stops its scheduled work, while retaining readable records and export access. Removal must not cascade-delete inventory or job history used elsewhere. Customer configuration is separate from shipped defaults; an update shows configuration/schema changes and asks for newly requested capabilities.

Host/plugin compatibility and data compatibility are separate. Test migrations against a copied database, take a consistent backup, and verify restore before production upgrades. Do not assume reinstalling an older plugin can undo an irreversible schema migration. Prefer additive migrations and staged activation; otherwise define a maintenance window and explicit restoration procedure.

## Shared architecture

```text
Windows desktop     iPad job/location screens     Owner's browser
        \                    |                    /
         Authenticated business API and action dispatcher
                              |
          Identity, scope, approvals, validation, audit
                              |
             Restaurant plugin | Cabinetry plugin
                              |
       Inventory | Time | Documents | Jobs | Diagnostics
                              |
       Business database + attachments + delivery outbox
                              |
          Source adapters: POS, CAM exports, time, accounts

Model adapter -> scoped query/proposal tools -> same dispatcher
```

Use a modular service with one deployment and explicit module boundaries initially. A microservice per plugin would multiply operational work without solving the first business's problem. Keep dependencies directional: industry modules use shared services through contracts; they do not write another module's tables.

For a shared business deployment, PostgreSQL is the recommended starting database. Its transactional behavior supports atomic reservations and concurrent changes. This still requires correctly designed locking/conditional updates, constraints, and retries; database selection alone does not prevent overselling. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

A single business host backed by SQLite could support a smaller managed installation, but supporting two engines immediately would add migration and test work. Retain current personal-project storage during the first phases; introduce one operations database implementation when shared writes begin. Do not migrate unrelated document history just to make the architecture uniform.

Keep drawings, photos, supplier documents, and exports in protected attachment storage with immutable revisions, content hashes, source and retention metadata. The database owns their relationships and access. Current text-file support does not already provide this binary attachment service.

### Data model boundaries

| Shared concept | Required meaning |
|---|---|
| Organization | Customer/business isolation boundary |
| Location | Restaurant, workshop, store, vehicle or site, with physical hierarchy where needed |
| Person and membership | Employee/owner identity and explicit organization, location and job grants |
| Device/session | Revocable access session; never a replacement for identifying the actor |
| Item and unit | Stable material identity, approved conversions, measurement precision |
| Stock event | Receipt, transfer, issue, return, scrap, conversion or count correction |
| Reservation | Claim on specified eligible stock for a purpose, with release/fulfillment lifecycle |
| Time entry | Person, interval/duration, operation, location/job, approval and correction history |
| Document revision | Approved or draft evidence tied to the operation that used it |
| Proposal and decision | Exact requested effect, actor, scope, versions, approver and result |
| Evidence/finding | Sources, calculations, coverage, freshness, conclusion status and follow-up |

Recipes/prep batches remain Restaurant concepts. Assemblies, cutting runs, finish approvals, installation phases and change orders remain Cabinetry concepts. A generic conversion operation may be shared, but food yield and sheet geometry are not interchangeable rules.

Use decimal-safe quantities and money, declared units, configured currencies and explicit rounding. A "case" requires its pack conversion; 6 mm must not silently substitute for 1/4 inch; nominal product descriptions and actual dimensions may differ. Rates and costing policies are versioned so later supplier prices or wage changes do not rewrite a completed period.

### Transactions and corrections

Every submitted command includes a unique request key, expected record versions, and an authenticated context supplied by the server. The server checks permissions and business rules, writes all related records atomically, commits, and then returns a receipt. Replaying the same request returns its original result; reusing its key with different arguments is an error.

Reservations need a concurrency rule such as a locked balance row plus an atomic availability check. Two iPads reserving the last five sheets must not both succeed. A proposal's earlier stock check is informative; the server rechecks at commit. Published approval binds to the exact action and relevant record versions. A changed quantity or changed drawing requires revalidation.

Use an append-only operational journal with ordinary current-state tables maintained transactionally. This does not require event-sourcing the entire application. Correct a posted stock entry with a linked reversal/correction, and correct approved time through an attributed amendment. Restoring a project file must not reverse a delivery, erase consumed material, or unapprove wages.

External updates use a transactional outbox and source-specific reconciliation. If a vendor times out after accepting a purchase action, mark the result unknown and investigate its source identifier before retrying. Exactly-once delivery cannot be assumed across independent systems; deduplication and reconciled state are the target.

## Model independence and diagnosis

The underlying model should be replaceable through an adapter that declares tested abilities: structured calls, tool-result handling, streaming, images, cancellation and permitted data destinations. "Any model" means any adapter passing the required capability tests. A model without reliable tool calls can draft explanations from a bounded evidence packet while direct forms keep operations usable.

Business calculations run in services. Models resolve language, request missing context, assemble relevant evidence, explain findings and propose next steps. They receive a small authorized tool set, not database credentials, unrestricted SQL, arbitrary shell access, or every customer's records. An agent must never install its own plugin or grant itself a new permission because a document requests it.

Scope is the intersection of the person's grants, organization policy, plugin capability grants, run-specific allowance and provider restrictions. Bind organization, identity and allowed locations at the host boundary. Do not accept a model's claimed identity or a supplied organization ID as authorization.

MCP transport authorization is useful but does not replace job/location authorization. Keep external connector tokens server-side and scoped to their destinations. MCP's security guidance explicitly rejects unvalidated token passthrough. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

Current native Codex/team integration is a possible adapter reference, not proof of universal model support. The repository's [gateway investigation](/F:/Achilles/diomedes/QUESTIONS.md) and inspected configuration distinguish observed allowed calls from an exhaustive prevention boundary. Business write tools require demonstrable server-side controls regardless of provider behavior. Provider/account suitability for customer deployment remains a separate selection decision; this report does not approve sharing the developer's personal sign-in across customer installations.

### A repeatable investigation workflow

1. **Frame the symptom.** Identify business, location/job, period, question and intended decision. "We lose money" is too broad; "three kitchen jobs exceeded their sheet allowance" is investigable.
2. **Check evidence readiness.** Identify authoritative sources, missing IDs, unmapped materials, measurement units, update delays and count coverage. Output a data-readiness finding before an unsupported business conclusion.
3. **Compute facts.** Run versioned calculations on a consistent snapshot, recording source revisions and unresolved exclusions.
4. **Test explanations.** Evaluate plausible alternatives against supporting and contradictory evidence. Distinguish recorded fact, supported inference, open hypothesis and unavailable answer.
5. **Propose a bounded intervention.** Show expected effect, cost assumptions, affected records, permission needs and how success would be measured.
6. **Record the decision and action.** The person or a preauthorized bounded workflow acts through the same validated dispatcher used by direct UI actions.
7. **Check the outcome.** Compare a comparable later period or job set, record confounders and user corrections, and retain the finding's history.

A finding should contain a plain-language claim, severity/urgency, explicit evidence links, source timestamps, coverage, calculation version, alternatives, responsible person and next check. Confidence is a labeled evidence assessment, not an invented percentage generated by the model. Estimated savings include the formula, assumptions and a range where warranted; they are not a sales promise.

### Example tool contract

Proposed `cabinetry.material_availability` input is an exact material ID, requested location, optional job/run reference and requested quantity/unit. The server resolves the caller's authorized scope independently. Free-text matching is a preceding read operation and returns alternatives when the specification is ambiguous.

An illustrative structured result is:

```json
{
  "materialId": "mdf-quarter-4x8-approved",
  "locationId": "workshop-main",
  "unit": "full_sheet",
  "recordedOnHand": 12,
  "held": 1,
  "reservedEligible": 6,
  "available": 5,
  "balanceVersion": 42,
  "balanceAsOf": "2026-09-06T14:12:00Z",
  "lastPhysicalCount": "2026-09-06T11:40:00Z",
  "quality": "recorded",
  "exclusions": [],
  "evidenceIds": ["count-17", "movement-301", "reservation-22"],
  "permittedNextActions": ["inventory.reserve"]
}
```

These synthetic evidence IDs are illustrative. A real result includes scoped links to actual records. The UI and assistant show the same quantities, with timestamps converted to the location timezone. An unavailable source returns an explicit incomplete/stale result or an error; it never returns an invented zero balance.

A proposed reservation command carries the exact material/location/job, quantity, unit, idempotency key, and expected balance version. A successful result returns reservation ID, committed version and audit receipt. Permission denial, stale version, ambiguous unit and insufficient stock are distinct outcomes. If a model supplies extra identity/scope fields, schema validation rejects them. The dispatcher still checks authorization and current availability even when the prior result listed reservation as a permitted next action.

For example: "Recorded MDF issues exceed the approved allowance by two sheets. One sheet is linked to a documented remake. One has no disposition recorded. Check the return log and ask the job lead before changing the estimate template." That is actionable without accusing an employee or treating missing records as proven waste.

For documents, begin with metadata and permission-filtered text search. Add embeddings only when a measured retrieval gap justifies them. Filters must apply before retrieval, and summaries/caches must remain scoped after creation. Supplier documents, imported notes and filenames are evidence, not authority to change permissions or execute instructions.

## People, locations, and devices

Start with one separately provisioned service and database per customer, with multiple locations inside it. This keeps early isolation and restoration understandable. Retain organization identifiers in records and jobs so later shared hosting does not depend on retrofitting ownership. A shared hosted fleet is a later option with different operational tradeoffs. [Microsoft tenancy models](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models)

Enforce access on API reads/writes, assistant retrieval, attachments, search, exports, background work, notices and cached responses. PostgreSQL row policies may provide defense in depth, but table owners and privileged roles can bypass them; use a restricted application role and test the real connection identity. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

Shared-device fast switching should select an individually authenticated worker, expire idle sessions, and visibly show the current person and location. A worker may record their own hours without seeing other people's rates. A restaurant manager may manage one site without retrieving another site's wages through a generated summary. A cabinet installer may access assigned drawing revisions while customer access codes and unrelated home photos remain restricted.

The shared service must run independently of the Windows app. Closing the owner window cannot disconnect the shop. An on-premises host favors continued local operation during internet failure; a managed hosted service favors remote installation crews and simpler central maintenance. Select after observing site connectivity, support ownership and backup needs. Avoid publicly exposing the current loopback prototype by merely changing its bind address.

Use the existing React experience for an authenticated responsive web client on iPads. Add home-screen installation and camera/manual-code capture after testing the actual device fleet. Keep navigation restrained: My work, Stock, Record, and Ask for an operator; Exceptions, Approvals and Reports for a manager. Preserve Book simplicity and Desk depth. Define interface context, permissions and underlying records consistently even when their layouts differ.

### Offline behavior

Phase one can require connectivity for committed operations while keeping the last authorized job sheet readable. A later durable local queue may capture time, photos and movement reports with visible pending status. An offline stock query displays its age; a reservation remains a request until accepted by the host. If material was physically taken while offline, record that historical event and reconcile a shortage rather than pretending the physical action did not occur.

Do not rely on background synchronization completing on iPad. MDN documents limited browser availability. Browser storage also has quota and eviction behavior, so unsynchronized data is not a backup. Provide foreground retry, visible unsent count, constrained offline access and an operational fallback for prolonged outage. [MDN background synchronization](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API), [MDN storage limits](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

Electron must keep its renderer isolation, restricted navigation and narrow bridge when loading plugin screens. Prefer bundled host-rendered components initially. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

## What "ready to go" must mean

Define readiness per capability, not just per installed package:

- **Demonstration ready:** works on labeled fixtures; setup and examples explain the workflow.
- **Assessment ready:** validates scoped customer exports, calculates reproducible facts, and reports missing evidence without changing operational systems.
- **Pilot ready:** selected users can run one complete workflow with reconciled data, permissions, recovery and measured results.
- **Operationally ready:** trained staff, supported integrations, proven restore, monitoring, version compatibility and a clear support owner exist.

The recommended sequence is assessment tools for both industries first, then one operational pilot. Cabinetry is the preferred first live pilot if the friend's company can provide a real job packet and a shop lead willing to validate it. Its five-sheet example is specific enough to test the shared foundations. Restaurant assessment fixtures should be built alongside it to expose assumptions that do not generalize.

Do not promise a production date from this research. Customer access, source quality, connectivity, deployment ownership and provider selection remain unknown. The [roadmap](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/development-roadmap.md) specifies exit evidence so implementation can be estimated after discovery, rather than treating a polished demonstration as a functioning business system.
