# Overnight sprint, 2026-09-24: what landed and what it leaves open

Bounded lanes ran on 2026-09-24. Each has its own record, `docs/implementation/2026-09-24-<lane>.md`,
with its tests, gaps and gate counts, and this page lists them in one place. The canonical
documents were reconciled from the records' proposed patches in two passes:

- **First pass:** Live Roadmap and Project Memory 2026-09-24.2, and `QUESTIONS.md` O11–O34 and R9.
- **Second pass:** Live Roadmap and Project Memory 2026-09-25.1. It applies Andrew's decisions of
  2026-09-24 (`docs/reference/DECISIONS_2026-09-24.md`, PR #108) as `QUESTIONS.md` R10–R13, and
  adds batches 5 and 6 and reviews C, D and E as O35–O42.

**Nothing here is released.** The latest release is 0.1.11. Batches 1 to 5 are in source on app
main at `4395331`. Batch 6 is PR #119, which is landing. No lane has live-provider, hosted,
packaged-installer or device proof, and none claims it.

How the work reached main:

- **Batch 1**: PR #86, merge `1b70c2e`. PRs #78, #79, #81, #82, #83, #84 and #85, plus
  `bugfix/ci-timing-flakes`.
- **Direct merges**: PR #74 (`de86916`), PR #75 (`5d73f1f`), PR #76 (`a08a694`) and PR #82
  (`9bd5147`, also carried by batch 1).
- **Batch 2**: PR #95, carried by batch 3. PRs #80, #87 and #91.
- **Batch 3**: PR #97, merge `f13be72`. PRs #88, #89, #93 and #96, plus batch 2.
- **Batch 4**: PR #106, merge `8d20fb9`. PRs #94, #98, #99, #100, #101, #102, #103, #104 and
  #105, plus the integration fix `ceb4836`, which gives the H13 loop's tools the effect class and
  output schema H12 requires, and two commits (`82c758b`, `6a3219a`) that stop tracking committed
  `node_modules` links.
- **Batch 5**: PR #107, merge `4395331`. H03 (PR #92) and H05 (PR #90).
- **Batch 6**: PR #119, landing. H10 (PR #111), H14 (PR #112), P04 (PR #114), reviews C (PR
  #109), D (PR #110) and E (PR #113) with their fixes, and an H03 test fix. The Windows gate job's
  30-minute timeout rides both batch 6 and PR #108.

"Reviewed" means an independent whole-prompt review by a lane that wrote none of the code. A
lane marked "not reviewed" is implemented and tested by its own author only. A feature accepted by
review is implemented in source and independently reviewed. That is not the same as released,
live-proven or done. The fixes from reviews C, D and E ride batch 6 (PR #119).

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
| `p05-files-attachments` | P05 drop and paste, previews, Thread attachments, file identity | DIO-31 | #80 → #95 → #97, `f13be72` | Reviewed (E), accepted with three P1 and one P2 fix | Binary restore refused; no open-externally hand-off (O30) |
| `h17-verified-completion` | H17 four-state verification bound to exact bytes | DIO-22 | #87 → #95 → #97, `f13be72` | Reviewed (D), accepted with two P1 and three P2 fixes | Declared commands are recorded and never run (O25) |
| `automations-b` | Automations Milestone B: schedules, missed runs, pause, in-app attention | DIO-91, DIO-92, DIO-93 | #96 → #97, `f13be72` | Reviewed (E), accepted with fixes: a slot due before an act is kept, a true "last seen", one slot per skipped day | A nonexistent DST local time runs at the jump, where the specification says skip; 2-hour catch-up; owners and admins pause (O12); default 16's wording (O42) |
| `h08-durable-controls` | H08 six durable controls with receipts | DIO-13 | #93 → #97, `f13be72` | Reviewed (C), accepted with three P1 and five P2 fixes | Resume and Retry confirm, Stop and Fork act on the press; no uncertain-effect override (O16) |
| `h18-context-accounting` | H18 context accounting, selection, compaction | DIO-23 | #89 → #97, `f13be72` | Reviewed (C), accepted with one P1 and two P2 fixes | Carried history not summarised; bounds unchanged; no pin control (O26) |
| `h02-codex-controls` | H02 Codex Steer, Resume, Fork | DIO-7 | #98 → #106, `8d20fb9` | Reviewed (C), accepted with five P2 fixes; the P1 lock during Resume and Fork is proposed (O40) | Keep Codex threads in the person's history only when resume or fork is offered (O17) |
| `d5-codex-proposals` | D5 for Codex proposals; task scope bound to ChatGPT account | — | #99 → #106, `8d20fb9` | Reviewed (E), accepted with two fixes; the approved-then-switched case and the always-ask list go to Andrew (O42) | Exact file set on one account; the task scope decides first (O15) |
| `h09-agent-profiles` | H09 exact-model profiles and routing | DIO-14 | #100 → #106, `8d20fb9` | Reviewed (E), accepted with a P0, three P1 and one P2 fix | Fallback off by default; a thread pin outranks lists (O20) |
| `h21-migrations-perf` | H21 migrations, crash matrix, perf gate, completion journey | DIO-26 | #101 → #106, `8d20fb9` | Reviewed (E), accepted with one P1 and one P2 fix; two P2 wiring issues proposed | A newer file stops the service; backups kept; host record still replaced (O27) |
| `h12-mediated-effects` | H12 typed tools, effect records, containment | DIO-17 | #102 → #106, `8d20fb9` | Reviewed (D), accepted with three P2 fixes | Any interrupted write is uncertain; no Console reconciliation yet (O22) |
| `p06-diffs-review` | P06 readable diffs, per-hunk keep, review comments | DIO-32 | #103 → #106, `8d20fb9` | Reviewed (E), accepted with two P2 fixes | Settled by Andrew: readable diffs are Core (R10); version comments by path (O42) |
| `h13-native-loop` | H13 plan, act, observe, finish loop | DIO-18 | #104 → #106, `8d20fb9` | Reviewed (D), accepted with two P1 and two P2 fixes | Settled by Andrew: an unverified finish stays in Review; delegates will work in sandboxes (R11, R13). Console start still open (O23, O29) |
| `h15-drift` | H15 drift detection, correction ladder, escalation | DIO-20 | #105 → #106, `8d20fb9` | Reviewed (D), accepted with three P1 fixes; a start while escalated is proposed (O41) | Settled by Andrew: thresholds, bounds, scope, queued corrections, always on (R12) |
| `cd05-zoom-motion-polish` | CD-05 200 percent zoom (C47), reduced motion (C49), accessibility | DIO-76 | #94 → #106, `8d20fb9` | Not reviewed | None (the minimum window stays Andrew's) |
| `h03-claude-live-controls` | H03 Claude Code queued steering, Stop with escalation, restart reconciliation, Console controls | DIO-8 | #92 → #107, `4395331` (a test fix rides #119) | Review F running (#116) | Project threads stay on the single-turn path (O38) |
| `h05-cursor-acp-sessions` | H05 kept ACP conversations for Cursor and Devin; engine questions as Needs | DIO-10 | #90 → #107, `4395331` | Review F running (#116) | An API route only; the private engine folder is kept (O39) |
| `h10-guidance` | H10 guidance proposals from evidence, digest-chained revisions, evaluation, rollback | DIO-15 | #111 → #119 (landing) | Not reviewed | A digest chain, not an HMAC; threshold 3; a decline holds until new evidence (O35) |
| `h14-teams` | H14 lead loop with bounded workers, a read-only advisor, a handoff ledger | DIO-19 | #112 → #119 (landing) | Not reviewed | Depth 1, 3 at once, 6 per run; a failed worker stops its lead. Sandbox and limits meet R11/R13 (O36) |
| `p04-on-demand` | P04 contribution index on activation; pinned, digest-checked loads | DIO-30 | #114 → #119 (landing) | Not reviewed | Changed content without a version bump is refused; opening is recorded; the model may choose a playbook (O37) |
| `review-c` | Review of H08, H02 and H18 | DIO-13, DIO-7, DIO-23 | #109 → #119 (landing) | This is a review: all three accepted with fixes | The Codex Resume wait under the service lock (O40) |
| `review-d` | Review of H12, H13, H15 and H17 | DIO-17, DIO-18, DIO-20, DIO-22 | #110 → #119 (landing) | This is a review: all four accepted with fixes | A new start while an escalation is open (O41) |
| `review-e` | Review of P05, P06, Automations B, D5 for Codex, H09 and H21 | DIO-31, DIO-32, DIO-89, DIO-14, DIO-26 | #113 → #119 (landing) | This is a review: all six accepted with fixes | D5 account and always-ask list, Automations B default 16, P06 version comments (O42) |

The Automations Milestone A work order (`2026-09-24-automations-milestone-a-work-order.md`, PR #69)
predates the sprint and is not a lane. It is the authority Milestones A and B built on.

Some records proposed edits outside the canonical documents, and these were not applied:

- `docs/harness/RUNTIME_VERIFICATION.md`: H02, H03, H04, H05, H08, H12, H13 and H15, plus reviews C
  and D.
- `docs/harness/HARNESS_INTEGRATION_MAP.md`: H13's retitle and H14's entries.
- `docs/product/2026-09-10-capability-packs.md`: P01/P03 and P04.
- `AGENTS.md` decision 13 and `docs/reference/STANDING_DECISIONS.md`: P05's boundary.

The one exception is Andrew's P06 decision (R10). It is now in `AGENTS.md` decision 13,
`docs/reference/STANDING_DECISIONS.md` and `docs/product/2026-09-10-capability-packs.md`. The
H-number clash still waits on O29.

## Independent reviews C, D and E

Every feature these three reviews covered was accepted with fixes. Each review wrote a failing test
before fixing a finding. The fixes ride batch 6 (PR #119).

| Review | Feature | Verdict | Fixed | Left open |
|---|---|---|---|---|
| C (`2026-09-24-review-c.md`, #109) | H08 durable controls | ACCEPT WITH FIXES | Stop credited to the engine only when it interrupts natively; the uncertain-effect block covers the whole lineage; Stop never refused at receipt capacity; five P2s | Consent, model and follow-up checks untested |
| C | H02 Codex controls | ACCEPT WITH FIXES | Only thread-not-found starts fresh; isolation fields on resume and fork; native Fork needs resume; no double Resume; a truthful replay | RC-H02-1: the service lock during Resume and Fork (O40); live Windows acceptance |
| C | H18 context accounting | ACCEPT WITH FIXES | A message that does not fit is omitted and summarised, never included and cut; surrogate-safe excerpt; an honest "summarised" count | Tool list outside the stable-prefix hash (suspected) |
| D (`2026-09-24-review-d.md`, #110) | H12 mediated effects | ACCEPT WITH FIXES | `effect.*` events in the vocabulary; a landed-file mismatch is uncertain; key-named variables refused | Residual rename window, already stated |
| D | H13 native loop | ACCEPT WITH FIXES | Loop actions go through H12 dispatch; a delegate reads only what the parent's cloud route may see; a refused input is observed; a delegate whose route cannot open is failed | Delegate spend is not charged to the parent's cap (patch B, needed for R11); a job-cap stop parks an unsent call (patch C) |
| D | H15 supervision | ACCEPT WITH FIXES | "Continue" acknowledges only the resumed run; a second run's drift is noted, not dropped; a prohibition with an exception is read correctly | A start while an escalation is open (patch A, O41); smaller items |
| D | H17 verification | ACCEPT WITH FIXES | Every judged file stays bound; a saved version is not a run output; a missing check result, backslash paths and the reserved id | Binary outputs never verify; review excerpts |
| E (`2026-09-24-review-e.md`, #113) | P05 Files | ACCEPT WITH FIXES | Linear-time workbook scan; a referenced version survives a quick edit; the GIF frame bound; the binary flag on recovery | Version order and deletions in the identity projection |
| E | P06 diffs | ACCEPT WITH FIXES | No comment on a change still being written; duplicate comment ids sent once | Line-ending-only hunks; version comments by path (O42) |
| E | Automations B | ACCEPT WITH FIXES | A slot due before a pause, edit or resume kept; a true "last seen"; one slot per instant on a skipped day | Default 16's wording (O42); packaged journey |
| E | D5 for Codex | ACCEPT WITH FIXES | A declined proposal's account no longer binds; evidence re-pointed at another grant refused | The approved-then-switched case and the always-ask list (O42) |
| E | H09 Agent profiles | ACCEPT WITH FIXES | A list never replaces the person's Agent (P0); an unreadable file refuses; an archived cap; team wakes; the digest checked on load | `null` clear over HTTP; a lowered effort unrecorded |
| E | H21 migrations | ACCEPT WITH FIXES | A journal is held to the version check; byte-for-byte backups | Three readers discard the migrated record; the wrong unreadable reason |

Review F of H03 and H05 (PR #116) is still running.

## Andrew's decisions, 2026-09-24

`docs/reference/DECISIONS_2026-09-24.md` (PR #108) answers four of the lanes' questions. They are
now `QUESTIONS.md` R10–R13:

- **R10, P06:** readable diffs of recorded versions are Core. The pack keeps Git, highlighting,
  code views and LSP.
- **R11, H13:** an unverified finish goes to Review. Delegates work in sandboxes and return change
  sets. The limits are depth 2 and 4 per run, delegates run in parallel, budgets are carved from
  the parent's, and routes come from H09 profiles. The attribution rules stand. The sandbox is the
  next slice, in progress on `feature/h13-delegate-sandboxes` and not landed.
- **R12, H15:** the thresholds 3/4/6, 4/5/8 and 80/90 percent (a project may tighten them only),
  the correction bounds and folder scope are accepted. So is an immediate pause on an out-of-scope
  write. A queued correction may start the next run without a person, within four stated limits.
  One escalation is raised per task and issue, supervision is always on, and the instruction-drift
  reading stands.
- **R13, team mode:** every helper Diomedes dispatches is sandboxed by default and gets no wider
  authority. The rule is "do not hamper".

## Still running

- H16 stream-time rules (PR #118)
- P07 Software Engineering pack (PR #115)
- H20 evaluation matrix (PR #117)
- DIO-107 (`bugfix/dio-107-two-window-load`)
- Review F of H03 and H05 (PR #116)
- The H13 delegate sandbox (`feature/h13-delegate-sandboxes`)

## What remains for 1.0

Derived from Live Roadmap 2026-09-25.1, sections 2, 4, 5, 6 and 9.

- **A release that carries this work.** Package from main after batch 6 (PR #119) lands. The
  release needs its candidate record, the Windows journey on named build bytes and installer proof.
  Until then 0.1.11 is what people run.
- **Independent reviews** for the lanes still marked "not reviewed": H10, H14, P04, CD-05 and the
  audit, CI and inventory fixes. Review F covers H03 and H05. The items reviews C, D and E left
  open are listed in the table above.
- **The H13 delegate sandbox and change-set return** (R11, R13). The same slice has to charge a
  delegate's spend to its parent (review D's patch B) and settle how H14's limits meet it (O36).
- **Live proof on real routes.** For H02, steer, resume and fork on Windows with the pinned Codex,
  plus the isolation proof for a kept thread. For H04, OpenCode 1.18.4. For H13, a live AWS
  Bedrock or Vertex loop; Azure and OpenRouter have never been driven. For CD-05, the packaged AWS
  journey and a live Luna call and spend.
- **Provider Resume.** H03 and H05 are in source (batch 5): Claude Code, Cursor and Devin keep
  their sessions, with a queued steer, a recorded Stop and restart reconciliation. Their live
  acceptance and review F remain. Work runs still reach Steer, Resume and Fork only through Codex,
  and H15's Continue has no provider route to act on.
- **Automations.** Both milestones need their packaged journeys. Review E accepted B with fixes.
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
  - Not started: P02 (the registry) and H19. H20 is running.
  - H14: workers only read, there is no per-handoff acceptance, and no Console start exists.
  - P04: installed packs' tools, Agents and context have no Runtime consumer.
  - H10: no model-backed evaluation, and a person's direct edits are not chain records.
  - Inventory: MI01 device identity remains, and so does R27-3.
- **The proof sequence in roadmap §6.**
  - Engine discovery and first-run setup without hidden paid prompts (C).
  - Local model setup, benchmarking and lifecycle (D).
  - A live Diomedes-led workflow (E).
  - Before any hosted access (F): production identity and membership, server-checked entitlement,
    company-held keys, tenant-bound metering, signed distribution, support and offboarding.
- **Decisions.** QUESTIONS.md O11–O42 hold the lanes' open defaults. R10–R13 hold what Andrew
  settled on 2026-09-24. Roadmap §9 holds the
  standing ones, among them the Thorough model qualification, the Solo allowance, managed
  metering and signed distribution.
- **Cloud synchronisation.** The canonical Google Docs still carry 2026-09-24.1. The 2026-09-24.2
  and 2026-09-25.1 patches still have to be applied there.
