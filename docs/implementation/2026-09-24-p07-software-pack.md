# P07: the Software Engineering pack's repository slice — Git, worktrees, mediated commands

Date: September 24, 2026. Lane `p07-software-pack`, branch `feature/p07-software-pack`, base
`origin/integration/overnight-batch-5` (bc7833f). Linear DIO-33 (P07: Software pack with repository
context, Git, worktrees and mediated build/test tools).

Canonical documents read: Core Pillars 2026-09-22.1, Live Roadmap 2026-09-24.1, Project Memory
2026-09-24.1; `docs/product/2026-09-10-capability-packs.md` in full (§3, §4, §4.2); the P01–P03
lifecycle, P06 diffs, H12 mediated effects, H17 verified completion and H18 context accounting
records. None of the canonical documents, `QUESTIONS.md`, the version or the native-runtime hashes
is edited here. The exact proposed patch is at the end.

---

## What shipped

Everything below is contributed by `diomedes.software-engineering` and exists only in a Project that
turned that pack on. It deepens the Console's Files pane; there is no second surface (decisions 1,
13, 14 and capability-packs.md §4.2).

### 1. Git status and history (read-only)

- `server/software-pack/git.ts` runs the `git` program **only** through H12's `containedSpawn`: no
  shell, a working folder through the containment funnel, the minimal environment, bounded output
  and a timeout that ends the process tree.
- Every git call is additionally pinned so that reading a repository cannot run anything the
  repository names: `GIT_CEILING_DIRECTORIES` is the project folder's parent (git never walks up to a
  repository that contains the project), no HOME and `GIT_CONFIG_NOSYSTEM` (no global or system
  configuration), `core.fsmonitor=false`, `--no-ext-diff --no-textconv` on every diff,
  `--no-optional-locks` so a read never rewrites the index, and hooks pointed at a folder that does
  not exist. A test sets a repository's `core.fsmonitor` and `diff.external` to a canary program and
  proves it never runs; a manual check confirmed plain `git status` on the same repository does run
  it, so the pin is load-bearing.
- The view: branch (or detached), HEAD, upstream and ahead/behind, changed files (porcelain v2,
  renames with where they came from, untracked, conflicted), and the 20 most recent commits with
  author, date and message. A changed file whose name the path guard would refuse (`.env`, `*.pem`,
  anything under a guarded folder) is **counted, never listed**. More than 500 changes are counted.
- **A folder that is not a repository says so**: "This project folder is not a Git repository." A
  project that is a subfolder of someone's repository is also not read as that repository, because
  that repository reaches outside the project.
- `git_status`, `git_file` (one changed file at HEAD and now) and `git_diff` are H12 `read` tools
  (`server/software-pack/tools.ts`) with strict input and output schemas, run through the registry's
  validation, timeout and output bounds.
- Console (`client/console/Repository.tsx`, `repository.css`): a Repository section at the top of the
  Files pane — branch and HEAD, changed files, recent commits; clicking a changed file shows P06's
  readable diff (unified or side by side, folded context, word marks) against HEAD.

### 2. Worktrees and branches

- `worktree_add` and `worktree_remove` are H12 `non-idempotent-effect` tools: permission
  `write-project-file`, **exact approval**, declared targets (`.diomedes-worktrees/<name>` and
  `git-branch:<branch>`), effect record written before they run.
- Worktrees live under `.diomedes-worktrees/` **inside** the project, so the path guard
  (`server/paths.ts` through `containedPath`, decision 11) judges them; a name outside
  `[a-z0-9-]{1,40}`, a branch git would not accept or that starts with `-`, an existing branch or
  folder, or a worktree folder swapped for a link to outside is refused with nothing changed.
- Add creates a **new** branch from HEAD in the new folder. The person's checkout — its branch, its
  uncommitted edits, its status — is untouched (tested byte for byte). The pack's own worktree
  folder is excluded from the Repository view's changes.
- **Never force-deleted.** Remove first asks git whether anything in the worktree is uncommitted
  (staged, unstaged or untracked). If so it stops and says so ("… has 1 file with uncommitted changes
  (draft.txt). Commit or discard them yourself first; Diomedes never force-removes a worktree.
  Nothing was removed."). Only then does it run `git worktree remove` **without** `--force`, so git
  refuses a dirty or locked worktree itself as a second guard. The branch and its commits are kept.
- Only a worktree this pack added can be removed here.

### 3. Mediated build and test commands

- A project declares its commands (`PUT /api/projects/:id/software/commands`, History entry
  "You declared … Declaring runs nothing; each run asks first."). A task's H17 `command` acceptance
  checks — recorded but never run before this — are offered too, labelled as task checks.
- **argv only.** A command is split on spaces into plain words (`shared/software-pack.ts`
  `parseCommandLine`). A word with anything a shell would interpret (`& | ; < > ( ) $ \` " ' * ? [ ]
  { } ~ ! # % ^`, newlines, tabs) is refused with `command_shell_refused`, never quoted or escaped;
  a shell or re-executor as the program (`bash`, `sh`, `cmd`, `powershell`, `pwsh`, `env`, `sudo`,
  `xargs`, …) is refused with `command_shell_program`. The words are judged again at the point of
  use, never trusted from the request.
- `run_command` is an H12 `non-idempotent-effect` tool: permission `write-project-file`, exact
  approval, targets `<folder>` and `command:<words>`, a per-command timeout (1 s – 9 min, default
  2 min) that ends the process **tree**, 1 MB of output at most (then the tree is ended), and the
  minimal environment (a canary `*_TOKEN` in the parent is proven absent in the child).
- A known outcome is **returned, not thrown**: `passed`, `failed` (non-zero exit), `timed-out`,
  `output-capped`, `error` (program not found; on Windows a `.cmd`/`.bat` script, which needs a
  shell) or `refused`. The last 16 KB of each stream is kept on the record, including what a
  timed-out command wrote before it was stopped (`containedSpawn` now attaches it to its error).
  Only something unforeseen throws, and H12 then records the effect as **uncertain** rather than
  guess; the record says "not confirmed", and nothing runs it again.
- **Approval.** Each run is one harness run on the host's `RunService` with one tool step dispatched
  through `ToolRegistry.dispatch`. It stops at `waiting_approval`; the Console shows exactly what
  will run, where, without a shell and under what limit; Go ahead posts the intent hash it was shown
  and the host refuses any other (`exact_approval_required`) before calling `RunService.decide`. The
  effect record carries `authorization: approval:<intentHash>`. Declining cancels the run and runs
  nothing. One command at a time per project.
- **Remembered approvals do not apply**: `classifyApproval` does not recognise a command or a
  worktree change, so each one asks, every time — which is also "approval before the first run of
  each distinct command", recorded per run. See *Proposed defaults*.
- **Evidence for H17.** `VerificationService` takes an optional `commandEvidence` dependency; where
  the pack is on, a task's `command` check is judged on the pack's newest recorded run of exactly
  that command in the project folder that **started after the work finished**, provided no recorded
  write came after it **and** the repository fingerprint (HEAD, porcelain status, the full diff
  against HEAD and every untracked file's content) is still the one it ran on. Exit 0 → *passed*
  (so a task can now be Verified on evidence); non-zero → *failed* with its last output line; stale,
  timed out or not yet run → *incomplete* with the reason. The verifier never runs a command itself.
  Where the pack is off the old sentence stands unchanged.
- A command or worktree change a stop interrupted (recorded as running, carried out by no job in
  this process) is settled as unconfirmed with a History entry the next time the section is read,
  and never re-run; it no longer blocks the next command.

### 4. Repo-aware context

- **Attach changed files**: the chosen changed files attach to the open thread's next message
  through the existing P05 attach path, so they go as the message's selected sources, under Cloud
  sharing's existing checks, and H18 accounts them as project files. The Console states the H18
  estimate (`utf8-bytes/4`) before and after.
- **Add diff to message**: the unified diff of the chosen changed files (git's own output; a
  synthesised new-file diff for untracked files) is placed in the message box as a fenced `diff`
  block, where the person reads and edits it before sending; H18 accounts it as message text. It
  goes **whole or not at all** (48 KB), only files git lists as changed can be chosen, and a file
  outside that list is refused — the whole repository is never pasted.
- The composer gained a small `insert` input (like the existing playbook `skill` input), and
  attaching several files in one click now keeps them all (the attach callback uses a functional
  state update).

### 5. History and attribution (decision 8)

Declarations and approvals are `actor: 'you'`; results are `actor: 'diomedes'` with an application
origin whose executor is `diomedes:software-pack` — a fixed procedure ran them, no model authored
anything. Every run keeps its harness run file (intent, approval, effect record, outcome). Nothing is
pruned (decision 10); the project keeps the newest 200 command records, and older ones stay in
their run files.

---

## Tests

| File | Count | Covers |
| --- | --- | --- |
| `tests/software-pack-git.test.ts` | 41 (1 Windows-only) | porcelain v2 parsing (branch headers, renames with `-z`, untracked, conflicts, spaced and non-ASCII names, detached, no commit yet); log parsing; new-file diff; a real temp repository's branch, changes, commits with authors and messages; private names counted not listed; the worktree folder excluded; not a repository; a subfolder of a repository not read as it; no commit yet; **a configured fsmonitor and external diff never run**; file at HEAD, missing, `..` and private refused; fingerprint moves with tracked and untracked content; **Windows**: a root spelled with forward slashes or a trailing separator; a path with spaces and umlauts; argv parsing: 4 accepted, 15 shell lines and 6 shell programs refused, empty and oversize |
| `tests/software-pack.test.ts` | 18 | Through `createApp` and HTTP: **every route refuses with `pack_inactive` and no process is started** (every `containedSpawn` call counted) and nothing is recorded; turning off refuses again and keeps records; a tool refuses at the point of use; the Git view, the diff sides, the diff text, an unchanged file and `..` refused; not a repository; **worktree add waits (red), a wrong intent hash is refused, the exact approval adds it (green)**, the checkout is untouched, the effect record carries targets and `approval:<hash>`; **a dirty worktree is refused and kept, a clean one removed and its branch kept**; decline changes nothing; bad names and branches refused; a linked worktree folder refused with nothing written outside; **a command does not run before approval (red), decline runs nothing, approval runs it once (green)**, asks again next time; a failing exit is a recorded failure; **timeout ends the command and its grandchild**; **output cap**; **minimal environment**; **shell metacharacters and shell programs refused** at declaration and at run for a task check, with no run created; cwd outside refused; **an interrupted run settled and not blocking**; **H17: red without the pack, "not run yet" with it, Verified after an approved passing run, uncertain after the repository moves, Failed on a failing command** |
| `tests/software-pack-ui.spec.ts` | 1 (Playwright) | The built Console on a fixture repository: no Repository section where the pack is off; branch, changed file, commit author and message; the readable diff; Attach changed files puts the file on the composer with the H18 estimate; Add diff to message fills the box with the fenced diff; Run shows the exact request, Go ahead runs it, the result reads Passed · exit 0 with its output; a shell line is refused at Declare; no horizontal overflow |

Red, then green, shown in this lane by disabling the code under test and re-running: the two H17
evidence tests fail with the `commandEvidence` hook unwired (the check stays "Trust decision this
build does not make" / not `failed`) and pass wired; the interrupted-run test fails with settling
disabled and passes with it. The approval-gating tests assert the red state (nothing exists, nothing
spawned) inside the same test before approving.

Gate counts are in the pull request, from the final run on the merged head.

---

## Known gaps (not shipped, and not claimed)

1. **Approvals are answered in Files > Repository, not as a thread Need.** The harness → Need path
   (`HarnessBridge.mirror`, `approval-admission.ts` load validation, `Store.writeRecorded`) accepts
   only recorded file writes (`harnessWrites`), and widening it touches Trust internals several
   lanes share. The approval primitive is the same (`RunService.decide`, bound to the exact intent
   hash, TTL, identity generation), but these runs have no Session or Task, do not appear on the
   Board, and cannot be remembered.
2. **No Agent uses these tools yet.** They are registered in a pack-owned `ToolRegistry`; nothing
   offers them to a model route or the native loop. An Agent working on a worktree's branch is the
   next slice.
3. **The Software Engineering manifest is unchanged (0.1.0, one need).** Changing it would change
   the preinstalled pack's digest in P01's store on existing installations. The slice's needs are
   declared on its tools and shown in the section as requests; the manifest bump is in the proposed
   patch.
4. **The diff as context is message text.** There is no separate "repository" context section in
   H18; the diff is counted as the message, and only on the routes H18 accounts (model-API
   conversations). External engines receive it as the message they are sent.
5. **Windows `.cmd`/`.bat` programs cannot be run** (`npm test` on Windows): starting one needs
   `cmd.exe`, which is a shell. The record says so and suggests declaring the program itself
   (`node …`). Windows and macOS runs of the new suites happen on the pull request's CI.
6. **A repository-local filter or hook configured by the person** (`filter.<name>.clean` in
   `.git/config`) can still run during `git status`; hooks are disabled, fsmonitor and external
   diff are pinned off, and a cloned repository cannot carry such configuration, but a person's own
   `.git/config` can.
7. **The person's own `git status` shows `.diomedes-worktrees/`** as untracked unless they ignore
   it; Diomedes does not write `.gitignore` or `.git/info/exclude` for them (that would be touching
   their checkout).
8. **Commit, push, merge, stash and branch deletion are not offered.**
9. **The H17 evidence is judged at verification time and bound by fingerprint, not by a History
   digest**, so a repository change after verification is caught the next time the task is
   verified, not by the existing `outputs-changed` projection row.
10. **An interrupted command is settled lazily**, when the section is next read or a command is next
    asked for.

## Proposed defaults (Andrew's to confirm)

- **§5.1 Granularity: one pack.** Git, worktrees and commands ship as the first pieces of the one
  Software Engineering pack, activated together; splitting diagnostics or LSP into optional pieces
  stays open until one exists.
- **Every command run and worktree change asks, every time.** Remembered approvals are not offered
  for them in this slice (the classifier already treats them as unrecognised); a person sees
  "approved before" as information, never as authority.
- **Worktrees go under `.diomedes-worktrees/` inside the project** and branch from HEAD on a new
  branch named `diomedes/<name>` unless the person names one.
- **Repository hooks do not run** for a worktree change made by Diomedes.
- **A project that is a subfolder of a repository is not read as that repository.**

---

## Proposed canonical-doc patch

For the integrator. Nothing below is applied on this branch.

**`docs/DIOMEDES_LIVE_ROADMAP.md`**, section 5, append after the paragraph beginning "Packs compose
tools, Agents, rules, context, workflows and relevant UI":

> P07 first slice (2026-09-24, DIO-33, `docs/implementation/2026-09-24-p07-software-pack.md`): where a
> Project turns on the Software Engineering pack, the Files pane shows the repository — branch,
> changed files with a readable diff against HEAD, and recent commits — read with git through H12's
> contained spawn and pinned so a read runs nothing the repository configures. Worktrees for a task
> are added and removed as H12 effects after an exact approval, inside the project path guard, and a
> worktree with uncommitted work is never removed. Commands the project declares run as plain words
> with no shell, a minimal environment, bounded output and a timeout that ends the process tree,
> each after an exact approval; an approved run of a task's declared command is now H17 evidence, so
> a task can be Verified on a passing test run bound to the repository state it ran on. Changed files
> and a chosen diff can be added to a message as context, counted by H18. Approvals are answered in
> the Files pane rather than as thread Needs, no Agent uses these tools yet, and nothing loads where
> the pack is off.

and in §9 "Existing open decisions remain:", append: "whether a declared project command or a
worktree change may ever be a remembered approval, and under what pattern; whether pack approvals
become thread Needs."

**`docs/DIOMEDES_PROJECT_MEMORY.md`**, under "Files, packs, permission and evidence", add:

> **Declared command; command evidence.** A *declared command* is a build or test command a person
> recorded for a Project (or as a task's acceptance check). Declaring runs nothing. Each run is a
> recorded effect that waits for an exact approval, runs as plain words without a shell, and keeps
> its exit code, the end of its output and the repository state it ran on. That record is *command
> evidence*: verification may count it only if it ran after the work finished and the repository
> has not changed since.

**`docs/product/2026-09-10-capability-packs.md`**, §4, after §4.2, add "### 4.3 What shipped
first (P07)" with the paragraph above, and in §6 append: "The Software Engineering pack's repository
slice (Git view, worktrees, declared commands, repository context) landed on 2026-09-24; see
`docs/implementation/2026-09-24-p07-software-pack.md` for what it does and does not do." In §5
question 1, record the proposed default: "Proposed default (P07): one pack; Git, worktrees and
commands are its first pieces."

**`AGENTS.md` decision 13**, in the sentence "Anything beyond the recorded boundary (attachments,
broader previews, code editing, Git, diffs, LSP) is still not shipped", the integrator should
reconcile with P05, P06 and this slice: Git status/history, worktrees and declared commands exist
for projects with the pack on, within the boundary in this record; code editing and LSP remain
unshipped.

**`shared/capability-packs.ts`** (with the P01 store update path): bump
`diomedes.software-engineering` to `0.2.0`, add `tools` and `workflows` to `contributes`, add the
needs `write-project-file` ("To add or remove a worktree and to run a command you declared; each one
asks first.") and a `files` UI affordance `repository`, and add the test updates that pin today's
single need.

**`QUESTIONS.md`**: answer nothing; add under capability packs: *P07 — pack approvals*: should a
declared command run or a worktree change ever be rememberable, and should pack approvals appear as
thread Needs? Default until answered: always asks, answered in Files > Repository.

---

PILLAR IMPACT: advances capability packs composing, not paralleling (decision 14) — one RunService,
one tool registry contract, one approval primitive, one path guard, the existing attach and diff
surfaces; activation still grants nothing, and every write names its authority. Decision 11 is kept:
worktrees and command folders go through the containment funnel and nothing widens the guard.
Decision 12 is kept: the slice is one Project's profile and invisible elsewhere. Decision 8: results
are application actions, attributed as such. Decision 10: records are appended, never pruned. The
one tension is gap 1 (approvals answered outside the thread Need flow); it is stated, not hidden.

ROADMAP IMPACT: P07 (DIO-33) first slice implemented — Git view, worktrees, mediated declared
commands with H17 evidence, repository context — with the gaps above. H17's "authorized
command-execution path for declared project commands" gap is closed where the pack is on.

BUILD STATUS: feature branch only; one draft pull request against `main`; not merged, not packaged,
no version bump, no native-runtime hash change, no canonical document edited.
