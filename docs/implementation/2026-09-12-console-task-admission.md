# Console task creation command admission

Worktree: `F:\Diomedes\diomedes-wt\console-task-admission-20260912`.
Branch: `slice/console-task-admission-20260912`, based on main `212106e`.
Authority read: Core Pillars `2026-09-10.1`, Live Roadmap `2026-09-12.2`, Project Memory
`2026-09-10.7` (local repository mirrors).

## Implemented

Console New task now sends a strict version 1 `task.create` command to the existing
`POST /api/projects/:id/tasks`. The shared command ID, canonical payload digest,
project command namespace, Store lock and atomic state persistence admit it. A
matching retry returns the existing Task; changed name, description or owner, or
reuse by Work, approval or scope issuance, conflicts. Unversioned callers keep
their existing behavior and receive no invented receipt.

The optional immutable `Task.creationReceipt` records command/digest, project,
task, admission time, local-client attribution and the existing `tasks-made`
History event. Task, receipt and event persist together. Every Store load and
recovery path, including prepared document journals, checks receipt consistency.
Failure before persistence leaves no phantom receipt; failure after persistence
reconciles to the saved task. Replay does not undo later edits, moves or soft
deletion. No receipt is evicted.

The Console saves a pending transport request in tab session storage before
sending, coalesces concurrent submissions and retries a failed/uncertain response
once with the same command. Further uncertainty preserves that command across
reload; the Board restores the original form with **Retry create**. A changed
request cannot replace it. Storage errors are visible, and malformed records stay
preserved. A confirmed create closes the form even if the subsequent state refresh
fails, so a failed refresh does not invite duplicate creation.

Each receipted Board row has expandable **Creation receipt** details showing its
time, command and History event. IDs retain exact casing and wrap within the row.
Rows without a receipt show no receipt claim.
Ready remains a projection of the same Task with no run. Creation adds no Session,
task move, scheduler, lifecycle, permission grant or additional History event.

## Focused verification

- `tests/task-admission.test.ts`: concurrent/default-normalized replay, durable
  restart, read-only replay, payload conflicts, malformed/versioned input, legacy
  compatibility, distinct intentional creates, edits/deletion, project/HTTP scope,
  cross-family command collisions, persistence failures before/after save, and
  incompatible receipts rejected without rewriting saved evidence.
- `tests/task-create-client.test.ts`: save-before-send, same-tick submissions,
  response loss, module reload, changed payload refusal, uncertainty versus
  definitive refusal, receipt checks, storage faults and project isolation.
- `tests/workbench-board.test.ts`: receipt evidence appears only on recorded tasks.
- `tests/native-ui.spec.ts`: normal create/start, two lost create responses followed
  by reload/retry, visible receipt matching durable state, and confirmed creation
  followed by failed Board refresh. Browser fixtures use no paid model calls.

Gate results from this worktree:

- TypeScript: `node_modules/.bin/tsc --noEmit`, exit 0. Source:
  `test-results/task-admission-typescript.log` (empty success output).
- Full Vitest: 93 files passed, 1,585 tests passed, 1 existing Windows path-alias
  test skipped. Source: `test-results/task-admission-vitest.log`.
- Vite build: exit 0. The existing bundle-size advisory remains. Source:
  `test-results/task-admission-vite.log`.
- Playwright: all 31 tests passed across `tests/ui.spec.ts`,
  `tests/native-ui.spec.ts`, and `tests/field.spec.ts` on the final client build.
  Source: `test-results/task-admission-playwright.log`. The first startup attempt
  refused occupied shared ports before running tests; verification proceeded
  after the other worktree finished, without changing its processes.
- Inspected the final 1440 x 900 screenshot: the receipt is readable on the Ready
  row, with exact-case command/event IDs wrapping within their column. Browser
  assertions also check receipt/state identity, CSS casing and document width.
  Capture: `test-results/browser/native-ui-Console-retries--68718-d-shows-the-durable-receipt/console-task-creation-receipt.png`.

## Limits and impact

Pending browser request recovery is per tab and uses session storage, like Work
start. The server receipt survives app restart; preserving an unacknowledged
browser command after deliberate tab/storage removal is not established. A new
command ID intentionally creates a new task even with the same words. Existing
unversioned/internal creation paths are not retroactively made idempotent.

PILLAR IMPACT: advances 04, 06 and 08 through reachable evidence and deterministic
retries. No product definitions or permission meanings change; no conflict found.

ROADMAP IMPACT: implements the creation-admission gap recorded in
`2026-09-12-console-tasks.md`. No roadmap status, release claim or canonical cloud
document is changed.

BUILD / PUBLICATION / DEPLOYMENT STATUS: client bundle built locally; patch uncommitted. No package,
commit, merge, push, publication, installation replacement or deployment authorized
or performed. Packaged desktop behavior remains unverified for this patch.

## Changed files

- `shared/types.ts`
- `server/command-admission.ts`
- `server/task-admission.ts`
- `server/store.ts`
- `server/app.ts`
- `client/task-create.ts`
- `client/console/Shell.tsx`
- `client/console/BoardView.tsx`
- `client/console/board.css`
- `tests/task-admission.test.ts`
- `tests/task-create-client.test.ts`
- `tests/workbench-board.test.ts`
- `tests/native-ui.spec.ts`
- `docs/implementation/2026-09-12-console-task-admission.md`

Proposed commit message: `Admit Console task creation with durable receipts and retry identity`.
