# Research evidence and unresolved decisions

Research date: September 6, 2026. These notes distinguish inspected code, published product/protocol documentation and proposed Diomedes design. They are not an installed-system audit of either prospective customer.

## Method and proof boundary

The review combined direct inspection of current Diomedes files with three research lanes: shared architecture, restaurant operations and custom cabinetry/remodeling. Two bounded research agents gathered industry evidence; the coordinating review reopened the critical restaurant-usage, POS-refund, remnant, nesting and construction-change sources and checked the Odoo cost claim against its official versioned source after the documentation website failed to open.

Research used official protocol/database/browser documentation and first-party business-product documentation. Vendor features are examples of established workflows, not comparative product recommendations. Public product pages are weaker integration evidence than technical schemas. No independent customer ROI study was used, so the writeup makes no quantitative savings claim.

Discovery focused on the decisions that could change the architecture: record authority, measured versus planned use, revision history, model/tool boundaries, concurrent writes, isolation and offline limitations. Follow-up resolved refund semantics, remnant confirmation, versioned cost baselines and browser synchronization assumptions. Research stopped when those decisions had primary support or an explicit customer-specific gap. A broader vendor/pricing roundup would not resolve the still-unknown customer systems.

No client credentials, accounts, databases or job records were accessed. No integration was installed, connected or tested. No model generation on customer data, production migration, plugin runtime implementation, application rebuild or app test run was performed for this report. Existing app work was left intact; only this new documentation directory was authored.

## Current code evidence

| Evidence | Inspected fact | Consequence |
|---|---|---|
| [package manifest](/F:/Achilles/diomedes/package.json) | React, Express, Electron, TypeScript and MCP SDK; desktop packaging scripts | Reuse the stack; a plugin system is an application design, not a new framework requirement |
| [desktop main](/F:/Achilles/diomedes/desktop/main.mjs:20) and [server listener](/F:/Achilles/diomedes/server/index.ts:57) | Local service lifecycle and loopback binding | Multi-device operations need a separately designed authenticated business host |
| [store](/F:/Achilles/diomedes/server/store.ts:182) | JSON-backed state and an in-process serialized write queue | New concurrent business records need stronger transaction/data contracts |
| [types](/F:/Achilles/diomedes/shared/types.ts:1) | Personal projects, tasks, conversations and approvals | Inventory, time, customer/location memberships and industry records are additions |
| [MCP tools](/F:/Achilles/diomedes/server/team/mcp.ts:28) and [routes](/F:/Achilles/diomedes/server/team/routes.ts:49) | Typed team operations and member bearer authentication | Reusable tool pattern; not evidence of employee/location authorization |
| [integration implementation](/F:/Achilles/diomedes/server/integrations.ts:129) and [gateway notes](/F:/Achilles/diomedes/QUESTIONS.md) | Default restrictions and team-specific host configuration; investigation documents limits of proving all native tool exposure | Enforce business actions at Diomedes's server boundary and test each adapter |
| [README](/F:/Achilles/diomedes/README.md) | Documents local prototype, current integration and storage limits | Avoid promising multi-user or arbitrary-provider readiness |
| [older business proposal](/F:/Achilles/planning/_archive/2026-09-05-v4-business/08-business-architecture-and-workspace.md) | Proposed capabilities, isolation and exports-first concepts; an older runtime assumption | Preserve useful ideas while explicitly replacing outdated architectural assumptions in this proposal |

Repository HEAD observed during research: `284a11a`. The workspace had additional changes. Existing historical test totals were not treated as fresh verification. This report's statements about current implementation come from inspected files, not from a remembered release summary.

## Source ledger

All sources were accessed on September 6, 2026. Dates below are publication/update dates visible in the source or the explicit documentation version; where none was exposed, the date is recorded as unavailable. "Direct" means the coordinating review opened the source. "Delegated" means the bounded industry review read it; critical claims were independently checked as described above. These access labels concern research provenance, not application verification.

### Shared architecture

| ID | Source / publisher | Version or date | Supported claim and access |
|---|---|---|---|
| A01 | [Tools, Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | 2025-11-25 specification | Discoverable schema-defined tools and structured results; tool annotations are not an authorization boundary. Direct. |
| A02 | [Authorization, Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | 2025-11-25 specification | HTTP transport authorization framework, resource-oriented token handling. Direct. |
| A03 | [Security best practices, Model Context Protocol](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) | Versioned 2025-11-25 path; no separate update date used | Token passthrough and other trust-boundary concerns. Direct; original specification link redirected here. |
| A04 | [Transaction isolation, PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html) | Current page identified PostgreSQL 18 | Concurrency/isolation semantics and need for whole-transaction retries on serialization failure. Direct. |
| A05 | [Row security, PostgreSQL](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Current page identified PostgreSQL 18 | Row filtering and privileged/table-owner bypass caveats. Direct. |
| A06 | [Security, Electron](https://www.electronjs.org/docs/latest/tutorial/security) | Living documentation; date unavailable | Renderer isolation, navigation/bridge restrictions and secure-content practices. Direct. |
| A07 | [Background Synchronization API, MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API) | Living documentation; date not used | Limited browser availability and secure-context requirement. Direct. Exact customer iPad behavior untested. |
| A08 | [Storage quotas and eviction, MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) | Living documentation; date not used | Browser storage has quota/eviction conditions; it cannot be assumed to be a durable central backup. Direct. |
| A09 | [Tenancy models, Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models) | Living documentation; date not used | Isolation and deployment choices entail tradeoffs. Direct. No Azure hosting selection was made. |
| A10 | [Extension manifest, Visual Studio Code](https://code.visualstudio.com/api/references/extension-manifest) | Living documentation; date unavailable | Manifest metadata, declared contributions and engine compatibility are established extension patterns. Direct. No VS Code runtime adoption proposed. |

### Restaurant operations

| ID | Source / publisher | Version or date | Supported claim and access |
|---|---|---|---|
| R01 | [Actual vs Theoretical Analysis, Restaurant365](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis) | Updated 2025-08-26; published 2024-07-08 | Counts/flows versus POS/recipe usage, waste and report-cost limitations. Direct and delegated. |
| R02 | [New Recipe Record, Restaurant365](https://docs.restaurant365.com/docs/new-recipe-record) | Updated 2026-04-23 | Ingredients/sub-recipes, yield, units and location-relevant recipe information. Direct and delegated. Immutable effective-dated versions are our proposal. |
| R03 | [Item Transfers Overview and Security, Restaurant365](https://docs.restaurant365.com/docs/item-transfers-overview-security) | Updated 2026-03-11 | Sending/receiving workflow, permissions and discrepancy handling. Delegated. |
| R04 | [Purchasing and Receiving, Restaurant365](https://www.restaurant365.com/inventory/purchasing-receiving/) | Date unavailable | Product-level purchasing, receiving and discrepancy capabilities. Delegated; marketing/product evidence, not an API contract. |
| R05 | [Selection schema, Toast](https://doc.toasttab.com/openapi/orders/tag/Data-definitions/schema/Selection/) | Date unavailable | Quantity, unit, modifiers, void/preparation state and monetary refund fields. Direct and delegated. |
| R06 | [Specifying modifiers and instructions, Toast](https://doc.toasttab.com/doc/devguide/apiSpecifyingModifiersAndInstructions.html) | Date unavailable | Nested modifiers and source-channel default behavior. Delegated. |
| R07 | [Getting time entries for employees, Toast](https://doc.toasttab.com/doc/devguide/apiGettingTimeEntriesForEmployees.html) | Date unavailable | Individual-restaurant requests, bounded date windows, open shifts and time-entry sales-field caveat. Direct and delegated. |
| R08 | [Authentication and restaurant access, Toast](https://doc.toasttab.com/doc/devguide/authentication.html) | Date unavailable | Different credential/access paths; actual customer entitlement must be checked. Delegated. |
| R09 | [Location access, Toast](https://doc.toasttab.com/doc/devguide/apiPartnersGettingAccessibleRestaurants.html) | Date unavailable | Partner restaurant access/mapping and change events. Delegated. Product/access-specific behavior; not a universal connector contract. |

### Custom cabinetry and remodeling

| ID | Source / publisher | Version or date | Supported claim and access |
|---|---|---|---|
| C01 | [Manufacturing order costs, Odoo](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/basic_setup/mo_costs.html) | Version 19; publication date unavailable | Planned/real cost distinction and completion-column behavior. Website open failed; coordinating review retrieved [official version-19 source](https://raw.githubusercontent.com/odoo/documentation/19.0/content/applications/inventory_and_mrp/manufacturing/basic_setup/mo_costs.rst). Delegated indexed retrieval also available. |
| C02 | [Version control, Odoo](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/plm/manage_changes/version_control.html) | Explicitly version 18 | Engineering-change preservation of BOM, operations and design-file history. Delegated indexed text; direct page failed in that research. No claim of exact version-19 parity. |
| C03 | [Reference: Scrap Management, Microvellum](https://intercom.help/microvellum-knowledge-base/en/articles/14074522-reference-scrap-management) | Jordan Munoz; 2026-03-16 | Remnant identities, dimensions, bin/trim data and commit/use workflows. Direct and delegated. API availability unverified. |
| C04 | [Process Material Library reference, Autodesk Fusion](https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/NST-REF-MATERIALS.htm) | Date unavailable; Manufacturing Extension reference | Grain/orientation, spacing, boundary and face constraints. Direct and delegated. No customer extension entitlement established. |
| C05 | [NC Program reference, Autodesk Fusion](https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-NC-OLD-V-NEW) | Date unavailable | Selected operations, machine/postprocessor and NC/setup outputs. Delegated. No machine/control integration tested. |
| C06 | [Shop Floor time tracking, Odoo](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/shop_floor/shop_floor_tracking.html) | Version 19; publication date unavailable | Per-operator work-order timing; labels require interpretation. Delegated indexed text and coordinating search verification; site open failed in delegated research. Do not assume every duration field equals the same measure across versions. |
| C07 | [Stock movement operations, Odoo](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/inventory_valuation/operations_valuation.html) | Version 19; publication date unavailable | Operational distinction among internal movement and other stock dispositions. Delegated indexed text. Not accounting-policy advice. |
| C08 | [Create Change Events, Procore](https://support.procore.com/products/online/user-guide/project-level/change-events/tutorials/create-change-events) | Last-updated date not exposed | Potential scope/schedule/cost changes precede downstream change-order decisions. Direct and delegated. |
| C09 | [View Punch List Items, Procore](https://support.procore.com/products/online/user-guide/project-level/punch-list/tutorials/view-a-punch-list-item) | Last-updated date not exposed | Project-linked responsibility, attachments, responses and history. Delegated. No API/license capability confirmed. |

## Evidence gaps that affect implementation

| Decision | Current confidence | Missing evidence and next action |
|---|---|---|
| Reusable plugin core is appropriate | Design recommendation supported by two distinct workflows | Validate against one real job and one real restaurant period; revise shared boundaries if they force unnatural records |
| Current app is ready for customer writes | Not established; required subsystems are absent | Implement and prove identity, transactions, source ownership and recovery first |
| The cabinetry company can integrate its tools | Unknown | Identify exact estimating/CAD/CAM/time/accounting products, versions and exports/API access |
| Meaning of prebuilt materials | Unknown | Ask whether this means an estimate template, allocated stock, purchased kit or finished assembly |
| Restaurant theoretical usage can be trusted | Conditional | Map actual recipes, modifiers, prep stages, stock units and count cutoffs; reconcile a period |
| Pooled CNC job cost can be allocated fairly | Policy decision | Obtain the shop's agreed allocation method and examples; label allocations explicitly |
| iPad offline operation is reliable | Unverified | Test actual OS/browser/device storage, identity switching, reconnect and prolonged outage cases |
| A different model can replace native Codex | Proposed adapter architecture only | Choose provider routes and run the same capability/access/failure tests for each adapter |
| Commercial ROI and timeline | Unknown | Measure baseline capture/reconciliation costs, data quality, workload and support requirements |
| Hosted versus on-premises deployment | Open | Observe field/shop connectivity, IT ownership, remote access and backup/restoration needs |

## Next discovery conversation

For the cabinet company, identify the current software first, then walk a single high-end kitchen or remodel job. Request the original estimate, an approved drawing/BOM release, one material receipt/issue/return set, corresponding time entries, and one revision or rework example. Ask who physically updates each record and when. Confirm whether cutting batches mix jobs and who decides a remnant is worth saving.

For a restaurant, identify POS, inventory, scheduling and payroll systems, then follow a small set of ingredients through buying, receiving, preparation, sale, waste and counts. Confirm how extras, substitutions, staff meals, comps, remakes, voids and refunds are actually entered. Establish the business-day boundary and who may access each location or wage field.

For both, agree on record ownership, approval responsibilities, practical capture burden and a measurable pilot outcome before selecting integrations or promising production readiness. This is a proposed product specification with bounded research limitations, ready for review and implementation planning once those inputs are available.

## Deliverable verification

The four Markdown files were read back and checked for existing absolute local links, valid referenced line numbers, balanced code fences, parseable JSON examples, ASCII content and unresolved placeholders. The restaurant usage, sheet-area conservation, availability and labor examples were recomputed. These document checks passed. The 24 industry and 20 shared acceptance cases are proposed future implementation tests; none is represented as a runtime pass. The conceptual screen layout was not implemented or visually tested.
