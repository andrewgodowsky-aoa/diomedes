# Diomedes Local Business Plan

> **Retired prices removed, 2026-09-19.** By owner direction, Diomedes' own retired price figures were struck from this dated document and appear as "[retired price removed]". Market and hardware prices were kept as evidence. Totals and margins that were computed from the struck figures no longer have their inputs and are not current. Reason and scope: `docs/business/PRICING_STRATEGY_2026-09-15.md`, "Removed figures". Git history holds the original.

Version: 2026-09-15.1
Date: September 15, 2026
Status: Proposal for Andrew's decision. Nothing here is built, approved, priced or shipped. This plan covers the market, verticals overview, go-to-market, delivery operations, the first 90 days and the hiring trigger; every hour, minute, rate and threshold in it is a placeholder pending Andrew's decision unless it is quoted from an approved line or a named source.
Repository: docs/business/2026-09-15-local-business-plan.md
Cloud canonical: none yet.
Depends on: docs/business/2026-09-14-custom-capability-packs.md, the 2026-09-10 pricing checkpoint (removed 2026-09-19), docs/business/MARKETABILITY_AND_INCOME_2026-09-10.md, the 2026-09-10 income-model inputs (removed 2026-09-19), docs/business/OPEN_DECISIONS.md, docs/business/2026-09-15-pricing-and-packaging-proposals.md, docs/business/income_model_2026-09-15_proposal.json, docs/business/2026-09-15-managed-inference-and-local-models.md, docs/business/2026-09-15-appeal-offers-catalog.md, docs/business/2026-09-15-roadmap-and-package-impact.md, docs/business/playbooks/README.md, docs/research/2026-09-15-local-business-program/ (notes 02, 03, 04a, 04b, 05, 07, 08, 10, 11, 12), docs/research/2026-09-14-smb-mcp-landscape/ADDENDUM_2026-09-15.md, docs/DIOMEDES_CORE_PILLARS.md

---

## How to read this plan

**Owner-directed expansion overlay:** `2026-09-15-private-ai.md` and pricing version 2026-09-15.3 supersede conflicting local-infrastructure scope/price suggestions below. Preserve the immediate internal/personal -> consultant -> narrow restaurant pilot -> measured case study -> repeatable hospitality sequence. Workload evidence may then justify private/hybrid infrastructure and optional Managed service. Older low-price examples in this proposal are historical and never quote the new infrastructure offering. The rest of this proposal retains its existing decision status.

- **Owner of each topic.** This plan owns market, verticals overview, go-to-market, operations, the 90-day plan and the hiring trigger. Prices, scope boundaries, guarantees, payment and referral terms, benchmarks and income-model parameters belong to `docs/business/2026-09-15-pricing-and-packaging-proposals.md` and `docs/business/income_model_2026-09-15_proposal.json`. Routes, provider terms, inference costs and hardware belong to `docs/business/2026-09-15-managed-inference-and-local-models.md`. Offers, lines and objections belong to `docs/business/2026-09-15-appeal-offers-catalog.md`. Patch text belongs to `docs/business/2026-09-15-roadmap-and-package-impact.md`. This plan links to those rather than restating them.
- **Labels used.**
  - **APPROVED** means a line from the approved price table in the 2026-09-10 pricing checkpoint (removed 2026-09-19).
  - **PLACEHOLDER** means an invented number, pending Andrew's decision. It is not a forecast, a commitment or a measurement.
  - **SYNTHETIC** means an invented example business or data set.
  - **INCOME-2026-09-10** means a modelling assumption in the 2026-09-10 income-model inputs (removed 2026-09-19). Those are themselves unverified planning allowances, per that file's notes.
  - Market figures carry **high / medium / low** confidence from the Verification section of the cited research note.
- **Computed numbers.** Every computed number was produced by a script (`node`) from the stated inputs. The formula sits next to each result. The scripts live under `docs/business/scripts/2026-09-15/` in the repository (run from the repository root with node).
- **Playbooks.** The playbook paths below are frozen. All of `01`-`13` and the four vertical playbooks (restaurant, home-services-and-trades, professional-services, nonprofits) now exist in the working tree.
- **Status honesty.** Per `F:/Diomedes/diomedes-site/src/data/status.ts` today:
  - Connections run on a synthetic three-restaurant fixture only.
  - Business setup and managed usage are in development, and there is no entitlement backend.
  - Paid agent, local models, scheduling and phone access are planned.
  - No business pack, registry connector, consultant role, hosted runner, managed inference, signing or configuration store exists.
  - The Guided/Technical view is not in `status.ts`.

---

## 1. Summary

**What Diomedes Systems sells.** A small business gets one recurring piece of work set up once. It is connected to the systems the business already uses, or to exports from them, and kept true after handoff. The unit of sale is a working, measured result on one workflow. That is the pilot pack on the bounded workflow pilot line. It is preceded by paid discovery and followed, where the result earns it, by a full pack, Diomedes Business, Managed Diomedes and expansion. The proposal is `docs/business/2026-09-14-custom-capability-packs.md` §2, §5 and §7. The positioning line is a design target from proposal §10, not a published claim: "Your business, set up once, connected to what you already use, and kept true."

**To whom.** Owner-operated local businesses in the Triangle (Raleigh, Durham, Cary, Chapel Hill). The target business has:
- an authorized sponsor
- one repetitive coordination task that spans two or more sources
- data it may lawfully share
- delays that cost money

Four candidate verticals are under study: restaurant, home services and trades, professional services (bookkeeping, tax, small law) and nonprofits. None is decided (OD-12). The two research notes rank them differently (section 3.6).

**Why now.**
- Independent measures put small-business AI use at 17-24%: Census BTOS 17-20% nationally (high); JPMorgan Chase Institute 17.7% paid adoption (high); NFIB 24% (medium); NC LEAD 18.9% in North Carolina (high). Vendor surveys report 58-89% (medium; sponsor-run or narrowly scoped samples, `02_smb-ai-adoption-2026.md`).
- Firms under 20 staff lag: no significant change in BTOS AI use from December 2025 to May 2026 (high).
- Among North Carolina non-users, about 22% cite a knowledge gap and about 22% cite privacy (high, `02_smb-ai-adoption-2026.md` Verification).
- What owners are offered elsewhere is either narrow AI bundled inside one vendor, or a general assistant where the owner does the setup (`03_competitor-ai-offers-2026.md`).
- The research found no offer that sets up review-gated work across systems for the owner. That is an absence finding, not proof of a gap.

**What must be true.**
1. Customer work runs only on an allowed route with a named payer (OD-9, OD-10).
2. A legal and insurance floor is in place before any real business data is touched (OD-20).
3. The pilot pack is scoped tightly enough to hit about 10-12 delivery hours (OD-15).
4. Acceptance examples can pin the deterministic parts of the work (proposal §6).
5. Packs 2 and 3 take measurably less founder time than pack 1, or the offer narrows (proposal §8).
6. Support minutes per account stay below what the monthly price can carry (section 8.3).

**Decisions that block the first paid pilot on real data.**

| Order | Decision | Why it blocks |
| --- | --- | --- |
| 1 | OD-9 provider routes (urgent) | No customer work can run on a route whose terms are unsettled, including the Codex adapter question. |
| 2 | OD-10 consultation and pilot route and payer | Every quote must name route and payer. |
| 3 | OD-20 legal and insurance gate | Entity, services agreement and SOW, data-access consent, confidentiality, E&O and cyber quote, invoicing review. |
| 4 | OD-15 pilot pack versus full pack scope | Sets what the [retired price removed] line buys. |
| 5 | OD-12 then OD-3 | The vertical for pack 1, then the named pilot businesses. |
| 6 | OD-22 regulated-verticals policy | Needed only if the chosen pilot touches PHI, tax-return information, legal matters, insurance or card data. |
| 7 | OD-17 guarantee and OD-18 payment terms | Needed in the SOW. |
| 8 | OD-11 consultant access | Needed before anyone other than Andrew touches a customer workspace. |
| 9 | OD-27 pilot-to-Business conversion | The pilot's exit path while Business is not sellable. |
| 10 | OD-26 execution host | Only if the pilot needs scheduled runs. |
| 11 | OD-23 case-study consent | Only before any result is used outside the customer. |

Section 11 gives the full decision order.

---

## 2. Offer ladder mapped to the customer journey

### 2.1 The journey at a glance

```
Workflow Fit Call (free 60 min, fit only)
   |
   +--> Workflow Audit / Weak Point Map ([retired price removed])   -- the default paid first step for pack work
   +--> Cloud AI Quick Start ([retired price removed])             -- when the need is one working model route, not a workflow
   +--> Local Hardware and Model Plan ([retired price removed])    -- when data must stay on premises  --> Local AI Deployment (from [retired price removed] + hardware)
   |
   v
Pilot pack (Bounded workflow pilot, from [retired price removed])  -- one workflow, exports or admitted connectors, ends with a result card
   |
   +--> stop / narrow / repeat (result card decides)
   v
Full pack (Broader/custom implementation, from $2,500)  -- 1-2 connected systems, 2-3 verified workflows, or a new connector
   |
   v
Diomedes Business (planned from [retired price removed]/month per organization)  -- when sellable (OD-27)
   |
   v
Managed Diomedes (from [retired price removed]/month, optional)  -- after a working deployment, on named triggers (OD-25)
   |
   v
Expansion (separate quote line)  -- only after a documented result
```

Three commercial categories stay separate in every quote: **initial configuration**, **maintenance** and **expansion** (proposal §7). Continued focused consultation at $100/hour is available at any stage, after the client accepts price and scope.

Approved credits:
- The [retired price removed] plan fee may be credited to a qualifying deployment.
- A $200 audit credit may apply to a qualifying pilot of [retired price removed] or more within 30 days.
- Credits do not stack.

Credit mechanics and scope wording belong to `docs/business/2026-09-15-pricing-and-packaging-proposals.md`.

### 2.2 Stage cards

Founder-minute targets are **PLACEHOLDER** unless a source is named. Where an approved or proposed estimating control exists, it is cited, and the minute figure is that control converted to minutes.

#### Stage 0. Workflow Fit Call

| Field | Content |
| --- | --- |
| Price line | APPROVED: first 60 minutes free. Initial discovery and fit, not an unlimited audit or installation. No automatic paid continuation. |
| Entry criteria | A business, not a consumer. The person booking is the authorized sponsor or can bring them. The booking form collects business name, category and systems in use, with no personal data beyond a business contact. |
| What the call decides | Fit only (proposal §5.1): authorized sponsor present; one repetitive task named; one example of a good result described; systems involved listed. |
| Exit criteria | One of three written outcomes: (a) fit, with a recommended paid first step; (b) not now, with the reason; (c) not a fit, with a referral where one exists. |
| Customer receives | A one-page written summary within a PLACEHOLDER two business days (idea from `11_appeal-offers-and-objections.md` catalog #14). |
| Client inputs | A spoken description of the task and the good result; the list of systems. No data, exports, screenshots of records or credentials. |
| Exclusions | Data access; facts interview; building or configuring anything; compliance advice; any promise of connector compatibility before discovery on real accounts (proposal §4). |
| Founder-minutes target | PLACEHOLDER 90 (60 call, 30 preparation and summary). |
| Playbook | `docs/business/playbooks/01-fit-call-agenda.md`; leave-behind in `docs/business/playbooks/11-sales-collateral-kit.md` §7. |

#### Stage 1a. Workflow Audit / Weak Point Map

| Field | Content |
| --- | --- |
| Price line | APPROVED: [retired price removed] fixed. Written assessment of one recurring process, data, risks, options and next step. |
| Entry criteria | Fit outcome (a). Signed quote. OD-20 confidentiality and data-access consent in place before any real business information is discussed or shared. Regulated-data screen done (OD-22). |
| Exit criteria | Written weak-point map delivered and walked through. Draft organization facts captured. Baseline method agreed: timed or observed. The owner's own estimate is recorded separately and labelled as an estimate. Recommendation made: pilot pack, full pack, Quick Start, local plan, or not now. |
| Customer receives | The written assessment (one process, data sources and access route per system, risks, options, next step); the draft organization-facts sheet; a draft acceptance example if the pilot is recommended. |
| Client inputs | The facts interview (paid work; proposal §5.1). Access-route answers per system: official, community, API or export (proposal §4). Sample exports where approved. The name of the person who can time the current process. |
| Exclusions | Building, configuring or connecting anything; production access; legal, tax or compliance opinions; payroll, payments, vendor ordering, employment decisions, public publication (the 2026-09-10 pricing checkpoint (removed 2026-09-19)). |
| Founder-minutes target | 210, from the the 2026-09-10 pricing checkpoint (removed 2026-09-19) control of about 3-4 hours (midpoint). |
| Playbooks | `docs/business/playbooks/02-consultation-interview-guide.md`, `docs/business/playbooks/03-organization-facts-template.md`, `docs/business/playbooks/04-acceptance-example-template.md`. |

#### Stage 1b. Cloud AI Quick Start

| Field | Content |
| --- | --- |
| Price line | APPROVED: [retired price removed] fixed. One supported model/account route, one useful example, basic configuration and handoff. Custom connectors and production multi-user systems excluded. |
| Entry criteria | The need is one working route, not a workflow pack. The customer has chosen this line and the organization-authorized commercial account route it configures (OD-9, OD-10). That route is optional, never required, and customers are never expected to bring, buy or share an AI subscription for Diomedes work. No such route is verified for customer work today, so this line waits until a row of `2026-09-15-managed-inference-and-local-models.md` §2.2 is verified (§7 gate 'Provider routes'). Never a consumer chat subscription used for company work, and never Andrew's personal accounts as the runtime route that rehearses or runs the work (setup tooling is disclosed separately under OD-10). The route and payer are named in the quote. |
| Exit criteria | One example runs on the customer's machine with the customer's account; handoff notes delivered; the customer repeats the example unaided. |
| Customer receives | Configured route, one example, a short handoff note. |
| Client inputs | The commercial account, created and owned by the customer (Diomedes does not create accounts or enter the customer's credentials); one example task. |
| Exclusions | Custom connectors; production multi-user; workflow packs; any claim beyond what `status.ts` marks available. |
| Founder-minutes target | 180, from the the 2026-09-10 pricing checkpoint (removed 2026-09-19) control of about 2-3 hours (upper bound). |
| Playbooks | `docs/business/playbooks/07-handoff-and-first-week.md` for the handoff note; route rules in `docs/business/2026-09-15-managed-inference-and-local-models.md`. |

#### Stage 1c. Local Hardware and Model Plan, then Local AI Deployment

| Field | Content |
| --- | --- |
| Price lines | APPROVED: plan [retired price removed] fixed; deployment from [retired price removed] plus hardware; shared/team local deployment from [retired price removed]. |
| Entry criteria | The customer wants processing kept on premises, or cloud routes are ruled out by OD-22 policy. |
| Exit criteria | Plan: written recommendation for one deployment. Deployment: benchmark recorded, documentation and handoff delivered. The Diomedes connection is made only "where supported". `status.ts` lists local models as **planned**, so no Diomedes-local-model connection is promised today. |
| Customer receives | Plan: hardware and workload review and a written recommendation. Deployment: one machine, runtime and model, tuning, benchmark, documentation, handoff. |
| Client inputs | Workload description, current hardware, budget, and a hardware purchase made by the customer. |
| Exclusions | Hardware cost; vendor prices used as anchors; shared hosts (separately scoped). |
| Founder-minutes target | Plan PLACEHOLDER 180. Deployment 420, from the the 2026-09-10 pricing checkpoint (removed 2026-09-19) control of about 6-8 hours (midpoint). |
| Playbooks | None of the numbered playbooks covers this stage. Routes and hardware sit in `docs/business/2026-09-15-managed-inference-and-local-models.md`; handoff in `docs/business/playbooks/07-handoff-and-first-week.md`. |

#### Delivery checklists for Stage 1b and Stage 1c

No numbered playbook covers these two stages (corrected note above); this checklist stands in until one is written.

**Cloud AI Quick Start ([retired price removed] fixed; about 2-3 delivery hours per the 2026-09-10 pricing checkpoint (removed 2026-09-19)).**

Blocked until a runtime route is confirmed for customer work (section 7 gate "Provider routes"; OD-9).

1. Confirm the account is in the organization's name, who administers it, and that its terms cover business use (§7 gate "Legal and insurance floor"; OD-20). The customer creates the account; Diomedes Systems does not enter the customer's credentials.
2. Set the spending limit and name who may change it.
3. Install the Windows preview. State that it is unsigned and tested on one Windows 11 build (`status.ts`).
4. Set the thread permission mode to "Show me first" (`status.ts`: available).
5. Run one recorded test turn and review it in the saved run inspector (`status.ts`: available in the development Console).
6. Practise one restore from History (`status.ts`: available).
7. Hand over a one-page route card: account, payer, spending limit, who can change it, how to revoke access.

Exclusions: no workflow pack, no connector, no scheduled work.

**Local Hardware and Model Plan ([retired price removed] fixed).**

1. Collect the workload description and current hardware.
2. Assess fit per `docs/business/2026-09-15-managed-inference-and-local-models.md` §7.4.
3. Check the licence of the exact model file and quantization (§7 gate "Regulated verticals").
4. Check power, noise and placement.
5. Write a plain statement of what "local" does and does not mean for this customer (`docs/business/2026-09-15-managed-inference-and-local-models.md` §7.6).
6. Deliver a written recommendation, credit note included: "[retired price removed] may be credited to the qualifying deployment; credits do not combine."

**Local AI Deployment (from [retired price removed] plus hardware; shared or team from [retired price removed]).**

1. The customer buys the hardware.
2. Install the runtime.
3. Measure tokens per second on the customer's actual model and machine. Record it; do not quote community reports.
4. Tune.
5. Hand over documentation.

The quote states: "A Diomedes connection to a local model is not available today (`status.ts`: local-models planned); this deployment delivers the machine, runtime, tuning, benchmark and documentation." Whether the price line's "Diomedes connection where supported" clause is scoped out, or kept with that statement, is OD-42, raised in `docs/business/2026-09-15-managed-inference-and-local-models.md` §7.5.

#### Stage 2. Pilot pack

| Field | Content |
| --- | --- |
| Price line | APPROVED: bounded workflow pilot, from [retired price removed]. One narrowly specified, measurable workflow using available integrations or approved exports, with testing and a stopping point. Target 10-12 delivery hours. |
| Scope (frozen program fact, OD-15) | One workflow. Approved exports or connectors already admitted to the registry. No new connector. Runs through rehearsal, shadow comparison and activation, ending with a result card. |
| Entry criteria | Audit or pilot first session complete. Organization facts drafted. At least one acceptance example with a stop-or-ask case. Timed or observed baseline captured. SOW signed with route and payer named (OD-10), stopping point, change control, guarantee and payment terms (OD-17, OD-18). OD-20 cleared. OD-22 screen passed. Pack labelled unsigned local manifest. |
| Exit criteria | Result card issued. Owner decision recorded: activate, narrow, repeat or stop. Handoff done with named duty owners, a manual fallback and one practised restore (proposal §5.2). Conversion path stated (OD-27). |
| Customer receives | One working workflow on rehearsal data, then shadow comparison against the current process, then activation. The result card. A two-view handoff document (OD-8). |
| Client inputs | Approved exports or sign-in to admitted systems by the customer; one rehearsal watched (proposal §2, step 3); a named reviewer for shadow comparison; baseline timing. |
| Exclusions | New connectors; payroll, payments, vendor ordering, employment decisions, public publication; payment card data; trust-account fund movement; any write action not reviewed first ("read is not write", Pillar 3); scheduled runs unless an execution host is decided (OD-26). |
| Founder-minutes target | 720 when templated (the approved 12-hour upper target). PLACEHOLDER 1,200 for a first pack in a new vertical (20 hours; placeholder pending Andrew's decision, from the pricing map). |
| Playbooks | `docs/business/playbooks/05-pilot-sow-outline.md`, `docs/business/playbooks/04-acceptance-example-template.md`, `docs/business/playbooks/06-measurement-protocol-and-result-card.md`, `docs/business/playbooks/07-handoff-and-first-week.md`, plus the vertical playbook under `docs/business/playbooks/verticals/`. |

#### Stage 3. Full pack

| Field | Content |
| --- | --- |
| Price line | APPROVED: broader/custom implementation, from $2,500. the 2026-09-10 pricing checkpoint (removed 2026-09-19) allows custom quotes of $2,500-$7,500. |
| Scope (frozen program fact, OD-15, OD-2) | One or two connected systems and two or three verified workflows, or any pack needing a new registry connector. |
| Entry criteria | A pilot result card showing net time returned, or a documented equivalent. Connector discovery done on real accounts. For any new connector: admission checklist started, vendor gates identified (Square allowlist; Intuit about 7 days average initial security review; Google CASA for restricted scopes; proposal §4.3). |
| Exit criteria | Each workflow passes its acceptance examples. Any generated connector passes review, restricted testing, approval and a pinned release. Result card per workflow. Handoff updated. |
| Customer receives | Two or three verified workflows; connector admission record where applicable; updated handoff. |
| Client inputs | System access by the customer; reviewers per workflow; vendor-application cooperation where a vendor gate applies. |
| Exclusions | As the pilot, plus any connector that fails admission. That work falls back to exports. |
| Founder-minutes target | 1,800, from INCOME-2026-09-10 steady-case custom project hours (30). A new connector adds PLACEHOLDER 960 build and 360 certification (16 and 6 hours; placeholders pending Andrew's decision). |
| Playbooks | `docs/business/playbooks/09-connector-admission-checklist.md`, `docs/business/playbooks/05-pilot-sow-outline.md`, `docs/business/playbooks/06-measurement-protocol-and-result-card.md`. |

#### Stage 4. Diomedes Business

| Field | Content |
| --- | --- |
| Price line | APPROVED: planned from [retired price removed]/month per organization. Software and bounded paid-agent usage as released. Not unlimited users, locations, inference or support. Never described as including managed inference. |
| Status | Not sellable today. `status.ts`: business-setup in development; managed-usage in development with no entitlement; paid-agent planned. The conversion rule while Business is not sellable is OD-27. |
| Entry criteria | A working pack; the roadmap's own readiness criteria for Business met (see `docs/business/2026-09-15-roadmap-and-package-impact.md`); OD-27 settled. |
| Exit criteria | Not applicable (subscription). Review at 30/60/90 days of active use. |
| Customer receives | As released, nothing more. |
| Client inputs | Their own commercial model account, or a local route once a local-model adapter exists (`status.ts` local-models: planned; OD-9). |
| Exclusions | Managed inference; unlimited support; multi-location pricing until OD-14. |
| Founder-minutes target | 15 per account-month support (INCOME-2026-09-10), plus PLACEHOLDER 45 per pack per month maintenance (0.75 hours, placeholder pending Andrew's decision). |
| Playbook | `docs/business/playbooks/08-maintenance-and-support.md`. |

#### Stage 5. Managed Diomedes

| Field | Content |
| --- | --- |
| Price line | APPROVED: from [retired price removed]/month, optional add-on. Agreed maintenance, health review and limited support after a working deployment. |
| Entry criteria | A working deployment. Named triggers present (proposal from `10_services-pricing-and-packaging-benchmarks.md` §7.7). Whether an activated pack requires Managed is OD-25. |
| Exit criteria | Monthly health review delivered. Support minutes logged against the account (section 8.3). |
| Customer receives | Today: agreed maintenance and health review by a person under Managed Diomedes (from [retired price removed]/month, optional); the automated loop is a design target. Design target (none of this exists today; playbook 08): the keeping-it-true loop in proposal §5.5: prevention, auto-recovery, support agent, then a person. Example event: Square tokens expire every 30 days, so re-authorization recovery is routine. |
| Client inputs | Re-authorization when asked; a named duty owner. |
| Exclusions | Expansion work; unlimited support; new workflows. |
| Founder-minutes target | 90 additional per account-month (INCOME-2026-09-10: 1.5 hours). |
| Playbook | `docs/business/playbooks/08-maintenance-and-support.md`. |

#### Stage 6. Expansion

| Field | Content |
| --- | --- |
| Price line | A separate quote line on the pilot or custom implementation lines. |
| Entry criteria | A documented result on the prior pack (catalog #60 in `11_appeal-offers-and-objections.md`: expand only after a documented result). Maintenance events for the existing pack within the placeholder allowance. |
| Exit criteria | As Stage 2 or Stage 3 for the added scope. |
| Customer receives | An added workflow, location or connector. |
| Client inputs | As Stage 2 or 3. |
| Exclusions | Anything that turns one pack into a fork. Pillar 2 applies: one configurable Diomedes; configuration, not code branches. |
| Founder-minutes target | PLACEHOLDER 600 per templated workflow added (10 hours, placeholder pending Andrew's decision); per-location 15 per month (0.25 hours, placeholder). |
| Playbooks | `docs/business/playbooks/05-pilot-sow-outline.md`, `docs/business/playbooks/09-connector-admission-checklist.md`. |

### 2.3 Worked example of the ladder (SYNTHETIC)

**"Synthetic Bistro Group" (SYNTHETIC; three restaurant locations).** This mirrors the proposal §3.3 example.

- **Fit Call.** The sponsor is the owner. The task is "operating brief for yesterday". A good result is a one-page brief by 9:00. Systems are the POS, a scheduling tool and email. Outcome (a): an audit is recommended.
- **Audit, [retired price removed].** The facts interview records:
  - The business day ends after midnight.
  - Net sales is defined, with exclusions.
  - Location exceptions route to that location's manager.
  - The rule "never change prices or place orders" is recorded.
  - The POS is reachable by export today. No live connection is named until the access route is confirmed on the real account.
  - Baseline: the general manager is timed at 45 minutes per day, 6 days per week. The owner's estimate of "about an hour" is recorded separately.
- **Pilot pack, from [retired price removed], less the $200 audit credit, which may apply to a qualifying pilot within 30 days.**
  - Route and payer: named in the quote once a route is verified for customer work (none is today; OD-9, OD-10). In this synthetic example the customer chose its own commercial API account, which is optional and never required.
  - Acceptance example 1: yesterday's exports in, expected net-sales total (deterministic), a brief in the agreed shape.
  - Acceptance example 2 (stop-or-ask): a location's export is missing, so the brief stops and asks rather than estimating.
- **Result card.** See section 6.4 for the SYNTHETIC measures.

---

## 3. Who it is for

### 3.1 Shared profile of a strong prospect

From `docs/business/MARKETABILITY_AND_INCOME_2026-09-10.md`, strongest and weakest prospect, and proposal §2:

| Strong prospect | Disqualifier |
| --- | --- |
| Repeated coordination across two or more sources | Rare task, or a task an existing system already solves |
| A responsible buyer who is the authorized sponsor | No owner for the work, or no authority to share data |
| Data the business may lawfully share, by export or its own sign-in | Locked-down data with no export and a partner-gated API |
| Delays or errors that cost money | No budget |
| Willingness to change a small process and time the baseline | Wants the tool to make judgment calls (pricing, hiring, legal advice) without review (Pillar 8) |
| Can complete the three-step customer promise: show a task and good result; hand over exports or sign in; watch one rehearsal (proposal §2) | Needs payment card data, payroll, payments or vendor ordering in scope |

The founder's hospitality and remodeling connections are **introductions, not customers** (`MARKETABILITY_AND_INCOME_2026-09-10.md`).

### 3.2 Restaurant (standing candidate)

| Field | Content |
| --- | --- |
| Ideal profile (hypothesis) | Independent owner-operator or small group with a general manager who compiles a daily or weekly brief from POS, schedule and messages. More than one location makes the business-day boundary and location exceptions valuable. The POS supports export, or has an official connector route. Square's MCP server covers 40 services (`01_square-mcp-and-connector-generation.md`, corrected c4). Diomedes Connections today run on a synthetic three-restaurant fixture only (`status.ts`). |
| Candidate first workflows | Operating brief for yesterday; weekly labor-versus-sales summary; schedule draft with "Needs you" items (review before publishing to staff). |
| Disqualifiers | Wants price changes or vendor orders automated; card data in scope (PCI, out); franchise rules forbid outside tools; no manager to own review; peak-season onboarding. |
| Market note | The food-service AI adoption rate is unknown. An ~8% figure was refuted (`02_smb-ai-adoption-2026.md` Verification). The JPMC retail and food-service figures are spend shares, not adoption rates. |
| Reach | NCRLA has no Triangle chapter; restaurant dues from $385; member counts unverified (`08_local-acquisition-channels.md`). Chambers and POS resellers are hypotheses. |
| Vertical playbook | `docs/business/playbooks/verticals/restaurant.md` |

### 3.3 Home services and trades

| Field | Content |
| --- | --- |
| Ideal profile (hypothesis) | HVAC, plumbing and electrical scoped together to spread seasonality (`04a_verticals-home-services-auto-retail-property.md`). Owner-operator with an office person who chases estimates and invoices. Uses field-service software with an API or export. |
| Systems context | Jobber, Housecall Pro and ServiceTitan are common. CompanyCam has an API and an MCP beta. FieldEdge is partner-gated. For GC/remodel, the JobTread AI Connector MCP (read/write) launched 2026-04-16 (`03_competitor-ai-offers-2026.md`). No connector is admitted to a Diomedes registry today. |
| Candidate first workflows | Estimate follow-up drafts; morning dispatch brief; invoice-chasing drafts; warranty renewal reminders; EPA refrigerant record compilation (records drafted for review, not filed). |
| Disqualifiers | Wants customer-facing quotes or prices sent without review; only system is partner-gated with no export; onboarding during peak season; licensing or permit decisions expected of the tool. |
| Market note | JPMC paid adoption in Construction is 8.9% (high). HVAC job values and $200-$600/month software spend figures are unsourced estimates and are not used. Landscaping: IBISWorld 2026 counts 556,238 businesses (corrected c7). Cleaning: 74% under 20 employees (corrected c9). NAICS counts are unverifiable (c1). |
| Reach | HBA Wake about 2,700 members; Associate membership $675/year is the vendor route; Affiliate is for member employees only (`08`). The Greater Raleigh Chamber has 1,800+ members. |
| Vertical playbook | `docs/business/playbooks/verticals/home-services-and-trades.md` |

### 3.4 Professional services (bookkeeping, tax, small law)

| Field | Content |
| --- | --- |
| Ideal profile (hypothesis) | Bookkeeping or tax firm chasing client documents each period; law practice of one to five attorneys on Clio compiling matter status or intake summaries (`04b_verticals-appointments-professional-health-nonprofit.md`). |
| Systems context | Karbon API plus vendor MCP; TaxDome API in private beta; Clio API plus community MCPs; MyCase API on the Advanced tier. |
| Candidate first workflows | Missing-document chase drafts; weekly matter or engagement status brief; intake summary for attorney review. |
| Disqualifiers | Tax or bookkeeping firm without a written information security program and unwilling to write one: the FTC Safeguards Rule requires one regardless of size, and firms with fewer than 5,000 consumers are exempt only from 314.4(b)(1), (d)(2), (h), (i). Tax preparer unwilling to obtain IRC 7216 consent where it applies. Law practice unwilling to obtain informed client consent where NC 2024 FEO 1 applies to delegating substantive legal tasks to AI. Any trust-account fund movement. |
| Regulatory gate | OD-22 must be decided before a pilot here. The route must satisfy the policy (OD-9). |
| Market note | JPMC paid adoption, Professional services, 30.3% (high). Finance and Insurance 33.9% is a BTOS figure (high). |
| Reach | NC Bar Association and NCACPA Raleigh are hypotheses from `04b`. Bookkeepers and accountants as a referral channel appear in section 5.1. |
| Vertical playbook | `docs/business/playbooks/verticals/professional-services.md` |

### 3.5 Nonprofits

| Field | Content |
| --- | --- |
| Ideal profile (hypothesis) | Staffed organization in the $500K-$3M budget segment, reachable through the NC Center for Nonprofits (`04b`). A development or operations staff member owns recurring reporting. |
| Systems context | Bloomerang API. A Planning Center "official" MCP is unconfirmed. |
| Candidate first workflows | Donor acknowledgement drafts; grant-report data compile; volunteer schedule brief; board packet assembly. |
| Disqualifiers | All-volunteer with no staff owner; no budget line; donor card data in scope; any requirement to publish without review. |
| Market note | About 1.8 million registered nonprofits and about 1.3 million public charities (corrected, `04b` Verification). Weakest buying power of the four. What a nonprofit on Personal receives is OD-13. |
| Reach | NC Center for Nonprofits (hypothesis). Durham Chamber Non-Profit tier $400 (confirmed, `08`). |
| Vertical playbook | `docs/business/playbooks/verticals/nonprofits.md` |

### 3.6 Others, shorter

| Segment | Why it is not first | Notes carried |
| --- | --- | --- |
| Retail | Thin margins; judgment-heavy work (merchandising, pricing) | Faire API access unverifiable. Square prices Plus $49 and Premium $149 per location per month (`10` c9 corrected; dated context, not anchors). |
| Property management | Heaviest regulation | Broker license under G.S. 93A-2 (75 hours); trust accounts; Chapter 42 as corrected; G.S. 42-14.1 preempts local rent rules. Buildium Open API on Premium only; AppFolio Stack exists, API terms unverified. Triangle Apartment Association is a channel hypothesis. |
| Auto repair | No Triangle channel found | Shopmonkey self-serve API v3, 50+ endpoints, on all plans. Tekmetric partner-gated. Right-to-repair status as corrected in `04a`. |
| Appointment businesses (salons, fitness) | Mixed connector reach | Mindbody API; Boulevard API on Enterprise; Fresha and GlossGenius export-only; Calendly official MCP. |
| Dental, veterinary, insurance | Fourth tier in `04b` | HIPAA business-associate chain for dental; Dentrix and Eaglesoft partner-gated; Open Dental API by email application. The Codex route must not see PHI. Insurance GLBA enforced by the state. OD-22 first. |

### 3.7 The two research rankings, side by side (not reconciled)

The notes scored different sets with different weights. They are not comparable on one scale, and this plan does not pick between them.

**`04a_verticals-home-services-auto-retail-property.md`**, scores 1-5, weights: connector 25, job fit 20, Pillar 8 inverse 15, buying power 15, Triangle reach 15, seasonality inverse 10.

| Rank | Segment | Score |
| --- | --- | --- |
| 1 | Home services | 3.95 |
| 2 | Auto repair | 3.55 |
| 3 | GC / remodel | 3.35 |
| 4= | Cleaning / landscaping | 2.75 |
| 4= | Property management | 2.75 |
| 6 | Retail | 2.65 |

The note proposes home services second (after restaurant) and auto third.

**`04b_verticals-appointments-professional-health-nonprofit.md`**, scores out of 100, weights: job density 15, connector reach 20, regulatory inverse 15, buying power 15, Triangle reach 10, pillar fit 15, founder scaling 10.

| Rank | Segment | Score |
| --- | --- | --- |
| 1 | Nonprofits / churches | 67 |
| 2 | Small law | 62 |
| 3 | Bookkeeping / tax | 61 |
| 4= | Salons | 59 |
| 4= | Real estate | 59 |
| 6 | Fitness | 55 |
| 7= | Dental | 54 |
| 7= | Veterinary | 54 |
| 9 | Insurance | 47 |
| 10 | Childcare | 43 |

The note proposes nonprofits second and small law third, with dental, veterinary and insurance as a fourth tier.

### 3.8 Proposed vertical selection criteria for OD-12

A proposal. Weights are PLACEHOLDER pending Andrew's decision. Score each criterion 1-5, where 5 is best. Criteria 1, 3 and 7 are gates: a 1 on any gate disqualifies the vertical regardless of total.

| # | Criterion | How to score | Weight (PLACEHOLDER) | Gate |
| --- | --- | --- | --- | --- |
| 1 | Data route on real accounts | 5 = official connector or self-serve API confirmed on a prospect's account; 3 = export only; 1 = partner-gated with no export | 20 | Yes |
| 2 | Deterministic core | 5 = the output's key numbers are calculations an acceptance example can pin (Pillar 1) | 15 | No |
| 3 | Regulatory load within OD-22 policy | 5 = no regulated data; 1 = regulated data with no decided policy | 15 | Yes |
| 4 | Buyer and budget | 5 = owner-sponsor with a budget line for tools or services | 15 | No |
| 5 | Pack reuse | 5 = the same pack plausibly serves PLACEHOLDER three or more similar businesses with configuration only (Pillar 2) | 10 | No |
| 6 | Triangle reach | 5 = a channel with verified address, dues or access (`08` confirmed rows) | 10 | No |
| 7 | Judgment load | 5 = human review points are few and clear (Pillar 8); 1 = the core job is a judgment call | 10 | Yes |
| 8 | Seasonality | 5 = onboarding windows most of the year | 5 | No |

Formula: vertical score = sum over criteria of (score × weight) ÷ 5. The maximum is 100. The weights sum to 100 by construction.

Selection rule proposal:
- Restaurant stays the standing candidate.
- The second vertical is the highest scorer that has at least one named Triangle prospect able to start an audit within the 90-day window.
- The third is chosen only after pack 2 shows the repeatability target (section 6.3).

---

## 4. Market context

### 4.1 Verified adoption figures

All from `02_smb-ai-adoption-2026.md`, governed by its Verification section.

| Figure | Value | Confidence | Note |
| --- | --- | --- | --- |
| Census BTOS, national business AI use | 17-20%; 19.8% at May 3, 2026 | High | No significant change under 20 employees; under 20% at 4 or fewer employees; 37% at 250+. Releases every two weeks. Question wording changed November 17, 2025; a series break is the note's inference. |
| JPMorgan Chase Institute, paid AI adoption | 17.7% (December 2025; report April 14, 2026; 4.6M accounts) | High | Employer firms 26.1% versus nonemployer 15.3%. |
| JPMC by industry | Information 39.3%; Professional 30.3%; Education 29.5%; Construction 8.9%; Transportation 5.4% | High | Retail and food-service figures are spend shares, not adoption. |
| BTOS, Finance and Insurance | 33.9% | High | |
| JPMC monthly AI spend by cohort | 2019 cohort about $50 rising to about $90; 2024 cohort about $20 rising to about $29 | High | Context for willingness to pay, not a Diomedes anchor. |
| NC LEAD, North Carolina | 18.9% using; 22.4% planning; 23.2% of employees using | High | |
| NC Commerce (July 23, 2026), reasons for non-use | 63% not applicable; about 22% knowledge; about 22% privacy; about 7% cost; about 6% skills | High | |
| NC users, effect on work | Supplementing about 4x replacing; 10.0% replace employee tasks; 16.8% replace software; about 97% no employment change | High | |
| NFIB | 24% / 21% / 48% | Medium | Primary source unverified. |
| Vendor-sponsored surveys | U.S. Chamber 58% (generative AI); QuickBooks 77%; Goldman Sachs "more than three-quarters", 14% embedded, over 70% want training; Thryv 66% from 55%, 70% need training (n=561); Constant Contact 87% (marketing-scoped) | Medium | Label by sponsor. Different definitions; not comparable with BTOS or JPMC. |
| NEXT Insurance (n=1,500, April 2025) | Cost first concern at 55% | Medium | |
| OnPay (2019) | 86% view their accountant as a trusted advisor | Low | Old; used only as a channel hypothesis. |

Reading the figures:
- About one in five small businesses uses AI by independent measures. Firms under 20 staff lag.
- Privacy and knowledge are cited as often as each other in North Carolina, and cost much less.
- No survey measured demand for done-for-you setup. That is a gap, not a finding.
- Vendor ROI claims are not imported.

### 4.2 What owners are offered elsewhere

From `03_competitor-ai-offers-2026.md`, corrected. Prices are dated context, never anchors. "Aggregator" means the price was seen only on a third-party site.

| Category | Examples and corrected status | What the owner still does |
| --- | --- | --- |
| AI bundled in vertical software | Toast (POS from $69, aggregator). Square AI: "no additional cost" confirmed only in the Canadian release; US plan prices aggregator. Jobber AI Voice and Chat in beta on all plans; no paid receptionist add-on confirmed. Housecall Pro: CSR AI optional add-on; Analyst, Coach, Marketing and Help AI free. ServiceTitan ($245-398 per tech, aggregator). Clio base plans (aggregator; Duo unverified). JobTread AI Connector MCP, read/write, launched 2026-04-16. QuickBooks $38/$85/$140/$340. | Works inside one vendor's data. Cross-system work stays manual. |
| Horizontal assistants | Claude Team $20/$25, premium seats $100/$125, 2-150 seats, no training on data by default (high). Google Workspace $7/$14/$22 regular (high). ChatGPT Business pricing unverifiable. Copilot Business price unverifiable; base-plan requirement confirmed. | Owner does the setup, prompting, data gathering and checking. |
| Agent builders (DIY) | Zapier (approval toggle, guardrails, Agents Pro about $33.33/month), Lindy, Make, n8n, Relevance, Gumloop | Owner or a hired builder designs, tests and maintains flows. |
| Phone AI | About $50 to several hundred dollars a month | Narrow to calls. Diomedes phone access is **planned** in `status.ts`. |
| Local consultants and MSPs | No primary pricing found | A documented gap (`10` also lists MSP pricing as a gap). |

**Gap as found:** nobody offered cross-system work with review, set up for the owner, and the research found no rollback offered. Both are absence findings from a bounded search.

### 4.3 Positioning

From proposal §10. The lines are design targets and stay off the website until a capture from a real build backs them (`docs/business/playbooks/13-website-page-map-proposal.md`).

- Vertical AI is bounded to one vendor's data. General assistants put the setup on the owner. Diomedes sells the working result on one workflow, set up for the owner and kept true.
- Differentiators that are real today and can be shown on synthetic data (`status.ts` available):
  - threads with "Show me first / Go ahead"
  - history and restore
  - scoped permissions (synthetic smoke)
  - run inspector
- Everything else in the promise is a proposal: packs, connectors, managed support, scheduling, the Guided/Technical view.
- Full appeal lines and objection answers: `docs/business/2026-09-15-appeal-offers-catalog.md`.
- Do not use catalog idea #67 ("bring the ChatGPT subscription you already pay for"). It conflicts with OD-9 and the verified provider terms.

### 4.4 Honest limits

- There is no verified demand figure for done-for-you AI setup among Triangle small businesses.
- The pack mechanics (registry, signing, consultant role, hosted runner, entitlement) do not exist. Packs 1-3 are hand-built, unsigned local manifests.
- Live connectors to real vendor accounts are not built. Connections run on a synthetic fixture only.
- Scheduled work has no host (OD-26).
- The founder is one person. Every stage above consumes that person's hours until section 6.4's trigger fires.
- FTC substantiation and deception standards apply to claims made to business buyers (`07_legal-risk-insurance-terms.md` c16 corrected). No outcome claim is made without a measured result card and consent (OD-23).
- Sentiment toward AI is reported as cooling (Gallup, cited in `11`). Expect skepticism, not pull.

### 4.5 Market sizing by vertical (not sourced this pass)

No Triangle establishment count exists yet for any candidate vertical. Every vertical playbook flags the same gap and names the source to check (section 3.7's rankings are relative scores, not counts). This table records the source to run, not a result:

| Vertical | Suggested NAICS or source | Triangle counties | Establishments | Source and date | Confidence |
| --- | --- | --- | --- | --- | --- |
| Restaurant | 722511 full-service, 722513 limited-service (Census County Business Patterns) | PLACEHOLDER (Andrew decides: Wake, Durham, Orange, Chatham, others) | Not sourced | — | — |
| Home services and trades | 238220 plumbing and HVAC; 238210 electrical; 236118 residential remodelers | Same | Not sourced | — | — |
| Professional services | 541211, 541213, 541219 accounting and tax; 541110 lawyers | Same | Not sourced | — | — |
| Nonprofits | IRS Exempt Organizations Business Master File by county; the staffed mid-size segment of roughly $500K-$3M budget is this program's target segment (section 3.5) | Same | Not sourced | — | — |

This table, once filled, gives an establishment count, not a reachable-customer count. Reach (a channel with verified access) and affordability (a budget line for tools or services) are separate questions, scored independently in section 3.8's criteria 4 and 6.

---

## 5. Go-to-market

### 5.1 Channels and partner hypotheses

From `08_local-acquisition-channels.md` and proposal §8. All are hypotheses. Terms are OD-19. Channel-by-channel hour caps and the 12-week test calendar are in `docs/business/playbooks/12-partner-channel-plan.md` §1 and §5.

| Channel | Hypothesis | Evidence and confidence | First test | Constraint |
| --- | --- | --- | --- | --- |
| Bookkeepers and accountants | They see recurring manual reporting and are trusted | OnPay 2019, 86% trusted advisor (low) | Two conversations about a connector reality-check one-pager (catalog #52-57) | Their own client-confidentiality duties; referral disclosure |
| MSPs | They already hold IT relationships and access | MSP pricing undocumented (gap) | One co-sell conversation | Access and confidentiality (OD-11, OD-20) |
| POS and software resellers | Restaurant and retail owners ask them "can it connect" | Hypothesis only | One reseller conversation | No compatibility promise before discovery on real accounts |
| Web and marketing agencies | Adjacent service, same owners | Hypothesis only | One conversation | Endorsement disclosure |
| Insurance agents, bankers | Trusted local relationships | Compliance constraints noted in `08` | Low priority | Their compliance rules |
| SBTDC Raleigh, SCORE Raleigh, Wake Tech ESBC (Cary), Durham Tech SBC | Workshops reach early-stage owners | Wake Tech and Durham Tech addresses confirmed; SCORE medium; SBTDC unverified (403) | Offer a no-sales workshop (catalog #49 "AI office hours") | Public-program rules on selling |
| Chambers | Membership directories and events | Greater Raleigh 1,800+, $45/month tier (confirmed); Durham Non-Profit $400, Business $800 (confirmed); Chapel Hill-Carrboro about 600 (confirmed); Cary (medium) | Join one chamber only after two guest events | Dues are a cost against a founder-hour budget |
| Trade associations | Vertical reach | HBA Wake about 2,700 members, Associate $675/year; NCRLA no Triangle chapter, dues from $385, counts unverified; NCRMA dues unverified | Decide HBA Wake Associate after OD-12 | Join only for a chosen vertical |
| Triangle BNI, Rotary District 7710 | Structured referrals | BNI 30+ chapters, one per category (medium); Rotary about 48 clubs (medium) | Guest visits before joining (`08` I5) | Large recurring time cost |
| Google Business Profile | Local search presence | Real-world name required; video verification not mandatory | Set up when the business address question is settled | Eligibility of a home-based business is an open question |

Endorsements: the FTC Endorsement Guides require disclosing material connections. The Consumer Reviews and Testimonials Rule (16 CFR 465) has been effective since October 21, 2024 (high). Penalties for fake reviews run up to $53,088 per violation (`07` c17 corrected). No incentivized or fabricated reviews.

### 5.2 Prospect lists: businesses only

Proposed policy, pending Andrew's decision (OD-43):

| Allowed | Not allowed |
| --- | --- |
| Business name, category, city, public business website, public business phone or email, source and date collected | Personal social-media profiles, personal cell numbers, home addresses, family details, age or other personal attributes |
| Chamber or association directories as published, where their terms allow the use | Purchased consumer lists; scraped personal data; enrichment services that add personal data |
| Warm introductions with the introducer's permission recorded | Contacting anyone who asked not to be contacted; re-adding opt-outs |
| Inbound fit-call bookings | Compiling information about individuals across sources |

Template row:

| Business | Category | City | Public business contact | Source and date | Channel | Status | Opt-out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SYNTHETIC Example HVAC Co. | HVAC | Cary | info@ address on business site | Chamber directory, 2026-10-01 | Chamber | Not contacted | No |

Outreach rules:
- B2B calls are exempt from most of the Telemarketing Sales Rule, but 310.3(a)(2) and (a)(4) still apply (`08`).
- TCPA and CAN-SPAM specifics were not verified. Review them under OD-20 before any cold email or call campaign.
- Until then, outreach is introductions, events and inbound only.

### 5.3 Collateral and website

- Collateral kit: `docs/business/playbooks/11-sales-collateral-kit.md`. It covers the price sheet (approved lines only), vertical one-pagers, the SYNTHETIC result card, the fit-call leave-behind, email templates, claims rules and the synthetic demo script.
- Website page map: `docs/business/playbooks/13-website-page-map-proposal.md`.
- Rules this plan depends on:
  - **Captures before claims.** No customer-facing line goes on the site until a capture from a real build backs it.
  - **Public prices on the site** are OD-21.
  - **Demos use synthetic data**, labelled synthetic. The current `business.astro` restaurant demo is scripted and carries two disclosures (`12_website-and-sales-collateral-patterns.md`).
  - **Status comes from `status.ts`.** The Guided/Technical view and a Personal edition are not marked available.
  - **Accessibility**: WCAG 2.2 AA, with text contrast 4.5:1, UI components 3:1 and targets 24px (`12`, corrected).

### 5.4 Weekly founder time budget (hypothesis)

This is the business-program slice of Andrew's week. Product development is separate. `MARKETABILITY_AND_INCOME_2026-09-10.md` models 350-650 product-development hours a year on top of this.

| Bucket | Hours per week (PLACEHOLDER) | Contents |
| --- | --- | --- |
| Selling | 5 | Channel events, guest visits, partner conversations, fit calls, proposals |
| Delivery | 8 | Audits, Quick Starts, pilot and full-pack work, handoffs |
| Support and maintenance | 2 | Re-authorizations, acceptance reruns, health reviews |
| Program building | 5 | Templates, ledger, playbook fixes, proof captures, legal gate work |
| **Total** | **20** | |

Computed from this budget (script; 52/12 weeks per month):

| Quantity | Formula | Result |
| --- | --- | --- |
| Delivery hours per month | 8 × 52/12 | 34.67 |
| Delivery hours per quarter | 8 × 52/12 × 3 | 104 |
| Fit calls per month if half of selling time goes to fit calls at 1.5 hours each | (5 ÷ 2) × 52/12 ÷ 1.5 | 7.22 |

### 5.5 Funnel assumptions (PLACEHOLDER)

Formula: pilots per month = fit calls per month × p(fit call to paid first step) × q(paid first step to pilot). Fit calls per pilot = 1 ÷ (p × q).

| Fit calls per month | p | q | Paid first steps per month | Pilots per month | Fit calls per pilot |
| --- | --- | --- | --- | --- | --- |
| 4 | 0.25 | 0.25 | 1 | 0.25 | 16 |
| 4 | 0.25 | 0.50 | 1 | 0.5 | 8 |
| 4 | 0.50 | 0.25 | 2 | 0.5 | 8 |
| 4 | 0.50 | 0.50 | 2 | 1 | 4 |
| 8 | 0.25 | 0.25 | 2 | 0.5 | 16 |
| 8 | 0.25 | 0.50 | 2 | 1 | 8 |
| 8 | 0.50 | 0.25 | 4 | 1 | 8 |
| 8 | 0.50 | 0.50 | 4 | 2 | 4 |

All rates are placeholders, not forecasts.
- Sales-cycle context from vendor blogs (low confidence): SMB cycles of 14-30 days (Gradient.works), and a median of 38 days for 1-10 employee firms (Focus Digital).
- `08` infers that top-of-funnel volume is the binding constraint.
- The 90-day plan measures the real p and q.

---

## 6. Delivery operations

### 6.1 Who does what at each stage

Today one person, Andrew, holds every role. A consultant or contractor role does not exist in PB-01 (OD-11). "Reviewer" means a second person who checks a pack before activation; until OD-11 that is Andrew plus the customer's named reviewer.

| Stage | Andrew | Customer sponsor | Customer reviewer / duty owner | Diomedes (as available) | Template |
| --- | --- | --- | --- | --- | --- |
| Fit Call | Runs call; writes summary | Describes task, good result, systems | Not involved | Nothing | `docs/business/playbooks/01-fit-call-agenda.md` |
| Audit | Facts interview; writes weak-point map | Answers facts; approves exports | Times baseline | Nothing on real data until OD-20 | `docs/business/playbooks/02-consultation-interview-guide.md`, `docs/business/playbooks/03-organization-facts-template.md` |
| Quote and SOW | Writes SOW naming route and payer | Signs | Not involved | Nothing | `docs/business/playbooks/05-pilot-sow-outline.md` |
| Build | Hand-writes unsigned manifest; writes acceptance examples | Provides exports or signs in | Confirms expected outputs | Threads, scoped permissions, run inspector (available) | `docs/business/playbooks/04-acceptance-example-template.md` |
| Rehearsal | Runs on rehearsal data | Watches one rehearsal | Checks output | Show me first | Same |
| Shadow comparison | Compares with current process | Not involved | Runs current process in parallel | History and restore | `docs/business/playbooks/06-measurement-protocol-and-result-card.md` |
| Activation | Confirms acceptance pass; handoff | Decides activate / narrow / stop | Named duty owner; manual fallback; practised restore | "Needs you" for decisions | `docs/business/playbooks/07-handoff-and-first-week.md` |
| First 30 days | Logs minutes and events | Uses it | Reports issues | Health and monitoring are in development | `docs/business/playbooks/08-maintenance-and-support.md` |
| Connector work | Admission checklist | Vendor cooperation | Not involved | Connection-build is in development (read-only OpenAPI compiler, no real vendor) | `docs/business/playbooks/09-connector-admission-checklist.md` |

### 6.2 Capacity arithmetic

Inputs: the weekly budget in section 5.4 (PLACEHOLDER) and the stage hours in section 2.2.

**Formula A:** engagements per quarter if only that stage were delivered = (weekly delivery hours × 52/12 × 3) ÷ hours per engagement.

| Stage | Hours per engagement (source) | Engagements per quarter at 8 delivery hours/week |
| --- | --- | --- |
| Quick Start | 3 (`PRICING_STRATEGY` control) | 34.67 |
| Audit | 3.5 (`PRICING_STRATEGY` control, midpoint) | 29.71 |
| Local Hardware and Model Plan | 3 (PLACEHOLDER) | 34.67 |
| Pilot pack, templated | 12 (approved target, upper; equals the pricing §12 / income-model placeholder `pack_build_hours_templated` 10 plus 2 acceptance-example hours) | 8.67 |
| Pilot pack, first in a vertical | 20 (PLACEHOLDER) | 5.2 |
| Full pack | 30 (INCOME-2026-09-10) | 3.47 |

**SYNTHETIC quarter mix** (not a forecast): 3 audits, 2 Quick Starts, 1 first-in-vertical pilot pack and 1 templated pilot pack.
- Formula: mix hours = 3 × 3.5 + 2 × 3 + 1 × 20 + 1 × 12 = **48.5 hours**.
- Against 104 delivery hours per quarter, slack = **55.5 hours**.
- The slack is the reserve for overruns: the pricing map's PLACEHOLDER overrun is 8 hours per pack.

**Formula B:** accounts supportable = (weekly support hours × 52/12) ÷ hours per account-month.

| Account type | Hours per account-month (source) | Accounts supportable on 2 support hours/week (8.67 hours/month) |
| --- | --- | --- |
| Business with one pack | 0.25 support (INCOME-2026-09-10) + 0.75 pack maintenance (PLACEHOLDER) = 1 | 8.67 |
| Business plus Managed with one pack | 0.25 + 1.5 (INCOME-2026-09-10) + 0.75 (PLACEHOLDER) = 2.5 | 3.47 |

Reading: at these placeholders, support capacity fills before delivery capacity. Either support minutes per account fall (Pillars 6 and 11), or the support bucket grows at the expense of delivery.

### 6.3 Repeatability target

Frozen program fact: packs 2 and 3 take measurably less founder time than pack 1, or the offer narrows. Proposal §8 adds: "If by customer #10 the founder is still writing manifests by hand, this proposal has failed."

Proposed measurable form (PLACEHOLDER reduction pending Andrew's decision):

**Formula:** pack 2 founder minutes ≤ pack 1 founder minutes × (1 − reduction), and pack 3 likewise, with reduction = 0.20. Minutes cover every stage in the ledger: fit, interview, build, rehearsal, activation, first 30 days.

Founder-minutes ledger template, one row per pack. This is the P11 proof capture in the appendix.

| Pack | Vertical | Fit | Interview | Build | Rehearsal | Activation | First 30 days | Total | Ceiling | Pass? | Templates left behind |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (SYNTHETIC) | Restaurant | 90 | 150 | 480 | 180 | 120 | 240 | 1,260 | Not applicable | Not applicable | Facts sheet, acceptance examples, SOW, handoff |
| 2 | | | | | | | | | 1,008 | | |
| 3 | | | | | | | | | 1,008 | | |

Computed: 90 + 150 + 480 + 180 + 120 + 240 = 1,260 minutes (21 hours). Ceiling = 1,260 × 0.8 = 1,008 minutes.

**Vertical-specific minutes (diagnostic, proposal).** Because pack 2 is meant to be in a different context, the ledger also records, per pack, the minutes spent on vertical-specific discovery apart from reusable steps (templates, SOW assembly, acceptance-example scaffolding, handoff formatting). This column explains a miss and does not change the test. The ceiling stays pack 1's actual total × 0.8, as proposal §8 states the target. Whether a cross-vertical pack 2 should instead be judged on reusable-step minutes alone would amend proposal §8 and is a question for Andrew (with OD-12), not a rule adopted here.

Every hand step leaves a template (frozen fact), so the "templates left behind" column is required.

### 6.4 Contractor or hiring trigger (metric-based, PLACEHOLDER thresholds)

Principle from `MARKETABILITY_AND_INCOME_2026-09-10.md`: hire only against collected contribution and a delegable backlog.

**Preconditions.** All must hold before anyone else touches customer work:
- OD-11 consultant access defined.
- OD-20 confidentiality and services terms cover subcontractors.
- The delegated work has a written playbook and a template.

**Triggers.** Engage a contractor when both T1 and T2 hold, plus either T3 or T4:

| # | Metric | Threshold (PLACEHOLDER) | Computed reference |
| --- | --- | --- | --- |
| T1 | Collected contribution over the trailing 90 days covers the next 90 days of contractor cost | Contractor cost = hours per week × 52/12 × hourly rate | 10 h/week at $40 = $1,733.33/month; 10 h/week at $50 = $2,166.67/month; 20 h/week at $40 = $3,466.67/month ($41,600/year, matching `MARKETABILITY_AND_INCOME_2026-09-10.md`) |
| T2 | Delegable backlog of signed, templated work | ≥ 3 weeks of delivery hours | 8 × 3 = 24 hours |
| T3 | Support and maintenance share of program hours, 4 consecutive weeks | ≥ 25% of the 20-hour week | 5 hours per week |
| T4 | Program hours over budget, 4 consecutive weeks | Actual total > 20 hours by 25% or more | Not computed; depends on the log |

The $40/hour rate is the illustration in `MARKETABILITY_AND_INCOME_2026-09-10.md` and the 2026-09-10 pricing checkpoint (removed 2026-09-19). The $50/hour rate is the contractor assumption in the 2026-09-10 income-model inputs (removed 2026-09-19). Neither is a quote.

**First delegation candidates**, in order: acceptance-example reruns and re-authorization recovery; export preparation; handoff document formatting. **Never delegated first**: the facts interview, route and payer decisions, anything under OD-22.

### 6.5 Support model

Support is quoted and delivered as `docs/business/playbooks/08-maintenance-and-support.md` sets out:
- Three quote categories.
- The keeping-it-true loop: health checks, re-authorization recovery, acceptance reruns, facts drift.
- Support order: prevention, auto-recovery, support agent, then a person.
- Severity levels with placeholder response targets.
- Support minutes tracked against price per account.
- Offboarding with configuration export and data export kept separate.

This plan adds one operating rule: support minutes are logged per account from day one of activation, because section 8.3's break-even depends on them.

A failed acceptance example blocks the workflow and opens "Needs you" (frozen fact). It is not silently retried.

### 6.6 Founder unavailability and continuity

The appeal catalog's answer to "Is this a real company? You're one person" promises a written statement of what happens if Andrew is unavailable, delivered before the customer depends on an activated pack (`docs/business/2026-09-15-appeal-offers-catalog.md` line 435). No pack is activated today; the points below are design commitments for that statement, not current facts, and they add row 17 to the risk register in section 9.

1. **The pack is designed not to need Andrew to run.** Every activated pack will have a manual fallback and a practised restore (playbook 07). Daily operation is designed not to require Andrew to be reachable. Re-authorization is done by the customer's named duty owner (section 6.1; proposal §5.2).
2. **The customer holds its own setup.** The configuration export and the data export are handed over at handoff and after every change, and stored with the customer (proposal §5.2; playbook 08 §8).
3. **Access can be cut without Andrew.** The customer revokes access in each vendor's own console (playbook 08 §8). Diomedes Systems is designed to hold no vendor credential outside the vendor's own authorization flow (proposal §4.2).
4. **Backup contact (PLACEHOLDER; none exists).** A named person or firm, under a written agreement, able to read the handoff documents and help the customer apply the manual fallback. This is OD-51.
5. **Notice.** If Andrew is unavailable for more than a PLACEHOLDER number of business days, customers with active work are told by the backup contact or a pre-written notice.
6. **Prepaid work.** Unused prepaid hours or fixed-price work not started are refunded pro rata, or handled as the services agreement states (lawyer drafts; OD-17, OD-18, OD-20).
7. **Wind-down.** If Diomedes Systems stops offering the service: a PLACEHOLDER number of days' written notice, a final configuration and data export, and the revocation checklist (playbook 08 §8).

---

## 7. Legal, data and provider-terms gate

The checklist is `docs/business/playbooks/10-legal-readiness-checklist.md`. This plan fixes only where the gate sits in the journey.

| Gate | Decision | Must be settled before | Minimum content (from the register and frozen facts) |
| --- | --- | --- | --- |
| Provider routes (runtime) | OD-9 (urgent) | Any engagement that leaves a running workflow or rehearses one: Quick Start, pilot pack, full pack, deployment with a Diomedes connection | The customer's runtime route is named, paid for by a named payer, and its terms cover the work (`2026-09-15-managed-inference-and-local-models.md` §2.2). As the runtime route: never Andrew's personal provider accounts (roadmap hosted-reasoning rule), never a consumer chat subscription for company work, never OpenCode Go/Zen. Open question over the Codex adapter as before. |
| Founder setup tooling | OD-10 | Setup work on customer information (audit analysis, facts drafting, acceptance examples) | The tool and data class are within OD-10 limits and disclosed in the order (playbook 05 §6.1; proposal §5.4). Not blocked by OD-9. Founder tools are ChatGPT, Claude, Codex and Devin Pro (SWE-2), the last pending Cognition's written confirmation (OD-54). OpenCode Go and Zen are never used for customer work, including setup. |
| Route and payer per engagement | OD-10 | Every quote | Route and payer named in the quote. |
| Legal and insurance floor | OD-20 | The first paid engagement on real data (the audit counts) | Entity; services agreement and SOW; data-access consent; confidentiality; tech E&O and cyber quotes, asking about generative-AI exclusions (ISO introduced a generative-AI CGL exclusion in January 2026; form numbers unverified, `07` c14); NC CPA review of invoicing. |
| Regulated verticals | OD-22 | Any audit or pilot in dental, medical, tax, bookkeeping, law, insurance, or any work touching card data | HIPAA business-associate chain (consumer ChatGPT and Claude plans are not BAA-eligible; OpenAI API BAAs by request; Anthropic first-party API with exclusions and Enterprise HIPAA mode). FTC Safeguards written program. IRC 7216 consent. NC 2024 FEO 1 informed client consent. State-enforced insurance GLBA. PCI, with card data kept out. |
| Data handling | Frozen facts | Build | Manifests hold no credentials or business records; configuration export and data export are separate; POS and payment connectors read non-payment data only. |
| Claims | FTC standards | Any collateral or site use | Substantiation for B2B claims; the endorsement and reviews rules in section 5.1; case-study consent (OD-23). |

---

## 8. Financial outline

### 8.1 Revenue building blocks by stage

Prices are APPROVED lines. Parameters, scenarios and credit mechanics are owned by `docs/business/2026-09-15-pricing-and-packaging-proposals.md` and `docs/business/income_model_2026-09-15_proposal.json`. The existing model is the 2026-09-10 income-model inputs (removed 2026-09-19) with `docs/business/MARKETABILITY_AND_INCOME_2026-09-10.md`. This table shows only the revenue per delivery hour implied by each line at the stage hours used in this plan.

**Formula:** revenue per delivery hour = approved (starting) price ÷ delivery hours.

| Block | Category | Price | Hours (source) | Revenue per delivery hour |
| --- | --- | --- | --- | --- |
| Fit Call | Sales cost | $0 for 60 minutes | 1.5 (PLACEHOLDER) | $0 |
| Quick Start | Initial configuration | [retired price removed] | 3 (control) | $99.67 |
| Audit | Initial configuration | [retired price removed] | 3.5 (control) | $100.00 |
| Local Hardware and Model Plan | Initial configuration | [retired price removed] | 3 (PLACEHOLDER) | $83.00 |
| Pilot pack, templated | Initial configuration | from [retired price removed] | 12 (approved target; pricing §12 placeholder 10 build + 2 acceptance hours) | $104.17 |
| Pilot pack, first in vertical | Initial configuration | from [retired price removed] | 20 (PLACEHOLDER) | $62.50 |
| Audit then pilot, with $200 credit | Initial configuration | [retired price removed] + [retired price removed] − $200 = $1,400 | 3.5 + 12 = 15.5 | $90.32 |
| Full pack at its starting price | Initial configuration | from $2,500 | 30 (INCOME-2026-09-10) | $83.33 |
| Diomedes Business | Recurring (planned; not sellable) | [retired price removed]/month | See 8.3 | See 8.3 |
| Managed Diomedes | Maintenance | [retired price removed]/month | See 8.3 | See 8.3 |
| Expansion | Expansion | Quoted on the pilot or custom line | Per scope | Per scope |
| Continued consultation | Any | $100/hour | 1 | $100.00 |

Existing scenarios (quoted, not recomputed) from `MARKETABILITY_AND_INCOME_2026-09-10.md`:
- Validation / Steady / Strong first-12-month revenue: $12,454 / $38,940 / $92,495.
- Founder hours: 542.5 / 1,003.75 / 1,498.
- The planning target is $10k-$40k first-12-month revenue.

That document already notes a 12-hour pilot is about $104 per delivery hour and a 35-hour one about $36. The first-in-vertical line above shows why OD-15's scope discipline matters.

### 8.2 Where money is not made

- The free fit call is a sales cost.
- A first pack in a new vertical earns less per hour than the templated target.
- Connector builds are amortized, not billed in full to one customer. The pricing map's PLACEHOLDER is amortization over 3 customers (`docs/business/2026-09-15-pricing-and-packaging-proposals.md`).
- Legal and insurance: PLACEHOLDER $2,000 per year, from the pricing map.
- Payment fee assumption: 3% (INCOME-2026-09-10) and 3.9% (PLACEHOLDER, pricing map). The pricing proposal reconciles the two.

### 8.3 The risk that support cost exceeds price

Proposal §9 names this as a primary risk. Illustration using INCOME-2026-09-10 assumptions (API $15 per business-month, hosting $5, tools $10 per managed-month, payment 3%, labor at $50/hour) and the PLACEHOLDER pack maintenance load:

**Formula:** contribution before support = price − API − hosting − tools − price × 3%. Break-even support hours = contribution before support ÷ $50.

| Account | Contribution before support | Break-even support per account-month | Contribution at the stated load |
| --- | --- | --- | --- |
| Business [retired price removed] | $76.03 | 1.52 hours (91 minutes) | At 1 hour (0.25 support + 0.75 pack maintenance): $26.03. At 1.5 hours: $1.03, matching `MARKETABILITY_AND_INCOME_2026-09-10.md`. |
| Business [retired price removed] plus Managed [retired price removed] = $348 | $307.56 | 6.15 hours | At 2.5 hours (0.25 + 1.5 + 0.75): $182.56 |

Reading:
- A Business account with one hand-maintained pack has little room. One re-authorization incident plus a facts-drift fix can pass 91 minutes in a month.
- The mitigations are Managed on named triggers (OD-25), prevention and auto-recovery (proposal §5.5), and the section 6.5 minute log.
- Separately, the $15 API allowance is at risk under multi-call agent loops (`docs/business/2026-09-15-managed-inference-and-local-models.md`).
- Business at [retired price removed] never includes managed inference.

### 8.4 Startup cash before customer #1 (proposal; amounts blank unless sourced)

Not a budget this plan can approve; it lists the one-time items to price before the first paid engagement on real data (OD-20), separate from the recurring per-account costs in section 8.3.

| Item | Amount | Status |
| --- | --- | --- |
| Legal review, contract templates, E&O and cyber insurance, CPA invoicing review | PLACEHOLDER $2,000 per year (pricing map's `legal_insurance_annual_allowance`; not a quote) | Quotes not obtained (OD-20) |
| Entity formation and registered agent | Not sourced | OD-20 |
| Code signing for the installer | Not sourced | Not purchased; installer unsigned (`status.ts`); not required by any gate in this program |
| One chamber membership | Dated vendor cost, not a Diomedes price: Greater Raleigh 1-10-employee tier $45/month; Durham Chamber Business $800 (period as published) (confirmed, `08`) | Join one only after two guest events (section 5.1) |
| Booking tool (website Option B) | Not sourced | Playbook 13 §4 decision |
| Continuity backup-contact arrangement | Not sourced | OD-51: backup contact (section 6.6), if the continuity plan is adopted |
| Demonstration hardware for local deployments, if any | Not sourced | The customer buys deployment hardware (section 2.2 Stage 1c) |
| Founder setup tooling subscriptions | Andrew's existing accounts, including Devin Pro (under OD-10 limits, pending OD-54); business-expense treatment is an open question for OD-20's CPA review | OD-20 |

---

## 9. Risks and mitigations

| # | Risk | Likelihood (judgment) | Impact | Mitigation | Owner decision |
| --- | --- | --- | --- | --- | --- |
| 1 | Support cost exceeds price | Medium-high | Negative contribution per account | Per-account minute log; break-even alert at 91 minutes per Business month; Managed triggers; prevention first | OD-25 |
| 2 | Bespoke creep turns packs into forks | High | Founder time grows linearly | OD-15 scope; change control in SOW; three quote categories; Pillar 2 check at handoff | OD-15, OD-4 |
| 3 | Provider terms block a route in use | Medium | Customer work halts | Settle OD-9 first; route and payer in every quote; local and customer-account routes | OD-9, OD-10 |
| 4 | Vendor gates delay connectors | High | Full pack slips | Export-first pilots; admission checklist; Intuit about 7-day review and Square allowlist planned into timelines | OD-2 |
| 5 | Vendor MCP quality or change breaks a workflow | Medium | Silent wrong output | Acceptance reruns on any change; failure blocks and opens "Needs you" | None |
| 6 | Regulated data enters scope | Medium in professional services | Legal exposure | OD-22 screen at fit call and audit; card data out; PHI never on a non-BAA route | OD-22 |
| 7 | Export-only systems cap value | Medium | Manual export step remains | State it in the audit; measure net time including the export step | None |
| 8 | Organization facts drift | Medium | Wrong brief | Facts re-derivation in the maintenance loop (playbook 08 §2.4) | None |
| 9 | Overclaiming in sales or on the site | Medium | FTC exposure; trust loss | Captures before claims; claims rules in playbook 11 §9; consent for case studies | OD-21, OD-23 |
| 10 | Founder time does not fall between packs | Medium | Offer fails Pillar 11 | Repeatability target (6.3); stop-or-narrow criteria (10.4) | OD-12 |
| 11 | Top-of-funnel volume too low | Medium-high (inference from `08`) | No pilots | Channel test with hour caps (playbook 12); measure p and q | OD-19 |
| 12 | Business not sellable when pilots end | High today | No recurring revenue path | OD-27 conversion rule; Managed or maintenance quote as bridge where allowed | OD-27 |
| 13 | Scheduled work has no host | High today | Brief requires manual trigger | Scope pilots to on-demand runs until OD-26 | OD-26 |
| 14 | Consultant access undefined | Certain today | Cannot delegate | Solo delivery until OD-11; hiring precondition | OD-11 |
| 15 | Insurance excludes generative-AI claims | Unknown | Uninsured loss | Ask E&O and cyber carriers explicitly | OD-20 |
| 16 | Point-of-work proof (Pillar 4) unavailable | Certain today | Restaurant and trades appeal weaker | Do not claim tablet or phone use; phone access is planned in `status.ts` | None |
| 17 | Founder unavailable (illness, capacity, exit) | Unknown; not measured | Active customers lose support; trust objection in the appeal catalog goes unanswered | Continuity design in section 6.6; backup-contact agreement; exports held by customers | OD-51: backup contact |

---

## 10. First 90 days after adoption

Day 0 is the day Andrew adopts this plan, or a narrowed version of it. The week bands are gated. A milestone does not start until its named decisions are settled.

### 10.1 Weeks 0-2: decide and prepare

| Milestone | Gated by | Measurement checkpoint |
| --- | --- | --- |
| Settle provider routes; record allowed routes | OD-9 | Written route list exists |
| Settle route and payer rule for consultation and pilot | OD-10 | SOW template names route and payer |
| Start the legal floor: entity check, services agreement and SOW, consent, confidentiality, E&O and cyber quote requests, invoicing review | OD-20 (in progress) | Quote requests sent; checklist in playbook 10 started |
| Fix pilot pack versus full pack scope | OD-15 | Scope text in pricing proposal adopted |
| Adopt OD-12 criteria (3.8); score candidates; shortlist pilot businesses | OD-12, OD-3 | Scored table; 3-5 named prospects (businesses) |
| Produce synthetic proof captures P1, P8, P9 (appendix) | None (synthetic) | Captures stored with provenance |
| Set up founder-minutes ledger, support-minute log, prospect list (5.2) | None | Ledger template exists |
| First channel contacts per playbook 12 (public programs, one association) | None | Contacts logged with hours |

### 10.2 Weeks 3-6: first paid step and pack 1 build

| Milestone | Gated by | Measurement checkpoint |
| --- | --- | --- |
| Run fit calls | None | Count; founder minutes per call; outcome (a)/(b)/(c) |
| First paid Workflow Audit on real information | OD-20 cleared; OD-22 screen; OD-10 | Audit minutes against the 210 control; timed baseline captured |
| Pilot SOW signed | OD-15, OD-17, OD-18, OD-10 | Route and payer named; stopping point written |
| Build pack 1 (unsigned local manifest) on approved exports | OD-9, OD-20 | Build minutes; acceptance examples written with one stop-or-ask case |
| Rehearsal on rehearsal data; P10 synthetic result card prepared | None for synthetic | Acceptance pass rate |
| Channel events and guest visits | OD-19 for any referral terms | Founder hours per qualified fit call per channel |

### 10.3 Weeks 7-12: activate, measure, repeat once

| Milestone | Gated by | Measurement checkpoint |
| --- | --- | --- |
| Shadow comparison, then activation of pack 1 | Acceptance pass; customer decision | Verification failures; owner setup minutes |
| Pack 1 result card on real measures | OD-23 before any use outside the customer | Net time returned = timed baseline − Diomedes time − review − rework |
| Conversion path offered | OD-27, OD-25; OD-26 if scheduled | Written offer or stated reason for none |
| Start pack 2 in a context as different as possible from pack 1 (proposal §8 step 1), chosen by the §3.8 selection rule | OD-3, OD-12 | Ledger row 2 against the 1,008-minute ceiling (SYNTHETIC reference) |
| First 30-day support log review for pack 1 | None | Minutes against 91-minute Business break-even |
| Channel review (playbook 12, week 12) | None | Founder hours and qualified fit calls by channel |
| 90-day review with Andrew | None | Section 10.4 criteria applied |

**SYNTHETIC result-card arithmetic**, continuing the section 2.3 example:
- Timed baseline: 45 minutes × 6 days = 270 minutes/week.
- Diomedes run plus review: 10 × 6 = 60.
- Rework: 20. Maintenance: 15.
- Net time returned = 270 − 60 − 20 − 15 = **175 minutes/week** (2.92 hours/week; 11.67 hours per 4 weeks).

SYNTHETIC. It illustrates the formula and is not a claim.

### 10.4 Stop-or-narrow criteria (PLACEHOLDER thresholds)

| # | Condition at review | Action |
| --- | --- | --- |
| S1 | OD-9 or OD-20 not settled by week 6 | No engagement with a runtime route; audits on real information continue only if OD-10 and OD-20 are settled. Narrow to synthetic demonstrations and local-model plans otherwise. |
| S2 | Zero paid first steps after PLACEHOLDER 10 fit calls | Narrow the channel or vertical; revisit the fit-call outcome wording |
| S3 | Pack 1 total founder minutes > 1,440 (2 × the 720-minute 12-hour target) | Narrow pilot pack scope (OD-15) before selling another pilot |
| S4 | Pack 2 minutes above the ceiling (pack 1 × 0.8) | Do not start pack 3 in a new vertical; template the missed steps first |
| S5 | Acceptance examples cannot pin the workflow's key numbers deterministically | Drop that workflow from the catalogue (Pillar 1) |
| S6 | First-30-day support minutes for a Business-equivalent account > 91 in a month | Require Managed on that pattern (OD-25) or narrow the pack |
| S7 | Net time returned ≤ 0 on the result card | Stop the workflow; record the result honestly (Pillar 10) |
| S8 | Program hours exceed 25 per week for 4 consecutive weeks without trigger T1 | Cut selling first, then pause new audits |

---

## 11. Decisions needed, in the order they unblock work

| Order | Decision | Unblocks | Needed by |
| --- | --- | --- | --- |
| 1 | OD-9 provider routes (urgent) | Any engagement with a runtime route (Quick Start, pilots, deployments); route list. The Workflow Audit is gated by OD-10 and OD-20, not OD-9. | Week 2 |
| 2 | OD-10 consultation and pilot route and payer | Every quote and SOW | Week 2 |
| 3 | OD-20 legal and insurance gate | First paid audit on real information | Before week 3 work |
| 4 | OD-15 pilot pack versus full pack scope, with OD-2 | Pilot SOW; full-pack quotes | Week 2 |
| 5 | OD-12 second and third vertical and criteria | Prospect shortlist; vertical playbooks in use | Week 2 |
| 6 | OD-3 pilot businesses | Audits and pilots | Week 3 |
| 7 | OD-22 regulated-verticals policy | Any professional-services, dental or insurance prospect | Before such an audit |
| 8 | OD-17 guarantee and OD-18 payment terms | Signed SOW | Week 4 |
| 9 | OD-43 prospect-list and outreach policy (5.2) | Channel work beyond introductions | Week 1 |
| 10 | OD-49 weekly founder time budget (5.4) and stop-or-narrow thresholds (10.4) | Measurement and the 90-day review | Week 1 |
| 11 | OD-19 referral and partner terms | Partner referrals with disclosure | Week 5 |
| 12 | OD-11 consultant access | Any delegation; hiring trigger | Before T1-T4 fire |
| 13 | OD-27 pilot-to-Business conversion, with OD-25 | Pack 1 exit path | Week 8 |
| 14 | OD-26 execution host | Scheduled briefs | Before any scheduled workflow |
| 15 | OD-23 case-study consent | Any external use of a result card | Before collateral use |
| 16 | OD-21 public prices on the site | Pricing page | After first result card |
| 17 | OD-8 handoff document, OD-16 three-layer language, OD-14 multi-location unit | Handoff template; restaurant groups | Pack 1 handoff |
| 18 | OD-50 contractor trigger thresholds (6.4) | Hiring | Before first 90-day review |
| 19 | OD-1 pack contract, OD-4, OD-5, OD-6, OD-7 | Registry and signing after pack 2 (proposal §8) | After pack 2 |
| 20 | OD-13 Personal for solo professionals and nonprofits; OD-24 prompt book placement | Nonprofit offer; later execution pass | After OD-12 |

---

## Appendix. Proof captures the program can produce

From the roadmap map's pillar proof scenarios. Captures stay internal until a real build backs any public use (`docs/business/playbooks/13-website-page-map-proposal.md`). External use of real-customer captures needs OD-23 consent.

Provenance labels:
- **Synthetic**: invented data.
- **Approved export**: customer data used with written data-access consent under OD-20.

| ID | Pillar | Capture | Data provenance | Depends on | Producible now? |
| --- | --- | --- | --- | --- | --- |
| P1 | 1 | Operating brief with deterministic totals over an export, with the calculation shown | Synthetic (three-restaurant fixture); later approved export | Connections fixture (in development, synthetic only) | Synthetic only |
| P2 | 2 | The same weekly brief configured for two synthetic variants (restaurant and construction or professional services), with no code difference | Synthetic | Pack configuration by hand | Synthetic only |
| P3 | 3 | Operations update citing POS export, schedule export and email; writes shown as drafts; activation preview showing "reads only / cannot change / information age" | Synthetic; later approved export | Activation surface (OD-5) | Partial (drafts via threads; preview not built) |
| P4 | 4 | Tablet or phone at the point of work | Not applicable | Phone access planned | **Cannot be supplied** |
| P5 | 5 | Consultation first run: route, pack, export source, rehearsal, ready after verification; plus missing-connector fallback to exports | Synthetic | OD-9, OD-10 for route labels | Synthetic walk-through |
| P6 | 6 | Restaurant schedule draft with "Needs you" items for decisions only | Synthetic | Threads (available) | Synthetic |
| P8 | 8 | Acceptance examples including a stop-or-ask case that stops rather than guesses | Synthetic | Playbook 04 | Yes |
| P9 | 9 | Activation preview of needs and payer labels; check that the manifest holds no credentials | Synthetic | OD-10, OD-5 | Manifest check yes; preview not built |
| P10 | 10 | Pilot result card on rehearsal data, net time formula shown | Synthetic first; approved export after pack 1 | Playbook 06 | Synthetic yes |
| P11 | 11 | Expired-authorization recovery; founder-minutes ledger across packs 1-3 | Recovery synthetic; ledger from real engagements (internal records, no customer data) | Packs 1-3 | Ledger after pack 1 |
| P12 | 12 | Two-layer handoff document (plain layer, technical layer describing the same behaviour) | Synthetic | OD-8 | Synthetic draft |

P7 (engines interchangeable, true payer attribution) is not in the map's scenario list. P9's payer labels cover the attribution part.

---

## PILLAR IMPACT

- **Pillars engaged:** 1 (acceptance examples pin deterministic totals), 2 (packs as configuration, not forks), 3 (exports first, read is not write), 5 (self-setup through the three-step promise), 6 ("Needs you" only for decisions), 7 (route and payer named), 8 (judgment work excluded or reviewed), 9 (legal gate, card data out, separate exports), 10 (timed baseline, net time returned, no invented ROI), 11 (repeatability target, hiring trigger), 12 (Business adds configuration and service).
- **Tensions:**
  - Hand-built manifests for packs 1-3 run against Pillar 5 and Pillar 11. The plan bounds this with the repeatability target and proposal §8's customer-#10 test.
  - Founder time is linear until the section 6.4 trigger fires (Pillar 11).
  - Pillar 4 cannot be proven today.
  - Pilot payer and route rules constrain Pillar 7's "subscription you already have" framing (OD-9).
  - A timed baseline adds owner effort against the three-step promise (Pillar 10 versus Pillar 5).
  - Personal users (Pillar 12) wait on OD-13.
- No pillar is amended.

## ROADMAP IMPACT

If adopted, the roadmap would gain:
- a local-business delivery track (Fit Call, paid first step, written pilot, Business when sellable, Managed) with the stage criteria in section 2;
- the founder-minutes ledger and repeatability target as tracked measures;
- the 90-day gates in section 10.

Patch text for `docs/DIOMEDES_LIVE_ROADMAP.md`, project memory, PB specs and the execution package, and the list of stale items, are in `docs/business/2026-09-15-roadmap-and-package-impact.md`. This plan does not repeat them.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Written in the working tree on 2026-09-15. Nothing committed, pushed, published or mirrored to Drive. No code changed. No web search or fetch was used for this document. Computed figures came from local `node` scripts under `docs/business/scripts/2026-09-15/` in the repository.
