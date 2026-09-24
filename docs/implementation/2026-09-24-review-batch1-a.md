# Independent review, batch 1 (a): H07 Ready scheduling, Automations Milestone A, remembered approvals (D5)

Date: 2026-09-24. Lane `review-batch1-a`, branch `review/h07-automations-a-remembered-approvals`,
based on `origin/integration/overnight-batch-1` (merged to `main` as PR #86) and then merged with
`origin/main` `9bd5147`.

This is the independent whole-prompt review the DONE rule requires ("full prompt scope, required
tests, an independent whole-prompt review") for three features merged on 2026-09-24. The reviewer
wrote none of the reviewed code. Every defect found has a failing test first, a fix, and the test
green; each fix is its own commit on this branch.

## Scope

| Feature | Record | Spec | Code reviewed |
|---|---|---|---|
| H07 Ready scheduling | `2026-09-24-h07-ready-scheduling.md` | Linear DIO-12, the record's own contract | `server/ready-scheduler.ts`, `shared/ready-queue.ts`, `client/ready-queue.ts`, `client/console/BoardView.tsx` (queue row), `admitWork` in `server/app.ts`, `server/work.ts`, `server/native-work.ts` admission order |
| Automations Milestone A | `2026-09-24-automations-a.md` | `2026-09-24-automations-milestone-a-work-order.md` §1–§6 | `server/automations.ts`, `server/automation-routes.ts`, `shared/automations.ts`, `server/harness/capabilities/weekly-brief.ts`, `server/harness/bridge.ts` (start, recover), legacy `POST …/brief` in `server/workspace-routes.ts`, `client/console/AutomationsPage.tsx`, `client/api.ts` |
| Remembered approvals (D5) | `2026-09-24-remembered-approvals.md` | work order §3 D5 | `server/trust/remembered-approvals.ts`, `shared/remembered-approvals.ts`, `server/trust/scope-grants.ts` diff, `server/harness/bridge.ts` (candidate, cover, resolve, decide, recover), `server/permission-routes.ts`, `server/store.ts` recover/write funnel, `format-report.ts`, Console `Need.tsx`, `ThreadView.tsx`, `Shell.tsx`, `RememberedApprovals.tsx`, `RunInspector.tsx`, `components.tsx` |

## Method

1. Read `AGENTS.md` (decisions 1–14), `docs/reference/STANDING_DECISIONS.md` §7–§8, each record and
   the spec it claims.
2. Read each feature's code end to end, then the paths it relies on (the Work start admission, the
   harness bridge's start/mirror/recover, the Store's journal recovery and write funnel), looking for
   the specific failure modes the review brief named: auto-start bypassing a Need, consent or a Trust
   check; claim/admission crash windows; fairness; pause; default-off; attribution; non-member
   leakage; replay/409; `admitting` recovery; missing-source-before-write; pinned revision; legacy
   convergence; label truthfulness; and for D5 every path that could create, widen or revive a grant
   without the person's click, the classifier under tricky input, live authority re-checks,
   revocation of an in-flight covered step, attribution, and Codex scope-grant byte identity.
3. Ran the three features' existing tests (144 green at the base), then wrote a failing test for each
   suspected defect before touching code.
4. Checked that no pre-existing test was modified by the D5 branch (`git diff` against the merge base:
   only its two new test files) and that the Automations branch's test migrations match work order
   §5 A7 and do not weaken anything.

## Findings

Severity: **P0** a Trust/authority or data-loss defect reachable today; **P1** a defect in a promise
the spec makes, reachable today; **P2** a latent or defence-in-depth gap, or a truthfulness defect
with limited reach.

### H07-1 (P1) — the Ready queue sent a document the person had unticked

- **Evidence.** A service-route task counted as "confirmed" once *any* start of it on that route had
  been admitted (`session.receipt.route === route`). The Board's send dialog lets the person untick
  the task's document or pick another one; the queue then always sent `[task.sourceDocument]` with
  `consent: true`. So a person who confirmed "send the instruction only" could have the task's
  document sent to the engine by the queue after reopening the task. That is consent the person did
  not give (decision 7; the record's own rule "consent is never invented").
- **Test.** `tests/ready-scheduler.test.ts` "a confirmed start re-sends only the documents the person
  confirmed": two tasks with the same default document; one started by hand with no document, one
  with it; both reopened; queue on. Before the fix both were re-sent (2 provider calls); after, only
  the matching one starts and the other is held with "Start it yourself: sending to … needs your
  confirmation".
- **Fix** (commit "Re-send only the exact request a person confirmed from the Ready queue").
  Consent is now an admitted start with the **same Work payload digest** (`parseWorkCommand`'s
  digest: task, route, documents, instruction, thread) as the command the queue would send; the
  command is built in one place (`commandFor`) for the check and for admission; a claim replayed after
  a restart re-checks it before admission. The record's proposed default 3 becomes "re-runs only
  exactly the request the person already confirmed".

### D5-1 (P2) — the always-asks classifier let inflected, run-together and credential-file actions through

- **Evidence.** Matching was whole-word only. Rememberable before the fix: tools named `deletefile`,
  `deleted_rows_report`, `removing_old_drafts`, `prune_history`, `sendpayment`, `run_payroll`,
  `set_passwd`, `rotate_accesstoken`, `SSHKeyUpload`, `send_magic_link`, `send_invitation`; a
  recorded local write to `.env`, `config/.env.production`, `credentials.json`,
  `.ssh/authorized_keys`, `deploy/id_rsa`, `certs/server.pem`, `.npmrc`, `.git/config` or
  `Team members.md`. `intentTargets` lower-cased URLs and channels, so two webhooks differing only in
  path case shared one pattern (a grant would cover both), and any destination field it did not read
  (`forwardTo`, `webhook`, `recipient`, `path`…) was simply left outside the pattern.
- **Reach today.** Latent: only `propose_write` (pinned to `Harness report.md`) can raise a harness
  approval, and the permission allowlist is the primary gate. The word lists are the defence in depth
  the D5 text promises ("payments, deletes, credential/member/permission changes always ask").
- **Tests.** `tests/remembered-approvals.test.ts`: 16 tricky names, 9 credential files, one
  "ordinary names stay rememberable" guard (so `Harness report.md`, `Weekly brief.md` and
  `to:accounts@…` do not regress), and "a destination field the pattern cannot bind is never guessed
  at" (unbound fields, URL case, mailbox case). 22 failed before the fix.
- **Fix** (commit "Keep inflected, run-together and credential-file actions always asking"). Stems
  matched inside each word and inside each name run together; extra exact inflections and acronyms;
  a `file:` destination is checked for credential/key/secret/member/permission names, sensitive dot
  folders and files, and key/certificate extensions; only mailboxes are case-folded; an input key
  that names an unbound destination makes the step unreadable (always asks). Every grant the shipped
  procedures can create stays rememberable, so no existing ledger fails load.

### D5-2 (P2) — the Store's write-time funnel ignored the writes for a remembered approval

- **Evidence.** `ScopeGrants.assertCurrent` dispatched a remembered authorization to
  `RememberedApprovals.assertCurrent(projectId, need)` and dropped `writes`; it only checked the grant
  was still live. The task scope's branch checks each write against its scope. Today the harness
  derives the writes from the covered intent, so they match; the funnel is the one place that should
  hold regardless of caller (including journal recovery).
- **Test.** "the write-time check refuses a write outside the remembered destination": same file
  passes; another file, or a deletion, is refused 403.
- **Fix** (commit "Check a remembered approval's destination at the Store's write funnel").

### D5-3 (P2) — a remembered Codex step did not ask again after a ChatGPT account switch

- **Evidence.** D5: "It asks again when … the credential or connection it acts through changes." The
  pattern's connection for a Codex report step was
  `settings.services.codexAccountRoute ?? 'codex:chatgpt'`; no production code writes that key, so
  it was always the default and an account switch was invisible. The run itself pins the real route
  (`grant.accountRoute`, `openai:chatgpt:<hash of account metadata>`).
- **Test.** "a Codex step is bound to the account its run used, so another account asks again".
- **Fix** (commit "Bind a remembered Codex step to the ChatGPT account its run used"). A run whose
  account route cannot be read yields no candidate (always asks). The fixture procedure is unchanged.
- **Related, pre-existing, not changed here:** the version 2 Codex task scope pins the literal
  `codex:chatgpt` and has the same blind spot. Changing it touches the v2 grant digest, so it is
  queued as a separate Trust task.

### AUT-1 (P2) — a press refused for a busy project hid what the last run left

- **Evidence.** The label was computed from the newest occurrence. A press refused before anything
  started (`project_busy`, a changed source) became the newest occurrence and the label fell back to
  **Manual — not scheduled**: a run still going read as not running, and a run that stopped for
  missing data stopped naming the files (A16/A17: "no clean result is shown"). Work order A1 says the
  run labels come from "the latest admitted run".
- **Test.** `tests/automation-routes.test.ts` "a refused press does not hide the last run's Waiting
  for data".
- **Fix** (commit "Label an automation from its latest run, not a press refused before it started").
  The label reads the newest admitted, admitting or `interrupted_before_start` occurrence; the refused
  press still appears first in the detail with its own **Not written** result.

### Checked and found sound (no change)

- **H07.** Auto-start calls `admitWork` with the Board's own command; the sample Need stops it exactly
  as by hand (tested); service off, consent, cloud sharing, scope, receipt capacity are `admitWork`'s.
  Claim is persisted before admission and replays by its `commandId`; admission persists the session
  before any provider call (`native-work.ts`), so the two abrupt-exit windows each give one session
  (tested by the child-process fixture). Pause, resume, global pause and the pass all run under the
  store lock, so a pause cannot interleave a claim; pausing never stops work. Default off: no record
  is written until the person configures, and `kick()` takes no lock while every queue is off. Refusal
  is recorded once and holds the task (no retry loop). Round-robin by latest claim is
  starvation-free. History attributes the start to Diomedes as an application action; the session
  keeps its runtime engine and model.
- **Automations A.** Membership is the first check on list, detail and run, and on the legacy route;
  non-members get the non-existent organization's 404 with no name, count or result (A25). Replay is
  by command id with a 409 for a changed request (A05). `admitting` is settled at start after the
  harness recovers: admitted if its deterministic run exists in the pinned project, otherwise
  `interrupted_before_start`, never re-admitted (A06/A12); an orphaned Session is failed by the
  bridge's own recovery. The read step records `missing[]` and fails the run before compose or save
  (A16/A17). The run input pins revision, digest, destination and per-run SHAs; compose reads the
  pinned manifest; save re-checks membership, binding, project and SHAs under the lock (A13–A15,
  A36). The legacy route is a thin caller of the same admission. Labels and results never say "Sent";
  a weekly answer shows as recorded-but-inactive; usefulness reads "Not measured". The Session engine
  is `diomedes-procedure` with `model: null` and an application origin; the draft's History actor is
  Diomedes. The migrated tests (`everything-hover`, `diomedes-home.spec`, `file-imports-ui.spec`,
  `business-output-routes`) follow work order A7 and weaken nothing.
- **D5.** Only three routes create or answer a grant, each the local client's explicit POST under the
  store lock, refusing a bearer or slot caller. Repeated approvals only move a tally and make at most
  one offer; the threshold is a host constant nothing sets. Pack activation, settings, configuration
  activation and rollback, restart and journal recovery leave the ledger as it was, and recovery
  carries a later revocation or decline onto the prepared image (tested by the lane). Coverage is
  digest equality, re-checks the classifier, the project, and the live principal, generation and
  permission; the write re-checks revocation (and now the destination); a covered step whose grant is
  revoked before it runs writes nothing and cancels the run. Attribution: the History coverage entry,
  the write entry, the Session log, the run record's `decidedBy` and the Console's approval status all
  say "Ran under a remembered approval — you, since …"; none presents it as a click. The D5 branch
  modified no pre-existing test, and version 2 Codex scope-grant records are untouched and keep their
  digest (the lane's byte-identity test passes).

## Andrew's decisions (not defects) — recorded with a proposed default

1. **Ready queue consent (changes H07's proposed default 3).** The queue now re-sends only a request
   identical to one the person confirmed (same documents and thread). Proposed default: keep this;
   a standing per-engine consent stays the open question the H07 record already lists.
2. **Ready queue and person-owned tasks.** The queue starts any Ready task, including those whose
   owner is "you" (the default for a task a person makes). The Board's Start does the same, so this
   is not a bypass, but "Start ready work automatically" may surprise someone who keeps their own
   to-dos on the Board. Proposed default: keep (the switch is off by default and per project); revisit
   if owners come to mean "who does it".
3. **Ready queue and "Confirm each start".** A project whose Board policy is *Confirm each start*
   can still turn on automatic start; the switch is itself the explicit opt-in. Proposed default:
   keep, and say nothing more on the Board (decision 4).
4. **A saved grant that a stricter classifier now calls always-asks** fails project load (the lane's
   fail-closed rule). No grant the shipped procedures can create is affected by D5-1. Proposed
   default: keep fail-closed for now; if the lists grow, treat such a grant as inactive and say why,
   rather than refusing to open the project.
5. **Classifier by name is heuristic.** The permission allowlist is the real gate and the word lists
   are defence in depth. Proposed default: any new rememberable permission is added to the allowlist
   only with its own review, as the lane intended.

## Verdicts

| Feature | Verdict | Why |
|---|---|---|
| H07 Ready scheduling | **ACCEPT WITH FIXES** | One P1 consent defect (H07-1), fixed and tested here. Everything else the brief asked about holds. |
| Automations Milestone A | **ACCEPT WITH FIXES** | One P2 label-truthfulness defect (AUT-1), fixed and tested here. The packaged Windows journey the spec requires for implementation acceptance is still not run (the lane's own record says so). |
| Remembered approvals (D5) | **ACCEPT WITH FIXES** | No path creates, widens or revives a grant without the person's click. Three P2 hardening defects (D5-1 classifier, D5-2 write funnel, D5-3 Codex connection), fixed and tested here. |

## Proposed canonical-doc patch

For the integrator; not applied here.

- **Live Roadmap**, the H07 bullet the H07 record proposes: replace "Automatic start of a
  never-confirmed task on a service route is not built" with "A service-route task is started
  automatically only as an exact re-send of a request the person already confirmed (same documents
  and thread); anything else is held for the person's Start."
- **Project Memory**, the "Ready queue" definition the H07 record proposes: replace "its engine needs
  their confirmation" with "its engine and documents need their confirmation".
- **Project Memory**, the "Remembered approval" definition: no change of meaning. The build note may
  add: "A Codex step's connection is the ChatGPT account its run used."
- **Roadmap / Memory for Automations A**: no change; the label rule is the work order's own ("the
  latest admitted run").
- **QUESTIONS.md**: none new beyond the H07 record's open question.

## PILLAR IMPACT

- Decision 7 (scoped authority): tightened. The Ready queue can no longer send a document the person
  did not confirm; a remembered approval cannot cover a credential file, an inflected destructive or
  money action, an unbound destination, a different webhook, a different ChatGPT account, or a write
  outside its named file at the Store funnel.
- Decision 8 (attribution): unchanged and verified across History, Session, run record and Console.
- Decision 10 (history is evidence): nothing pruned; refused claims and refused presses stay listed.
- No pillar conflict.

## ROADMAP IMPACT

None beyond the patch above. The three features stay "implemented" with this review recorded; the
Automations packaged Windows journey remains open.

## BUILD STATUS

From this lane's own final run on the branch after merging `origin/main` `9bd5147`, on the Linux
sprint container (CI runs Windows and macOS):

- `npx tsc --noEmit`: clean.
- vitest (full suite, `--maxWorkers=2`, under the shared lock): 361 files passed, 1 skipped; 6430
  tests passed, 16 skipped, 0 failed.
- `npx vite build`: built.
- Playwright `ui.spec.ts` + `native-ui.spec.ts` + `field.spec.ts` + `automations.spec.ts` +
  `ready-queue-ui.spec.ts` + `remembered-approvals-ui.spec.ts`: 42 passed, 0 failed, 0 skipped
  (36 gate tests + 2 + 1 + 3).

Nothing here is published, packaged or released; the branch is pushed for the integrator.
