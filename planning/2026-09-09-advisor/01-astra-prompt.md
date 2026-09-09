# Diomedes — unified Astra implementation, integration and Windows build

Continue Diomedes in one implementation thread. Build and integrate the approved
Triage/routing/picker work and the existing Connections proof into the current app, merge your own
build back into ours, and produce a tested Windows package. **This is authorization to implement
this bounded slice locally**, not another research-only or specification-only assignment.

The result should let me create a task on the Console board, leave it in Triage, release it to
Ready, inspect or override its route using the proper Diomedes picker, and see a real supported
worker carry it through the appropriate states. The Connections proof should become an integrated,
clearly labelled credential-free experience using the same Tasks, Runtime, rules, Trust and
History — not a separate demo application standing in for integration.

Preserve the existing product and the current Runtime/Trust work. Use the supplied designs and
evidence; make implementation decisions where necessary and record meaningful deviations. Research
only unresolved compatibility questions. Keep progress updates to decisions, completed slices and
genuine blockers. Use subagents where independent work benefits, rather than repeating the same
investigation with multiple reviewers.

---

## 1. Establish the actual starting point, and note that it moved this morning

App repository: `andrewgodowsky-aoa/diomedes`. Website reference: `andrewgodowsky-aoa/diomedes-site`.

**The authority is the local `main` in `F:\Achilles\diomedes`, not `origin/main`.** On 2026-09-09 a
surface pass landed four commits on local `main` that have **not been pushed**:

```
ad1ab61  Fold Astra's project instructions into one AGENTS.md, and name the website trap
a9cd625  One surface: record the decision where the next agent will read it
9bd2700  Let the proposal speak instead of the narration
8bc7d7f  Centre the measure, contain the picker, and stop borrowing the Workbook's card
f98ce35  Keep the triage and routing spec in the repository
11829e1  Clarify LLC formation status        <- what origin/main still points at
```

So: do not `git pull` and assume you are current, and do not treat `11829e1` as the base. Fetch
without resetting or cleaning local work, then follow §2's merge protocol.

**Read first, in this order:**

1. `AGENTS.md` (new, tracked at `ad1ab61`) — the standing decisions, what is not an agent's to
   decide, the coordination rules and the gates. It did not exist when the earlier version of this
   brief was written.
2. `docs/implementation/2026-09-09-one-surface.md` — the Workbook retirement decision (§9 below).
3. `docs/superpowers/specs/2026-09-09-triage-and-routing-design.md` — the full 713-line triage and
   routing design. It was untracked when it was written; it is **now committed** at `f98ce35`, so a
   fresh worktree from `main` contains it. Its Claude artifact URL and any pasted summary are not
   substitutes for the file.
4. `planning/2026-09-09-advisor/00-fable-advisor-opinion.md` — an advisor pass over the whole app:
   the copy doctrine and its rewrite table (§3), fifteen ranked small-surface defects (§4), and the
   reasoning behind the Workbook decision (§1, §2.3). `planning/` is untracked and lives only in the
   main checkout; read it by absolute path.
5. `docs/harness/RUNTIME_VERIFICATION.md`, `CHANGES.md`, `HARNESS_INTEGRATION_MAP.md`,
   `NR02_NR03_VERIFICATION_2026-09-09.md` and any newer continuation reports; the current Trust and
   accounts handoff; and `F:/Achilles/planning/DIOMEDES-CONNECTIONS-OWNERSHIP-2026-09-09.md`.

Roadmap state at the time of writing: tracked `docs/DIOMEDES_LIVE_ROADMAP.md` said `2026-09-09.4`;
the canonical Google Doc said `2026-09-09.6`
(`https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit`). These are
discovery checkpoints, not checkout targets; use a newer verified state when present. The `.6`
direction preserves Core as agent/routing semantics, Runtime as durable execution authority, Trust
as identity/authorization, local-first use, direct-agent use, and the future Diomedes supervisory
agent. The first usable product must not depend on rented GPUs, proprietary model training,
mandatory online accounts or subsidised model usage. The `.5` continuation recorded the Usage
regression fixed locally; do not resurrect the `.4` open issue without checking current evidence.

**Connections handoff:** the document headed `Connections proof handoff` (uploaded as
`Pasted markdown(3).md`, possibly also `DIOMEDES_CONNECTIONS_PROOF_HANDOFF_2026-09-09.md`). Its
source worktree is `F:/Achilles/diomedes-wt/connections-proof`; read its `IMPORT-MANIFEST.json`,
`docs/connections/` architecture/research/handoff and `evidence/connections/` verification records.
The attachment is a report, not the source bundle. Check the frozen source hashes before import and
record integration changes separately.

---

## 2. You have your own build; here is how it comes home

You have been building in your own worktree — features, buttons and surfaces of your own — while a
separate surface pass ran on `main`. That is fine, and the collision is smaller than it feels. As
inspected at 06:31 on 2026-09-09, your live worktree (`F:/Achilles/diomedes-wt/windows-release`)
had uncommitted edits to `client/App.tsx`, `client/Workspace.tsx`, `client/components.tsx`,
`client/console/Rail.tsx`, `client/console/Shell.tsx`, `client/console/types.ts`, `package.json`
(0.1.1), `playwright.config.ts`, `scripts/package-desktop.mjs`, `server/**` and `evidence/**` —
**39 client insertions across six files, and none of them touch a file the surface pass changed.**
The only two shared files are `server/app.ts` (your hunks at 33–358, ours at 1346–1347) and
`server/native-work.ts` (your one line at 66, ours near 280, 415 and 486). Both merge cleanly.

**Merge protocol.**

1. Commit your work on your own branch first. Never let another agent commit it for you, and never
   run `git clean`, `git stash` or `git checkout -- .` in the main checkout — every worktree shares
   one `.git`.
   **Before you merge, delete your worktree's untracked `AGENTS.md` and `CLAUDE.md`.** You wrote
   them locally; every rule in them (the live-roadmap authority, the isolated-checkout build rule,
   never replacing the running installation, approval before commits and pushes, ROADMAP IMPACT and
   the separate build/publication/deployment statuses) has been merged verbatim into the tracked
   `AGENTS.md` on `main`, alongside the design decisions, so nothing is lost. Git refuses to merge
   over an untracked file, so leaving them there blocks the merge for no gain.
2. `git merge main` into your branch (or rebase onto it) and resolve there, not on `main`. Expect
   nothing to resolve in your own files.
3. Run the full gates in §10 on the merged tree.
4. `git checkout main && git merge --ff-only <your-branch>`. If the fast-forward is refused,
   someone landed first: rebase your branch again, never the reverse.
5. Pushing to `origin`, publishing a release and replacing Andrew's live installation each need
   separate explicit authorisation. "Build" alone is not permission to publish.

### Already done — do not redo, do not undo

| Landed on `main` | Where |
|---|---|
| The thread column is centred in the work pane: `width: min(760px, 100% - 96px)` with auto inline margins, so head, instrument line, permission line, transcript and composer share two edges at every width. **One `.col` rule owns the page column; a `margin` shorthand on a `.col` element silently resets it.** | `console.css` |
| The picker menu can no longer push text outside its panel. The cause was inheritance, not width: `.top-right` sets `white-space: nowrap`, and an absolutely positioned panel escapes its ancestor's layout box but not its inherited properties. Wrapping is reset at the panel edge; the engine path shows its tail with the full path on hover; the model id keeps its full width and the display name yields first; the menu has a height ceiling and scrolls. | `console.css` `.pmenu*`, `Picker.tsx` |
| Build's composer names documents only when there are any, and states scope rather than repeating the approval promise. | `Composer.tsx` |
| A Build turn's text becomes the proposal summary on completion. The completion path used to stamp `turn.helper` and never `turn.text`, so the "Codex is preparing a file proposal…" holding line was the permanent record of every Build exchange. | `server/native-work.ts`, `server/app.ts` |
| The needs-you moment is a Console block, not the Workbook's `Notice` card. Verbs, wording, decisions and the receipt are unchanged, which is why the approval specs pass untouched. | new `client/console/Need.tsx`, `ThreadView.tsx`, `console.css` |
| Title-bar overlay is 40 px, matching the strip it sits on (was 46, hanging 6 px into the stage). | `desktop/main.mjs` |
| One scrollbar treatment for every scroller in the Console. `scrollbar-color` inherits; `scrollbar-width` does not, so descendants carry their own rule. | `console.css` |
| Project names in the crumb ellipsise instead of being cut mid-glyph; "Projects" never gives up room. | `console.css` |

Gates green on that tree: `tsc` clean, **483 vitest**, `vite build`, **26 Playwright**
(ui + native-ui + field). The taskbar exe was rebuilt from `main` and passed the desktop smoke.

---

## 3. One architecture, with the scope corrected

Build the real dispatcher, route decision and automatic stage movement now. Do not substitute a
`NullDispatcher`, a logging-only pickup handler or animated mock state changes.

The future customer-facing Diomedes supervisory agent is not a prerequisite. However, a class called
`NativeAgent` already exists as the harness model/tool loop, and the Connections proof uses it.
Preserve that implementation. "The future supervisor is not delivered" does not mean "delete or
rebuild the native execution kernel."

Responsibilities stay where they are:

- **Core** chooses a permitted route and supplies scoped rules and context.
- **Runtime** owns admission, command and run identity, leases, budgets, cancellation, checkpoints,
  recovery and execution effects.
- **Trust** resolves current authority and broker access.
- **Store** owns existing project Tasks, History and guarded document mutations.
- **Connections** verifies and normalises source events and creates durable observations and tasks
  through those authorities.
- **Desktop** presents that truth and submits validated commands.

The combined path is:

`source event → durable inbox → bounded rule evaluation → existing Task/History → origin-aware
release → Ready → durable pickup/admission → supported adapter → actual progress/approval/result →
task transition/evidence`

Connections triage identifies an issue; dispatch triage chooses how eligible work is executed. They
are different steps, not two owners of execution. Preserve the public capability name **"automatic
triage."** Make routing strategy replaceable so a future supervisor can supply decisions through the
same validated contract, without gaining a bypass around Runtime/Trust or requiring replacement of
task persistence.

---

## 4. Triage, release and authoritative transitions

Add Triage as a real persisted task state and the leftmost Console column. Enable task creation
directly on the Console board. User-authored tasks wait in Triage until deliberately released;
moving an eligible task into Ready requests automatic pickup. `createTask` gains an optional `state`
that **defaults to `'todo'`**, so the two funnels stay distinct: tasks from a thread or the team
view start running as they do today; only user-authored board tasks sit in Triage.

Preserve existing team- and thread-originated auto-start behaviour. The new funnel must neither
stall those tasks nor dispatch them twice. Record origin and release eligibility explicitly; a
shared owner label alone is not a reliable origin marker.

**Important source distinction.** The inspected published main has four stored `TaskState` values
(`todo`, `working`, `waiting`, `done`) but five rendered board columns — Review and Blocked are
projections of state and reason. "Sixth column" does not mean six persisted values already exist.
Reconcile the spec against the current tree and preserve compatible projections unless the spec
explicitly calls for a migration. Use explicit ordered column definitions; TypeScript union order is
not runtime ordering.

Unify all relevant task mutations behind the current authoritative transition path — both
`store.moveTask` and the direct assignments in `server/team/service.ts`, and inspect other writers
as well. Do not attach pickup solely to the renderer or one HTTP route.

Transition persistence must cover the task change, attribution and history, and the release/pickup
intent needed for recovery. The pickup seam is **a durable pickup request shown as waiting**, never
a silent drop. Use existing Store locking and transaction patterns and Runtime admission primitives.
Dispatch external work after durable admission, not while holding a Store lock. Avoid nested-lock
deadlocks, recursive pickup and duplicate History from multiple observers.

Specify and implement release identity, ownership and stale-command behaviour so duplicate UI or MCP
commands, reconnect, two workers, restart and a route-change race cannot launch the same release
twice. An ambiguously dispatched provider call must not become a fresh automatic start.

Existing Ready tasks must not all start merely because an upgraded app opens, imports a project,
restores a snapshot or refreshes a catalogue. Migration preserves existing work; newly authorised
releases receive explicit identity. Reopen, pause and recovery must respect live runs, approvals and
unresolved effects.

Audit every state translation and eligibility check. In particular: `server/team/board.ts` has a
trailing completed fallback; the member-wake path in `server/app.ts` uses a negative done filter;
Console/Workbook mappings, counts, MCP views, persistence validation and undo/reopen paths all need
deliberate Triage handling. Use exhaustive mappings and runtime validation. **Triage or an unknown
state must never silently mean completed or runnable.**

For new Connections-created manager tasks, where neither source specifies release policy, use Triage
by default and document that integration decision. Automatic release requires an explicitly adopted,
bounded rule and current execution authority. Do not classify connector issues as team-originated to
bypass review. Completing an inbox-processing run is not completing the manager's business task;
acknowledging an availability event does not establish that the restaurant's issue is resolved.

---

## 5. Real capability-aware routing and manual override

Implement the spec's `decideRoute()` and dispatcher against the current adapter registry and Runtime
interfaces. Automatic choice considers enabled and runnable adapters, available model controls,
required capabilities, authority, permitted destinations and billing class, and budgets. Installed
binaries or populated catalogues alone do not establish executability.

Use current runnable adapters, even if only one is available. Do not hard-code "all non-Codex
engines unavailable" if a newer adapter has landed; equally, discovering another engine is not
permission to pretend it runs.

An explicitly unavailable route may remain a saved preference, but its task must show a precise
unserved or blocked reason and a route-change action. Never mark it Working without execution, and
never silently substitute another provider, account, billing class or sample model. Auto excludes
unsupported routes rather than choosing them and simulating progress.

Preserve automatic routing and explicit overrides in the same selection contract, with automatic
visible as the default and manual override reachable from the same control. Define precedence
between task overrides, thread settings and workspace defaults from the spec and current code. Keep
requested, admitted/effective and runtime-reported choices distinct in the evidence, and never
identify the executing model from its own prose.

Model identity includes its runtime and provider route, not only a slug. **Preserve provider-specific
effort ladders, defaults and mode ceilings; never normalise them into one universal scale.** Explain
a policy-constrained effective choice rather than silently rewriting the request.

Selection is not authorisation. Moving to Ready or pinning a model never approves unrestricted
egress or subsequent changes; exact Need approval, authority at dispatch, result acceptance and
effect, cancellation and budgets stay in the existing path.

Stage movement follows actual events: accepted pickup or start, active work, an outstanding
approval, a blocked prerequisite, verified completion. Do not drive every task through every column
on a timer. Preserve current completion guards for outstanding Needs and Changes. A mid-run override
applies through a supported steering boundary or the next run; it must not mutate an admitted
request invisibly.

---

## 6. One selection control, built from the picker as it now stands

`client/console/Picker.tsx` already exists, reads live catalogues, and **was changed this morning** —
it now has a `shortLocation` helper and a containment-safe menu (see §2's table). Adapt *that*
control into the shared app selection control. Do not start again from the website or an HTML
prototype, and do not revert its containment rules.

The reported white selector is the native recipient `<select>` in `client/console/TeamView.tsx`,
whose default reads "Diomedes routes it." That chooses a *recipient*; engine/model/effort selection
chooses an *execution route*. Reuse themed interaction primitives without conflating those meanings
or changing mailbox delivery semantics.

**The website is not a design source for this app, and this is the section where that mistake would
happen.** `F:\Achilles\diomedes-site` (diomedes.net) is a separate Astro repository holding a
*marketing rendition* of this app's language: "living chrome" (`src/components/chrome/Spine.astro`,
`Wake.astro`, `CommandPalette.astro`, branch `muse/living-chrome`, commit `33b8835`) and the demo
scripts `model-picker.ts`, `menu.ts`, `mode-rail.ts` and `console-frame.ts` driven by a hardcoded
`src/data/engines.ts`. Those files were built to *look* like Diomedes on a landing page. **They are
not Diomedes, they are not the authority for any control, and none of them is to be ported.** When
this brief says "preserve the app/site shared selection semantics and visual tokens", it means the
shared *meanings* and *token values* — not shared implementations, not the site's component tree,
and not its sample catalogue. The app's controls live in `client/console/` and answer to
`05-instrumented-density-prototype.html`. If you find yourself reading Astro under
`diomedes-site/` to decide how an app control should look or behave, stop.

Build one `Menu` component from the picker's `.pmenu` rules and use it for **all three** native
`<select>`s in the app (`TeamView.tsx`, the Fix "what is failing" select in `Composer.tsx`,
`Workspace.tsx`). The stepped, animated reasoning rail is built on that `Menu`, so build the `Menu`
first. Preserve the app/site shared selection semantics and visual tokens without forcing a
framework migration, a custom-element platform or a marketing-site dependency; the website's sample
catalogue is not the desktop's operational authority.

Where the spec extracts derivations into `buildSelection`, first preserve existing valid behaviour
and appearance, and separate deliberate behavioural improvements from the extraction so a refactor
cannot quietly change routing, defaults or capability handling.

The desired interaction is a theme-aware anchored surface, clearly grouped choices, a readable
selected state and a stepped reasoning rail. In Field it uses graphite, thin rules and sparse
semantic cyan; the selection point moves between real supported detents. Offer thinking on/off, or
no effort control at all, when that is what the adapter exposes. Keep automatic selection and manual
pinning visibly distinguishable, with a clear return to Auto.

Preserve every shipped theme, keyboard navigation, accessible selection state, Escape and focus
return, usable hit targets and responsive menu positioning. **Menus and rail labels must not be
clipped by a board lane, inspector, zoom or window edge** — and note the general rule now in
`AGENTS.md`: any flex or grid child that can carry a machine string gets `min-width: 0` and a
truncation or wrapping policy where it is written. Do not shrink controls into illegibility to fit
six columns; reflow the layout while keeping every stage accessible.

**Accessibility correction:** `tests/ui.spec.ts` checks for active motion *after* setting
`reducedMotion: 'reduce'`. It does not prohibit normal-mode animation. Preserve that guarantee: the
rail may animate normally and must become immediate under reduced motion. Do not blanket-exempt
monospace text or disable UI tests to copy 11 px prototype labels; if compact secondary
instrumentation is required, scope its typography contract and test narrowly while retaining
hit-target, focus, contrast, zoom and reduced-motion checks.

Keep the approved flat surfaces, wordmark, contextual inspector, Ctrl+K and Living Thread movement.
**This task is not another redesign or website overhaul.**

---

## 7. Import Connections as a consumer of the reconciled host

Import only the frozen additions identified by `IMPORT-MANIFEST.json`, plus the manifest and
required documented dependencies. Exclude junctions, scratch profiles and logs, credentials and
machine configuration. Preserve the original evidence and distinguish it from new integrated
evidence.

The source proof already contains reviewed manifests, scoped instances, typed observations, signed
ingress, durable inbox receipts, rules and proposals, fixture adapters, OpenAPI candidate generation
and a fixture UI. Reuse those pieces. Its reported 537-test run was on a different tree from the
newer Runtime/Trust continuation; neither report proves the merged build.

Bind the consumer to the final current-authority and reference interfaces, including
`currentAuthority` and `refOf` where those remain the actual exports. Register once per
`HarnessHost`, integrate recovery after Store and host initialisation, and keep exclusive recovery
ownership. Preserve the exact-once local receipt and effect semantics actually supported, without
claiming universal exactly-once provider delivery.

Wire the feature into normal app navigation and appropriately authorised app endpoints — your
worktree already adds a `Connections` view to the rail, `client/console/types.ts` and `Shell.tsx`,
which is the right shape. Keep the credential-free source adapter visibly labelled as sample or
fixture data. Reuse the existing shell, settings and permissions, and evidence surfaces rather than
mounting a second application alongside Diomedes. Its skin follows the Field register in
`AGENTS.md` §2, not a new one.

The proof's synthetic principal, client header and ephemeral HMAC secret are test facilities, not
production identity or a credential vault. Production authority remains host-resolved and
deny-by-default. Do not ship a normal-app route that trusts a renderer-supplied principal or enables
fixture authentication silently.

Consume the finished Trust and account work where available; do not choose a competing account
backend or migrate provider credentials. If a required authority seam remains unfinished, keep that
dependent operation visibly gated, retain the explicitly isolated fixture path for tests, and report
the exact partial capability. Do not substitute synthetic authority to obtain a green end-to-end
claim.

---

## 8. Preserve the proof's rules, semantics and security boundaries

Retain one generic versioned rule vocabulary with scoped selection, deterministic deny policy,
natural-language proposals, exact-digest adoption, replay and provenance. Distinguish standing
guidance, triggered correction, pre-effect enforcement and postcondition checks in both UI and
evidence.

The current proof supports a bounded subset of natural-language threshold and external-write rules.
Do not present it as arbitrary workflow generation. Proposals remain inactive until authorised
adoption; stale approvals cannot activate changed content or re-enable a newer disabled rule.
Guidance and learned preferences cannot expand authority.

Reuse the scoped investigator role and only its approved tools and resources. Preserve mandatory
policy before optional hooks. A whole-response `ModelAdapter` does not prove token-stream
interception; do not claim OMP-style stream interrupts on unsupported integrations. Full automatic
learning and adoption remains deferred; proposal, replay and adoption history is useful without it.

Maintain these Connections behaviours through integration:

- Signature validation, durable acknowledgement, bounded inbox, conflicting-duplicate refusal,
  out-of-order handling, and stale/conflict reconciliation.
- One durable manager Task per source condition, carrying location, timestamps, quantities or
  unknowns, threshold and rule provenance; receipt replay duplicates neither Tasks nor History.
- Current authority and revocation-generation checks at admission, invocation and result acceptance.
  Reconnect invalidates stale runs and requires a fresh source observation.
- Group freshness based on the **oldest** required approved location refresh, not the newest.
- Fail-closed capacity behaviour rather than evicting receipts to appear healthy; no claims of an
  always-on monitor from this local slice.

Preserve the documented Toast sample semantics: `IN_STOCK` means available with untracked quantity;
`OUT_OF_STOCK` means unavailable without an invented quantity; a valid `QUANTITY` is the reported
number; unknown stays unknown. This is menu and modifier availability, not physical ingredient
inventory. A documented selected-item POST may be a read; effect classification is not inferred from
HTTP method alone.

All Toast data, credentials and events in this proof are synthetic. Keep authenticated Toast
transport, account eligibility, public HTTPS webhooks, subscriptions, polling and hosting,
consequential external writes and full issue-resolution policy outside this integration slice. The
inactive OpenAPI GET candidate generator stays offline and review-required, with no approved origins
and no arbitrary generated-code execution.

---

## 9. One surface: the Workbook retires into the Console

**Decided by Andrew on 2026-09-09.** Record: `docs/implementation/2026-09-09-one-surface.md`. Read it
before you plan any UI. It is settled and not open for re-litigation.

- **Every new feature is Console-only, from today** — the triage column, the routing controls,
  Connections, the harness surfaces. If a feature seems to need a Workbook screen, it needs a
  Console screen instead. Your worktree's `client/Workspace.tsx` additions are the last Workbook
  work; bring them across rather than extending them.
- **No further re-skin passes on the Workbook's half of `client/styles.css`.** Two have already
  failed, because the mismatch is structural: `styles.css` sets a 14 px body and a 36 px minimum on
  every control, and `tests/ui.spec.ts:409-413` asserts that floor on Home, while the Console runs
  13/12/11 px under a 0.95 zoom.
- **Port order, one page per pass:** Review (your `HarnessProposal` needs a Console home anyway),
  then Documents, History, Home. **Settings stays.** The reading face (IBM Plex Serif) survives
  where reading actually happens: documents and plans.
- Only after the port do the F17 floor tests and `Workspace.tsx` go. Until then the Workbook keeps
  working and keeps its tests passing.
- "Guided" becomes a density of the Console, not a second UI. **The definition is still Andrew's
  call** (Appendix). Proposal on the table: a wider measure, the instrument line and the Activity
  column hidden, plainer captions, the mode strip kept. Do not assume more than that.

Two further Console items belong to you once your branch has landed, both currently mounting
Workbook chrome:

- **The preview sheet.** `Shell.tsx` opens the Workbook `Modal` (2 px cyan top, Workbook buttons)
  for the proposal preview, now also carrying your `HarnessProposal`. Replace it with a Console
  sheet in the Field register.
- **Markdown in Diomedes turns.** `ThreadView.tsx` splits replies on blank lines, so a Codex answer
  containing a code fence renders raw backticks. The Workbook already has a `Markdown` renderer in
  `Workspace.tsx`; move it to `client/markdown.tsx`, use it for `diomedes` turns, and render fences
  in the 13 px mono register. This is the defect that embarrasses the app first in a demo.

Apply the copy doctrine in `00-fable-advisor-opinion.md` §3 to any string you add: Diomedes says a
thing once, and does not narrate its own state when a point or a record already shows it. Its
28-row rewrite table is **pending Andrew's approval** (Appendix) — do not apply the table wholesale
yet, but do not add new sentences that violate the doctrine either. §4 of the same report lists
fifteen ranked small-surface defects; the ones inside your files are yours to fix as you pass
through them, and the rest are backlog.

---

## 10. Gates and evidence

Run these on the merged tree, before every merge to `main`, with ports 5174 and 47632 free and no
other agent verifying at the same time:

```
npx tsc --noEmit
npx vitest run
npx vite build
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
```

`tests/native-ui.spec.ts` asserts that `dist/` is newer than `shared/types.ts` and fails with
"dist is older than …" if you skip the build — **run `npx vite build` before Playwright, every
time.** The current baseline is tsc clean, 483 vitest, 26 Playwright; report your actual final
counts and source identity, never a sum of historical suite totals.

Use focused tests for the changed contracts and run the relevant existing suites against the final
integrated source. Keep the prior Runtime/Trust/Usage/package corrections intact. A passing source
fixture is not browser, Electron, authentication or installer proof.

Cover the important failure boundaries:

- A manually created task persists in Triage without starting; a deliberate Ready release starts one
  eligible run.
- Duplicate release, concurrent pickup, restart, stale commands and route-change races create no
  duplicate starts or effects.
- Team and thread behaviour remains intact, while connector tasks follow their own explicit release
  policy.
- Every relevant state projection and MCP view treats Triage as non-terminal and non-running.
- Auto, pinning, defaults, capability changes and unsupported routes display and behave honestly.
- Real progress, approval and rejection, cancellation, blocked recovery and verified completion
  agree across Thread, Board and Team.
- Connections ingress, replay, crash, revoke and rule adoption/replay still satisfy their original
  invariants after integration.
- Missing or stale authority fails closed, without breaking startup or reviving saved rights.

Exercise the picker and the six-stage board at 1280, 1366, 1536, 1920 and 2560, plus a narrow
supported layout, with interface scaling and reduced motion. **Inspect rendered screenshots and
element bounds, not only document `scrollWidth`,** which misses content hidden by clipping — that is
exactly how the picker overflow survived until a user reported it. Verify keyboard access, task
text, controls, popup edges and existing Usage and navigation behaviour.

The combined credential-free demonstration should run through the ordinary app where its real local
authority contract permits: authorise a scoped sample connection, invoke a read, ingest a signed
sample event, inspect the single resulting task and its evidence, release it, inspect or override
its route, execute permitted work, and exercise interruption, replay and revoke. Keep the business
issue's lifecycle separate from completion of the inbox run.

Separately prove dispatch through an actual supported provider using only the existing authorised
opt-in smoke path, synthetic input and bounded usage. No new billing route, credential copying or
bypass around Trust. Clearly distinguish scripted-adapter tests from a genuine provider run. If live
verification is blocked, name the blocker and the resulting unverified claim instead of relabelling
a fixture as a real run.

Rerun failures to diagnose them, not until one green attempt can replace the history. The
Connections handoff disclosed timing-sensitive admission tests; preserve those reports and establish
concurrency preconditions deterministically rather than weakening assertions.

---

## 11. The Windows deliverable, and the contract the website is waiting on

Once the integrated source is ready, build in your owned workspace using the current packaging
pipeline. Inspect build and postbuild behaviour first: `npm run package:desktop` is `npm run build`
plus its postbuild and **overwrites that checkout's release directory**. Packaging requires
`Diomedes.exe` to be closed, never runs in two checkouts at once, and — for anything Andrew will
click — runs from `main` only, so every exe is a commit you can name. Do not package from another
owner's worktree or replace Andrew's running installation or profile.

Produce the complete distributable: a working portable package or ZIP with the executable and its
required resources, or the existing supported installer. **A bare Electron executable without its
supporting files is not the download artifact** — the 246 MB `Diomedes.exe` alone does not run.

Test the packaged app with an independent disposable profile, from a relocated directory where it
cannot rely on the source checkout, a development server, source fixtures or build output. Exercise
the new task and picker flow and the integrated Connections sample as far as its stated authority
boundary permits, plus the existing approval, restart and History behaviour. Confirm startup and
owned-process cleanup.

Record artifact path, version and build identifier, source commit plus any uncommitted-source
digest, SHA-256, size, build time, signing status and the exact tested capabilities. Keep fixture,
live-provider, packaged and authenticated-user evidence separate. An unsigned local preview must be
labelled honestly.

**The website side is a strict contract, and it is the thing that makes `/download` go live.**
`diomedes-site/src/data/releases.ts` holds the release record; `/download` renders whatever state
that record is in, and its `validate()` runs in Astro frontmatter, so a bad record fails
`npm run build` rather than shipping. It refuses plain http, hosts outside `github.com` and
`objects.githubusercontent.com`, `/latest` redirects, a url whose tail disagrees with `filename`, an
extension that disagrees with `kind`, a filename lacking the version, a hash that is not 64
lowercase hex, a non-positive size, and signed-without-publisher. The SHA-256 must be **of the
artifact** — an `app.asar` hash is not interchangeable. Publishing the record also arms four skipped
Playwright tests that fetch the bytes anonymously and check size and SHA-256. `astro check` needs
`NODE_OPTIONS=--max-old-space-size=8192` on this machine or Node OOMs during typecheck.

So: write a factual release handoff carrying complete artifact identity, requirements, installation
method, known limits and capability statuses, and leave the record edit, deployment and website copy
to their owner. Provide a public URL only if a verified publication already exists. Keep "automatic
triage" as the feature name. Code signing is Andrew's decision, not yours.

---

## 12. Finish with a usable result and a continuation record

Do not stop after rewriting a plan. Continue through implementation, integration, tests and Windows
packaging wherever prerequisites permit. Keep a concise local continuation record — write it to
`planning/2026-09-09-advisor/02-astra-log.md` — so a context boundary does not lose source
identities, decisions, remaining work or artifact locations.

The final report should identify:

- What now works in the ordinary app, what is fixture-only, and what remains blocked or deferred.
- Which spec and proof assumptions required reconciliation against current source.
- Files, commits and the Runtime/Trust snapshot integrated, plus what the merge with `main` moved.
- Test commands and results, actual live-provider evidence, screenshots and packaged smoke evidence.
- Exact executable and distributable location, hashes and launch instructions.
- Separate source-publication, CI, packaging, installation, signing and public-release statuses.
- ROADMAP IMPACT and the next smallest remaining slice.

Reconcile roadmap status without overwriting newer work. Use revision-safe cloud edits only when
available and authorised; otherwise leave a precise proposed patch and say the cloud copy was not
changed. This work advances existing milestones; neither the Connections fixture nor the first
dispatcher establishes the full future Diomedes supervisory agent or completes the genuine M5
workflow by implication.

---

## Appendix — open decisions, Andrew's alone

Do not choose these. Do the work that does not depend on them and say which items you parked.

1. **What "Guided" means** as a density of the Console (§9). Proposal: wider measure, instrument
   line and Activity hidden, plainer captions, mode strip kept.
2. **The copy doctrine and its 28-row rewrite table** (`00-fable-advisor-opinion.md` §3) — approve as
   written or edit. A voice belongs to one person; apply it, do not set it.
3. **The approval's verbs.** Today: `Go ahead` · `Go ahead for this whole task` · `Don't do this` ·
   `Show me first`. The advisor argues for three, with the task-wide grant living on the thread's
   policy control instead of on every need, and `Show me first` renamed because it collides with
   that control's identical label. Playwright pins the current names.
4. **Minimum window width** (`desktop/main.mjs` `minWidth: 800`) versus the 860 px breakpoint in
   `console.css`, which hides the rail, ledger, picker, Settings and Ctrl K with no way back.
5. **Palette row click.** Today a row click runs its first action (`Palette.tsx`), so a stray click
   on a Ready row can start a run. Select-then-Enter is safer.
6. Anything that deviates from `05-instrumented-density-prototype.html`. The prototype is the design
   authority; every deviation is approved by name, never discovered in a diff.
