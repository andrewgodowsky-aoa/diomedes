# Diomedes foundation: durable task Work admission

Date: 2026-09-08. Milestone: M0 and the first bounded M1 slice, F01 on task Work.

F01 passes for task Work. Task Start in Workbook and Console uses a durable command receipt through the
existing Work service. Identical retries find one run; a changed payload under the
same command ID is refused. This is the first foundation slice, not completion of
M1 or the later product roadmap.

## Authority and source reconciliation

The owner requested implementation from the September 8 prompt and consolidated
brief, with performance preserved and no Astra subagents. The documents were read
in that order. Their initial assignment is M0 plus the smallest missing M1 slice.
The later message, "fable is done, go crazy lol", released the desktop rebuild hold.
No commit, push, public deployment or live-data migration was authorized or made.

- Main checkout: `F:\Achilles\diomedes`, inspected at `218f325` after Fable finished.
- Isolated checkout: `F:\Achilles\diomedes-wt\codex-foundation`, branch
  `codex/foundation-20260908`, originally created from `bd33d40`.
- Fable's committed `c7c7b54` and `218f325` performance changes were applied in the
  isolated copy before verification. They are inherited changes, not authored by
  this task. Review the task's tracked diff against `218f325`.
- Main's unrelated `scripts/package-desktop.mjs` edit and `tmp/field-pushed.html`
  were preserved. All tests use
  synthetic projects and independent profiles, data directories and ports.
- Coordination and Fable's acknowledgment are recorded in
  `F:\Achilles\planning\DIOMEDES-CODEX-COORDINATION-2026-09-08.md`.
- The governing self-sufficient host decision is
  `F:\Achilles\planning\2026-09-06-v6-two-views\01-foundation-decision-2026-09-06.md`.
  Existing README, QUESTIONS, v5 UX/history/merge guidance, and the planning index
  were reconciled with code. Workbook and Console are the current names.
- The newer `21-chat-execution-plan-2026-09-08.md` is a draft. Its proposed
  cancellation on HTTP disconnect would conflict with durable admission; it is
  not implemented here. The draft does not replace the existing host or grants.
- Muse through OpenCode Go performed scoped analysis, client implementation and
  review. The primary agent revised and independently tested the changes. No
  Astra or Fable delegates were invoked. The real smoke explicitly used Luna.

## M0 matrix

Status describes the selected surface after this slice, with broader gaps explicit.

| Requirement | Existing implementation | Status | Evidence and smallest remaining change |
| --- | --- | --- | --- |
| One canonical host | `server/app.ts`, `server/work.ts`, `server/native-work.ts`, `server/team/` | verified | Express and Store already own Work, approvals and history. Reused them; no second host, database or external host/UI runtime. |
| F01 command identity and idempotency | Work had durable sessions but no task-start command receipt | verified for task Start | `server/work-admission.ts`, `Store.recordWorkAdmission`, client helper; concurrent, timeout, changed-payload, reload and restart tests. Extend to other entry points next. |
| F02 validation, actor and project scope | Loopback/Host/Origin/client-header checks; project-scoped lookup; separate team bearer tokens | partial | Strict bounded v1 input and cross-project/foreign-Origin denials tested before adapter/write. `local-prototype` receipts explicitly do not claim authenticated device/user identity. |
| F03 admission and dispatch recovery | `Store.locked`, atomic JSON persistence, `Store.init` interruption recovery | verified for this slice | Receipt, run and event persist before dispatch. Process exits before admission, after admission and during dispatch recover without automatic model resend. Interrupted proposals expire. No durable automatic dispatcher yet. |
| F04 exact-action approval | Native fixed proposal and selected source hashes; Need preview; locked decision and `writeRecorded` | partial | Stale-base, race, replay and restart-expired proposals cannot write different bytes. Explicit approval digest/expiry and immutable durable decision receipts are still missing. |
| F05 guarded write journal | `Store.writeRecorded`, content objects, durable journal, `recover` | verified for supported text | Prepared/applied/finalized journal fixtures recover consistent bytes and one history record, including a second restart. Existing guarded writer reused. |
| F06 restore without Git | Content-addressed before/after objects, expected revision, preserved displaced version | verified for supported text | BOM and CRLF preserved; newer edit conflict denied, explicit force restore preserves displaced text. Real native smoke restores original hash. Arbitrary binary editing is outside this writer. |
| F07 uncertain external effects | This native proposal path exposes no sending/payment/browser tools | missing, intentionally deferred | No general external-effect ledger or reconciliation state. Versioned team targets are denied. The external-effect lost-acknowledgment test is deferred until such an adapter is supported. |
| F08 cancellation | Native AbortController, stopped state, run cleanup; sample timers stopped | verified for this slice | Late generator result after Stop cannot write; project accepts another run; restart leaves no stale active state. Stop does not promise to reverse a completed effect or recover provider charges. |
| F09 engine/tool boundary | Diomedes native adapter, disabled inherited tools, no tools in ordinary proposal mode | partial | Existing integration boundary tests plus separate real proposal smoke. QUESTIONS O1 remains: team tool-host rejection is not a universal pre-execution veto. No expansion to remote/autonomous tools. |
| Durable events and common entry points | In-memory SSE notifications plus persisted project History and sessions | partial | Current UI resyncs from state and receipts. Durable cursors, authorization-aware replay and shared composer/team/schedule admission remain missing. |
| V01 version handling | Existing project/settings migration; optional Session receipt | partial | Legacy sessions need no rewrite migration. Unsupported new request version and inconsistent stored receipts fail closed. Future incompatible schema migration still needs explicit backup/rollback design. |
| V02 performance and lifecycle | Fable's background document cache and slim state/SSE payloads | partial | Existing 3,000-file regression, zero-scan receipt replay, bounded browser pending state and package lifecycle tested. Full CPU/RAM/disk budgets across future capture/analyze/cloud features remain unmeasured. |
| V03 desktop and usable controls | Existing task controls, preview, review and two surfaces | partial | Actual packaged launch plus browser loss/reload tests. No new visual system. Phone pairing/narrow viewport and complete 150% scaling proof belong to later gates. |

F01 was the first missing gate. Adding a receipt to the existing session made the
normal proposal/approval/write/history/restore route testable under retries without
duplicating passing components. Replacing JSON Store with SQLite, or adding a
separate receipt authority, would introduce migration and synchronization cost
without addressing a demonstrated need in this bounded single-host flow.

## Implemented contract

`POST /api/projects/:projectId/work/start` opts into strict v1 when either
`protocolVersion` or `commandId` is present. Both are required for a valid v1
request. Unversioned callers remain supported and existing compatibility tests pass.

The normalized payload includes task, route, instruction, selected source paths,
consent, optional project thread and demo mode. The command key is separate from
the SHA-256 payload digest. Validation permits at most eight source paths, 16,000
instruction characters and a 128-character command key; unsupported fields,
versions, duplicate source paths and invalid scope are refused.

Under the existing Store lock:

1. Validate scope and current Codex enablement/consent.
2. Return the existing session and original receipt for an identical command;
   refuse a different payload with `work_command_conflict`.
3. For a new command, validate and read explicitly selected inputs using existing
   guarded paths. Create the session, its permission, the `work-admitted` History
   event and the receipt. Save them together through the atomic state writer.
4. Invoke the native generator only after persistence succeeds. No lock is held
   across the model response. Store rollback handles a failed admission write.
5. Generate, preview, approve, apply and restore through existing services.

`GET /api/projects/:projectId/work/commands/:commandId` retrieves the current
session with its immutable original receipt. Receipt identity includes protocol,
command/payload, project, task, session, admission event/time, route and
`scope: local-prototype`. It proves admission, not successful execution.

On restart, an interrupted run is visibly stopped and its open proposal expires.
The receipt remains queryable and a retry cannot silently resume it. Completed
sessions retain their result. This is truthful reconciliation without unsafe
automatic redispatch, including the admitted-but-not-dispatched crash interval.

The browser saves one pending command per project/task in `sessionStorage` before
sending. Concurrent identical calls share one promise. Transport/ambiguous failures
get at most one automatic retry with the same ID and body; explicit new-request
4xx denials are not retried. Ambiguous requests retain their identity on later
errors. Existing project-state refreshes reconcile confirmed receipts after SSE
or reload, without an additional request or timer. Unmatched pending requests are
retained; changed inputs cannot silently replace an unresolved action.
Damaged browser records are kept and reported once while independent valid records
reconcile; a storage problem does not block the project or team roster from loading.

There are at most 32 browser pending records and 1,024 saved command receipts per
project. Old receipts are never silently evicted and made executable again. At the
host cap, known retries still work and new command starts return a typed refusal.
A future retention design must define explicit expired-key handling. Session
storage survives a page reload, not closing the browser session or clearing site
data; cross-device/browser-lifetime deduplication is not claimed.

## Verification

Commands run from the isolated checkout. Log paths under `output/foundation/` are
local ignored artifacts; JSON proofs and selected screenshots are durable evidence.
These results are from the final source build and the 06:56 EDT verification run.
`evidence/work-admission-verification.json` binds the source/package hashes and logs
to this result. Test-name F numbers in the older `ui.spec.ts` are its historical UX
scenario identifiers; the M1 acceptance mapping above is the September 8 brief's.

| Check | Command or procedure | Result | Evidence and proof boundary |
| --- | --- | --- | --- |
| TypeScript, production client and Windows packaging | `npm.cmd run build` | PASS | `output/foundation/build.log`; postbuild packages the isolated app only. |
| Full deterministic suite | `node node_modules/vitest/vitest.mjs run --maxWorkers 2 --no-file-parallelism` | PASS, 278 tests | `output/foundation/tests.log`; 12 files, including 32 admission and 19 client tests; native fixtures, validation, crash/recovery, history and existing regressions. |
| Browser suite, final built client | `node node_modules/playwright/cli.js test --config output/foundation/playwright-built.config.ts` | PASS, 18 tests | `output/foundation/browser-built.log`; all browser scenarios serve the final production client. Native generation here is injected, not real. Includes one/both lost responses, reload and corrupt-storage roster recovery. |
| Real native proposal | `node --import tsx scripts/native-work-smoke.ts` | PASS | `evidence/native-work-proof.json`: pinned native runtime, one Luna generation, same receipt on retry, unchanged file before approval, approved output and byte-exact restore, owned server closed. |
| Packaged desktop | `node scripts/desktop-smoke.mjs` | PASS | `evidence/desktop-proof.json`; isolated EXE/profile/data, Workbook/Console response loss, 1.24x scaling, team UI, renderer isolation, close/relaunch and original receipts. |
| Review | Muse Go read-only review, then primary source/test reconciliation | Addressed and verified | Initial admission review found no defect. Follow-up identified corrupt-storage exceptions blocking roster load, starving valid records and recurring reports. Fixed with explicit returned errors, independent reconciliation and deduplicated reporting; unit and browser regressions pass. Logs: `output/foundation/muse-review.json`, `output/foundation/muse-reconciliation-review.log`. |
| Performance | Cached 3,000-file state read, 50 receipt retries, controlled client bundle comparison | PASS for measured regressions | State read 11 ms; 50 replays 52.2 ms, no listing/read/persist/adapter calls. `evidence/work-admission-performance.json`; no claim that all existing slowness is fixed. |

The normal dev-browser suite also passed 18 tests, but its font requests exposed a
Vite allow-list issue specific to the shared `node_modules` junction. The final
suite therefore used an ignored local config pointing at `server/index.ts
--production` on port 5174, with the same synthetic environment and model-catalog
fixture. No serving guard was weakened and no dependency was installed. Production
fonts loaded in the final suite and packaged desktop. The primary agent inspected
the Workbook proposal, Console recovered task and scaled desktop screenshots.

For the controlled bundle comparison, `git archive 218f325` supplied `client/`,
`shared/`, `index.html`, `vite.config.ts` and `package.json` in an ignored temporary
directory. Vite built that snapshot with the same installed dependencies. The JS
entry grew from 306,872 to 311,395 bytes; gzip grew from 92,198 to 93,873 bytes
(+1,675 bytes, 1.82%). No dependencies, background timers or processes were added.
The existing state refresh performs receipt reconciliation without extra requests.
These are local measurements, not a complete latency or CPU/RAM/disk budget.

The real native proof is separate from injected tests. It used `gpt-5.6-luna`, one
generation, the existing sign-in and the pinned local runtime. No credential was
copied, no provider fallback was used and no real external message was sent.
Original/restored SHA-256:
`d359422d94ff64f54a3420d8fc1bb32c9bc54f8ba36d1bd6fbd1df02059a0e9e`.

Failure fixtures explicitly simulate disk-full rejection and process/journal
boundaries. They do not claim physical power-loss testing on this Windows volume.

## Remaining gates and next slice

M1 remains open. The next bounded slice should add explicit proposal/base digest,
expiry and durable approval-decision receipts to the existing Need path, including
lost-decision-response and restart tests. Then share admission with composer and
team entry points and add authenticated event replay before M2 phone access.

F02 authenticated actors, full F04, F07, F09/O1, durable event replay and broader
V01-V03 remain partial or deferred as above. M2-M8, R01-R05, learning/capture,
scheduling and cloud gates are not implemented here. No live recording, networking
changes, pairing, account changes, scheduled actions or worker provisioning occurred.

## Proposed commit and integration

Proposed message: `Add durable command receipts and recovery to task Work starts`

No commit, amend or push was performed. Main was not merged or repackaged. Integrate
this task against Fable's `218f325` or its successor, preserving the unrelated main
packaging edit. The following is this task's file list; inherited Fable-only test
changes are excluded:

- `README.md`
- `docs/implementation/2026-09-08-work-admission.md`
- `shared/types.ts`
- `server/work-admission.ts`
- `server/store.ts`
- `server/app.ts`
- `server/work.ts`
- `server/native-work.ts`
- `client/work-start.ts`
- `client/Workspace.tsx`
- `client/Console.tsx`
- `tests/work-admission.test.ts`
- `tests/work-admission-child.ts`
- `tests/work-start-client.test.ts`
- `tests/native-ui.spec.ts`
- `scripts/native-work-smoke.ts`
- `scripts/desktop-smoke.mjs`
- `evidence/native-runtime-manifest.json`
- `evidence/native-work-proof.json`
- `evidence/desktop-proof.json`
- `evidence/work-admission-performance.json`
- `evidence/work-admission-verification.json`
- `evidence/screenshots/work-admission-workbook.png`
- `evidence/screenshots/work-admission-console.png`
- `evidence/screenshots/desktop-tasks.png`
- `evidence/screenshots/desktop-tasks-large.png`

The binary-inclusive review patch is `output/foundation/task-changes.patch`, based
on `218f325`. It includes this task's new files and excludes Fable's already
committed changes. The packaged copy is at
`release/Diomedes-win32-x64/Diomedes.exe`; tests launched it with an independent
profile and synthetic projects, not the live user's project data.
