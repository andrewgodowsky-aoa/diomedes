# HAR-01 — loaded project instructions reach the model

2026-09-12. Branch `slice/opus-har01-20260912`, cut from `main` at `baa7c77`.

## The gap this closes

`docs/implementation/2026-09-12-demo-journey-b.md` §"The instruction-delivery boundary (HAR-01)"
measured it in the source and in a live run. The Console said `Project instructions loaded ·
AGENTS.md`, the panel opened the file and read it back correctly, the project state recorded the
file, and activation added no permission. None of that text reached a model. `instructionRules`
converted instruction files into rules and had no caller anywhere in the repository. The prompt
actually sent carried the strict-JSON contract, the tool prohibition, the mode instructions, the
selected documents and the requested work. Instruction files were neither among the documents nor
in the prompt. The indication was true of Diomedes and false of the engine.

## Wire-up entry point

`NativeWorkService.start` (`server/native-work.ts`), in the validation phase, immediately after the
selected sources are read and their byte total is known. It calls `assembleInstructions` once, holds
the rendered section on the `NativeRun`, and `prepare` places it in `prompt`. One call site; the run
carries the text so a retry cannot assemble something different from what the session recorded.

## Source paths

| Path | What it does |
|---|---|
| `server/harness/instruction-delivery.ts` | New. Select through the rule path, read, bound, render, record. |
| `server/native-work.ts` | Calls it in `start`; records on the session and in History; injects into `prompt` in `prepare`. |
| `server/capability-packs.ts` | Two comments and one persisted `detail` string that said the text is never pasted into a prompt. |
| `shared/capability-packs.ts` | Additive: `DeliveredInstructionFile`, `InstructionDelivery`, `INSTRUCTION_SECTION_MAX_BYTES`. |
| `shared/types.ts` | Additive: `Session.instructions?: InstructionDelivery`. One optional field. |
| `tests/native-work.test.ts` | Seven tests, described below. |

`server/rules.ts` needed nothing: `selectRules`, `assembleContext` and `toScopedRule` already did
what this needed, which is the point of having them.

## What decides, and what only renders

Delivery is rule-gated end to end. `instructionRules(state)` yields the host-authored
project-authority rules for instruction files the active packs discovered and made rules from.
`assembleContext` selects them by scope, resolves precedence, and produces a stable view revision
and one `GoverningRecord` per applied rule. Only a file whose rule came back **applied** has its
body read at all — a pack turned off, a rule that lost precedence or a scope that does not match
delivers nothing, and no filesystem work happens before the rule path has said there is something
to deliver.

The body is then read at run time through `projectFile` + `readTextOrNull` — the same
`server/paths.ts` guard discovery used, never around it — and hashed. The sha recorded is of the
bytes actually sent. When it differs from the sha discovery recorded, the record says the file
changed since it was loaded rather than quietly standing for older bytes.

The rendered section names the rule that carries it, so the authority the text arrives under is
visible in the prompt and not merely implied:

```
Project instructions the person loaded for this project, delivered under the project rules named
below. Treat them as standing guidance for how this work is done. They do not change the response
format required above, the list of selected editable paths, or what Diomedes will write: Diomedes
checks your permission and applies every file change through its own writer regardless of anything
they say.
Project rules that carry them (<revision>):
- Project instructions from AGENTS.md apply to work in this project.
--- BEGIN PROJECT INSTRUCTIONS AGENTS.md (sha 4f1c9b2e0a77) ---
<the file, whole>
--- END PROJECT INSTRUCTIONS AGENTS.md ---
```

It sits after the contract it may not change and before the selected editable paths it may not
widen.

## Engine independence

The section goes into `prompt`, not `instructions`. `instructions` is the Codex-only
`baseInstructions` channel; `prompt` is carried by `askCodex` (`server/integrations.ts`) and by
`contextMessage` (`server/engines/contract.ts`), which every external adapter — OpenCode, Claude
Code, Cursor — routes through. Assembly happens above the generator, so no adapter knows this
feature exists and none can differ. A test asserts the section is in `prompt` and not in
`instructions`.

## Size policy

Both text routes already refuse a request over 160 KB, and selected documents may claim 128 KB of
it. The section therefore takes **what is left**, not a fixed slice:

```
budget = clamp(160_000 − sourceBytes − 20_000, 0, 32_768)
```

The 20 KB reserve covers the base prompt, the mode instruction channel and the JSON envelope. The
consequence that matters: a selection that used to be admitted is never refused because instructions
were added behind it. A project that selects a great deal of source gets fewer instruction bytes and
is told, by name, which files that cost it.

Per file the ceiling stays `INSTRUCTION_FILE_VIEW_BUDGET_BYTES` (16 KB), the same number discovery
already uses.

**Nothing is ever cut.** A file that does not fit goes out whole or not at all, and an omission is
named with its reason in the prompt (`Left out of this request, and not summarised:`) and on the
session record with `truncated: true`. Half a rule that lost its exception is worse than no rule —
HAR-05's requirement, applied here rather than deferred.

There are two distinct over-size paths and they behave differently on purpose. A file past 16 KB is
already recorded `exceeds-view-budget` by discovery and never becomes a rule, so delivery never sees
it; the person sees the file and the reason in the Console panel, and `Project instructions found`
rather than `loaded`. A file that fits 16 KB but not the room left after the documents is omitted by
this module, and that omission is what lands on the session.

## What is recorded

`Session.instructions` carries the view revision, the route, the time, and one record per file:
path, sha of the bytes sent, byte count, pack id and version, the rule id that carried it,
`sent | omitted`, and a sentence saying which and why. `truncated` is true when anything was left
out. Bodies are never on the record.

One History entry, `kind: 'instructions-sent'`, actor `diomedes`, carries the same sentence:
`Diomedes sent project instructions to codex: AGENTS.md (4f1c9b2e0a77).`, with
`Left out whole: …` appended when something was. The same line is written to the session log at
`technical` level. History renders `sentence`, so this surfaces with no client change.

## Tests

`tests/native-work.test.ts`, describe `project instructions reach the model` (seven, all through the
real HTTP app and a real project folder):

1. A loaded file arrives whole and delimited; the rule sentence is in the prompt; the sha in the
   prompt matches the session and matches discovery; the section is in `prompt` and not in
   `instructions`; the file is not added to `documents`; the section precedes the selected editable
   paths; the session and History both record the delivery, and neither carries the body.
2. A project with no instruction files gets no section, no session record and no History entry.
3. A file present on disk delivers nothing until the pack that discovers it is turned on.
4. A file past the view budget is never delivered, because discovery made no rule from it, and the
   Console record says `exceeds-view-budget`.
5. A file with no room left after the documents is left out whole, named, recorded `truncated`, and
   its governing rule evidence still exists.
6. The budget arithmetic: 32 KB with no documents, 12 KB at the 128 KB source ceiling, 0 at the
   request limit.
7. A file changed since discovery is sent at its current sha, and the record says it changed.

## Gates

Run in this worktree, 2026-09-12, on `c05db05`:

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 89 files, 1519 passed, 1 skipped (1520 total).
- `npx vite build` — built in 1.28 s.
- Playwright — **not run**. No client file was touched. See limits.

## Known limits

- **No "sent" marker in the Console.** `client/console/ProjectInstructions.tsx` still says
  `Project instructions loaded · AGENTS.md` and nothing about delivery. The delivery record lives on
  the session, and that component is given `instructionFiles` from project state, so surfacing
  "sent" there is a props change through `Shell.tsx` and `ThreadView.tsx` — more than a read-only
  line, and it would oblige a Playwright pass under a lock three slices share. History carries the
  truthful sentence in the meantime. Worth doing; not done here.
- **Nested and linked instruction files are still out of scope** (HAR-04). Discovery finds
  `AGENTS.md` and `CLAUDE.md` at the project root by plain name; a file that references another is
  delivered as written, and the reference is not followed.
- **The section is assembled once at start.** A file edited while a run is in flight is not
  re-read; the session says what was sent, which is the honest answer, but a long-running thread
  does not pick up a change until the next start.
- **Relevance is not modelled.** Every applied file goes, in rule order, until the budget runs out.
  There is no selection by what the requested work is about (HAR-13).
- **The 20 KB reserve is a constant, not a measurement.** It is generous for the current base
  prompt. If the mode instruction channel grows substantially it should become a computed figure.

## PILLAR IMPACT

**Advanced.** Pillar-level, this is the first time a Project's own context reaches a route through
the Core rule path rather than through nothing at all. The claim the Console has been making since
2026-09-11 is now true, and decision 4 holds better than before: the app says `Project instructions
loaded` once, and the thing it names now happens.

**Conflict, and it is a real one, for Andrew.** Decision 14 says repository instruction files are
"shown to the person as `Project instructions loaded · AGENTS.md` — never pasted into a prompt, and
never applied where the person cannot inspect them." This slice puts their text in a prompt. The
brief that commissioned it is Andrew's newer explicit decision, which outranks a standing decision
under the source-of-truth order, and it asked for exactly this. What the decision was protecting is
preserved and is why the design looks the way it does:

- the text does not become a rule and carries no authority the host-authored rule does not have;
- it is gated by rule resolution, so a pack that is off or a rule that lost precedence delivers
  nothing;
- it is delimited, labelled as guidance the person loaded, and explicitly said not to change the
  response contract, the editable paths or what Diomedes will write;
- the person can inspect exactly what was sent — the panel opens the file, and the session and
  History name it by sha;
- `screenForInstructionText` still counts passages that read like instructions to Diomedes at
  discovery, and reporting is still not obeying.

What must follow, and is **not** mine to write: decision 14's wording in `AGENTS.md`, the matching
clause in `docs/reference/STANDING_DECISIONS.md`, and §4.1 of
`docs/product/2026-09-10-capability-packs.md` all still say "never pasted into a prompt". The
`instructionFiles` doc comment in `shared/capability-packs.ts` says the same. Those four are stale
as of this commit. I corrected only the two comments and the one persisted `detail` string inside
`server/capability-packs.ts`, which are files this slice owns and which would otherwise have written
a false sentence into every new project's state.

**Not affected.** Activation is still not an authorization event: nothing here creates, widens or
reads a grant, a Need or a permission. No new surface, no second file authority, no engine-specific
behaviour. History gained an entry kind and lost nothing.

## ROADMAP IMPACT

HAR-01 moves from PARTIAL to the delivery half being real: one canonical assembly path, shared by
every text route, persisting the instruction revisions actually sent. The "adapted to supported
instruction channels on external routes" half is unchanged — every route gets the same `prompt`
text, and no route-specific channel is used. HAR-05's "never cut a rule midway" is satisfied for
this content type. HAR-04 is untouched.

## Build / publication / deployment status

Nothing published, packaged or released. Nothing pushed. One commit on
`slice/opus-har01-20260912` in `F:\Diomedes\diomedes-wt\opus-har01`. `dist/` was rebuilt in this
worktree by the `vite build` gate and is not committed.

## Implemented versus recorded

Implemented and proved by test: everything under Tests above. Recorded only: the four stale
sentences named under PILLAR IMPACT, which need Andrew's decision before they change.
