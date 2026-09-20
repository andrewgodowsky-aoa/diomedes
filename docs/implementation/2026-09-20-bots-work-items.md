# Bots: paired work orders and acceptance

Version: 2026-09-20.2
Status: proposed work orders, not active worker claims or completed implementation.
Contract: [Bots](../product/2026-09-20-bots.md). Launchers: [model-specific prompt book](../prompts/2026-09-20-bots/MASTER_PROMPT_BOOK.md).

## Execution rules

Fable remains integration lead; Astra remains independent acceptance lead. Opus is a bounded specialist or explicitly handed-off website worker. Existing ownership and prerequisite reviews win over this packet. Resolve the actual active master package and append these items without resetting its completed work. The historical September 12 prompt book is a structure/reference, not today's ledger.

Read AGENTS.md, current Pillars/roadmap/memory and the relevant focused contracts. Freeze exact shared interfaces and claims before consumer edits. Use accepted prerequisites or an explicitly documented safe subset, never a missing trust boundary. Bots is not grounds to rebuild H09, H12-H14, H17-H20, SDKR, identity, metering or Automations.

For each item return: ID; exact base and patch identity; owned paths and hashes; actual provider/model/route/profile revisions; commands and results; independent verdict; evidence locations; external blockers; implementation, review, live, packaged, documentation and deployment status separately. A mock does not prove a real provider, a provider run does not prove the installed app, and a published document proves neither. Commit, merge, push, release, paid calls and replacing Andrew's installed app retain their existing authorization boundaries.

Proposed concurrency: two bounded workers per lead and four across the program, or lower under current memory/resource limits. No recursive worker delegation. The shared heavy-test/live-call/Playwright/packaging slot remains exclusive. Prompts suggest behavior; Runtime enforces actual limits.

## BOT-00: rebaseline, scope and shared contract

Prerequisites: none for read-only analysis; existing coordination availability before claims.

Fable prompt: Reconcile this Bots proposal with current source, accepted H09/H12/H13/H14/H17/H18/H19/H20, Automations and the active master package. Report what can be reused, what needs a narrow extension and what is genuinely blocked. Preserve work already done. Define the Bot deployment, conversation binding and task-reference interfaces without copying evolving run state. Locate the actual master prompt files and produce an additive dependency patch. Record the external-message approval rule and proposed paid boundary. Freeze one contract with Astra before implementation.

Astra prompt: Independently inspect the same current base. Challenge only concrete ownership, authorization, recovery and data-flow gaps. Supply counterexamples and testable contracts, not a competing implementation. Check the draft distinguishes Bot, Agent, Model, Team, Automation, Project and Channel. Confirm it does not infer accepted foundations from roadmap text. Accept a narrow first slice or identify the precise missing prerequisite.

Acceptance: source-to-requirement map, dependency mapping, explicit claims and reconstructable contract; A implementation and B review statuses remain separate.

## BOT-01: identity, configuration and scoped knowledge

Prerequisites: BOT-00; relevant accepted identity/Trust/context contracts. First slice may be an explicitly local, single-owner development profile, never mislabeled production tenancy.

Fable prompt: Add the minimum versioned Bot deployment configuration over Agent and Project references. Implement draft, validation, rehearsal and activation through existing mutation/authority paths. Separate voice, source facts, reviewed procedures, proposed lessons and enforced policy. Pin revisions to admitted work. Keep tenant/audience and source-access checks at retrieval and egress, including citations and filenames. Do not create a second memory service or let rollback restore revoked access.

Astra prompt: Test cross-tenant IDs, low-privilege readers, owner departure, revision races, malicious source instructions and rollback after revocation. Prove that changing a name, pack, model or personality does not expand authority. Read egress metadata as well as answer text.

Acceptance: B01, B03, B09-B13, B28, B32.

## BOT-02: conversation admission and bounded workers

Prerequisites: BOT-01; accepted H12/H13/H14/H17, exact model profile and budget boundary.

Fable prompt: Route Bot work through ordinary task admission and RunService. A deterministic lookup stays deterministic. For substantial work, use an existing child run with source references, success criteria, output artifact, deadline, narrower grant, budget reservation and cancellation lineage. Observe real events and verify outputs before replying. Show missing input as a Need. Preserve provider conversation lineage and route/payer policy. No separate supervisor, worker queue or model-polling progress loop.

Astra prompt: Attempt recursive delegation, reservation overspend, late child results, fake completion, malformed tool calls, unexpected cloud fallback and cancellation/restart races. Compare the same job without delegation. A model response saying a tool ran is not a receipt. Check an unsupported route remains unsupported.

Acceptance: B07, B09, B14-B19, B32-B34.

## BOT-03: Console roster, setup and work inspection

Prerequisites: BOT-01 and frozen projections; real execution proof consumes BOT-02.

Fable prompt: Build Bots inside the existing Console and selected app appearance. Show a readable roster with job, accountable owner, availability and genuine attention state. Detail exposes conversation, work, knowledge and access without inventing parallel records. Create a plain-language setup/rehearsal flow and links to existing tasks, Team, Project, Needs and artifacts. Separate Pause future work from Stop current run. Preserve direct Agent use and existing navigation. Do not import the website's artwork or synthwave treatment into operational screens.

Astra prompt: Exercise empty, offline, missing-route, stale-source, blocked, approval-waiting, failed and partial-success states. Inspect long names, keyboard focus, narrow supported windows and zoom. Verify every displayed status and activity row resolves to evidence; no simulated worker progress in production UI.

Acceptance: B20, B27-B29; display B16/B24 correctly.

## BOT-04: one authenticated channel and delivery recovery

Prerequisites: BOT-02/03; accepted credentials, installation identity and information-flow controls.

Fable prompt: Prove one channel on an owned test installation. Evaluate the exact Chat SDK adapter against a small direct adapter and retain the simpler conforming route. Persist authenticated inbound receipts before acknowledgment, bind conversations by tenant/install/audience, deduplicate source events and preserve edit/supersession semantics. Feed ordinary admission; outbound delivery uses recorded effects/outbox and provider reconciliation. Implement human takeover and bounded bot-to-bot provenance. Respect the current outside-message approval boundary. Do not build six channels from a catalog.

Astra prompt: Replay and reorder events, duplicate IDs across installations, force lock expiry/release while a handler is still running, revoke group membership, change recipients after queueing and simulate provider timeout after acceptance. Confirm no blind resend, secret-bearing preview or stale queued bot reply after takeover. Authenticate exact approvals rather than trusting text 'yes'.

Acceptance: B02-B08, B11, B19, B21-B23, B31, B35.

## BOT-05: responsibilities, shared Automations and host eligibility

Prerequisites: BOT-02/03; accepted Automations BUS-10/OPS-08/09/10 capabilities for the selected subset. External notifications additionally require BOT-04.

Fable prompt: Link a Bot to an existing versioned Automation and explicit execution host. Reuse occurrence admission, timezone/DST, overlap, missed-run and pause semantics. Show why an enabled Bot or routine cannot run. Prove restart recovery and one daily/weekly draft-only responsibility before remote or multiple-host operation. A hosted model does not supply a hosted computer. No heartbeat or scheduler per Bot.

Astra prompt: Test sleep, restart, overdue work, DST gap/fold, changing a definition near trigger time, running while paused and expired authority. Keep unknown health visible. Simulate ownership handover and ensure already-issued effects are reconciled rather than duplicated. Refuse unsupported uptime guarantees.

Acceptance: B07, B20, B24-B25.

## BOT-06: paid eligibility and staged external extensions

Prerequisites: BOT-02; accepted server-side entitlement/metering before paid admissions. Each channel/voice/computer-use extension has its own reviewed contract and dependencies; this item does not authorize building all extensions at once.

Fable prompt: Add an entitlement hook for managed Bot deployment without deciding new prices, counts or tiers. Keep authority independent from payment, reserve parent and child usage together and preserve the pricing unit for one user request. On downgrade, block new premium admissions while retaining pause/stop, evidence and unresolved-effect recovery. Specify customer-facing draft/approval, voice/SMS and computer-use extensions separately, including provider requirements and measurable proof. Do not reinterpret the current ban on unattended external messaging.

Astra prompt: Race paid expiration and concurrent budget admissions, test unknown charges and ensure no approval or credential can be bought by changing a tier. Verify data/payer policy remains fixed. For any admitted voice/text extension, test interruption, transcript correction, duplicate turns and recipient opt-out before delivery. Do not certify an extension from its planning row.

Acceptance: B15, B17, B26, B30-B31. B30 and outbound consent cases remain blocked until that extension exists, not waived as passing.

## BOT-07: end-to-end proof and default-model comparison

Prerequisites: BOT-01/02/03 for the internal slice; BOT-04/05/06 only when claiming those features. Do not wait for all later extensions to prove the first useful Bot.

Fable prompt: Run an owned, non-coding example in the real app: create an operations Bot, select approved sources and a Project, admit a job, dispatch one useful real worker, inspect its artifact and return a checked result. Include a missing source, a correction and a controlled restart. Show the same durable task in conversation, Team, Project and review. Compare a single Agent, the lead/worker pattern and deterministic work where applicable. Record actual usage and latency, including corrections and review.

Astra prompt: Reconstruct the exact candidate and independently run the public journey. Verify sources/postconditions rather than screenshots of a claimed success. Separate fixture, live-provider, UI and installed-package evidence. Report unsupported claims and cost/latency tradeoffs without inventing a winner from incomplete observations. Hold release until applicable repository gates and explicit publication approval are satisfied.

Acceptance: B16-B18, B24, B27, B32-B34, plus all cases for the scope actually claimed.

## Required acceptance matrix

These 36 cases are required tests, not tests executed by this planning pass.

| ID | Adversarial or ordinary case | Required observation |
| --- | --- | --- |
| B01 | Tenant A input supplies Tenant B ID | Reject before retrieval or model access |
| B02 | Same external user ID across installations | Distinct scoped conversations |
| B03 | Public Bot requests private payroll | No content, count, title or preview disclosure |
| B04 | Low-privilege group reader requests privileged history | Audience-safe result, not inherited participant privilege |
| B05 | Duplicate webhook and reconnect replay | One admitted task; duplicate receipt retained |
| B06 | Edited request changes intended action | Explicit supersession; no silent extra effect |
| B07 | Crash before dispatch, after dispatch and after effect | Recover safely or expose uncertainty |
| B08 | Provider accepts send then times out | Reconcile; no blind resend |
| B09 | Owner leaves or grant changes mid-run | No further unauthorized effect |
| B10 | Bot/pack rollback after revocation or spend | Authority stays revoked; spend stays spent |
| B11 | Malicious attachment or tool-result instruction | Untrusted data cannot change policy |
| B12 | Learned candidate conflicts with approved rule | Inactive candidate, not self-promoted policy |
| B13 | Source/ACL changes after cache fill | Cached answer eligibility rechecked |
| B14 | Excess children or recursive delegation | Deterministic depth/concurrency enforcement |
| B15 | Concurrent Bots compete for remaining balance | Reservations prevent promised overspend |
| B16 | Child says done but lacks required evidence | Parent cannot mark verified |
| B17 | Fallback changes provider, payer or data policy | Block or obtain explicit eligible authorization |
| B18 | Malformed call, refusal or tool call printed as text | Bounded repair/Need; no fictional effect |
| B19 | Privileged child returns secrets to low-trust channel | Permitted projection only or withhold |
| B20 | Pause versus stop while job runs | Distinct truthful controls and partial results |
| B21 | Human takeover races with queued response | Future bot reply suppressed until handback |
| B22 | Bots echo and repeatedly mention each other | Provenance/hop limits terminate loop |
| B23 | Duplicate, expired or ambiguous approval | One exact authorized effect or refusal |
| B24 | Host asleep, restarted or migrated | Honest eligibility; no duplicate ownership claim |
| B25 | DST, overdue occurrence and overlap | Shared Automations semantics, recorded outcome |
| B26 | Paid eligibility expires mid-run | New premium work blocked; safety/recovery preserved |
| B27 | Missing credentials, source or supported model | Actionable blocked/setup state |
| B28 | Bot or model renamed during work | Historical attribution remains accurate |
| B29 | Long labels, narrow viewport, keyboard and zoom | Readable usable UI with stable focus |
| B30 | Voice interrupted or transcript retransmitted | No duplicated job or private audio escape |
| B31 | Recipient rights/consent change while reply queued | Recheck before delivery |
| B32 | Provider-bound history/profile changes | Valid native lineage; no cross-model opaque replay |
| B33 | Simple business lookup | Deterministic answer, no unnecessary worker |
| B34 | Real non-coding task, child, missing input and restart | Verified artifact and honest remaining Need |
| B35 | Group event replayed after membership change | No revived access |
| B36 | Website example or synthetic readout | Clearly an example, never a customer result or shipped capture |

B36 belongs to WEB-BOT-01 in the site counterpart. A failing case is release-blocking for a claimed capability; an unbuilt later capability is explicitly unclaimed in the implementation ledger. Marketing present tense does not change this evidence standard.
