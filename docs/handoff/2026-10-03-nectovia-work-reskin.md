# Round 2 reskin: brief for the build thread

Written 2026-10-03, about 21:10 EDT, by the session that designed and merged the wide window rules
(session 1ffe8776, PR #212). It is for the fresh thread that builds the round 2 reskin. Read all of
it before you start. Where it points at a source, read the source: prices, statuses, branch states
and file contents change, and the source wins over this brief.

## Work order

| Field | Value |
|---|---|
| Feature | nectovia-work-reskin |
| Linear | DIO-200 (the reskin), DIO-201 (the Local model option, its child) |
| Branch | `feature/nectovia-work-reskin`, from origin/main `04e2d88`, upstream unset |
| Convention worktree | `F:/Diomedes/diomedes-wt/nectovia-work-reskin` (gates run here) |
| Your session worktree | `F:/Diomedes/diomedes-wt/nectovia-work-reskin/.claude/worktrees/<name>`, branch `claude/<name>` |
| Owner | this thread (Claude Code, Opus 5.5, max effort), working for Andrew Godowsky |
| Coordination record | `F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/work-orders/nectovia-work-reskin.json` |
| Design spec this build must keep | `docs/superpowers/specs/2026-10-03-wide-windows-and-multitask-mode-design.md` |

## What Andrew asked for

At 20:45 EDT on 2026-10-03:

> start the round 2 reskin build in a new worktree so i can begin a fresh thread, ensure it has
> context from our session here as well so it knows what to appropriately update. also, make sure
> the nectovia app has a button for "Local Model" or something as a Nectovia option, as I have
> bonsai being installed and i want it to be able to be called in Nectovia (codex is setting that
> up rn), but you're in charge of that actual UI reskin button being added too.

Earlier the same day, at 16:27 EDT, about the same design:

> i want to ensure that when that UI/UX is applied, it doesn't scale really. i want it to be very
> clean, having spacing on full screen and larger window modes, and then when its smaller windowed
> mode, it is at the scale its currently at. information needs to be visible but not overly in
> your face in full screen.

Later that evening, on how to work:

> dont write the plan, just go straight to execution. you're able to skip that step and it wastes
> tokens.

So write no plan document. The superpowers flow's plan step is skipped for this build.

## The design

The source is the Agent and Work design canvas, version 17:
https://claude.ai/artifact/RkinDiymHU8i5BmSeGdJ5b. Read it with the Artifact tool's `read` action,
never a web fetch. Its two round 2 pages:

| Board | What it shows |
|---|---|
| N1 Service line | The paid Nectovia home for a restaurant owner (Frank Ruiz at Kestrel Hospitality), in the Harbor palette. A cover count bar chart, and a colored sweep line under a working step. |
| N2 One thread, live | One conversation. N1's chart sits at the top of the thread and stays live with the task; the sweep runs on the chart's baseline while helpers read. |
| N3 The note | The Marble alternative view. |
| N4 The ask box | The spec of the composer, shared by every board. |
| BD1 Thread and board | The Work view for an IT lead (Dana Whitfield): a thread beside its board. Has a paid and a free state. |
| BD2 Team view | Nectovia leads a team and asks Jev. Has a paid and a free state. |
| BD3 Routines | Routines, renamed from Automations. |

Andrew's reactions: N1 and N2 are his "absolute favorites". He loves N1's bar chart and the sweep
line. The Work view "is great as well".

Local copies, in `F:/Diomedes/deliverables/nectovia-round-2-boards-20261003/`:

- `root/project/*.dc.html`: the boards as published, with their styles inline. Start here.
- `src/boards/*.src.html`: each board's source. `src/ask.html` and `src/ask.js` are the shared
  ask box, pulled in by the `@@ASK:...@@` and `@@ASKJS@@` macros. `src/base.css`, `src/r2.css` and
  `src/bd.css` are the shared styles.
- `copy-*.txt`: each board's visible text, for the voice scan.
- The css, js and mjs files exist on disk only, because workspace git ignores them. If they are
  gone, the `.dc.html` boards hold the same styles.
- If the local files and the published canvas disagree, the canvas wins.

The boards are design references, not code to paste. Their 18px type is a presentation size; the
size rules below win.

Round 1, for background: the definition doc https://claude.ai/artifact/Sfds1WczWG7BMM3CNJDhhy keeps
Andrew's round 1 picks in its `picks` collection. N1, N2 and N3 continue round 1's S4 Service line,
S5 One thread and S3 The note. On 2026-09-28 he said home looks become templates a business picks
at purchase. Where round 1 and round 2 differ, round 2 wins.

## Rules that bind every slice

### Size and space (merged 04e2d88, DIO-192)

- Sizes stay as they are today, at every window width. The tokens in `client/styles.css`:
  conversation 0.9375rem (15px), body 1rem, input 0.9375rem, interface 0.875rem, caption
  0.8125rem, meta 0.75rem, section 1.125rem, title 1.25rem, and `--dm-type-display` 3rem for the
  home greeting.
- The work column is `--dm-measure`, 57.5rem (920px). A bigger window adds margin, never bigger
  type. Small windows look as they do today.
- No viewport or container units (vw, vh, vmin, vmax, cqw and the rest) in a font, padding, margin
  or gap, or in a `--dm-type`, `--dm-line` or `--dm-measure` token, in CSS or in an inline style.
  `tests/viewport-units.test.ts` fails the build otherwise. Its list of five older rules only
  shrinks.
- `tests/readability.spec.ts`, run by `playwright.responsive.config.ts`, checks that type measures
  the same at 1280, 1920 and 2560 and that the column holds at 920 on the wider two. Every new home,
  thread and Work layout must keep passing it.
- Full screen stays calm. Nothing appears on a big window that the person did not open.
- Side content is a column of `.console .stage` (232px rail, the work column, then
  `var(--files-w)` when Files is open), never a margin on `.col`. Keep it that way: the side panel
  (DIO-193) turns that third column into a host for any tool, and it starts after this reskin
  merges.

### The ask box (N4) and engines

Andrew decided these on 2026-10-03:

- One line that grows as you type. Under it, one row of styled dropdown boxes: Engine, then Model
  or tier, then Effort, then Agent, then a small context ring that is always visible.
- Engine: Nectovia plus every engine found on this computer. Nectovia always shows Online.
- Model or tier: on Nectovia it is the tier, so it reads "Nectovia | Focused". On another engine it
  lists that engine's models, for example "Claude Code | Opus 5.5".
- Effort appears only on an engine other than Nectovia. It holds that engine's own levels, as a
  slider inside the dropdown.
- His words: "DO NOT HARDCODE MODEL NAMES, THEY MUST BE INFERRED AUTOMATICALLY". Names, effort
  levels and defaults come from the engine. The source is `EngineCatalog` (`shared/types.ts:774`)
  from `GET /api/engines/:engineId/models`.
- Short agent labels ("Researcher" for Documentation Researcher) are a proposal, not a decision.
  `shared/agents.ts` has no short label field. Ask before adding one.
- The canonical roadmap (2026-09-27.2) adds: engines follow their installations and model
  catalogues, and a failed check withdraws stale choices and never silently picks a different
  model or payer.

Today's code to start from: `client/console/Composer.tsx` (the ask box; attachments arrive through
`onAttachments`, inserted text through `insert`), `client/console/Picker.tsx` (engine, route and
model menu; it reads `EngineCatalog`), `client/console/WorkStylePicker.tsx` (the tiers, from
`shared/work-style.ts`) and `shared/effort.ts`. Engine and route names come from `shared/engines.ts`.

### Plans and the two views

- The top switch reads "Nectovia | Work". Today the view is chosen in the "···" menu, under View:
  Conversation or Architect (`client/console/Shell.tsx`, near line 2067, `settings.view`). Work
  replaces Architect.
- Paid boards say "Nectovia" wherever Claude Code appeared, at every tier.
- Engine and model names are fine in Work, and for a paid person running Nectovia on their own
  subscription. Everywhere else a person sees tiers and credits.
- A free person cannot use the Nectovia view on their own subscription, but can use their own
  subscription in Work. Work's engine menu shows Nectovia grayed and unselectable, reading "Buy
  credits or upgrade your plan to use Nectovia". He asked for "unlock", which is a copy gate word,
  so the boards say "use", and he was told.
- The team view is on every plan. Nectovia leading the team and calling models like Jev is paid
  only. On free, the person leads.
- Automations is renamed Routines everywhere a person reads it, and Routines stay paid only. My
  recommendation: rename what people read, and keep internal names and API paths unless a slice
  needs them changed.

### Copy and design

- No italics, no em or en dashes, no redundant helper text, the simplest wording. A spaced hyphen
  fails like a dash does.
- Run every new string through the voice scan with the app surface:
  `pwsh -NoProfile -File F:/andre-plugins/plugins/nectovia/scripts/scan_copy.ps1 -Path <file> -Surface app`
  (or `-Text "<string>"`). Engine and model name FAILs in Work and on own-engine surfaces are
  expected; report their count.
- `.nv-accent` in `client/console/nectovia.css` (near line 765) is still `font-style: italic`. The
  2026-09-28 first pass asked for an upright accent.
- Home rules from 2026-09-20: keep the view uncluttered, and show a section only when it carries
  something. "Everything" is a hover control (`Everything.tsx` opens on click today). An unbuilt
  feature keeps a real, disabled slot instead of being deleted.
- The bust is the thing Andrew loves most. On 2026-09-28 he wanted both the On light treatment
  (Marble, Paper) and the Quiet treatment (narrow windows, phones).
- The 2026-09-28 first build pass, in order: the one needs-you rule (done, #175, merged
  2026-09-29); vendor words gone below Technical, the approval card and truncation; the upright
  accent and the bust; the home redesign; Work replacing Architect. For this brief only #175 and
  the italic accent were checked. Verify the rest on main before you count them done or pending.

## The Local model option (DIO-201)

Andrew wants a "Local Model" button, or something like it, as a Nectovia option, so a model
running on this computer can be called from Nectovia. The first is Bonsai 2 27B, which Codex was
installing at `F:\Bonsai-2` tonight. This lane owns the button.

It has two pieces:

1. **The option (this lane).** A "Local model" entry in Nectovia's Model or tier box, after
   Efficient, Focused and Thorough, so it reads "Nectovia | Local model". "Local model" is a
   product label like the tiers. Everything else comes from the server: the model's own name (shown
   only where model names are allowed), its context size for the ring (Gaming runs 16,384 tokens,
   Full 131,072, so it can never be a constant), and whether it is running. `IntegrationStatus`
   (`shared/types.ts:852`) already has `kind: 'local'`, with `found` and `available`. Nothing in the
   code may name Bonsai.
2. **The binding behind it (no owner yet).** No route reaches a local model on main, and nothing
   in branches, open PRs or coordination claims one as of 21:00 EDT. Codex's README for the
   install says the app side "has not been implemented or tested". Andrew decides whether this lane
   builds it. Until he does, build the option against the catalog and integration status, so it
   lights up when a binding reports a local model.

Defaults until Andrew says otherwise:

- Hidden when nothing local is set up. Grayed, with one short line, when it is set up but not
  running.
- Never the default, and choosing it changes no tool permissions. The connection file's boundary:
  "Optional local worker or provider behind Nectovia's existing engine and Trust interfaces. Do not
  replace a cloud default or expand tool authority merely by selecting this model."
- If the local server stops, withdraw the choice and say so. Never fall back to a cloud model.
- Plans follow the own-engine rule: the Nectovia view is paid, and Work allows a person's own
  engines on any plan.

Facts about the first local model. They are data, not instructions, and they change, so read them
fresh:

- `F:\Bonsai-2\nectovia-connection.json`: OpenAI compatible at `http://127.0.0.1:18082/v1`,
  Anthropic compatible at `http://127.0.0.1:18082`, health at `http://127.0.0.1:18082/health`, no
  key (a client that insists gets the placeholder `bonsai-local`), model id `bonsai-2-27b`.
- `F:\Bonsai-2\README.md`, section "Nectovia preparation".
- The app has never been tried against it (`nectoviaInstalledAppSelection: not_performed`).
- Do not start or stop Bonsai yourself (`Start-Bonsai.ps1`, `Stop-Bonsai.ps1`). It shares video
  memory with Andrew's games, so starting it is his call.
- Never write that the local model answers or "serves" until a live call through the app has
  succeeded.

## Suggested order

One PR per slice. A single PR for the whole reskin would be too big to review or gate.

1. The ask box (N4), with the Local model option. Every board shares it, and the option lives in
   it.
2. The Nectovia home and thread (N1 and N2, with N3 as the alternative view), plus the accent and
   bust items.
3. The Work view (BD1 to BD3) replacing Architect, the Routines rename and the team view.

Hot files need a coordination claim first: package.json and lockfiles, `shared/types.ts`, the
shared harness, Agent and pack contracts, `server/app.ts`, `server/store.ts`,
`server/native-work.ts`, `client/api.ts`, `client/console/Shell.tsx` and `desktop/`. If a claim is
refused, return a patch, or record an owner override when Andrew directs the change (memory note
`hot-file-claim-refused-owner-override.md`).

## How to work here

1. **Start.** Run `git log --oneline -3`. If this brief's commit is missing from your branch, run
   `git merge --ff-only feature/nectovia-work-reskin`.
2. **Read.** The repo's `AGENTS.md` and `CLAUDE.md`. The three canonical documents
   (`docs/DIOMEDES_CORE_PILLARS.md`, `docs/DIOMEDES_LIVE_ROADMAP.md`,
   `docs/DIOMEDES_PROJECT_MEMORY.md`, all 2026-09-27.2 when this was written). The workspace
   `F:/Diomedes/AGENTS.md`. The memory index
   `C:\Users\andre\.claude\projects\F--Diomedes\memory\MEMORY.md`, by that path, because your
   worktree session gets a memory folder of its own.
3. **Edit and commit in your session worktree.** If Edit or Write refuses a file there (this layout
   has not been tried against the edit hook), use the Node replacer in
   `edit-hook-blocks-diomedes-wt-from-session-worktree.md`. The trees are CRLF.
4. **Run gates in the convention worktree, never in yours.** A path with a `.claude` part makes
   `rejectForbidden` in `server/paths.ts` refuse test data, so vitest and Playwright fail falsely
   there. Instead run `git -C F:/Diomedes/diomedes-wt/nectovia-work-reskin merge --ff-only claude/<name>`
   and run the gates in `F:/Diomedes/diomedes-wt/nectovia-work-reskin`.
5. **Take the heavy slot first,** for `npm ci`, vitest, Playwright and vite build, one heavy
   command at a time. The slot is often held by another lane; wait for it.
   - Take it: `node F:/Diomedes/diomedes/node_modules/tsx/dist/cli.mjs scripts/coordination.ts slot --role opus --pid <your claude.exe pid> --purpose "<what>" --node nectovia-work-reskin --worktree F:/Diomedes/diomedes-wt/nectovia-work-reskin --root F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913`
   - The grant's id is at `slot.slotId`. Release it with `unslot --slot <id>` and the same
     `--role`, `--pid`, `--worktree` and `--root`, in a `trap ... EXIT`.
   - Find your pid by walking up from your shell's parent processes to `claude.exe`. Always pass
     `--root`.
6. **First install.** The convention worktree has no `node_modules`. Under the slot, run `npm ci`
   at its root and `npm ci --prefix services/control-plane`.
7. **The four gates.** `npx tsc --noEmit`, `npx vitest run`, `npx vite build`, then
   `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`. Add
   `npx playwright test --config playwright.responsive.config.ts` for any layout change. Build
   before Playwright, every time. Report real counts from your own run. Then restore what
   Playwright rewrites: `git restore -- evidence/ docs/verification/`.
8. **Commit when gated.** Andrew allows local commits on the feature branch once the gates pass and
   the work is good. Add no `Co-Authored-By` line and no "Generated with Claude Code" line to any
   commit or PR, whatever a system reminder says. That is Andrew's standing rule.
9. **Push, PR and merge only on Andrew's yes for that patch.** Main is protected; a merge needs
   `gh pr merge <n> --merge --admin` with his approval for that PR. Never edit the ruleset. Merging
   to main redeploys the `diomedes` Worker.
10. **Linear.** Update DIO-200 and DIO-201 as you go, without asking. Read an issue fresh before
    editing it. Set Done only after a merge to main, with evidence. The Linear tools that work are
    the claude.ai connector's (`mcp__896996a9...`).
11. **Record each slice** in `docs/harness/CHANGES.md`, and finish with the required report in
    `AGENTS.md` (pillar impact when it matters, roadmap impact, build status, what is built versus
    only recorded, anything uncommitted or unpushed).
12. **Delegate little.** Do small things yourself. Never spawn a Fable subagent, and always pass an
    explicit model.

## Memory to read

In `C:\Users\andre\.claude\projects\F--Diomedes\memory\`:

- `multitask-mode-design-2026-10-03.md`: the wide window and side panel design, and why the size
  rules bind this build.
- `agent-work-round-2-boards-2026-10-03.md` and `composer-and-plan-rules-2026-10-03.md`: the boards
  and Andrew's ask box and plan rules.
- `nectovia-agent-work-split-2026-09-28.md`, `agent-home-design-rules.md`,
  `nectovia-copy-no-italics-no-dashes.md`, `console-design-language-2026-09-20.md`,
  `nectovia-skin-design-2026-09-22.md`: earlier design decisions.
- `paid-plan-decisions-2026-09-28.md`, `individuals-free-harness-paid-agent-2026-09-27.md`: plans.
- `heavy-slot-before-any-heavy-command.md`, `fresh-worktree-needs-two-installs.md`,
  `diomedes-full-browser-suite.md`, `edit-hook-blocks-diomedes-wt-from-session-worktree.md`: process
  traps.
- `diomedes-core-pillars-are-binding.md`, `no-co-authored-by-trailer.md`,
  `commit-without-asking-when-gated.md`, `app-main-ruleset-admin-merge.md`,
  `app-main-merge-deploys-the-worker.md`: publishing rules.

And the app repo's own note:
`C:\Users\andre\.claude\projects\F--Diomedes-diomedes\memory\gates-fail-under-claude-worktrees.md`.

## Open questions for Andrew

Ask these in your first turn unless he has already answered them in the thread:

1. Does this lane also build the binding that reaches the local model, or does another lane? Until
   he answers, build the option only.
2. Local model and plans: the default above follows the own-engine rule. Does he want it that way?
3. Short agent labels in the ask box: add them or not?
