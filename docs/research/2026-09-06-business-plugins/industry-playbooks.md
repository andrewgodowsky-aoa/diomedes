# Industry playbooks: Restaurant Operations and Custom Cabinetry and Remodeling

Date: September 6, 2026. Status: proposed product behavior informed by primary documentation. These plugins are not implemented. Example businesses, quantities and diagnoses below are synthetic.

Read with the [shared architecture](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/README.md), [development roadmap](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/development-roadmap.md), and [source ledger](/F:/Achilles/diomedes/docs/research/2026-09-06-business-plugins/research-evidence.md).

## 1. Restaurant Operations

### Purpose and first outcome

Give a restaurant manager a reliable daily picture of available ingredients, preparation, receiving discrepancies, labor exceptions and unresolved tasks. Give an owner comparable results across authorized locations. Let staff record the physical events that a POS cannot observe.

The first outcome is a reproducible explanation of ingredient usage for a small set of important ingredients at one location. It should answer: what was counted, what arrived, what moved, what the menu implies should have been used, what waste was recorded, and what remains unexplained.

Restaurant365 documents actual-versus-theoretical reporting with count boundaries, sales/recipe-derived usage, recorded waste and cost options. It also warns that the report need not exactly reconcile to financials. This establishes the need for explicit report definitions; it does not establish any particular restaurant's current data quality. [Restaurant365 actual-versus-theoretical analysis](https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis)

### Business-specific setup

The plugin's setup interview should produce a reviewable restaurant profile, not just a saved chat:

| Configuration | Questions it resolves |
|---|---|
| Locations and physical storage | Which restaurant, walk-in, freezer, dry store and prep station are involved? |
| Operating calendar | When does the business day end? Which timezone and count boundaries apply? |
| Record ownership | Which system owns POS orders, recipes, physical stock, attendance, and final payroll? |
| Ingredients and suppliers | What is a case, bag, bottle or portion for each item? What aliases do suppliers use? |
| Menu and preparation | Which recipes, modifiers, prep batches and substitutions actually occur? |
| Staff authority | Who receives goods, enters waste, approves corrections, views wages or orders supplies? |
| Connectivity and devices | Where are iPads used, who shares them, and what happens during an outage? |
| Pilot goals | Fewer shortages, faster counts, more complete hours, or better explained variance? |

Start with roughly 10-20 high-value ingredients and their relevant recipes/menu items as a proposed pilot scope, adjusted to the restaurant. Do not require a complete catalog before showing value. Do require the scope exclusions to remain visible in totals and conclusions.

### Core records

**Ingredient.** Stable ID, product specification, vendor aliases, purchase pack, storage unit, recipe unit, approved conversions, location, and count method. Lot/expiry fields can be added where staff can maintain them. A recorded expiry date supports stock rotation; it is not an automated determination that food is safe to serve.

**Recipe version.** Yield quantity/unit, ingredients, sub-recipes, preparation instructions, effective date, location overrides and approving person. Historical reports use the version applicable to the relevant preparation/sale. A versioned recipe is our design choice; Restaurant365's recipe documentation establishes yield, ingredients/sub-recipes and unit concepts, not a claim that it implements this exact historical version contract. [Restaurant365 recipe records](https://docs.restaurant365.com/docs/new-recipe-record)

**Prep batch.** Inputs actually taken, expected output, measured output, time, preparer, location and disposition. Intermediate goods such as sauce, portioned protein or dough need their own counted state when the restaurant tracks them. Capture expected-versus-actual yield without converting every difference into spoilage.

**Movement and count.** Receipt, supplier return, internal transfer, preparation input/output, consumption, waste, donation/staff meal, count and correction. Link the record to the person, source and timestamp. A count establishes a measured balance at its cutoff and creates an explained adjustment to the prior record; it must not silently erase intervening movements.

**Sale mapping.** POS location, menu item, modifier hierarchy, portion, quantity, status and source revision mapped to recipe effects. Preserve original source events for replay and auditing. Unmapped selections enter an exception queue; they must not quietly become zero ingredient use.

**Time.** Person, location, role, start/end, breaks, approval status and correction history. Attendance and task allocation are separate. Import wages only when needed and restrict their visibility; final payroll calculation remains in the selected payroll authority for the initial plugin.

### Daily workflow

1. The manager opens today's location page. It shows stale counts, pending receipts/transfers, low recorded availability, incomplete prep and missing clock-outs.
2. Receiving staff scan or find the expected delivery, record what actually arrived, and flag substitutions or damaged goods. Purchase order, physical receipt, invoice and payment remain separate states. Supplier invoice extraction can draft a receipt, but it needs physical confirmation.
3. Prep staff open the approved recipe, record a batch, and enter usable output or a reason for a discrepancy. Frequent quantities should be one or two touches after selecting the item.
4. POS synchronization updates the theoretical consumption view. A normal sale, complimentary meal, void, refund and remake follow their configured physical implications.
5. Staff record waste and transfers with quick reason codes. A receiving location accepts a transfer and records discrepancies. Departure from location A does not prove arrival at B; Restaurant365's transfer workflow is an established example of this distinction. [Restaurant365 item transfers](https://docs.restaurant365.com/docs/item-transfers-overview-security)
6. At the configured cutoff, staff count the selected inventory. The manager reviews discrepancies and approves corrections. The resulting report links every subtotal to its evidence and unresolved coverage.

### Correct calculations

For a simple purchased ingredient with no intermediate-production adjustment, all quantities in one canonical unit and one aligned count period:

```text
Actual disappearance between counts
  = beginning count + receipts + transfers in
    - transfers out - supplier returns - ending count

Theoretical consumption
  = sum of mapped production/sale quantities x applicable recipe quantities

Unexplained quantity variance
  = actual disappearance - theoretical consumption
    - documented non-sale consumption not already included in theoretical use
```

The term "actual" here means derived from the recorded count/flow evidence; it is not a continuous physical measurement. Actual disappearance includes waste. Deducting waste in both actual disappearance and unexplained variance would count it twice.

Fixture: beginning 20 kg + receipts 30 kg + transfer-in 5 kg - transfer-out 2 kg - ending 13 kg = 40 kg disappearance. Sales/recipes explain 34 kg, recorded waste explains 4 kg, leaving 2 kg unexplained. This example has no supplier returns, no remaining intermediate prep and no other non-sale consumption.

Prepared goods require an explicit reporting basis. Either reconcile each stage separately, or expand opening/closing prepared inventory into ingredient equivalents using its recorded batch version and yield. Do not compare raw-ingredient disappearance with menu sales while ignoring sauce or prepared portions still in stock.

Choose one depletion owner per item/stage. When making a sauce consumes raw ingredients and creates sauce stock, later sales consume sauce. They must not consume those raw ingredients a second time. An alternative estimated POS-depletion method can be used for items without physical prep capture, with balances labeled as estimates and periodically reconciled by counts.

Quantity variance, purchase-price variance and recipe/yield variance should be separate explanations. A supplier price increase can raise cost without increasing physical waste. Define the costing basis, rounding and treatment of unapproved entries before comparing stores. Reports should state whether they are operating estimates or reconciled financial outputs.

### POS integration: semantics before convenience

Toast's selection schema exposes quantity, unit, modifiers, preparation status, voids and monetary refund details. A monetary refund is not evidence of ingredients physically returning to usable stock. Its preparation-state behavior also depends on KDS configuration, so a missing READY state is not proof that food was never made. [Toast selection schema](https://doc.toasttab.com/openapi/orders/tag/Data-definitions/schema/Selection/)

Nested modifiers, omitted ingredients, extras, portions and order-channel defaults require explicit mapping. Toast documents modifier hierarchy and different default-modifier behavior for API-created orders. Test real exported examples before claiming complete consumption coverage. [Toast modifier documentation](https://doc.toasttab.com/doc/devguide/apiSpecifyingModifiersAndInstructions.html)

A connector needs stable event IDs, pagination/backfill, edits/deletions, rate-limit handling, duplicate detection, late-event processing and a recorded synchronization watermark. Expose source-access failures and mapping gaps. A successful login is not proof that every needed endpoint is available; Toast documents distinct credential/access paths. [Toast authentication](https://doc.toasttab.com/doc/devguide/authentication.html)

Toast time-entry documentation describes restaurant-scoped retrieval, open shifts, employee/job references and corrections-related fields. It also notes that sales/tip totals on time entries may not follow later order changes. For a labor-versus-sales report, reconcile the selected sales authority and period instead of assuming a convenient field is authoritative. [Toast time entries](https://doc.toasttab.com/doc/devguide/apiGettingTimeEntriesForEmployees.html)

### Assistant capabilities and diagnosis

Proposed read tools: `restaurant.stock`, `restaurant.recipe`, `restaurant.usage_variance`, `restaurant.delivery_exceptions`, `restaurant.labor_exceptions`, and `restaurant.evidence`. Proposed actions use shared operations: record a count, record waste, acknowledge a transfer, create an investigation task, or propose a reorder.

| Question | Investigation | Useful answer |
|---|---|---|
| Do we have enough chicken for tonight? | Identify location/product, usable recorded stock, recipe demand assumptions and synchronization state | Available quantity and estimated covers, with assumptions and freshness |
| Why was food usage high last week? | Check count cutoffs, pack conversions, menu mappings, transfers, prep and waste before attributing residual variance | Ranked findings and the next evidence needed |
| Did that supplier short us? | Compare ordered, acknowledged and received quantities, units, substitutions and receipt photos | A specific discrepancy to verify or claim, not an unsupported accusation |
| Which shifts still need attention? | Read authorized incomplete/overlapping or corrected time records | Named entries and responsible reviewer, without exposing unrelated wage data |
| What needs my attention at this restaurant? | Gather scoped exceptions and due work | A short actionable list, with direct links to the affected records |

Example answer: "Downtown has an estimated 8.4 kg available. The last physical count was yesterday's close; mapped sales and receipts are synchronized through 14:10. One receipt has an unresolved case-size mapping and could change this balance."

A variance investigation first tests data coverage and unit mapping, then operational explanations such as portion changes, yield, remake waste and transfers. It should not infer theft or recommend disciplining a worker from a variance report. Recipes, supplier notes and uploaded instructions cannot authorize a purchase or disclose another restaurant's information.

### Screens and role scope

The prep screen leads with the batch, recipe version, quantity and actions: Start prep, Record yield, Record waste. Receiving leads with expected versus received lines. The manager screen leads with exceptions requiring a decision. Owner comparisons remain drillable to source records and show differing coverage across locations.

Use the Diomedes type system, readable quantities, explicit units and restrained color meaning. Avoid adapting the expert Desk into a dense tablet control panel. The selected person/location should always be visible. A kitchen worker can complete normal tasks through forms if speech recognition fails or the model is unavailable.

Roles are proposed: prep worker, receiver, shift/location manager, area manager, owner and catalog administrator. Permissions compose by duty and location; job titles alone do not imply wage access or authority to purchase. Cross-location summaries must enforce the same scope as source records.

### First pilot acceptance cases

| ID | Fixture and required result |
|---|---|
| R01 | Two cases of six 1-kg bags produce a 12-kg receipt. A changed supplier pack requires mapping review. |
| R02 | Raw stock becomes a prep batch; selling portions consumes the batch once and leaves the counted remainder intact. |
| R03 | A Monday portion change does not alter Sunday's historical calculation. |
| R04 | Three burgers, including one without cheese and one with extra cheese, produce the expected ingredient effects. |
| R05 | A refund for poor service after preparation does not add ingredients to stock. A recorded remake has its own consumption/waste treatment. |
| R06 | A sends 5 kg; B receives 4.5 kg. The 0.5-kg discrepancy remains visible and total stock is conserved. |
| R07 | Duplicate sale/waste submissions affect the ledger once; a late correction creates an attributed revision. |
| R08 | The 40-kg disappearance fixture reconciles to 34 kg theoretical, 4 kg waste and 2 kg unexplained. |
| R09 | Overnight work remains open until an end time arrives; timezone/business-day rules do not split or double-count it incorrectly. |
| R10 | A location manager cannot retrieve another location's wage, document, total or chat-derived evidence through direct IDs. |
| R11 | Expired source access changes freshness/health and prevents a false "fully synchronized" answer. |
| R12 | Every displayed variance exposes its counts, flows, recipe versions, mapped sales and exclusions. |

The first pilot excludes autonomous purchasing, payroll execution, automated food-safety judgments and replacing the POS. Purchasing assistance can prepare a quantity recommendation for authorized review. Later additions should follow observed needs: par planning, supplier discrepancy tracking, multi-location prep, stock rotation records and scheduling support.

## 2. Custom Cabinetry and Remodeling

### Purpose and first outcome

Cover a custom project through field measurement, design, estimate, engineering release, in-house manufacture, staging, site delivery, installation and correction work. High-end remodeling introduces customer selections, drawing revisions, fit/finish decisions and site conditions that a simple stock counter would miss.

The friend's actual process is not yet documented. In particular, "prebuilt material" could mean a template allowance, a purchased job kit, a reserved bundle, or an already fabricated assembly. Discovery must name that state before implementing it.

The first operational outcome is the five-sheet CNC workflow: resolve the material and released run, answer availability, reserve and issue stock, record what was cut/returned, record human time, and compare the result with the preserved job allowance.

### Job structure and commercial boundaries

Proposed structure: Project -> room/area -> assembly -> part -> operation, with delivery packages and installation/punch items linked alongside it. Make deeper levels optional. A pilot should work with job-level material and time before staff label every part or fastener.

Maintain independent records for:

- Original approved scope, estimate and customer price.
- Current authorized budget, including approved changes.
- Current released production definition: BOM, drawings, cut list, operations and file package.
- Actual recorded materials and labor.
- Open commitments and forecast remaining work.
- Delivery, installation, rework and verified completion.

Odoo's manufacturing documentation illustrates planned versus real costs and documents a completion behavior that updates the displayed MO cost to real cost. Therefore an imported current cost field is not necessarily a durable original estimate. Preserve explicit baseline snapshots and source versions in Diomedes. [Odoo 19 manufacturing costs](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/basic_setup/mo_costs.html)

A design revision and a commercial change order need separate approval. Correcting a field measurement may require new parts without a customer price increase. Adding an island may require both revised drawings and a separately approved price/scope change. Procore's change-event workflow records potential changes before downstream change orders; use that distinction as a reference, not a claim that Diomedes implements Procore. [Procore change events](https://support.procore.com/products/online/user-guide/project-level/change-events/tutorials/create-change-events)

Potential high-end details to validate include veneer matching/sequence, finish batches, approved physical samples, visible-face orientation and customer-specific hardware. Include them only where the company actually needs and can maintain them. Protect home addresses, access instructions and customer photos according to project scope.

### Material identity and availability

"Quarter-inch MDF" is a search term. A usable stock record may require manufacturer/product, grade, nominal and actual thickness, sheet dimensions, face/finish, unit, location, condition and allowed substitutions. Resolve ambiguity before reserving. Incoming purchase orders belong in a future supply view, not present usable stock.

Compute available material from eligible stock at the required location, subtracting reservations against that eligible stock. Held/damaged stock is already excluded from the eligible set; do not subtract an overlapping hold and reservation twice. Model transfer lead time separately when stock exists at another site.

Synthetic answer: "There are 12 full 4 x 8 sheets recorded. Six usable sheets are reserved for other work, and one separate sheet is on hold. Five are available for this run in rack B3. Last physical count: 07:40; records synchronized through 10:12. Reserve five for Job K-104?"

The system knows recorded availability. It still needs a counting and movement process to stay aligned with the rack. The UI should make a count discrepancy easy to record rather than encourage workers to override a number informally.

### Full sheets, remnants and cutting runs

Microvellum's scrap-management documentation records reusable scrap identities, dimensions, bins, trims and usage/commit workflows. Diomedes should similarly distinguish a planned offcut from a physically saved remnant. No assumption is made that a Microvellum API is available. [Microvellum scrap management](https://intercom.help/microvellum-knowledge-base/en/articles/14074522-reference-scrap-management)

A remnant needs an individual identifier, material specification, conservative usable dimensions, location, condition and count history. Start with rectangular usable bounds. Add irregular geometry only through a validated CAD/CAM exchange. Three remnants never increase the full-sheet count by three.

Nesting suitability depends on rotation, grain, spacing, clearance and face constraints. Autodesk documents these parameters in its nesting material library. Area alone cannot establish that a part fits. Diomedes can show candidates and cite an approved nesting result; geometry validation remains in the chosen CAM workflow. [Autodesk nesting material parameters](https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/NST-REF-MATERIALS.htm)

Material movement follows explicit states: receipt, reservation, transfer to station, consumption into produced parts, return of unused full material, saved remnant, scrap, hold, count and correction. A move to the CNC station or truck changes location/custody; it is not itself proof of consumption. Odoo's inventory-operation documentation illustrates distinct internal moves, consumption and other stock operations. [Odoo stock operations](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/inventory_valuation/operations_valuation.html)

Conservation fixture: issue five full 4 x 8 sheets to the station, cut four, and return one intact. Four cut sheets contain 128 square feet: 95 in parts, 25 in three saved/labeled remnants, and eight in kerf/trim/waste. The full-sheet balance falls by four after return; saved remnants enter their own records. The proposal requires all areas to use the same measured/nominal basis and flags reconciliation differences rather than forcing them into an invented perfect yield.

A nest may contain parts for multiple jobs. Measure input sheets, produced parts, retained remnants and waste at batch level. Per-job allocation of shared sheet cost or waste needs a declared policy, such as part area plus agreed allowances. Retain its version, inputs, overrides and rounding remainder. Allocated waste is not measured waste caused by that job. This prevents the assistant from assigning blame based on an accounting convention.

### Labor, machine time and operational progress

Capture person, job, operation, start/end or duration, breaks, reason and approval. Useful operation choices include measurement, design, CNC setup, cutting, edge work, assembly, sanding, finishing, packing, travel, installation and rework. Keep the list short enough that staff will use it; add detail when a real decision needs it.

Attendance, allocated labor, machine runtime, setup, waiting and calendar duration are separate quantities. Two people working 30 minutes each contribute one labor hour; a 20-minute CNC cycle remains 20 machine minutes. Twelve hours of curing is not twelve labor hours. Odoo's shop-floor documentation describes per-operator time and aggregation, supporting the need to label duration semantics precisely. [Odoo shop-floor tracking](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/shop_floor/shop_floor_tracking.html)

Allocation controls should flag overlapping employee sessions and hours unassigned to a job. Permit approved allocations across jobs without inventing more time than a person worked. Missing installation time means job cost is incomplete, not zero. Keep attendance reconciliation and payroll approval in their declared source systems initially.

Estimate-versus-actual reports separate material quantity, material price, labor duration, labor rate, approved scope changes and rework. Show cost-to-date separately from forecast completion cost. A forecast can combine actual incurred cost, remaining commitments and estimated work only after identifying overlaps; a received purchase already included in actuals must not be added again as an open commitment. The agreed customer price changes only through its commercial workflow.

### Controlled production files

Link the released drawing, BOM/part list, nesting report, setup sheet, target machine/postprocessor when supplied, NC files, hashes, generation date and approving person. Autodesk documents NC programs as groups of selected operations with machine/postprocessor context and generated outputs. That is why a loose filename is insufficient to establish readiness. [Autodesk NC program reference](https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-NC-OLD-V-NEW)

Draft revision D should not silently replace released revision C on the operator screen. Releasing D identifies affected pending or in-progress operations; completed work remains tied to what it actually used. Odoo 18's engineering-change versioning provides a reference for preserving older BOMs, instructions and design files. This source is explicitly version 18; verify the selected customer's actual system separately. [Odoo 18 version control](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/plm/manage_changes/version_control.html)

Diomedes may display, distribute and check approved production packages. This plugin does not generate unreviewed NC code, select machine parameters autonomously, start a CNC machine, or certify a machine-safe setup. "Ready for review" is the appropriate result when prerequisites are checked; physical setup and machine execution remain with the operator and established CAM controls.

### Site work and high-end completion

Track assemblies/packages through workshop, staging, truck/transit and site receipt. Record quantity, condition, receiving person and discrepancies. Delivery, installation and customer acceptance are different milestones. A site transfer does not create another copy of the same inventory.

The installation packet contains approved drawings, relevant measurements, prerequisites, assigned workers and controlled site notes. Field discoveries create an issue linked to the affected room/assembly. Where the business uses subcontractors, record their commitments and approved work separately from employee time.

Punch items need a location/assembly, description, owner, target date, supporting photos, responses and verification. Procore documents project-linked punch items with responsibility, attachments and history. Use the pattern to retain accountable closure and associated rework material/time. [Procore punch items](https://support.procore.com/products/online/user-guide/project-level/punch-list/tutorials/view-a-punch-list-item)

### Diagnostic playbooks

| Symptom | Evidence to check | Allowed conclusion and next step |
|---|---|---|
| We keep running short of MDF | Counts, holds, reservations, issues, saved remnants, returns and plan revisions | Identify a reconciled shortage or missing entries; propose a count/reconciliation task |
| This kitchen exceeded its allowance | Baseline, approved changes, consumed quantities, price/rate snapshots, labor coverage and rework | Separate explained overruns from unrecorded work; preserve original and current budget comparisons |
| CNC jobs keep getting remade | Released versus used file versions, recorded remake reasons, measurements and affected parts | Name evidenced revision/quality patterns; avoid inferring machine failure without machine evidence |
| Installers arrive before jobs are ready | Assembly completion, package contents, site prerequisites, changes and defects | A scoped list of remaining work and the responsible people |
| Our jobs show surprisingly good margins | Unallocated hours, missing receipts, delayed subcontract charges, remaining work and costing policy | Mark incomplete costs and request reconciliation before treating the margin as reliable |

Example finding: "Job K-104 used one more sheet than the approved allowance. A remake entry links that sheet to an updated sink-opening measurement. The customer change remains unapproved, and installation hours are incomplete. The current cost report is provisional; review the change and missing time before deciding whether the template needs adjustment."

Each finding links to actual records, names the period/revision, lists contradictory evidence and offers a concrete next step. No model-training project is required to learn a customer's approved terminology and rules: begin with a versioned business profile, mappings, documents and deterministic tests. Any later fine-tuning would need separate evidence that these mechanisms are insufficient.

### Screens and role scope

The operator's main screen is a job sheet: job/operation, released revision, material specification, quantities, rack/bin and a short action row. The installer opens the assigned site packet and outstanding work. The estimator/manager sees budget versions, readiness, shortages and approvals. The owner sees comparable job outcomes with coverage indicators.

```text
Job K-104 / Kitchen / CNC cutting        Jordan / Main workshop
Released package: C                     Stock checked: 10:12

1/4-inch MDF, 4 x 8, approved grade      Need 5 | Available 5
Rack B3                                 6 reserved elsewhere

[Reserve material] [Record material] [Start work]

Drawing C | Cut list | Setup sheet | Record an issue | Ask
```

This is a conceptual layout, not an implemented or visually tested screen. Keep units and revision labels near the decisions they affect. Scan a job/rack label where practical, and retain manual lookup. A shared iPad must show the active person before recording hours.

### First pilot acceptance cases

| ID | Fixture and required result |
|---|---|
| C01 | 12 full sheets, six reserved and one separate held sheet produce five available, with exact material/location/freshness. |
| C02 | Two devices request the last five sheets. One succeeds and the other receives a conflict with current availability. |
| C03 | Five issued, four cut, one returned; 128 square feet reconcile to 95 parts, 25 remnants and eight waste. Remnants do not become full sheets. |
| C04 | A large-enough-area remnant that fails dimensions/grain requirements is not promised as suitable. |
| C05 | Pooled-job allocations sum to batch cost with a visible policy/remainder and no false claim of measured per-job waste. |
| C06 | Pending drawing D does not replace released C; a later release identifies affected queued/started work. |
| C07 | Completion preserves original estimate, approved changes, current budget, actuals and reproducible variance. |
| C08 | Two workers x 30 minutes = one labor hour, alongside a separate 20 machine minutes. |
| C09 | A submitted issue with a lost response can be retried without a second stock movement. Offline reservation is visibly unconfirmed. |
| C10 | Damaged delivered material is returned and replaced with linked rework; punch closure requires verification. |
| C11 | Assigned workers cannot retrieve unrelated customer drawings, addresses, cost or attachments via direct IDs or chat. |
| C12 | Missing installation time prevents a complete-cost/margin claim and identifies the missing coverage. |

The first pilot should use one material family and one complete job, with one successful historical job and one overrun/rework packet for comparison where available. Add the customer's actual CAD/CAM export and field workflows after proving record conservation, job identity and revision control.
