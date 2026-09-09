# Diomedes: advisor opinion, 2026-09-09

Fable 5.1, read-only pass over `F:\Achilles\diomedes` (checkout on `fable/surface-20260909` at `11829e1`, which is also `main` and `origin/main` as of this read; the brief's "main = 86ee91d" is already stale because the checkout was fast-forwarded and branched while this was written). Nothing edited, nothing run. Line numbers are from `11829e1`; `client/console/**` is unchanged since `86ee91d`, `server/app.ts` moved by +15 lines.

---

## 1. Verdict

The Console is the product, and it is already better than most agent front ends. One register for anything measured (mono uppercase instruments at 11–12 px), one accent with one job, the spine and the point as the only state language, one verb per state on the board, a palette that acts instead of navigating, ten schemes off eleven tokens with Paper genuinely legible, and a motion doctrine that is written down and tested. The polish commit `3b02d8e` shows the right discipline: measured against the prototype and corrected to the pixel. That is the "small obsessive product team" feel, and it is real.

It does not feel like one product because it is two, and the seam runs through the Console's most important moments. `ThreadView.tsx:17` and `Shell.tsx:25` import `Notice`, `Modal`, `Button` and `ApprovalStatus` from the Workbook, so the instant Diomedes needs you, a Workbook card (`styles.css:822-845`: well background, 1 px box, 4 px amber bar, Plex Serif prose, 36 px buttons) lands in the transcript, and "Show me first" opens a Workbook dialog with a 2 px cyan top (`styles.css:1163-1180`). The rail's foot is literally a door labelled "Workbook" (`Rail.tsx:93-103`). The mode contract is written three times (`server/modes.ts:38-80`, `Workspace.tsx:47-52`, `Composer.tsx:6-11`) and the thread screen repeats it in six places. And the Workbook's own test (`tests/ui.spec.ts:409-413`: every text node ≥ 14 px, every button ≥ 35.5 px on Home) legislates a different register into law, which is why wave 4B's re-skin and 7b's follow-up could not converge and never will.

Position: retire the Workbook into the Console. Not delete it this week; freeze it (7b was the last re-skin), make the Console own its Need, Sheet and Button today, port Home / Documents / History / Review as Console screens over the next arc, then delete `Workspace.tsx` (2,496 lines) and roughly two thousand lines of `styles.css`, keeping Settings. "For everyone" becomes a Guided density of the one surface (wider measure, instrument line and Activity hidden, plainer captions) and is delivered by defaults and copy, not by a second UI. The reading face (Plex Serif) survives where reading happens: documents and plans. Every feature on the runtime / triage / connections track is Console-only from today, so nothing new is built on the surface that is going away.

---

## 2. The four complaints

### 2.1 "This still isn't centered"

**Root cause.** `client/console/console.css:343-347`:
```css
.console .col { max-width: 760px; margin-left: 56px; padding-right: 24px; }
```
inside `#scrThread { grid-template-columns: minmax(0,1fr) 296px }` (`:334-336`). The prototype was drawn at 1440, where the work column is 912 px and 56 + 784 leaves 72 px on the right. On a wide window the work column grows and the measure stays pinned left: at 2560 the dead field is ~1,200 px. The exe is not the problem: `git log -- client/console/console.css` shows `.col` untouched since wave 2, so a rebuild of `86ee91d` would show the same thing.

**Centered or asymmetric.** Centered, inside the work column, never closer than 56 px to the rail. Reason: the rail (232) and the ledger (296) are fixed instruments, so "centered in the window" is wrong and "centered between them" is right; the ledger must not grow with the window (a 296 px gauge on a wide screen is correct, a 500 px gauge is furniture). The general rule for this app: **prose centers, instruments fill.** Board columns and Team lanes already fill (`board.css:41-49`, `team.css:38-45`); the thread, the head, the instrument line and the composer are one `.col` and center together.

**Exact rule** (replaces `:343-347`; keep the `@media` overrides at `:1126-1128` and `:1156-1158` for the floor only):
```css
.console .col {
  max-width: 760px;
  padding-right: 24px;
  margin-left: max(56px, calc((100% - 800px) / 2));
}
```
At 1440 this resolves to exactly 56 px (912 − 800 = 112, / 2 = 56), so the approved prototype is pixel-identical; at 2560 it resolves to 616 px and the column sits centered. The gutter marks at `left: -24px` (`:444-452`, `:506-515`) ride with the column. Apply the same idea to the one other left-pinned prose block: `.console .teamcompose { max-width: 900px }` (`team.css:324-327`) sits hard-left under lanes that fill; drop the max-width so the Team composer spans its lanes.

**Stop the class.** Write it into `01-visual-system.md` as a layout rule ("one `.col` rule; nothing else sets a page column's margin-left") and add one `field.spec` case at 2560×1200 asserting `.col` left ≥ (work width − 800) / 2 − 1. How far: this and the Team composer, nothing else. Do not touch the ledger width, do not add a max-width to the board.

### 2.2 "Words going out of the picker"

**Root cause.** Three faults, one panel.
- `Picker.tsx:134` puts `integration.location` in the group heading. For Codex that is `server/integrations.ts:499` = `CODEX_EXECUTABLE`, a full Windows path with no break opportunity.
- `console.css:928-935` makes the `h4` a flex row and `:936-942` gives the span `margin-left: auto` and nothing else. A flex item's `min-width` is `auto`, so an unbreakable string cannot shrink and walks out of the 340 px panel (`:912-924`).
- `.pmenu .m` (`:943-954`) is `grid-template-columns: 1fr auto` and neither `.id` (`:958-962`) nor `small` (`:966-971`) has a wrap or truncation policy, so a long slug plus a long display name overruns the same way.

**Fix, in order of importance.**
1. Content: a menu carries state words, never locations. The heading span shows status ("signed in", a version) and the path stays where it already is, Settings › Engines (`Settings.tsx:280-282`).
2. CSS: `.pmenu { overflow: hidden }`; `.pmenu h4 span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`; `.pmenu .m > span, .pmenu .m small { min-width: 0; overflow-wrap: anywhere }`; `.pmenu .m .id { max-width: 16ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }`.
3. Ceiling: the menu has no `max-height` (`:912-924`). Three engines × their catalogues will run under the window edge. `max-height: calc(100vh - 72px); overflow-y: auto`.

**Stop the class.** Rule: any flex or grid child that can carry a machine string (path, URL, slug, model name, thread title) gets `min-width: 0` and a truncation policy at the point it is written; strings from the OS never enter a fixed-width surface without one. Test it: `playwright.config.ts:26-40` already fakes the Codex catalogue; give the fixture a 90-character `display_name`, a 200-character `description` and a 120-character location, and assert the menu's `scrollWidth === clientWidth`. Do not widen the menu.

### 2.3 "The Workbook look does not match"

**Root cause.** It is structural, not chromatic, which is why two re-skin passes did not fix it:
- A different type floor and control size: `styles.css:210-217` (14 px body), `:254-258` (36 px `min-height` on every button, input and select), `:399-421` (`.button` 36 × 84 min), enforced by `tests/ui.spec.ts:409-413`. The Console runs at 13 / 12 / 11 px under a 0.95 zoom (`App.tsx:154-164`).
- A different page grammar: `.workbook-layout` is a two-column grid with a fixed 440 px margin column (`:753-762`); `.reading` carries 40 px padding and a "meridian" line (`:770-790`); `.page-frame` floats the page 20 px inside the window (`:618-628`). The Console is edge-to-edge hairlines.
- Cards: `.notice` (`:822-845`), `.dialog` (`:1163-1180`), `.composer` as a raised panel with a 68 px serif textarea (`:976-981`, `:1052-1063`), task cards with marks (`:1450-1479`).
- A different voice: captions on everything (`Workspace.tsx:47-52`, `:663`, `:709`, `:740`), "Diomedes …" sentences where the Console uses a verb.

**Right fix.** Section 1: retire, do not re-skin. What to do now, before anything lands from Codex: nothing in `styles.css`. What to do in the Console now: `client/console/Need.tsx` replaces the `Notice` mount at `ThreadView.tsx:308-316` (see §4 item 1) so the needs-you moment stops being a Workbook card; that single change removes the Workbook from the Console's daily path. What to do after Codex lands: the preview `Modal` at `Shell.tsx:799-825` becomes a Console sheet (Codex is editing that block right now, so it waits). Then the port, one page per pass, in this order: Review (Codex's `HarnessProposal` needs a Console home anyway), Documents, History, Home. Guided density is a Console setting, defined by Andrew (§6). Only after the port do the F17 floor tests and `Workspace.tsx` go.

### 2.4 Over-explaining

**Root cause, in three files, and one process failure.**
- `Composer.tsx:205-213`: the Build aux row prints "may touch the documents you name" and "Nothing is written until you say go ahead." under a strip whose caption (`:262-266`, `CAPS.build` at `:9`) already says "applied only on your go-ahead."
- `server/app.ts:1345-1347`: every Build / Fix send creates a Diomedes turn whose text is "Codex is preparing a file proposal. Review each proposed change before saying go ahead. No project files have been changed." `server/native-work.ts:416-429` later rewrites the turn's `helper` and never its `text`, so the sentence is the permanent transcript record of every Build exchange, still there after the proposal was reviewed and applied. It is the wrong channel, not just the wrong words.
- `ThreadView.tsx:299-305`: a permission explainer under the instrument line ("Every change waits for your OK." / "The first OK in a task covers the rest of it. Nothing runs without that first OK." / "Each proposed file change needs its own exact OK."). The reconcile pass deliberately left this out (integration log, "Left undone 2"); the feature verifier listed the absence as a gap; `3b02d8e` added it and pinned it with `tests/field.spec.ts:275`. A checklist turned an absence into a defect and a sentence nobody asked for got a test. That is the process failure to name.
- Plus `ThreadView.tsx:320` ("Nothing changes until you say so."), `components.tsx:251` ("Diomedes is paused until you decide."), `Picker.tsx:197-207` (two notes), `TeamView.tsx:440-447` (two captions explaining the UI to the user).

**Right fix.** The doctrine in §3, then delete rather than rewrite. The mode contract lives in exactly one place on screen (the `.cap` under the strip) and in one file in code. The narration moves to the run record and the turn gets the proposal summary when it lands (`run.proposal.summary` already exists, `native-work.ts:603`); until then the turn is the live point with the caret that `console.css:591-598` already defines and nothing uses. How far: every string in the §3 table, the two structural changes (turn text on completion; one source for mode copy), and the test pin at `field.spec.ts:275` updated in the same commit.

---

## 3. Copy doctrine

**When Diomedes speaks.** When state changed in a way the person must act on or could not have predicted: a proposal is ready, a run stopped, a file the person named is gone, an engine went away, something needs an OK. It names the thing (the files, the count, the reason) and the one next step.

**When it stays silent.** About what the mode already promises (the caption said it), about what did not happen ("no files were changed" is the invariant, not news), about how the UI works ("members talk through the team service"), about its own state ("is paused", "is preparing") when a point or a record already shows it, and about consent in general terms. Consent is asked once, at the moment of consent, with the specific thing. It is never ambient reassurance.

**Channels.** A Diomedes turn is a reply. A run record is what happened, timestamped, in the mono register, collapsible. A need is a request with verbs. A caption is a contract in at most six words. A toast is a fact that will be gone in two seconds. Nothing crosses channels: status never becomes a turn, a contract never becomes a caption on a second element.

**Voice.** Verbs, not "Diomedes will". Present tense. No "please", no "simply", no "just". Ceremony copy (the wake, reconnect, a handoff) is the one exception and stays.

**Mechanics.** Mode copy has one home (`server/modes.ts`; give it `console.caption` and have `Composer.tsx` read it; delete `Workspace.tsx:47-52` and `Composer.tsx:6-11`). No sentence is pinned by a test unless it is a receipt (`components.tsx:201-205` are receipts; keep those).

### Rewrite table

| Where | Current | Replacement |
|---|---|---|
| `Composer.tsx:205-213` | `may touch` + `the documents you name` / `Nothing is written until you say go ahead.` | Show `may touch <files>` only when `sources.length > 0`; otherwise render nothing. Delete the second sentence. |
| `Composer.tsx:6-11` (and `modes.ts:38,52,66,80`, `Workspace.tsx:47-52`) | `Nothing in the project changes.` / `A plan you read before work begins.` / `Changes proposed, applied only on your go-ahead.` / `The smallest change that clears the failure.` | `Answers. Changes nothing.` / `Writes a plan you read first.` / `Proposes changes for your OK.` / `The smallest fix, up to three tries.` One source. |
| `Composer.tsx:236` | `Up to three tries.` | delete (the Fix caption says it) |
| `Composer.tsx:263-264` | `Pick the document or paste what went wrong to send.` | `Name the document or paste the failure.` |
| `ThreadView.tsx:299-305` | the three permission sentences | delete the element; the `.seg` labels are the explanation. Update `tests/field.spec.ts:275`. |
| `ThreadView.tsx:319-320` | `A new thread.` / `Ask, or choose Plan, Build or Fix below. Nothing changes until you say so.` | `A new thread.` only |
| `server/app.ts:1347` | `Codex is preparing a file proposal. Review each proposed change before saying go ahead. No project files have been changed.` | `''` at creation (live point + caret); `turn.text = proposal.summary` at completion in `native-work.ts:416-429`; on failure, the failure sentence. The record gets `Preparing a proposal` as its first line. |
| `server/app.ts:1346` | `Picked up a message from the team. Anything Codex proposes waits for your go-ahead.` | `Picked up the team's message.` |
| `server/native-work.ts:624` | `Work stopped: <reason> N recorded files changed; their versions are in History.` / `No project files were changed.` | `Stopped: <reason>. N files changed, versions in History.` / `Stopped: <reason>.` |
| `server/native-work.ts:675` | `You stopped <task>. No unapproved changes were written.` | `You stopped <task>.` |
| `components.tsx:251` | `Diomedes is paused until you decide.` | delete |
| `components.tsx:248-250` | button `Show me first` | `Show the changes` (it collides with the thread policy control of the same name at `ThreadView.tsx:250`, which means something else) |
| `components.tsx:243-247` | four buttons | three: `Go ahead` · `Show the changes` · `Not this`; `Go ahead for this whole task` becomes the policy control's job, not a button on every need |
| `Picker.tsx:134` | `{integration.location}` | status word or version; never a path |
| `Picker.tsx:143-145` | `Default` / `default` / `Follow the saved default in Settings` | `Default` / `from Settings` |
| `Picker.tsx:199` | `Fix runs at medium. Your choice still governs Ask, Plan and Build.` | `Fix caps at medium.` (the struck rungs already show it) |
| `Picker.tsx:202,206` | `Applies to this thread. The default lives in Settings.` | delete |
| `Picker.tsx:124` | `Waiting for the current run to finish` | `Locked while the run finishes` |
| `TeamView.tsx:440-442` | `Members talk through the Diomedes team service.` | delete |
| `TeamView.tsx:445-447` | `One task, one record; every message lands in the streams above.` | delete |
| `TeamView.tsx:372` | `No team yet. Add a leader, then members.` | `No team yet.` + a working `Add` (see §4 item 12) |
| `BoardView.tsx:18` | `Add a task in the Workbook, or make tasks from a plan.` | `No tasks ready.` (after triage lands: `Write one in Triage.`) |
| `Shell.tsx:680` | `Start one and it is listed in the rail.` | delete; keep `New thread` |
| `Ledger.tsx:72` | `N open items, updated 11:33 am` | `N open, <ageOf(last)>` (a clock with no date lies by tomorrow) |
| `Ledger.tsx:91` | `{task.state} on {worker}, {age}` | the thread's `stateWord` (`review`, `blocked`, `needs you`), shared |
| `Settings.tsx` surface / detail descriptions (`components.tsx:33-40`) | keep | keep; Settings is where explanation belongs |
| Palette placeholder `Palette.tsx:117` | keep | keep; it teaches the verb search |

---

## 4. Small surfaces and details, ranked

1. **The needs-you moment is a Workbook card.** `ThreadView.tsx:308-316` mounts `Notice` (`components.tsx:225-256`) → `styles.css:822-845`. Replace with `client/console/Need.tsx` in the transcript's rhythm: amber point at −24 px, `Diomedes wants to {what}` on one line, the why beneath, the four digests in the `.record` register, verbs as text (`Go ahead` in `--attn`, `Show the changes`, `Not this`). New file, not a restyle of `Notice`, so `components.tsx` (which Codex is editing) is untouched.
2. **Picker menu has no ceiling.** `console.css:912-924`: no `max-height`, no `overflow`. Three catalogues run under the window. See §2.2.
3. **Scrollbars are the fat Windows bar everywhere but the transcript.** `scrollbar-width` and `scrollbar-color` are inherited properties; set them once on `.console` (`console.css:9-22`), delete the copy at `:430-435`, and the ledger (`:742-748`), palette list (`palette.css:30-36`), board columns (`board.css:41-49`), team streams (`team.css:209-218`) and the composer textarea (`console.css:623-635`) all fall in line.
4. **The window's own minimum width hides the app.** `desktop/main.mjs:139` `minWidth: 800`; `console.css:1131-1162` removes rail, ledger, picker, Settings and Ctrl K below 860 px with no way back. Raise `minWidth` to 1000 and delete the 860 block (it is the prototype's phone demo). Keep the 1100 rule.
5. **Title bar overlay is 46 px on a 40 px strip.** `main.mjs:43-44,145` vs `console.css:15`. The caption buttons hang 6 px over the hairline into the stage. Set the overlay to 40 (the Workbook strip is 40 too, `styles.css:505-507`).
6. **Diomedes turns don't render Markdown.** `ThreadView.tsx:31-33,175` splits on blank lines; a Codex answer with a code fence shows raw backticks. The Workbook has `Markdown` (`Workspace.tsx:2452-2490`, used for turns at `:1467`). Move it to `client/markdown.tsx`, use it for `diomedes` turns, fences in the 13 px mono register. This one embarrasses the app first.
7. **A palette row click runs its first action.** `Palette.tsx:130-134` `onClick={() => run(entry, 0)}`. Under "Go ahead for this task" a stray click on a Ready row starts a run. Row click selects; Enter and the action buttons run.
8. **The title is a clickable `h1`.** `ThreadView.tsx:238-240`, `console.css:355-359`. No affordance, no keyboard path. Rename via a quiet `Rename` in the head's tools register or the palette; the heading stays a heading.
9. **Hit areas are the size of the ink.** The reset at `console.css:26-34` gives every button `padding: 0`; `.rail-head button` (`:205-208`), `.who .tools button` (`:549-552`), `.ledger li button` (`:844-847`), `.instr button` (`:391-397`), `.record button` (`:497-502`), `.top-right .link` (`:170-175`) and Settings (`Shell.tsx:564`) are 12–14 px tall targets. Rule: ink unchanged, hit area ≥ 24 px via `padding: 5px 6px; margin: -5px -6px`.
10. **The crumb clips without an ellipsis.** `console.css:140-154`: `overflow: hidden` on the nav, `nowrap` on each project. With three projects open the last name is cut mid-glyph. `max-width: 22ch` + ellipsis per button, or fold older projects into the `···`.
11. **The ledger disagrees with the thread about state.** `Ledger.tsx:89-92` prints raw `task.state` (`waiting on Codex, 2 h`); `ThreadView.tsx:114-125` says `review` / `blocked` / `needs you`. One shared `stateWord()`.
12. **The Team empty state has no action.** `TeamView.tsx:372-377` gates `Add` on `onAddMember`; `Shell.tsx:747-783` never passes it, so "Add a leader, then members" has nothing to click. Wire it (palette or Settings › Engines) or say where the team is made.
13. **Two unstyled empties.** `Shell.tsx:673-708` "No threads yet" renders a bare reset `<button>`; `Shell.tsx:427-433` `.console-loading` has no rule. Give both the `.greeting` treatment (`console.css:573-590`) and a `.link` button.
14. **Dead CSS and dead code that will grow back.** `.console .proposal` (`console.css:604-609`) is a bordered, rounded card nothing renders; `.toast` + `say()` (`Shell.tsx:109-113`, `:793-797`) is never called; `.mono.lc` is declared twice (`:46-50`, `:59-63`). Delete all three; an unused card rule is how cards return.
15. **Native `<select>` in three places.** `TeamView.tsx:428-439`, `Composer.tsx:217-228`, `Workspace.tsx:725-737`. The OS popup is light, system-font, outside the tokens. One `Menu` component built from `.pmenu` (`console.css:912-1007`) serves all three; the triage spec's reasoning rail replaces the recipient select anyway, so build the Menu first and the rail on it.

Checked and fine, leave alone: hairline weights (`--hair` for dividers, `--hair-2` for controls, consistent across the four stylesheets); tabular figures (`.mono` carries `tabular-nums`, `:51-58`; the one proportional count is `.ledger .sub`, fixed by the `ageOf` rewrite above); focus rings (`:35-41`, one rule, correct); the 0.95 zoom on the Console (deliberate, documented in `7-console.md`); `Ctrl+1–8` are Workbook page keys that silently do nothing on the Console (`App.tsx:216-224`), harmless until the Workbook retires, then delete.

---

## 5. Merging safely while Codex works

**State as read.** `main` = `origin/main` = `11829e1`. The checkout at `F:\Achilles\diomedes` is on `fable/surface-20260909` at `11829e1` (created by fast-forward, per the reflog). `docs/superpowers/specs/*` is untracked. The taskbar exe (`release\Diomedes-win32-x64\Diomedes.exe`, 12:36 yesterday) is from `86ee91d`, two commits behind on the surface and eleven behind on the server. Codex's live worktrees carry **uncommitted** edits: `codex-runtime-proof` touches `Shell.tsx:25` (import) and `:799-825` (preview Modal gains `wide` + `HarnessProposal`), `components.tsx` (new `HarnessProposal` after `Modal`), `App.tsx:183-203`, `Workspace.tsx`, `server/app.ts:30-45,280-320`, `scripts/package-desktop.mjs`, `server/harness/**`, `server/integrations.ts`, `tests/ui.spec.ts`; `connections-proof` is all new files (`client/connections/`, `server/connections/`, `shared/connections.ts`, `server/rules.ts`); `windows-release` is both of those plus `Rail.tsx:79-92` and `types.ts:12` (a `Connections` view) and `package.json` → `0.1.1`. `opus/trust-v1` is two committed, purely additive commits under `server/trust/` and can land whenever.

**The rule that makes this safe.** Surface work lands in Console-only files or in new files; shared files get string-level edits only, in regions Codex is not in. Concretely, on `fable/surface-20260909`:

- Free to edit: `client/console/console.css`, `Picker.tsx`, `Composer.tsx`, `ThreadView.tsx`, `Ledger.tsx`, `Palette.tsx`, `palette.css`, `BoardView.tsx` (strings), `TeamView.tsx` (strings, `:440-447`), `team.css`, new `client/console/Need.tsx`, new `client/markdown.tsx`, `desktop/main.mjs:43-44,139,145` (Codex does not touch it), `server/modes.ts` captions, `tests/field.spec.ts`.
- Edit one region only: `server/app.ts:1346-1347` (Codex's hunks are at 30-45 and 280-320; no overlap). `server/native-work.ts:416-429` (turn text on completion): Codex's diff there is two lines elsewhere, but it is their file this week; do the `app.ts` string now and leave the completion rewrite for the second pass.
- Do not touch: `Shell.tsx:25` and `:799-825` (edit only `:427-433` and `:673-708`), `Rail.tsx:79-92`, `client/console/types.ts`, `client/App.tsx`, `client/components.tsx`, `client/Workspace.tsx`, `package.json`, `package-lock.json`, `playwright.config.ts`, `scripts/package-desktop.mjs`, `server/harness/**`, `server/connections/**`, `client/connections/**`, `shared/harness.ts`, `shared/types.ts`, `evidence/**`, `docs/harness/**`, `.data/native-runtime/**`, and anything under `F:\Achilles\diomedes-wt\`.

**Order.**

0. Now, on the surface branch, first commit: `docs/superpowers/specs/*` as a docs-only commit so the triage spec stops being untracked and cannot be lost to a `git clean`. (This report lives in `planning/` inside the repo because the brief put it there; either commit it with the docs or move it to `F:\Achilles\planning\`.)
1. Now, before any Codex branch lands: the surface set (§2.1, §2.2, §3 table minus `native-work.ts`, §4 items 2–5, 7–11, 13–15; item 1 as a new file; item 6 as a new file). One commit per concern, so any one can be reverted alone.
2. Gates, in `F:\Achilles\diomedes`, with ports 5174 and 47632 free and no Muse or Codex pass verifying at the same time (the integration log's recorded trap): `npx tsc --noEmit` → `npx vitest run --configLoader runner` → `npx vite build` → `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`. The only deliberate red is `field.spec.ts:275`, updated in the same commit that deletes the sentence.
3. Merge: `git checkout main && git merge --ff-only fable/surface-20260909 && git push origin main`. Fast-forward only; if it refuses, someone landed on `main` first and the branch rebases, never the reverse.
4. Package **from `main`**, with `Diomedes.exe` closed: `npm run package:desktop` (writes the taskbar target), then `DIOMEDES_DESKTOP_PROFILE=F:\Achilles\diomedes\.profile-smoke npm run test:desktop`. Andrew opens the taskbar exe and sees the centering and the picker today. Package from `main` and only from `main`, so the exe is always a commit you can name.
5. Tell Codex, in its next brief, exactly which files moved on `main` (the list in "free to edit" plus `app.ts:1346-1347`). Its `windows-release` rebases once with nothing to resolve in its own files; `Shell.tsx` merges three-way clean because the two edit sets are 250 lines apart.
6. After `windows-release` (0.1.1) lands on `main`: the same four gates, package, smoke; second rebuild of the taskbar exe. Then the deferred surface items that sit in Codex's regions: the preview sheet (`Shell.tsx:799-825`, now carrying `HarnessProposal`), the Connections view's skin, the `native-work.ts` completion rewrite, `Rail.tsx` foot.
7. `opus/trust-v1` lands on `main` by fast-forward after 6; no surface impact.

**Never.** Run `git clean`, `git stash` or `git checkout -- .` in the main checkout while worktrees share `.git`; run `npm run package:desktop` in two checkouts at once; run Playwright while a pass is verifying; bump the version (Codex owns `0.1.1`); touch the native-runtime hashes; commit Codex's uncommitted worktree files for it.

---

## 6. What to hand Astra, and what not to

**Astra's (deep implementation, on the runtime / triage / release track):**
- The `triage` state and its six enumerations, the Triage column, the six-column check at 1280 and 1440, per `docs/superpowers/specs/2026-09-09-triage-and-routing-design.md`.
- The runtime-selection contract and the reasoning rail, built on a shared `Menu` component derived from `.pmenu`, replacing the three native `<select>`s (§4 item 15).
- `Markdown` moved to `client/markdown.tsx` and used for Diomedes turns (§4 item 6), including code fences in the mono register.
- Turn text on completion (`native-work.ts:416-429` sets `turn.text = proposal.summary`; failure sentence on failure) and the record's `Preparing a proposal` line, after Codex's branch lands.
- The Console preview sheet replacing `Modal` at `Shell.tsx:799-825`, rendering `HarnessProposal` natively, after Codex's branch lands.
- `Need.tsx` wiring into the approval flow (`decideApproval`, receipts) once the design of the block is signed off.
- The 0.1.1 package, the desktop smoke, and the second exe rebuild.
- The Workbook port, one page per pass, when Andrew says go: Review, Documents, History, Home.

**Not handed out, because it is a judgement call Andrew (or the design owner) makes:**
- Retiring the Workbook into the Console, and what "Guided" means as a density of one surface (§1). This changes what everyone builds next; decide it before the port starts, not during.
- The centering rule itself (§2.1): centered-with-a-floor is my recommendation against the prototype; changing what the approved prototype shows at 1440 is Andrew's call, and this rule deliberately does not.
- The copy doctrine and every string in §3. A voice is one person's; a model can apply the doctrine but must not be the one who sets it.
- Which three verbs a need shows and their labels (§3 table, `components.tsx:243-250`).
- Whether the picker's heading shows a version or a status word, and whether the path leaves the Console entirely.
- Palette click semantics (§4 item 7): select-then-run is the safer default; Andrew may prefer one-click for the `go` policy.
- The minimum window width and the fate of the 860 px breakpoint (§4 item 4).
- Anything that deviates from `05-instrumented-density-prototype.html`. The prototype is the design authority; every deviation is approved by name, not discovered in a diff.
