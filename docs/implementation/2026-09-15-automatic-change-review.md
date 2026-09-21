# Automatic Change Review — deterministic, model-independent change review

**Date:** 2026-09-15
**Worktree / branch:** `F:\Diomedes\diomedes-wt\automatic-change-review`, `feature/automatic-change-review`
**Base:** `origin/main` at `daba366e3683962798d1f9a188e420c9e4dddf20`
**Work order:** H22 (`docs/product/2026-09-15-automatic-change-review.md`), extended by the task prompt to include the Git source and the generalized Business/structured source now.
**Uncommitted:** everything below. Nothing committed, nothing pushed, nothing packaged.

Canonical documents read for this slice: `docs/DIOMEDES_CORE_PILLARS.md` **2026-09-10.1**,
`docs/DIOMEDES_LIVE_ROADMAP.md` **2026-09-13.1**, `docs/DIOMEDES_PROJECT_MEMORY.md` **2026-09-10.7**,
`docs/product/2026-09-15-automatic-change-review.md`, `docs/reference/STANDING_DECISIONS.md`,
`docs/harness/RUNTIME_VERIFICATION.md`, `docs/implementation/2026-09-10-reviewer-and-agents.md`,
`docs/implementation/2026-09-10-autonomy-workbench.md`,
`docs/implementation/2026-09-11-files-pane-and-overview.md`,
`docs/product/2026-09-10-capability-packs.md`,
`docs/product/2026-09-10-project-files-and-agent-overview.md`.

---

## Problem

A person should not have to read a Git patch, raw JSON or command output to know what an agent
changed. Diomedes needed a Core capability that automatically collects changes while a run is live,
analyzes them mechanically, runs deterministic checks where allowed, renders a human-readable
summary, and attaches every claim to evidence — across software **and** ordinary Business
workflows. The model-backed `Code Reviewer` / `Approve for me` remains a separate, optional layer:
this review is evidence, not a judgment, and it grants no authority.

## Researched approaches and the decision

### Naming: "change source", not "adapter"

Diomedes already reserves *adapter* for engine routes (`server/engines/`). The product proposal
names the seam **change source**: the Core collects through pluggable sources; Software/Git is one
pack source; structured Business records are another. Implemented as `server/change-review/` with
one `ChangeEntry` output contract every source produces.

### Baseline / attribution strategy

A plain `git diff HEAD` lies in a dirty workspace: it cannot tell pre-existing edits from the run's
work. The implemented baseline is three independent, honest records captured at run start by
`runStarted` (called from `WorkService.start` and `NativeWorkService.start` before any of the
run's writes can land):

1. **Folder listing** (`snapshot.ts`): a walk under the same boundary rules as
   `Store.walkDocuments` — dot-entries, symlinks and `SKIPPED_FOLDERS` are never opened — plus a
   streaming SHA-256 and size per file, and a `listingDigest`. Comparing two listings reports
   created/modified/deleted/renamed/unchanged; a delete+add on identical content is reported as a
   rename, the same rule Git applies. Everything the walk chose not to inspect is named in
   `coverage.skipped` / `blocked` / `unavailable` — coverage is evidence, never silence.
2. **History scope** (`recorded.ts`): the baseline records the index of the session's first own
   History entry. `Store.writeRecorded` already saves before/after object hashes per file with the
   session, task and actor — the strongest attribution available. Entries before the boundary are
   pre-existing work; entries after it, matching the session or task, are `recorded` changes.
3. **Git status** (`git.ts`, Software Engineering pack only): see below.

What changed between baseline and now but has no recorded write is reported as `observed` — the
review says the file changed while the task ran, never that Diomedes wrote it. That is the whole
honesty model: `recorded` means Diomedes wrote it, `observed` means the comparison saw it,
`declared` means a structured record's own before/after values.

### Git source — hardened read-only observation

Method B from the research: use the installed `git` binary as repository truth, but never through
the person's index and never through repository-controlled execution paths.

- `prepareGit` creates a temp directory with a **private index seeded from the real one**
  (`GIT_INDEX_FILE`). Every snapshot re-copies the live index so staging that happens after the
  baseline is still visible. Nothing ever writes to `.git`.
- `git status --porcelain=v2 -z --untracked-files=all --no-ahead-behind` gives NUL-safe machine
  output covering staged, unstaged, untracked, renamed and unmerged paths — spaces and unusual
  characters included.
- Worktree content is hashed with `git hash-object --no-filters`, which never runs clean filters —
  a planted `.gitattributes`/`filter.*.clean` cannot turn a review into code execution.
- The porcelain `hI` field (index blob sha) is captured as `stagedSha`, so staged-only content
  moves are still detected when the worktree matches the index.
- The environment is scrubbed: `engineEnvironment()` allowlist, `GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` → NUL, `core.hooksPath` → NUL, `core.fsmonitor` and
  `core.untrackedCache` off, `diff.external` emptied, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`. All through `capture()` — explicit executable + argument array, no
  shell, 30 s timeout, 8 MB output bound.
- **Residual, documented:** `git status`/`diff` may still consult repo config for filter processes
  on content comparison (Git offers no flag to fully disable that path). The mitigation is that
  status is asked only for names, modes and index hashes; content identity comes from
  `hash-object --no-filters`. If Git refuses, the source reports `captured: false` with a reason
  instead of guessing.
- `diffGitSnapshots` compares two snapshots: a path dirty at baseline in *exactly* the same state
  (same XY, same worktree hash, same index hash, same rename source) is pre-existing — it is never
  attributed to the run.

### Generalized structured source — the Business path

`structured.ts` is a domain-agnostic before/after differ. A `StructuredRecord` is a labelled bag
of fields; each `StructuredField` supplies a stable `path`, a human `label`, a `kind`
(`value` | `list` | `set`) and optional `flagCodes` raised when the field moves. `sensitive`
fields report *that* they changed and never *what* they hold — the mask token `••• (recorded, not
shown)` is all that reaches the manifest. Output is the same `ChangeEntry` +
`StructuredFieldChange` contract the file sources produce, so rules, checks, the renderer and the
UI treat a business setting exactly like a file. No domain logic exists in Core.

### Rejected alternatives

- **A second Review lifecycle / state machine** — rejected. The manifest derives from existing
  `Session`, `Change`, `Need`, `HistoryEntry` records and the review is presented inside the
  existing thread/review surface.
- **Reimplementing Git semantics in JS** (isomorphic-git etc.) — rejected. The installed binary is
  the repository truth; the work went into isolating it safely instead.
- **Auto-stash / fake commits / worktree enforcement** — rejected explicitly. Baselines observe;
  they never mutate the person's work.
- **Tree-sitter / difftastic structural facts in this slice** — deferred with a clean seam.
  `ChangeEntry` already carries per-file evidence; a `symbol` source can add function-level facts
  later without changing the manifest contract. Prioritizing Core + Git + Business first was the
  task's own ordering.
- **New dependencies** — none added. Hashing is `node:crypto`, diffs for recorded content reuse
  the existing `diff` package patterns (Weekly Brief precedent), process execution reuses
  `server/engines/process.ts` (`capture`, `engineEnvironment`), path guarding reuses
  `server/paths.ts`, secret detection reuses `shared/business-setup.ts`'s `containsSecretLikeText`.

## The manifest — `shared/change-manifest.ts` (schema 1)

- `ChangeReviewManifest`: `schemaVersion`, deterministic `id` (`cr_` + digest prefix), `subject`,
  `outcome`, `baseline` + `baselineReason`, `changes`, `facts`, `flags`, `checks`, `summary`
  (three sentence groups), `coverage`, `generatedAt`, `rulesVersion`, `rendererVersion`, `digest`.
- `canonicalJson` sorts keys at every level; `manifestContent` covers the claim surface only —
  `id`, `generatedAt`, check `ranAt`/`durationMs` and the ledger are bookkeeping and stay outside
  the digest, so the same evidence digests identically whenever it is rebuilt, while any change in
  what the review *says* mints a new identity.
- `ReviewFact` carries `code`, `templateId`, structured `params` and `evidence[]`; `ReviewFlag`
  carries `code`, `ruleId`, `severity`, `text`, `paths`, `evidence[]`; every `ReviewSentence`
  names the `factIds`/`flagCodes` it renders. A sentence without evidence cannot exist.
- `BANNED_SUMMARY_WORDS` (`safe`, `secure`, `correct`, `verified`, `risk`, `score`, `looks good`,
  …) is enforced inside the renderer: a template that produced a banned phrase throws at build
  time. "No flags fired" is never rendered as "the change is safe" — silence is never a claim.
- `escapeVisible` converts control/bidi/invisible characters to visible `\uXXXX` escapes before
  any path or value reaches a sentence, so a malicious filename cannot disguise itself.

## Rules, checks, renderer

- `rules.ts` — `CHANGE_REVIEW_RULES_VERSION 2026-09-15.1`. Path rules (lockfile, config, CI,
  auth-path, permission-path, migration, API surface, executable, test file), structural flags
  (added/deleted/renamed/binary/oversized), dependency-manifest deltas (name-level add/remove/
  change via parsed `package.json`), content scans bounded to 512 KB (conflict markers, trailing
  whitespace, invisible/bidi characters, credential-like text), attribution flags
  (`outside-changes`, `blocked-paths`, `unavailable-files`, `uninspected-paths`,
  `uncertain-effects`), check-staleness (`check-stale-input` compares each check's `inputDigest`
  to the current one), structured-field flags and unchanged-field facts, and settle state
  (`changes-settled`: kept/undone/waiting counts from the Change records).
- `checks.ts` — deterministic scans only: `diff-integrity` (recorded hashes still match the files
  on disk), `conflict-scan`, `credential-scan`, structured-record validity. States: `passed`,
  `failed`, `skipped`, `error`, `not-run`. **Project commands never run**: typecheck/unit-tests/
  production-build appear as `not-run` rows naming why (running repository code is a Trust
  decision). `plannedProjectChecks` is the documented seam for a future Trust-bound command check;
  nothing is wired to it silently.
- `render.ts` — `CHANGE_REVIEW_RENDERER_VERSION 2026-09-15.1`. Fixed templates only:
  `files-changed`, `lines-changed`, `focus-areas`, `changes-settled`, `field-changed`,
  `collection-changed`, `fields-unchanged`, `no-changes`, `no-baseline`, `check-line`,
  `attention-flag`. Every emitted sentence is scanned against the banned-word list.

## Service — `server/change-review/service.ts`

One durable `ChangeReviewRecord` per session under `dataDir/change-review/<project>/<session>.json`
(baseline + latest manifest + append-only ledger of `baseline-captured` / `built` /
`rebuilt-kept` / `rebuilt-undone` / `rebuilt-restored` / `rebuilt-state` / `cleared` rows).
Builds are deterministic rebuilds — a manifest is recomputed from current evidence and replaced
only when its digest moves.

The service learns about work two ways: the explicit `runStarted` hook (before run writes) and
the store `change` event (covers terminal transitions, settle decisions and restores, including
sessions the hook missed — baseline then reconstructs the scope boundary from the session's first
own History entry). All record writes serialize through a per-session promise chain; baseline
capture is best-effort and degrades to an explicit `baselineReason` rather than failing a run.
Text for content rules/checks is prefetched under a 512 KB bound — recorded object blobs via
`store.object`, small worktree files via `projectFile` + `readTextOrNull`.

## Server and Console integration

- `server/app.ts`: `ChangeReviewService` constructed before the work services; routes
  `GET /api/projects/:id/change-review/session/:sessionId`,
  `…/task/:taskId`, `…/examples/:exampleId`. Existing `/review` routes untouched; the model-backed
  `ReviewerService` is untouched.
- `server/work.ts`, `server/native-work.ts`: one additive optional-dependency hook each —
  `runStarted` before the run's writes.
- `client/console/ChangeReview.tsx` + `change-review.css`: "What changed" section in the existing
  thread transcript (mounted in `ThreadView`, after `RunInspector`). Hierarchy: outcome/baseline
  notes → plain sentences → Needs your attention → Checks (Passed/Failed/Not run/Skipped/Error
  visually distinct) → Changes (kind badge, path, line stats, `observed` badge) → per-row evidence
  drill-down → "Technical details" (manifest id, digest, rules/renderer versions, baseline and
  coverage). Sensitive fields never render a value. Plain threads show only the two Business
  example links, not an empty section.
- Uses existing Console tokens (`--t1…t3`, `--hair`, `--attn`, `--fail`, `--light`, `--dm-type-*`,
  `--rb`, `--mono`); no new visual language.

## Business demonstrations — `server/change-review/fixtures.ts`

Two fixtures through the *same* differ → rules → checks → renderer → manifest:

- **Restaurant weekly operations report:** schedule `Monday 7:00 AM → Monday 6:00 AM`; recipients
  `3 → 4` (added `General Manager`); data sources `2 → 3` (added `Waste log`); permissions
  `2 → 3` (added `Assistant Manager`). Flags: `field-changed`, `recipient-list-changed`,
  `connector-changed`, `permission-set-changed`.
- **Small-business invoice reminder automation:** trigger `Mondays at 9:00 AM → Every day at
  8:00 AM`; destination `Email → Slack channel #billing`; enabled `On → Off`; access `2 → 3`;
  threshold `500 → 1000`; service key `sensitive` — the manifest contains no key bytes.
  Flags: `field-changed`, `connector-changed`, `automation-toggled`, `permission-set-changed`.

## Trust and security interactions

- Grants nothing, approves nothing, withholds nothing — the review is evidence for the person and
  (optionally, later) for the model reviewer. A flag is not a reviewer decision; a reviewer
  decision is not a fact.
- No project code executes anywhere in the pipeline. Git runs read-only inspection through the
  existing bounded `capture()` boundary; declared command checks stay `not-run` with the reason.
- Repository content is untrusted: NUL-safe porcelain parsing, guarded `projectFile` resolution,
  streaming hashes, output and read bounds, `escapeVisible` on every rendered path/value,
  credential-pattern scans, sensitive-field masking, symlink/hidden/skip-folder boundaries shared
  with the document walk.
- The manifest lives under the app's `dataDir`, never inside the reviewed project folder — a
  review cannot be poisoned by the content it describes.

## Tests — `tests/change-review.test.ts`, `tests/change-review-ui.spec.ts`

Unit/integration (52 tests): canonical JSON key ordering; digest stability across `generatedAt`;
structured differ (scalar/collection/unchanged/sensitive masking/added/removed/bounded members);
both Business fixtures end-to-end with severity separation and no secret bytes; folder diff
(added/modified/deleted/rename/unchanged, coverage notes, file-cap honesty); recorded-writes
scoping and settle state; outside-history → observed; dependency added/removed/changed exactness;
deleted-file flag + evidence; outside-changes flag; banned-word throw; identical renders; settle
sentence; diff-integrity passed/failed/skipped/error + sha-prefix normalization; conflict and
credential scan failures; command checks `not-run`; real-git baseline isolation, mode transitions
(644→755→644), numstat binary, pre-dirty post-baseline delta, unusual filenames, synthetic
NUL-parsing; binary content detection (folder + git) and binary-never-rendered; bounded text
evidence (diff/excerpt/truncation declared/oversize refused); severity policy (info default,
attention for recipients/connectors/permissions/credentials, expansion vs contraction);
structured bounds (member cap with true totals, scalar cut marker); the generalized
every-sentence-resolves-to-evidence invariant; the no-model lexical guard; HTTP: sample run,
outside file observed, keep/undo, declined → honest no-change, mid-window pre-dirty delta,
terminal-session record byte-identical across a later session's history.

Browser (3 tests, `change-review-ui.spec.ts`): task thread renders the verified review —
sentences, distinct check states, change list, per-row evidence, technical details; a plain
thread serves both Business examples with field drill-down and no sensitive value; Failed vs
Not-run checks render separately, and a binary change shows metadata with no patch body.

## Independent audit correction pass

An independent Muse audit reproduced the four gates and returned a **conditional pass / B+**:
the architecture held, but specific audited deficiencies remained. This section records the
correction pass — each finding, the exact fix, and the regression that proves it.

### Findings and corrections

1. **Binary support was not real.** `binary: false` was hardcoded through the sources, so
   `binary-changed` could never fire. **Fix:** `inspectFile` now streams each file's first
   `BINARY_PROBE_BYTES` (8 KB) for a NUL byte — deterministic, documented as a bounded head
   probe — and the Git source asks Git itself: `diff --numstat -z` marks binary paths with
   `-`/`-`, with the same head probe for untracked files. Binary entries render metadata
   only; `textEvidenceFor` returns `kind:'none', reason:'binary'` so bytes are never
   decoded as text. *Tests:* real NUL file classified binary, modified binary produces a
   `binary-changed` flag, Git numstat marks a committed-then-modified binary, text stays
   non-binary, probe-window boundary exercised.

2. **Git file modes were parsed and discarded.** Porcelain v2 `mH/mI/mW` were read but
   dropped. **Fix:** `GitWorktreeFile` carries `headMode`/`indexMode`/`worktreeMode`;
   `effectiveGitMode` reports worktree when it moved, else the index (which carries staged
   transitions); entries carry `modeBefore`/`modeAfter`, and a transition emits a
   `file-mode-changed` fact plus `executable-bit-set` (attention) / `executable-bit-cleared`
   (info) flags. Wording says "Git file mode" — never OS-level executable semantics. The
   filename-based `executable-changed` path rule was reworded to "a script or program file
   changed" so it cannot be misread as mode evidence. *Tests:* real repo,
   `git update-index --chmod=+x` stages the transition in the real index (NTFS-independent),
   100644 → 100755 produces the attention flag and the rendered "became executable."
   sentence, `--chmod=-x` produces the cleared flag, `.sh` alone flags nothing.

3. **Technical drill-down showed no actual change.** Evidence rows carried ids and sha
   prefixes only. **Fix:** new `server/change-review/text-evidence.ts` produces a bounded
   unified-style diff when both sides exist, a labelled excerpt for one-sided changes, and
   `none`+reason otherwise. Before-content is retained at baseline (content-addressed blob
   store, 64 KB/file, 4 MB total) or read from the Git object store via the baseline's
   staged/HEAD blob ids; a path clean at baseline resolves its before-side from the entry's
   own `beforeSha` (the committed HEAD blob). *Tests:* a text modification renders real
   `−`/`+` lines, added/deleted produce excerpts, >200 changed lines truncate with an
   explicit count, oversized sides refuse with `unreadable`, binary never reaches the
   renderer.

4. **Missing acceptance tests.** Added: clean/declined run → honest no-change sentence;
   unusual filenames (spaces, Unicode, Windows-legal punctuation) through both a real repo
   and synthetic NUL-delimited porcelain; pre-dirty file further modified after baseline
   reports only the post-baseline delta (git-source and HTTP-service level); check `error`
   as a distinct state; structured collection removal; Failed vs Not-run rendered
   separately in the browser; a lexical guard asserting no change-review module can reach
   a model adapter.

5. **Attention severity was uniform noise.** Every structured field change raised
   `attention`. **Fix:** a deterministic severity policy — `info` is the default;
   `attention` is reserved for descriptor-flagged consequential codes:
   `recipient-list-changed`, `connector-changed`, `automation-toggled`,
   `credential-changed`, and `permission-set-changed`. Flag text states the concrete reason
   and names the delta ("expanded — Assistant Manager was added"); permission expansion and
   contraction are stated apart. *Tests:* restaurant and invoice fixtures produce info for
   the schedule/threshold and attention for recipients/access/credentials; contraction
   reads "narrowed", never "expanded".

6. **Scale traps.** **Fix:** `noteChange` now rebuilds only sessions whose evidence could
   have moved — own state, own change records, own History entries — plus live sessions on
   any new project write; terminal sessions are immutable evidence of their own window.
   Hashing streams (`inspectFile`); text prefetch is budgeted (`PREFETCH_MAX_FILES`,
   `PREFETCH_TOTAL_BYTES`); the folder walk and manifest entries are capped with honest
   counts (`filesSeen` vs indexed, `detected` vs listed in `coverage.limits`); structured
   members and scalar display values are bounded with true totals preserved. *Tests:*
   file-cap walk still counts every file it saw; a 3 MB file hashes correctly through the
   stream; oversized collections keep `addedTotal` while bounding `added`; a second
   session's history append leaves a terminal session's persisted record byte-identical.

7. **Summary sentences could carry no evidence.** `no-baseline` and check sentences had
   empty `factIds`/`flagCodes`. **Fix:** every sentence now carries typed
   `ChangeEvidenceRef`s — check sentences cite the check record itself, the no-baseline
   sentence cites the null baseline ref, and `sentence()` *throws* on an empty evidence
   array so a future renderer cannot regress. *Tests:* a generalized invariant test
   resolves every sentence's refs across file-change, no-baseline and both business
   manifests; fact ids resolve to facts, flag codes to flags, check refs to checks.

### Small correctness fixes folded in

- `dependency-removed` is now raised for a deleted manifest or a removal-only delta,
  distinct from `dependency-added` and `dependency-changed`; the flag names the members.
- Recorded `FileRecord` SHAs were bare hex while live scans used `sha256:`-prefixed
  digests — `diff-integrity` could never pass on recorded entries. Comparisons now
  normalize on the digest itself.
- Structured field sentences render in descriptor order (the business order the record
  declares), not regrouped by kind; manifest canonical ordering stays deterministic
  independently.
- Stale `.diomedes/change-review/` path comment corrected to the real record location.
- Diff rendering indexes lines by cursor, not `indexOf` — duplicate lines no longer
  mis-order.
- Per-session Git inspection environments were retained forever; each is now cleaned
  once its session's terminal manifest is persisted (active sessions keep theirs for
  later rebuilds), and any remaining are cleaned at service close.
- The service had no shutdown drain: `noteChange` enqueues fire-and-forget builds that
  write `data/change-review/`, so an in-flight persist could race removal of the data
  dir (surfaced once as `ENOTEMPTY` in `harness-host` teardown under load).
  `ChangeReviewService.close()` now removes the store listener, drains every session
  chain and cleans remaining Git temp dirs; `app.locals.close` awaits it before the
  other services settle, and `enqueue` refuses new work once closed so a read landing
  mid-drain cannot write behind it.

## Verification results (this worktree, `feature/automatic-change-review`)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | PASS (0 errors) |
| Unit suite | `npx vitest run` | PASS — 100 files, 1719 passed / 1 skipped (1720 total; the skip is pre-existing in `tests/paths.test.ts`) |
| Unit suite, bounded workers | `npx vitest run --maxWorkers=2` | PASS — 100 files, 1719 passed / 1 skipped |
| Client build | `npx vite build` | PASS (1.32 s; pre-existing >500 kB chunk warning) |
| Browser gates | `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts tests/change-review-ui.spec.ts` | PASS — 37 passed / 0 failed (55.2 s, includes all three CR-UI tests) |

An earlier `--maxWorkers=2` run of this pass produced one `ENOTEMPTY` teardown failure in
`tests/harness-host.test.ts` — investigation found the cause in this feature (the missing
service drain above), fixed it, and both worker configurations now pass clean.

One suite-hygiene fix the browser run surfaced: the spec originally created the
named sample project (`POST /api/projects/sample`), which persists in the shared
per-run data dir and hides the landing's 'Try the sample project' link for
`ui.spec.ts` F01 later in the same run — projects cannot be deleted via the API.
The spec now drives the sample *route* on an ordinary project
(`POST /api/projects`), which produces identical recorded writes without
claiming the sample project's name.

## Remaining limitations after the correction pass

- Binary detection is the documented bounded probe: a NUL byte within the first 8 KB (folder,
  recorded text, untracked Git paths) or Git's own numstat verdict (tracked changes). A binary
  file whose first 8 KB happen to be NUL-free is classified text — bounded by design, not a
  heuristic guessing filenames.
- Before-content exists only where evidence allows it: retained baseline blobs (≤64 KB each,
  ≤4 MB per baseline), recorded objects, or committed Git blobs. A pre-dirty *uncommitted* Git
  edit's earlier bytes are not in the object store, so that case degrades to an excerpt.
- Command checks remain `not-run` — no project code executes without a Trust admission.
- The reviewer model does not consume the manifest yet — that is the documented next slice,
  not shipped.
- Business coverage is the generalized structured differ plus the two fixtures; production
  connector wiring is a later slice.
- Model independence is proven by construction (no import path can reach a model adapter);
  the lexical guard test fails loudly if one is added.

## Limitations

- Command checks (typecheck/tests/build) are declared `not-run`; wiring them to a Trust-bound
  command admission is a separate, later slice.
- `git status` may still consult repo config for filter processes on content comparison
  (documented residual); content identity itself comes from `hash-object --no-filters`.
- No syntax-aware (symbol-level) facts yet — the seam exists via a new source producing the same
  `ChangeEntry` contract.
- Observed (non-recorded) entries carry hashes but no line counts; line stats are exact only for
  recorded writes.
- `runStarted` covers the two work services; a session that began before the feature existed gets
  an honest `baselineReason` and a reconstructed scope boundary, not a fabricated baseline.
- The manifest shows the newest session for a task; earlier sessions are addressable via the
  session route.

## Next logical slices

- Trust-bound command checks behind the existing admission boundary.
- Symbol-level facts via a structural source (tree-sitter or difftastic-as-precedent study).
- Reviewer consumption of the manifest as context (deterministic evidence feeding the optional
  model layer, never the reverse).
- More change sources under the same contract: document/automation/connector records.
