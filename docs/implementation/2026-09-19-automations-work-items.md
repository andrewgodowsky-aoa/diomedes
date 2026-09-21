# Automations — current delivery mapping and publication record

Version: 2026-09-19.1
Date: September 19, 2026
Status: Owner-authorized planning publication; application implementation pending
Owner instruction: update GitHub and Drive to reflect the Automations plan and remove stale mentions that could mislead models.

## Read first

Product/architecture/edge cases: docs/product/2026-09-19-automations.md, version 2026-09-19.1.
Strategy: docs/DIOMEDES_LIVE_ROADMAP.md, version 2026-09-19.1.
Definitions: docs/DIOMEDES_PROJECT_MEMORY.md, version 2026-09-19.1.
Core Pillars: unchanged. Existing H01/H12/SDKR/MH-1 contracts, prerequisite reviews, current coordination claims and Field Readiness ownership remain in force.

## Existing work, not a second initiative

BUS-10 owns the owner-facing Automations catalogue/detail and permitted organization/project/location projection. OPS-08 owns durable recurring-trigger admission through the existing Runtime. OPS-09 supplies truthful host/operating-window availability. OPS-10 supplies scoped notifications through existing Needs/evidence. Local Infrastructure operating windows reuse the shared scheduling capability; packs do not each gain a scheduler. Do not renumber the current execution program or create a competing runtime.

A — visibility first: catalogue/detail, plain-language purpose/limits, accountable owner, manual/active distinction, real run links, source freshness/coverage, result and existing controls. Weekly brief remains Manual — not scheduled. Prove ordinary Console navigation, an authorized invocation, missing input and durable evidence after restart. Production Business aggregation requires verified tenant controls, not fixtures.

B — one bounded recurring proof: one assigned host, daily/weekly draft workflow, durable occurrences and one shared Runtime scheduler feeding current admission. Prove timezone/DST, next-run preview, missed-run/overlap/deadline policy, duplicate prevention, pause/stop races, current authority/budget, sleep/restart and uncertain-effect handling. Do not imply multi-host failover or always-on service.

C — named supported events and production hardening: authenticated ingestion, credential lifecycle, deduplication/order/reconciliation, rate limits, destination-effect guarantees, scoped notifications and genuine multi-location identity/authorization. No arbitrary connector claim.

D — governed templates, remote extensions and measured value: pack configuration, reviewed plain-language setup, authorized device/host controls, separately proved takeover, baseline-backed net-time reporting. No unrestricted remote shell, invisible cloud/payer fallback or invented ROI.

The specification's A01–A36 matrix is required proof coverage, not 36 tests that passed. All four milestones are planned; source-only foundations do not complete any milestone. Detailed default choices and exact module/API design remain implementation-review work.

## Review handoff

Re-read current source and contract revision in an isolated authorized worktree. Find existing equivalents for definitions/occurrences before proposing modules. Map the UI to current task/run/Need/review/artifact/usage records and all commands to existing admission/Trust/cancellation/recorded-write paths. Review all 36 cases, especially duplicate effects, ambiguous sends, changing authority, schedule revision races, partial location data and stale health. Start with A; no pretend scheduling toggle.

Candidate navigation seams include client/console/types.ts, client/console/Shell.tsx, the activity projection, shared configuration/work-control contracts, server/weekly-brief.ts, server/harness/run-service.ts and server/harness/present.ts. A named seam is not permission to edit another worker's claimed file. Coordinate Trust/shared hot files with their owners.

Source finding retained for implementation review: generic non-idempotent approval copy promises undo from before/after records. Reversibility must be destination/action-specific. It is not fixed by this documentation patch.

Implementation acceptance requires focused unit, integration/Trust/recovery, browser/accessibility and named-byte packaged Windows proofs under the current repository gates and independent review. Record real counts/skips/failures; never copy historic green counts. This document does not authorize future code publication, deployments or production credentials/effects.

## Stale-guidance cleanup and preservation

The Automations draft is promoted to the current published plan, not to implemented functionality. The detached PROPOSED_CANONICAL_AMENDMENT.md and REVIEW_HANDOFF.md from the original downloadable draft package are historical; use the current specification and this handoff instead. A previously downloaded ZIP is not a live authority.

The roadmap and memory now share version 2026-09-19.1 across their existing canonical document IDs and repository paths. The September 17 MH-1 requirements remain; distinct repository PB/permission/Files/HAR-01/H22/release records are retained by reference rather than overwritten by the less complete cloud copy. Old release 'latest' wording, copied test counts and dated agent assignments have been removed from active entry-point guidance. Historical evidence is preserved, not rewritten as a current status.

Unaltered repository snapshots are retained at docs/reference/DIOMEDES_ROADMAP_PRE_AUTOMATIONS_2026-09-19.md (source blob 88b37cf45e734b268244dbda4f7a7901b0ea36ab) and docs/reference/DIOMEDES_PROJECT_MEMORY_PRE_AUTOMATIONS_2026-09-19.md (source blob d880c2b71395e07d4a8140725ff86e5026acddbc). Source commit: 448448683458c2ef813035f344baa79a4c6817bd. Read docs/reference/AUTOMATIONS_RECONCILIATION_2026-09-19.md before treating their dated prose as guidance.

Cloud snapshots: https://docs.google.com/document/d/18I5Y384mPcbT70AuH-N3wZA8cFodLq7xxczfAcC96bk/edit and https://docs.google.com/document/d/1rDyz3L4RqBEiZM39-nuk-8AZjs3UYkAfjQnSMqDRAfo/edit . Existing canonical IDs are retained; no duplicate active roadmap/memory is created.

Scope: active app planning entry points and the Automations specification. This does not rewrite every archived brief, downloaded bundle, local worktree, external agent context or marketing page. Their current consumers must refresh the canonical entry points. Prices, entitlements, application source, website source, installed builds and customer data are untouched.

## Verification and delivery boundaries

Documentation verification checks the 36 unique acceptance IDs, shared version/reference consistency, preserved MH-1 paragraphs, no product-source edits, immutable archive blob identities and post-write readback. A fast-forward-only Git ref update must reject a concurrently advanced main; Docs writes require a freshly checked revision. No force-overwrite is authorized.

Application typecheck/unit/build/browser/packaged tests are not run by this documentation-only publication and are not claimed green. Prior records remain historical evidence only. No model/provider calls, live automation, app release or website deployment are performed. Publication success and remote readback must be reported separately from implementation readiness.
