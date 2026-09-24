# Overnight sprint, 2026-09-24: what landed and what it leaves open

Twenty-seven bounded lanes ran on 2026-09-24. Each has its own record,
`docs/implementation/2026-09-24-<lane>.md`, with its tests, gaps and gate counts. This page lists
them in one place. The canonical documents were reconciled from the records' proposed patches in
one pass: Live Roadmap and Project Memory 2026-09-24.2, and `QUESTIONS.md` O11–O34 and R9.

**Nothing here is released.** The latest release is 0.1.11. Batches 1 to 3 are source on app main
at `f13be72`; batch 4 is PR #106 (`integration/overnight-batch-4` at `ceb4836`), which is landing
on main now. No lane has live-provider, hosted, packaged-installer or device proof, and none claims
it.

How the work reached main:

- **Batch 1**: PR #86, merge `1b70c2e`. PRs #78, #79, #81, #82, #83, #84 and #85, plus
  `bugfix/ci-timing-flakes`.
- **Direct merges**: PR #74 (`de86916`), PR #75 (`5d73f1f`), PR #76 (`a08a694`) and PR #82
  (`9bd5147`, also carried by batch 1).
- **Batch 2**: PR #95, carried by batch 3. PRs #80, #87 and #91.
- **Batch 3**: PR #97, merge `f13be72`. PRs #88, #89, #93 and #96, plus batch 2.
- **Batch 4**: PR #106, open. PRs #94, #98, #99, #100, #101, #102, #103, #104 and #105, plus the
  integration fix `ceb4836`, which gives the H13 loop's tools the effect class and output schema
  H12 requires.

"Reviewed" means an independent whole-prompt review by a lane that wrote none of the code. A
lane marked "not reviewed" is implemented and tested by its own author only.

| Lane | Work item | Linear | PR → merge | Review | Key proposed defaults (QUESTIONS.md) |
|---|---|---|---|---|---|
| `automations-a` | Automations Milestone A: screen, Run once through RunService | DIO-89, DIO-90 | #85 → #86, main `1b70c2e` | Reviewed, accepted with one P2 fix (#91) | D1–D4 settled (R9); per-organization refusal of an unreadable file, label precedence, 9-unit budget (O11) |
| `h07-ready-scheduling` | H07 Ready queue: automatic start, fairness, pause | DIO-12 | #78 → #86, `1b70c2e` | Reviewed, accepted with one P1 consent fix (#91) | Auto-start off; limits 1 per project and 2 overall; a service route starts only as an exact re-send of a confirmed request (O13) |
| `remembered-approvals` | D5 remembered approvals for harness steps | — | #83 → #86, `1b70c2e` | Reviewed, accepted with three P2 fixes (#91) | Offer after 3; a decline restarts the count; one offer per item per project; remember only within 15 minutes (O14) |
| `h04-opencode-sessions` | H04 OpenCode kept sessions | DIO-9 | #82 → main `9bd5147` | Reviewed, accepted with fixes (#88) | Not a Console conversation route pending CD-01 Decision 5 (O19); steer consent (O18) |
| `p01-p03-pack-lifecycle` | P01 manifests, P03 install lifecycle | DIO-27, DIO-29 | #81 → #86, `1b70c2e` | Reviewed, accepted with nine P2 fixes (#88) | Built-ins preinstalled by Diomedes; a dependency asks; outward-request denylist kept (O28) |
| `editor-guard` | One exit gate for unsaved writing; settled file kind | DIO-85, DIO-87 | #84 → #86, `1b70c2e` | Reviewed, accepted with fixes (#88) | None |
| `audit-server-fixes` | Stale Discovery evidence, executable identity, UTF-8 limits | DIO-84, DIO-86, DIO-88 | #79 → #86, `1b70c2e` | Not reviewed | Binding revision counter does not move on a same-version byte change (O32) |
| `ci-flake-hardening` | Deterministic CI timing tests; change-review ledger label fix | — | `bugfix/ci-timing-flakes` → #86, `1b70c2e` | Not reviewed | None |
| `inventory-auth` | Local-principal authorization for inventory commands | DIO-95 | #76 → main `a08a694` | Not reviewed | `org:<id>` → `org.<id>`; permission mapping; stays unmounted; token always required (O33) |
| `h11-nested-rules-delivery` | H11 nested instruction files, precedence, delivery record | DIO-16 | #75 → main `5d73f1f` | Reviewed, accepted with four P2 fixes (#88) | AGENTS.md before CLAUDE.md; bounds 6 deep, 2000 folders, 32 files, hits unrecorded (O21) |
| `independent-reviews` | Reviews of PR #36 and PR #27; CD-01 contract marker | DIO-96, DIO-72 | #74 → main `de86916` | This is a review; its fixes were not re-reviewed | R36-4 "Nectovia is writing" against decision 8 (O34); R27-3 left open |
| `review-batch1-a` | Review of H07, Automations A and D5 | — | #91 → #95 → #97, main `f13be72` | This is a review | Person-owned tasks, *Confirm each start*, fail-closed classifier (O13, O14) |
| `review-batch1-b` | Review of H11, H04, P01/P03 and the editor guard | — | #88 → #97, `f13be72` | This is a review | Outward-request allowlist, steer consent, damaged pack (O18, O28) |
| `p05-files-attachments` | P05 drop and paste, previews, Thread attachments, file identity | DIO-31 | #80 → #95 → #97, `f13be72` | Not reviewed | Binary restore refused; no open-externally hand-off (O30) |
| `h17-verified-completion` | H17 four-state verification bound to exact bytes | DIO-22 | #87 → #95 → #97, `f13be72` | Not reviewed | Declared commands are recorded and never run (O25) |
| `automations-b` | Automations Milestone B: schedules, missed runs, pause, in-app attention | DIO-91, DIO-92, DIO-93 | #96 → #97, `f13be72` | Not reviewed | A nonexistent DST local time runs at the jump, where the specification says skip; 2-hour catch-up; owners and admins pause (O12) |
| `h08-durable-controls` | H08 six durable controls with receipts | DIO-13 | #93 → #97, `f13be72` | Not reviewed | Resume and Retry confirm, Stop and Fork act on the press; no uncertain-effect override (O16) |
| `h18-context-accounting` | H18 context accounting, selection, compaction | DIO-23 | #89 → #97, `f13be72` | Not reviewed | Carried history not summarised; bounds unchanged; no pin control (O26) |
| `h02-codex-controls` | H02 Codex Steer, Resume, Fork | DIO-7 | #98 → PR #106 (open) | Not reviewed | Keep Codex threads in the person's history only when resume or fork is offered (O17) |
| `d5-codex-proposals` | D5 for Codex proposals; task scope bound to ChatGPT account | — | #99 → PR #106 (open) | Not reviewed | Exact file set on one account; the task scope decides first (O15) |
| `h09-agent-profiles` | H09 exact-model profiles and routing | DIO-14 | #100 → PR #106 (open) | Not reviewed | Fallback off by default; a thread pin outranks lists (O20) |
| `h21-migrations-perf` | H21 migrations, crash matrix, perf gate, completion journey | DIO-26 | #101 → PR #106 (open) | Not reviewed | A newer file stops the service; backups kept; host record still replaced (O27) |
| `h12-mediated-effects` | H12 typed tools, effect records, containment | DIO-17 | #102 → PR #106 (open) | Not reviewed | Any interrupted write is uncertain; no Console reconciliation yet (O22) |
| `p06-diffs-review` | P06 readable diffs, per-hunk keep, review comments | DIO-32 | #103 → PR #106 (open) | Not reviewed | Readable diffs are Core, not the pack (O31) |
| `h13-native-loop` | H13 plan, act, observe, finish loop | DIO-18 | #104 → PR #106 (open) | Not reviewed (H13.R pending) | Unverified finish stays in Review; delegate read-only, one level; no Console start (O23, O29) |
| `h15-drift` | H15 drift detection, correction ladder, escalation | DIO-20 | #105 → PR #106 (open) | Not reviewed | Thresholds 3/4/6 and 80 percent; a queued correction may start the next run (O24) |
| `cd05-zoom-motion-polish` | CD-05 200 percent zoom (C47), reduced motion (C49), accessibility | DIO-76 | #94 → PR #106 (open) | Not reviewed | None (the minimum window stays Andrew's) |

The Automations Milestone A work order (`2026-09-24-automations-milestone-a-work-order.md`, PR #69)
predates the sprint and is not a lane. It is the authority Milestones A and B built on.

Some records proposed edits outside the canonical documents, and these were not applied:

- `docs/harness/RUNTIME_VERIFICATION.md`: H02, H04, H08, H12, H13 and H15.
- `docs/harness/HARNESS_INTEGRATION_MAP.md`: H13's retitle.
- `docs/product/2026-09-10-capability-packs.md`: P01/P03 and P06.
- `AGENTS.md` decision 13 and `docs/reference/STANDING_DECISIONS.md`: P05 and P06.

Decision 13's wording waits on QUESTIONS.md O31. The H-number clash waits on O29.

## What remains for 1.0

Derived from Live Roadmap 2026-09-24.2, sections 2, 4, 5, 6 and 9.

- **A release that carries this work.** Package from main after PR #106 lands, with its candidate
  record, the Windows journey on named build bytes and installer proof. Until then 0.1.11 is what
  people run.
- **Independent reviews** for every lane marked "not reviewed" above. Automations B, H08, H12, H13
  and H15 carry the most authority-sensitive logic.
- **Live proof on real routes.** For H02, steer, resume and fork on Windows with the pinned Codex,
  plus the isolation proof for a kept thread. For H04, OpenCode 1.18.4. For H13, a live AWS
  Bedrock or Vertex loop; Azure and OpenRouter have never been driven. For CD-05, the packaged AWS
  journey and a live Luna call and spend.
- **Provider Resume.** H03 (PR #92) and H05 (PR #90) are still open. Until a provider route wires
  Resume through H08's seam, Steer, Resume and Fork reach only Codex, and H15's Continue has no
  provider route to act on.
- **Automations.** Both milestones need their packaged journeys, and B needs its review.
  Milestone C (named event paths, notifications beyond in-app attention, multi-location
  authorization) and Milestone D remain, as does measuring usefulness.
- **Console gaps from the Workbook removal.** Make tasks from this plan, the Fix-attempt chip and a
  conversation Stop are still missing. P06 supplies Keep and Undo for waiting changes.
- **Gaps named in the records.**
  - Verification: H17 has no automatic check at run completion outside the H13 loop and no
    authorized way to run a project command.
  - Effects: H12 has no reconciliation surface for a person.
  - H21: the perf gate and journey are not in CI, and SSE fan-out is the slow path.
  - Files: P05 has no PDF viewer and cannot send pictures or PDFs to an engine.
  - Not started: P02 (the registry). H19 and H20 were not part of this sprint.
  - Inventory: MI01 device identity remains, and so does R27-3.
- **The proof sequence in roadmap §6.**
  - Engine discovery and first-run setup without hidden paid prompts (C).
  - Local model setup, benchmarking and lifecycle (D).
  - A live Diomedes-led workflow (E).
  - Before any hosted access (F): production identity and membership, server-checked entitlement,
    company-held keys, tenant-bound metering, signed distribution, support and offboarding.
- **Decisions.** QUESTIONS.md O11–O34 hold the 2026-09-24 lanes' defaults. Roadmap §9 holds the
  standing ones, among them the Thorough model qualification, the Solo allowance, managed
  metering and signed distribution.
- **Cloud synchronisation.** The canonical Google Docs still carry 2026-09-24.1, so this patch
  still has to be applied there.
