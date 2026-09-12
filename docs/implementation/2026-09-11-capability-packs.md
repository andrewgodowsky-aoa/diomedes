# Capability-pack activation and repository instruction files

Date: September 11, 2026. Status: implemented and proven under `tsc` and Vitest, **uncommitted and
unpushed**. Worktree `F:/Diomedes/diomedes-wt/opus-packs`, branch
`opus/packs-instructions-20260911`, from `b6d26ec` ("Let the pack manifest keep its literal types").

Slice: PAK-01, PAK-03 minimum, the PAK-04 subset, HAR-02 and HAR-04. Route-specific delivery of the
rule (HAR-01) is **not** in this slice, and nothing here sends an instruction file to a model.

---

## What is implemented and proven

A person can turn the Software Engineering pack on for one Project. Activation appends a
`PackActivation` record and a History entry, discovery walks the manifest's `instructionFiles`
through the `server/paths.ts` guard, and each finding becomes an `InstructionFileRecord` with its
path, size, sha and a plain sentence saying what happened to it. A loaded file becomes one
`Rule` at project authority. The thread head says `Project instructions loaded · AGENTS.md` and
opens the file read-only. Turning the pack off stops discovery and the rule; it deletes nothing.

| Claim | Proof |
| --- | --- |
| Nothing loads for a project that did not activate | `capability-packs.test.ts` "a folder with AGENTS.md produces no record and no rule until someone activates" — `instructionFiles` stays `undefined`, `discoverInstructionFiles` returns `[]` and does no filesystem work |
| Activation appends; deactivation appends; nothing is removed | "each decision adds one activation record and one History entry, and removes nothing" — a `readDocument` seeds a pre-pack History row, then two `packs` records, two `kind: 'pack'` entries, `history.length` exactly `+2`, and the pre-pack rows deep-equal a clone taken before activation. A repeated activation of an already-active pack appends nothing |
| Discovery goes through the path guard | three tests: a name that leaves the project, a private name (`.env`), and a file behind a real Windows junction. Each is `unreadable` with `sha === null`; the junction case asserts the target's distinctive body appears nowhere in the record. The `../AGENTS.md` case asserts the recorded reason **is** `projectFile`'s own message, so there is no second copy of the refusal to drift |
| Over the view budget: listed, readable, no rule | "over the view budget it is recorded, hashed, and produces no rule" plus the route test "an over-budget file is listed and readable, and an undiscovered path is refused" — state `exceeds-view-budget`, sha present, `ruleId` absent, `instructionRule` returns `null`, and `GET /instructions/read` returns the whole file with a matching sha |
| The rule is project-authority guidance, and organization policy still governs | "it is guidance at project authority, and an organization forbid still governs" — `authority: 'project'`, `category: 'guidance'`; against an `organization` `forbid` on the same requirement key, `resolution.applied` is `['company-forbids']` and the project rule's outcome is `blocked` with `overriddenBy: 'company-forbids'` |
| The read route serves only what discovery recorded | same route test — `README.md` (present in the folder, discovered by the documents route) is 404, `../AGENTS.md` is 404, `CLAUDE.md` (absent) is 404 |
| `validateManifest` refuses a manifest that could grant | "grantsAuthority, an unknown id and a path in instructionFiles are each refused" |
| Text that tries to instruct the harness is reported, at any size | "a file that tries to instruct the harness is reported as such, at any size" — a file matching two `INSTRUCTION_SHAPES` records `2 passages in it read like instructions to Diomedes` in `detail`, on the loaded record **and** on an over-budget one, while `rule.text` stays the fixed host-authored sentence |
| Activation is not an authorization event | "no grant, need or permission is created or changed by turning a pack on or off" — `state.scopeGrants`, `store.scopeGrants.view(id)`, `state.needs` and `state.conversations` (which carry each thread's permission) are deep-equal before and after both activation and deactivation |
| The indication is said once, and only where something loaded | three `renderToStaticMarkup` tests over `ThreadView`: no records renders no line; two records render exactly one `Project instructions` occurrence, no inlined body and no open panel; a file that produced no rule reads `found`, not `loaded` |

### Three departures from the brief, all deliberate

1. **The rule id.** The brief's example is `instructions:AGENTS.md`. `ruleSchema.id` is
   `^[a-z][a-z0-9-]{0,63}$`, so that string is not a legal `Rule.id`. `instructionRuleId` slugs the
   name into that grammar instead — `AGENTS.md` becomes `instructions-agents-md` — and it is used
   for both `Rule.id` and `InstructionFileRecord.ruleId`. The rule is built with
   `ruleSchema.parse`, so the id is validated rather than assumed.
2. **`resolveRules` returns `blocked`, not `overridden`.** The brief asks that the organization rule
   be left governing, and it is: `applied` holds only the organization rule. The project rule's own
   outcome is `blocked` rather than `overridden`, because `weakens()` in `shared/rule-authority.ts`
   refuses to let a lower authority hold a permissive stance against a higher authority's `forbid`.
   That is the stronger of the two answers and the test asserts it as written, not as expected.
3. **A repeated decision appends nothing.** The brief says activation appends. Turning on a pack
   that is already on decided nothing, so no record and no History entry are written: an entry
   saying a person changed a setting they did not change would be untrue, and History is evidence
   before it is a log. Every decision that does change the state appends. A test covers both.

### How the file body stays data

`admissibleAsRule({ origin: 'imported-document', ... })` refuses, and a test asserts that it does.
The rule this slice makes is therefore host-authored: its text is the fixed sentence
`Project instructions from AGENTS.md apply to work in this project.`, and the body is referenced by
path and pinned by sha in `provenance.source`. `screenForInstructionText` runs over the content and
the attempt count lands in `detail` — on the over-budget record as well as the loaded one, since a
large file is exactly where such a passage hides. Reporting the attempt is not obeying it, and the
count is not an input to admissibility; a test asserts the rule text is unchanged by it.

---

## Verification

Run from `F:/Diomedes/diomedes-wt/opus-packs` with the worktree's own binaries.

```
$ ./node_modules/.bin/tsc --noEmit
(no output; exit 0)
```

```
$ ./node_modules/.bin/vitest run tests/capability-packs.test.ts tests/rules-assembly.test.ts \r
    tests/rule-authority.test.ts tests/paths.test.ts tests/backend.test.ts
 ✓ tests/rule-authority.test.ts (21 tests) 20ms
 ✓ tests/paths.test.ts (6 tests | 1 skipped) 10ms
 ✓ tests/rules-assembly.test.ts (12 tests) 21ms
 ✓ tests/capability-packs.test.ts (18 tests) 743ms
 ✓ tests/backend.test.ts (48 tests) 25481ms

 Test Files  5 passed (5)
      Tests  104 passed | 1 skipped (105)
   Duration  30.24s
```

The whole unit suite was run as well, to prove nothing else moved:

```
$ ./node_modules/.bin/vitest run
 Test Files  83 passed (83)
      Tests  1419 passed | 1 skipped (1420)
   Duration  40.00s
```

One earlier whole-suite run on this same code reported 7 failures in `tests/harness-host.test.ts`
(1412 passed, 1 file failed). That run's test wall time was 456 s against 242 s for the passing run
above, on a machine that was doing other work at the time; `tests/harness-host.test.ts` spawns child
processes and writes to disk. Run alone it is 22 passed, 22 tests, every time. Nothing in this slice
touches the harness path. It is recorded here as an observed flake under load, not hidden and not
explained away — if it recurs on an idle machine it is a real defect and belongs to that suite.

The one skip is `tests/paths.test.ts` "a short name standing in for a guarded directory is still
refused": this volume does not generate 8.3 aliases. It is unverified here, not a passing test. The
junction case in `tests/capability-packs.test.ts` ran — its own capability probe confirmed this
machine makes directory junctions — and is not skipped.

Not run, and therefore not claimed: `vite build` and Playwright. The brief forbids both, so no
browser gate covers the two new components. Their behaviour is proven only at the
`renderToStaticMarkup` level above.

---

## Files

Created:

- `server/capability-packs.ts`
- `client/console/ProjectInstructions.tsx`
- `client/console/PackSettings.tsx`
- `tests/capability-packs.test.ts`
- `docs/implementation/2026-09-11-capability-packs.md`

Modified:

- `shared/types.ts` — `Project.packs?` and `ProjectState.instructionFiles?`, and nothing else.
- `shared/capability-packs.ts` — two pure helpers appended (`instructionRuleId`,
  `activeInstructionFiles`). No exported shape changed.
- `server/app.ts` — the four routes plus their imports.
- `client/console/ThreadView.tsx` — one optional `instructionFiles` prop, defaulting to `[]`, and
  `ProjectInstructions` as the last item of `.col.head`.
- `client/console/PermissionPanel.tsx` — two lines: the import and `<PackSettings />` at the end of
  the existing `<section>`. Nothing in the dialog was redesigned.
- `client/console/console.css` — one delimited block at the end of the file.

`Shell.tsx`, `Rail.tsx`, `client/console/types.ts`, `paletteEntries.ts` and `server/store.ts` were
not touched.

---

## Partial or blocked

- **`ProjectInstructions` is not mounted in a running app.** `ThreadView` accepts the prop and
  renders the component, but nothing passes the prop yet: `Shell.tsx` belongs to another worker.
  Until the one-line change below lands, the indicator is proven in tests and invisible in the app.
- **`refreshDocuments` does not refresh discovery.** The contract says the records are refreshed on
  activation and on `refreshDocuments`. Activation and `GET /api/projects/:id/packs` both refresh;
  `server/store.ts` is outside this slice's file list, so the third trigger is an integrator line.
- **Markdown is rendered as preformatted text.** The Console has no Markdown renderer; the only one
  in the repository is a private function inside the frozen `client/Workspace.tsx`. Per the brief,
  the panel shows the file preformatted with its name, size and sha, and no dependency was added.
- **No route delivery.** `instructionRules(state)` returns the rules in the shape `assembleContext`
  takes, and nothing calls it. That is HAR-01.
- **Opening a file writes a History row.** `GET /instructions/read` reuses `store.readDocument`,
  which is the existing `DocumentContent` primitive (decision 13) and brings outside-change
  detection with it. The first read of a file Diomedes has not recorded writes an `observed` entry,
  as it does anywhere else in the app. That is existing document behaviour, not a leak, but a person
  opening `AGENTS.md` from the indicator will see History grow by one row.

## Exact next action

**HAR-01: deliver the instruction rule on each route.** Feed `instructionRules(state)` into
`assembleContext` at context assembly for the project scope, and record the resulting
`GoverningRecord`s. Until then the rule exists and is inspectable but governs nothing.

---

## Needs the integrator

Three edits outside this slice's file list. Each is stated as the exact change.

1. **`client/console/Shell.tsx`**, in the `<ThreadView ... />` call inside `{view === 'Thread' &&
   selected && (`, add one prop next to `changes={state.changes}`:

   ```tsx
   instructionFiles={activeInstructionFiles(state.project.packs, state.instructionFiles)}
   ```

   with the import `import { activeInstructionFiles } from '../../shared/capability-packs';`.
   Use `activeInstructionFiles`, not `state.instructionFiles` directly: the records survive
   deactivation on purpose, and a project that turned the pack off must not keep reading
   `Project instructions loaded`.

2. **`server/store.ts`**, if the third refresh trigger is wanted: inside `refreshDocuments`, in the
   `.then(...)` after `this.state(id).documents = documents;`, add

   ```ts
   void discoverInstructionFiles(this, id).catch(() => undefined);
   ```

   with `import { discoverInstructionFiles } from './capability-packs.js';`. **Warning:**
   `discoverInstructionFiles` persists and `persist` emits `change`, and a `change` handler that
   walks documents would loop. `discoverInstructionFiles` only persists when a finding actually
   changed, which breaks the loop after one pass, but the interaction should be checked against the
   live SSE fan-out before this lands. It was deliberately not added here.

3. **Nothing else.** `Rail.tsx`, `client/console/types.ts` and `paletteEntries.ts` need no change
   for this slice; the pack contributes no palette entry and no rail item.

---

## PILLAR IMPACT

- **Pillar 05 — advanced.** The pack changes what Diomedes is good at without changing what it may
  do. The manifest's `needs` are rendered under "What it would use" next to the sentence "Turning it
  on grants nothing; Trust still decides.", and the test asserts that grants, the grants view and
  needs are all deep-equal across activation and deactivation.
- **Pillar 07 — advanced.** Discovery is inspectable end to end: every finding is listed, including
  refusals and over-budget files, each carries a sha, and each readable one opens read-only through
  a route that serves only recorded paths. A rule the person cannot inspect would be a hidden
  behaviour change; this is not one.
- **Pillar 09 — advanced.** Nothing was added around the path guard. `projectFile`, `safeAbsolute`
  and `readTextOrNull` decide what may be opened, the refusal message is recorded verbatim rather
  than restated, and a test pins the recorded reason to `projectFile`'s own so the two cannot drift.
- **Pillar 12 — held, with the risk named.** A Project stays general-purpose: the pack is off by
  default, `discoverInstructionFiles` does no filesystem work at all without an activation, and a
  Project that never activates has `instructionFiles === undefined`. **The risk is real and is the
  one to watch**: if any future caller reads `state.instructionFiles` without going through
  `activeInstructionFiles` or `isPackActive`, a pack loads for a project that did not ask, which is
  decision 14's exact prohibition. Two tests guard the current callers; a new caller is a new risk.

Neither the Files pane nor any IDE-grade capability is shipped by this slice. Decision 13 remains
approved direction only. This slice is activation plus instruction files, nothing more.

## ROADMAP IMPACT

- PAK-01 (activation record and Project-level state): implemented, proven, uncommitted.
- PAK-03 (instruction-file discovery, minimum): implemented, proven, uncommitted.
- PAK-04 (activation surface, subset): the Capabilities section inside the task-permissions dialog
  exists; no dedicated project-settings surface was created and none is claimed.
- HAR-02 / HAR-04: the discovered file reaches the rule vocabulary at project authority and is
  recorded. Delivery on a route (HAR-01) is unstarted.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Nothing built, nothing packaged, nothing published, nothing deployed. No `vite build`, no
`npm run package:desktop`, no Playwright run, no version bump. All work is uncommitted and unpushed
in `F:/Diomedes/diomedes-wt/opus-packs` on `opus/packs-instructions-20260911`. No site copy, release
note or roadmap status may describe the Files pane or any IDE capability as shipped on this basis.
