# H12 — Typed tools, mediated effects and real execution containment

Linear: DIO-17. Branch `feature/h12-mediated-effects`, from `integration/overnight-batch-3`, with
`origin/main` merged before the final push. Date 2026-09-24.

## What was missing

The 2026-09-23 audit found typed tools (`server/harness/tools.ts`), the mandatory policy boundary
(`server/harness/policy.ts`), RunService's approval and permission gating, the Trust port, the
read-scope tools and the path guards in `server/paths.ts`. The accepted "v3" patch never reached
`main`; it was re-derived here from the current source, not recovered. Missing for DONE: a
complete tool declaration refused when incomplete, **recorded-effect admission**, containment below
the tool (targets, sizes, time, processes), and a **containment attack matrix**.

## What shipped

### 1. Typed tool contract (`server/harness/tools.ts`)

A `ToolDefinition` now declares, and `ToolRegistry.register` requires:

| Field | Rule | Refusal code |
|---|---|---|
| `schema` / `execute` | present (unchanged) | `invalid_tool` |
| `outputSchema` | a zod schema | `tool_contract_incomplete` |
| `effectClass` | `pure`, `read`, `idempotent-write`, `non-idempotent-effect`, `external-send` | `tool_contract_incomplete` |
| `permission` | own property; a name, or explicit `null` | `tool_contract_incomplete` |
| `approval` | boolean approval policy | `tool_contract_incomplete` |
| `trustedInputRequired`, `description` | present | `tool_contract_incomplete` |
| class vs `effect`/`destination` | `idempotent-write` → local `idempotent`; `non-idempotent-effect` → local `non-idempotent`; `external-send` → external `non-idempotent`; `pure`/`read` either destination | `tool_contract_mismatch` |
| `targets(input)` | required for every class that changes the world | `tool_contract_incomplete` |
| `permission` of an `external-send` | must not be null | `tool_contract_incomplete` |
| `limits` | within hard caps (10 min, 4 MB in, 8 MB out) | `tool_contract_incomplete` |

At run time every handler runs under the tool's timeout (default 60 s, `tool_timeout`, the handler's
signal aborts), its input under `maxInputBytes` (default 64 KB, `tool_input_too_large`) and its
output under `maxOutputBytes` (default 512 KB, `tool_output_too_large`); an output that is not plain
JSON or does not match `outputSchema` is `tool_output_rejected` and is never recorded. The
model-facing `ToolDescriptor` is unchanged (no output schema, targets or handler reach a model).

Every production registry was brought to the full contract: attached-source tools, read-scope tools
(`list_files`, `read_file`, `search_files`, `fetch_page`, `connector_read`), team tools
(`non-idempotent-effect`, target `team:<projectId>`, permission null because TeamService membership
is the gate), the report and weekly-brief capabilities, the Connections fixture read tools and the
test-only write probe. `tests/h12-tool-contract.test.ts` pins the refusals and that each of these
registries passes.

### 2. Recorded-effect admission (`RunService`, no parallel store)

`ToolRegistry.dispatch(runs, request)` is the one mediated path: validate the input, compute and
contain the declared targets, then run one RunService `tool` step carrying an `effectRecord`
declaration. NativeAgent, the weekly brief and the Codex report write now use it; every existing
intent hash is unchanged (the declaration is not part of the intent).

For every class but `pure`, RunService pushes an `EffectRecord` (`shared/harness.ts`) onto
`StepRecord.effects` **in the same durable commit that starts the attempt**, before the handler can
run: `tool`, `effectClass`, `attempt`, `inputsDigest` (sha-256 of the canonical validated input),
`targets`, `idempotencyKey`, `principalId`, `identityGeneration`, and `authorization` —
`approval:<intentHash>` for a consumed exact approval, `host:<ref>` for a host grant reference (the
Codex write records `authority:<authorityHash>`), `permission:<name>` for a held capability, or
`none`. Events `effect.intended` → `effect.applied` / `effect.failed` / `effect.uncertain` /
`effect.abandoned` / `effect.reconciled` sit in the run's own event log. One record per attempt,
appended, never rewritten (decision 10). The saved-run schema (`readableRun`) reads them
fail-closed.

**Outcomes.** Success → `applied` with the output hash. A handler that reports failure → `failed`
(an idempotent write may then retry under the same idempotency key, as before). A non-idempotent
effect or external send that errors → `uncertain` (as before, now recorded). **A crash, a lease
takeover, a cancel, or a timeout between intent and outcome of any write** → `uncertain`, its step
`reconcile_required`, and a dispatch of that step is refused with `effect_uncertain`; the handler is
never called again. A read interrupted the same way changed nothing: `abandoned`, and it retries.

**Reconciliation.** `RunService.reconcileEffect(runId, stepId, { resolution, by, evidence,
output? })` settles an uncertain effect: `applied` settles the step (with the sink's recorded output
when given), `not-applied` lets it run once more under the same idempotency key as a new attempt with
a new record. Who and on what evidence is kept on the record; a second reconciliation is
`not_uncertain`. A tool may declare `reconcile`; `ToolRegistry.reconcile` accepts only a definite
answer and the bridge runs it at recovery. The recorded writer's tools (`propose_write`,
`save_brief_draft`) reconcile from the History entry labelled with the idempotency key (exact path
and text sha, else a person decides) — so crash recovery still never writes twice, and now says so
on the record (`tests/automation-weekly-brief.test.ts` asserts `reconciled-applied` by
`tool:save_brief_draft`).

**H08.** `uncertainEffectsOf(run)` gives one sentence per uncertain effect. `DurableControls` gained
a `harnessEffects` dependency, wired in `server/app.ts` to `HarnessBridge.uncertainEffects`, so Retry
and Resume refuse with `uncertain-effects` and send nothing while a harness tool effect of the run is
uncertain (`tests/h12-controls.test.ts`).

### 3. Containment (`server/harness/containment.ts`)

- **`containedPath(root, spelled, { write })`** — the one path funnel. Refuses: non-string, over
  512 chars or NUL (`path_invalid`); non-NFC spelling for a write (`path_unnormalized`); posix,
  drive, drive-relative, UNC and device-namespace spellings (`path_absolute`); any `..`
  (`path_traversal`); a name that folds under NFKC and any case to a private or guarded entry, e.g.
  fullwidth `．env` (`path_forbidden`); then `projectFile` + `safeAbsolute` (links and junctions at
  every component → `path_link`; 8.3 alias expanded and re-judged → `path_forbidden`, decision 11;
  reserved names, streams, trailing dots → `path_invalid`); then the deepest existing component must
  resolve inside the resolved root under the same spelling (`path_outside_root` / `path_link`); for a
  write, a name that differs from an existing entry only by case or Unicode normalisation is
  `path_collision`. The read tools now use it and their refusals carry the code.
- **`containedWrite`** — writes only a declared target (`path_not_declared`), under a size cap
  (`payload_too_large`), via an exclusively created temporary file in the checked folder; between
  the write and the rename it re-checks the folder (same plain folder, same identity, same real
  path) and the target (absent or the same plain file) and refuses a swap with `path_changed`;
  after the rename it confirms the file that landed is the one written.
- **`containedSpawn`** — the only way a harness tool starts a process: `shell: false`, a working
  folder through `containedPath`, an environment of `PATH`, the Windows system folders, temp and
  `LANG` only (an explicit addition named like a token, secret, key, password, credential, auth,
  cookie or session is `spawn_env_refused`), bounded output (`tool_output_too_large`), timeout
  (`tool_timeout`), abort, and process-tree cleanup (own process group and `kill -pgid` on POSIX,
  `taskkill /T /F` on Windows). A test pins that no file under `server/harness/capabilities`
  imports `child_process` (the MCP connector keeps the SDK's minimal environment, unchanged).
- **`write_file`** (`server/harness/capabilities/contained-file-tools.ts`) — the contained write as a
  typed tool: `idempotent-write`, `write-project-file`, exact approval, its path as its target,
  checked before the intent and again at the write, with a reconciler that says `applied` only when
  the file holds exactly that text. **No route or capability offers it**: model-API turns stay
  read-only (owner decision 2026-09-23) and approved document changes keep going through
  `Store.writeRecorded`. It exists so a capability that declares a file write has a contained sink,
  and so the matrix runs end to end through `dispatch`.

### 4. Attack matrix (`tests/h12-attack-matrix.test.ts`, 60 cases, 2 Windows-only)

Per tool, each row asserts the exact code and that nothing outside the project (or outside the
declared targets) changed:

- `write_file`: `../`, nested and backslash traversal; posix, drive, drive-relative, UNC,
  `\\?\` and `//` absolute paths; `.env`, `.ENV`, fullwidth `．env`, `id_rsa`, `.git/…`, `.GIT/…`;
  `PROGRA~1`; `nul`, `con.txt`, `README.md:hidden`, NUL byte, trailing dot; NFD spelling;
  oversized payload, wrong types, unknown keys, missing fields, empty path, non-JSON values;
  case-insensitive twin and NFC-vs-NFD twin (`path_collision`); linked folder and linked file;
  folder swapped for a link and target swapped for a link between check and use (`path_changed`);
  a handler writing outside its declared target (`path_not_declared`); a crash between intent and
  effect (`uncertain`, then `effect_uncertain`).
- read tools: traversal, absolute, NFKC-private, guarded folder, `..` listing, search outside, a
  linked folder — each an answer `{ refused: true, code }`.
- `containedSpawn`: canary secret and `ANTHROPIC_API_KEY` absent from the child; six secret-shaped
  explicit variables refused; working folder outside refused; shell metacharacters passed
  literally; an output flood cut off; a timeout that kills a grandchild.
- **Windows CI only** (`test.runIf(win32)`): a junction to outside refused; a folder swapped for a
  junction between check and use refused.

`tests/h12-effect-admission.test.ts` (14) proves the intent is on disk when the handler starts (it
re-reads the run file from inside the handler), every field of the record, approval and host
authorization references, pure/read/replay/refused-input behaviour, crash → uncertain →
`effect_uncertain`, reconciled not-applied (one new attempt, same key, second record), reconciled
applied (never runs again), person reconciliation and its single use, read crash → abandoned, cancel
→ uncertain, timeout → uncertain, handler failure → failed then retry with the same key, and an
external send refused by policy before any intent.

## Proof (this branch, Linux container)

- `npx tsc --noEmit`: clean.
- `CODEX_HOME=$(mktemp -d) node node_modules/vitest/vitest.mjs run --maxWorkers=3`: 377 files
  passed, 1 skipped; 6780 tests passed, 18 skipped (the two Windows-only H12 cases among them), 0
  failed — on the head with `origin/main` merged.
- `npx vite build`: built.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed.
  No UI changed and no spec was added.

## Decisions taken (conservative; Andrew's to confirm)

1. **Any interrupted write is uncertain, idempotent ones included.** Before H12 an idempotent step
   interrupted by a crash retried on its own. Now it waits for reconciliation; the recorded writer's
   tools reconcile themselves from History, so their recovery is unchanged in effect. A handler
   that *reports* failure is still retried under the same key.
2. **Only a definite reconciler answer settles an effect.** `unknown`, a throw or an output that does
   not match the schema leave it for a person. `write_file` answers `applied` only on an exact text
   match, never `not-applied` (a different text may be someone's later edit).
3. **Team tools keep `permission: null`.** Their gate is team membership in TeamService; adding a
   project permission would change who may use them, which is not this task's to decide.
4. **`write_file` is not offered anywhere.** Offering a file-write tool to a model route is a product
   decision (model-API turns are read-only by owner decision 2026-09-23).
5. **Read tools skip the NFC and collision refusals.** Reading `readme.md` on a case-insensitive disk
   reaches an allowed file; the private-name checks still fold case and compatibility forms.
6. **No HTTP route for reconciliation yet.** `reconcileEffect` is host API; a Console surface for a
   person to reconcile is a follow-up (below).

## Known gaps / follow-ups

- **Residual TOCTOU window.** Node has no `openat`/`renameat`, so a swap in the instant between the
  last re-check and the rename cannot be excluded; the post-rename identity check detects a changed
  landing but cannot undo it. A native helper (or `O_NOFOLLOW` + directory handles) would close it.
- **No person-facing reconciliation UI or route.** An uncertain harness effect is shown by the
  existing `presentRun` "could not confirm" sentence and blocks Retry/Resume; settling it needs the
  host API today.
- **External engines' own tools** (Codex, Claude Code, OpenCode sessions) are observed, not
  mediated: they execute inside the engine. H12 covers the host-executed harness tools only
  (roadmap §5: observed capabilities become enforced only after native bypass/containment is
  proved).
- **The platform's own floor of variables still reaches a child.** On Windows, libuv copies its
  fixed required set (`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`,
  `USERNAME`, `USERPROFILE` and the system folders) from the parent whatever environment is
  passed; macOS adds `__CF_USER_TEXT_ENCODING`. None is a secret; closing it would need a spawn
  below libuv. The test pins that nothing else arrives.
- **No production tool spawns a process yet**; `containedSpawn` is the sanctioned path and is pinned
  by tests, and the MCP connector keeps the SDK's minimal environment.
- **8.3 aliases** are refused by shape at the funnel on every platform; a real expanded alias is
  exercised by `tests/paths.test.ts` on Windows, not re-tested here.
- Windows and macOS runs of the new suites happen on the PR's CI, not in this container.

## Proposed canonical-doc patch

Not applied here: the integrator reconciles the canonical documents.

**`docs/DIOMEDES_LIVE_ROADMAP.md`** — §5, after the paragraph beginning "The AI SDK direct-model
plane does not absorb external-agent sessions.", add:

> H12 mediated effects (DIO-17, 2026-09-24, `docs/implementation/2026-09-24-h12-mediated-effects.md`):
> every host-executed harness tool declares input and output schemas, an effect class (pure, read,
> idempotent write, non-idempotent effect, external send), its permission and approval policy, and
> the targets it may change; an incomplete declaration is refused at registration. Before a tool
> with an effect runs, its intent (tool, inputs digest, targets, idempotency key, principal,
> authorization) is written durably in the run's step record and its outcome is recorded against
> it; an interruption between the two leaves the effect uncertain, it is never re-executed on a
> guess, and Retry and Resume refuse until it is reconciled on evidence. Tool paths go through one
> containment funnel (no absolute, climbing, linked, aliased, private-by-folding or colliding
> names; writes only to declared targets, re-checked between check and use), and a tool process
> runs without a shell, with a minimal environment, bounded output and a timeout that ends its
> tree. Proven by a table-driven attack matrix, with junction cases on Windows. External engines'
> own tools remain observed, not mediated.

and in §9 "Existing open decisions remain:", append: "whether an interrupted idempotent write may
retry on its own when its sink dedupes by idempotency key; where a person reconciles an uncertain
effect in the Console."

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — under "Files, packs, permission and evidence", add:

> **Effect record; uncertain effect.** Every tool call that could change something leaves an
> *effect record* written before it runs: which tool, a digest of exactly what it was given, what it
> may change, its idempotency key, on whose authority, and afterwards what happened. An effect is
> *uncertain* when Diomedes stopped between the record and the outcome; it is never repeated on a
> guess, and Retry and Resume wait until someone — the tool's own record or a person — says whether
> it happened.

**`QUESTIONS.md`** — add two open questions, with the defaults above until answered:
*Mediated effects — idempotent recovery*: may an interrupted idempotent write whose sink dedupes by
key retry without a reconciliation step? *Mediated effects — reconciliation*: where and how does a
person mark an uncertain effect applied or not applied, and what evidence must they give?

**`docs/harness/RUNTIME_VERIFICATION.md`** — add: "H12 mediated effects: typed contract refusals,
durable effect intent before execution, uncertain-on-interruption, reconciliation, containment
funnel, contained write and spawn proven deterministically on Linux (Windows and macOS on CI); the
junction cases are Windows-only. No external engine's native tools are mediated."

## PILLAR / ROADMAP / BUILD

- **PILLAR IMPACT:** scoped authority (every effect names the authority it ran under — exact
  approval, host grant, held permission — and the principal and generation; no new permission,
  preset or grant; activation of nothing is widened), durable evidence (effect records are appended,
  never rewritten or pruned; reconciliation adds who and why), truthful state (an interrupted effect
  is said to be uncertain, never relabelled as done or cancelled), one runtime (records live in
  RunService's step records; no second store, executor or permission model; decision 14).
  Decision 11 is kept: the funnel judges the resolved path and never widens `server/paths.ts`. No
  conflict found.
- **ROADMAP IMPACT:** H12 moves from "typed tools and gating exist" to "typed contract enforced at
  registration, recorded-effect admission with uncertain-effect blocking integrated with H08, and
  containment with an attack matrix". DIO-17 is closable for the host-executed harness tools; the
  gaps above stay open.
- **BUILD / PUBLICATION STATUS:** branch pushed, one draft PR against `main`, not merged; no version
  bump, no native-runtime hash change, no canonical document edited, nothing packaged or released.
