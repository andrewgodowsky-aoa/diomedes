# CD-05.R-1: independent client acceptance

A, `cdfc845`: **accepted with named fixes**. Fix CD05-R-01 before merge: keyboard interaction with a hover-opened panel must cancel pointer dismissal. The hover/click race, unmount cleanup, reserved pin eligibility and inert rail routing otherwise hold under source inspection. This is acceptance of the bounded client patch, not certification of browser behavior or release readiness.

B, `c53e116`: **accepted with named fixes**. Fix CD05-R-02 and CD05-R-03 before merge: remove the unavailable conversation's workspace-wide claim and preserve access to results at narrow widths. The props-only separation is sound; being unwired is expressly allowed. CD05-R-04 is a defensive note, not a normal project-creation failure. No rewrite or backend implementation is requested.

No P1 findings. P2 means should fix before merge; P3 is a note. Findings below are independently traced source behavior, not executed browser reproductions.

## Findings

### CD05-R-01 | P2 | A: keyboard interaction does not retain a hover-opened panel

**Claim:** Pressing anything inside the panel stops it following the pointer.

**Location:** `cdfc845:client/console/Everything.tsx:320`, `:378`, `:406`, `:441`; dismissal at `:258`.

**Observed result:** Only the trigger's click handler and the panel's `onPointerDown` promote `by.current` to `intent`. Focusing a row or pin only changes `active`; the keyboard handler only moves focus. Reproduction from these handlers: focus Everything with Tab, let the mouse hover open it, Tab into its active row, move to a pin and press Space, then move the pointer outside. No pointer-down occurred, so `by.current` is still `pointer`. The leave handler schedules `setOpen(false)` after 260 ms, removing the focused control. The same issue applies when a close timer is already pending as keyboard focus enters.

**Consequence:** Deliberate keyboard use, including pinning, can lose its panel and focus because of incidental mouse movement.

**Smallest fix:** Promote a hover-opened panel to intentional ownership on focus entering its controls, and cancel the closing timer there. Hover alone must still take no focus. Add the mixed pointer/Tab/Space scenario to the later browser checks.

### CD05-R-02 | P2 | B: unavailable home still claims the whole workspace

**Claim:** When the conversation cannot run, the composer is replaced by its reason and the page never presents itself as workspace-wide.

**Location:** `c53e116:client/console/diomedes-view.ts:82`, especially `:87`; `client/console/Diomedes.tsx:109`, `:121`, `:167`.

**Observed result:** With `scopeId = null` and any non-null `unavailable`, the textarea and controls correctly become the plain reason. However, `spineItems(projects, now)` always supplies the home row subtitle `The whole workspace`, and the component always passes that row to Rail. Availability never reaches that projection. This includes the empty-project case.

**Consequence:** The visible scope claim contradicts the explicit unavailable-state rule. A composer refusal does not retract the claim elsewhere on the page.

**Smallest fix:** Remove or replace the home row's unconditional subtitle with neutral conversation wording. This can preserve every existing function and prop signature; do not infer workspace-wide access from a null scope. Check the unavailable home with both zero and several projects.

### CD05-R-03 | P2 | B: result links disappear at the supported minimum width

**Claim:** The page remains keyboard reachable throughout at 800x600.

**Location:** `c53e116:client/console/Diomedes.tsx:246`, especially `:258`; `client/console/diomedes.css:102`. Inherited rules at `c53e116:client/console/console.css:1305` and `:1410`.

**Observed result:** Every `onOpenResult` control lives inside `aside.ledger`. The imported shared stylesheet sets every Console ledger to `display: none` at viewport widths at most 860px, and also at app-container widths at most 1100px. The new stylesheet changes the screen to one column at 860px but neither restores the ledger nor supplies another result control. At 800px, supplied results therefore have no visible or keyboard-reachable opener on this page. This conclusion follows directly from the selectors; no browser measurement is claimed.

**Consequence:** Narrowing the supported page removes a function, rather than only rearranging it. The shared container rule also hides results before this page's viewport breakpoint.

**Smallest fix:** Add a page-scoped narrow layout that keeps the same result controls reachable, for example a stacked, scrollable ledger, and account for both shared hiding rules. Keep the empty ledger free of placeholder copy and leave other screens' rules unchanged.

### CD05-R-04 | P3 | B: the 'all' sentinel relies on a narrower invariant than loading enforces

**Claim:** A real Project can never carry `ALL_PROJECTS = 'all'`.

**Location:** `c53e116:client/console/diomedes-view.ts:27`, `:94`, `:105`, `:110`; `client/console/Diomedes.tsx:198`. Supporting boundary: `c53e116:server/store.ts:51`, `:53`, `:374`, `:734`.

**Observed result:** Ordinary creation generates twelve hexadecimal characters, so it cannot generate `all`; a project merely named "all" is also harmless. However, Project's input remains a string, and the saved-registry validator accepts `all`. If such a saved project reaches these props, the home and project rows have duplicate keys/selection IDs, both select options have value `all`, and selecting either calls `onScope(null)`. The test checks a project named "all" with id `proj-1`, not this ID collision.

**Consequence:** An accepted saved/custom fixture ID can become indistinguishable from home. No ordinary UI path creating that ID was found, which keeps this a P3 note.

**Smallest fix:** Use a UI sentinel outside the persisted project-ID alphabet, preserving the helper signatures, and test an actual project id of `all`. Alternatively, document and enforce the narrower ID precondition at the caller. Do not silently rename persisted projects.

## Checks that held, and limits of acceptance

For A, `triggerClick(true, 'pointer')` returns `keep`, and `onTrigger` cancels both timers before promoting intent and moving focus into the already-open panel. A subsequent trigger click closes it. A click during the opening delay cancels that delay. Hover passes `false` to the focus helper; mouse-only pointer handlers leave touch opening on its existing click path. Intentional opening ignores pointer leave. Unmount clears both timers. Escape while open closes the panel and restores trigger focus only when focus was inside; blur out and outside mousedown still dismiss it.

A pending closing callback is not cancelled by every dismissal path, such as Escape. In the traced paths it only repeats `setOpen(false)`; a fresh trigger activation or mouse entry cancels it before reopening. No unmount timer leak or stale timer closing a newly intentional opening was established. Pending-hover Escape suppression and actual event ordering still need browser coverage.

Reserved eligibility is recalculated from `item.reserved`, independent of current pin membership (`Everything.tsx:365`), so unpinning does not remove Automations' ability to be pinned again. Unpinned, non-reserved Connections still has no pin. The unavailable Rail branch never calls `onDestination` (`Rail.tsx:109`). Its revealed reason has the exact ID named by `aria-describedby` (`:120`, `:128`); it is not an unrelated visual tooltip.

Using `aria-disabled` here is not itself a trap: the unavailable destination action is suppressed, while the focusable native button's click explains why. Native Enter/Space reaches that explanation handler. This does not prove how every screen reader announces the conditionally mounted status. The reserved flag also does not add Automations to Shell's default pin array; this patch supplies pin capability, while landing defaults remain a caller/wiring concern.

The search through `tests/*.spec.ts` found direct Everything openings in `tests/fd02-discovery.spec.ts:21` and `tests/fd03-readiness.spec.ts:21`: both click the exactly named trigger, then click a menuitem. The new keep-on-hover branch preserves that intended sequence whether hover wins first or not. No executed browser regression result is claimed.

For B, the four-file commit contains no fetch, persistence, message-ID generation or shared-signature edit. It takes existing Project and Turn records and emits callbacks. The three local restriction values match the owner decision; Build is absent. Empty turns generate no greeting. Empty results generate no heading, list or empty-state sentence; the empty layout aside remains. The page's own copy contains no model/vendor name. Dynamic records and destinations still require truthful caller projection.

The Mode captions at `Diomedes.tsx:52` match the recorded Automatic, Answer only and Plan only intent: existing authority still governs starting work. They are promises to be enforced by the later trusted contract and caller, not by this presentation component. The page cannot prove that enforcement; it does not widen shared Mode or bypass admission. No independent caption defect was established from the available contract evidence. The final CD-01 seam is not present in these two candidates and is not certified here.

The Enter handler passes `nativeEvent.isComposing` into `keyIntent`, which returns null during composition; Shift+Enter leaves the textarea's newline behavior intact. Actual supported-browser IME ordering remains untested.

The markup has one named navigation landmark, one named main and one named ledger aside, without a duplicate named enclosing section. Native controls remain in the keyboard path when visible, subject to CD05-R-01 and CD05-R-03. The new stylesheet uses theme tokens, changes no shared stylesheet, and does not reset column centering. Its two `.console .dio-screen` selectors are not literally prefixed by `.console.diomedes`, but a search found that class only on this page; no current cross-screen override was established.

The five supplied static boards were read as text, including `WorkingMythic.dc.html`, alongside the design-language record. The shared rail, work-column and ledger structure follows those boards. Sample greetings, workers, Needs and inspector results were not treated as data this props-only slice should fabricate. These boards are not browser proof.

## Independent commands and real results

Working directory for every shell invocation: `F:/Diomedes/diomedes-wt/core-agent-bot`.

- `./node_modules/.bin/tsc --noEmit`: exit 0, no diagnostics. The initial call returned running session 80240; polling that session returned exit 0.
- `./node_modules/.bin/vitest run tests/everything-hover.test.ts`: tried once, exit 1 before any tests loaded. Vite could not write `node_modules/.vite-temp/vitest.config.ts.timestamp-1789967697068-e633ec19161a6.mjs`, with `EPERM` (errno -4048). There is no independent passing or failing test-case count.
- Both checks ran at current HEAD `a528ca110934a42d47103b046b18d0922adfe091`, not on a checkout of either candidate. The five A files are unchanged between `cdfc845` and that HEAD. B was not typechecked or tested independently.
- The A worktree was clean before writing this report. B was clean at `c53e116d31d2461c646a4c91b979af589ba2c8e3`, with no diff in its four candidate files.
- A's actual immediate parent is `8fb3bf32d79e163b6e346126e94bb752cefa56dc`, a documentation commit after `dadb72d`. Its client patch is the named five files. B's immediate parent is `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`.
- The first Git batch targeting B failed ownership checks. Later reads used command-local `-c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page`; no Git configuration file changed. Exploratory searches also named nonexistent `server/fs.ts`, `server/util.ts` and bot-tree `client/console/diomedes.css`; their error output was not used as evidence. B's actual stylesheet was read from its commit.

The complete shell-command ledger is below. Read-only batches returned exit 0 unless noted above; this describes the batch result, not success of every intermediate search. Some broad read outputs were truncated, followed by narrower reads. The report was created with `apply_patch`, with no application edit.

## Integrator results, not independent results

As supplied in this work order: A, TypeScript exit 0 and 5/5 tests; B, TypeScript exit 0 and 25/25 tests. Those are the integrator's results.

The integrator additionally reports the live-app pointer scenarios at 127.0.0.1:5193: short pass, resting without focus movement, gap crossing, leave-to-close, hover then click, second click, clicking during the delay, and the 200px held-entry row. None was rerun or adopted as independent browser evidence here. Neither unit suite mounts these components; their counts do not establish event, focus, accessibility or CSS behavior.

## Deferred verification and delivery status

Once wired, a browser suite must establish actual 1440x960 and 800x600 layout, horizontal overflow with long names/text, vertical reachability, themes and zoom, focus preservation, mixed pointer/keyboard behavior, touch, IME composition, and assistive-technology announcements. It must also verify result opening, scope switching, unavailable-state transitions, greeting provenance, empty-ledger behavior and every existing Everything navigation flow.

Wiring and runtime evidence are required for startup selection, reserved-home filtering/provisioning, trusted restriction enforcement, message identity/retries, stop behavior, authority checks and correct conversation/result scoping. An unknown non-null scope currently falls back to the visible name "All projects" (`diomedes-view.ts:125`, `Diomedes.tsx:113`); the wiring must reconcile missing scopes explicitly rather than treating that text as a scope change. This review does not establish those runtime properties.

Repository mirror versions read: Pillars 2026-09-19.1, Roadmap 2026-09-19.2, Project Memory 2026-09-19.2. Pillar impact: the unavailable scope claim risks truthful scope presentation under P09; the source fix above resolves that presentation issue without changing authority. No pillar meaning or canonical document was changed.

Roadmap impact: no status changed and neither lane is declared shipped or complete. Build status: no build, full suite, browser suite or packaging was run. Publication and deployment: none. Only this review file is newly written and remains uncommitted and unpushed. Both candidate implementations remain untouched.

## Exact shell-command ledger

Batch 1:

```powershell
Get-Location; git status --short; git rev-parse HEAD; rg --files -g AGENTS.md -g '*DIOMEDES_CORE_PILLARS*' -g '*DIOMEDES_LIVE_ROADMAP*' -g '*DIOMEDES_PROJECT_MEMORY*'
```

Batch 2:

```powershell
Get-Content C:/Users/andre/.agents/skills/hostile-verifier/SKILL.md
```

Batch 3:

```powershell
Get-Content AGENTS.md; Get-Content docs/DIOMEDES_CORE_PILLARS.md; Get-Content docs/DIOMEDES_LIVE_ROADMAP.md; Get-Content docs/DIOMEDES_PROJECT_MEMORY.md
```

Batch 4:

```powershell
git show --format=fuller --stat cdfc845; git diff dadb72d cdfc845 -- client/console/Everything.tsx client/console/Rail.tsx client/console/Shell.tsx client/console/console.css tests/everything-hover.test.ts
```

Batch 5 (B ownership failure, exit 1):

```powershell
git -C F:/Diomedes/diomedes-wt/core-agent-page status --short; git -C F:/Diomedes/diomedes-wt/core-agent-page show --format=fuller --stat c53e116; git -C F:/Diomedes/diomedes-wt/core-agent-page diff dadb72d c53e116 -- client/console/diomedes-view.ts client/console/Diomedes.tsx client/console/diomedes.css tests/diomedes-view.test.ts
```

Batch 6:

```powershell
git show cdfc845:client/console/Everything.tsx | ForEach-Object -Begin { $n = 0 } -Process { '{0,4}: {1}' -f (++$n), $_ }
```

Batch 7:

```powershell
git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page show c53e116:client/console/Diomedes.tsx | ForEach-Object -Begin { $n = 0 } -Process { '{0,4}: {1}' -f (++$n), $_ }
```

Batch 8:

```powershell
rg -n 'Version|version' docs/DIOMEDES_CORE_PILLARS.md docs/DIOMEDES_LIVE_ROADMAP.md docs/DIOMEDES_PROJECT_MEMORY.md; Get-Content -Encoding UTF8 docs/implementation/2026-09-20-console-design-language.md; rg --files docs/implementation | rg 'core-agent|cd-0|CD-0'; rg -n -C 3 'Everything' tests -g '*.spec.ts'
```

Batch 9:

```powershell
git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page show c53e116:client/console/Diomedes.tsx | ForEach-Object -Begin { $n = 0 } -Process { '{0,4}: {1}' -f (++$n), $_ }
```

Batch 10:

```powershell
git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page show c53e116:client/console/diomedes-view.ts | ForEach-Object -Begin { $n = 0 } -Process { '{0,4}: {1}' -f (++$n), $_ }; git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page show c53e116:client/console/diomedes.css
```

Batch 11:

```powershell
Get-Content -Encoding UTF8 docs/implementation/2026-09-20-core-agent-work-items.md; rg -n 'Version|version' docs/DIOMEDES_CORE_PILLARS.md docs/DIOMEDES_LIVE_ROADMAP.md docs/DIOMEDES_PROJECT_MEMORY.md; git diff cdfc845 HEAD -- client/console/Everything.tsx client/console/Rail.tsx client/console/Shell.tsx client/console/console.css tests/everything-hover.test.ts; git show --no-patch --format='%H %P %s' cdfc845 c53e116
```

Batch 12:

```powershell
./node_modules/.bin/tsc --noEmit
```

Batch 13:

```powershell
./node_modules/.bin/vitest run tests/everything-hover.test.ts
```

Batch 14:

```powershell
Get-Content -Encoding UTF8 docs/product/2026-09-20-core-diomedes-agent.md; Get-Content -Encoding UTF8 docs/implementation/2026-09-20-core-agent-work-items.md | Select-Object -Skip 130 -First 120; rg --files F:/Diomedes/diomedes-wt/core-agent-page -g AGENTS.md; Get-ChildItem F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/agent-home/project | Select-Object Name,Length
```

Batch 15:

```powershell
git show cdfc845:client/console/Everything.tsx | Select-Object -Skip 400; git show cdfc845:client/console/Rail.tsx; rg -n 'project.*id|id:.*uid|id:.*uuid|function uid|export .*uid|slug' server/store.ts shared/types.ts server/paths.ts server/app.ts | Select-Object -First 110; rg -n 'frozen|signature|answer-only|plan-only|unavailable|workspace|CAPS|CD-05' docs/implementation/2026-09-20-core-agent-work-items.md; Get-Content -Encoding UTF8 F:/Diomedes/diomedes-wt/core-agent-page/tests/diomedes-view.test.ts
```

Batch 16:

```powershell
rg --files docs shared | rg 'interaction|core-agent-contract'; Get-Content -Encoding UTF8 server/store.ts | Select-Object -Skip 45 -First 18; Get-Content -Encoding UTF8 server/store.ts | Select-Object -Skip 360 -First 22; Get-Content -Encoding UTF8 server/store.ts | Select-Object -Skip 710 -First 48; rg -n 'identifier' server/fs.ts server/util.ts server/store.ts; Get-Content -Encoding UTF8 docs/implementation/2026-09-20-core-agent-work-items.md | Select-Object -Skip 240 -First 35; git diff --stat dadb72d cdfc845; git show cdfc845 --format= -- client/console/Everything.tsx
```

Batch 17:

```powershell
Get-ChildItem F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/agent-home/project -Filter '*.dc.html' | ForEach-Object { $_.Name; $boardText = Get-Content -Raw -Encoding UTF8 $_.FullName; $boardText -replace '(?s)<style.*?</style>', '' -replace '(?s)<script.*?</script>', '' }; Get-Content -Encoding UTF8 F:/Diomedes/diomedes-wt/core-agent-page/AGENTS.md | Select-Object -Last 20
```

Batch 18:

```powershell
Get-ChildItem F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/agent-home/project -Filter '*.dc.html' | ForEach-Object { $_.Name; $boardText = Get-Content -Raw -Encoding UTF8 $_.FullName; $boardText -replace '(?s)<style.*?</style>', '' -replace '(?s)<script.*?</script>', '' -replace ' style="[^"]*"', '' -replace '(?s)<svg.*?</svg>', '' }; rg -n -C 3 '\.work|\.col|\.instr|\.bar|\.ledger|\.turn|\.screen|\.stage|@media' client/console/console.css | Select-Object -First 380
```

Batch 19:

```powershell
git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page status --short; git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page rev-parse HEAD; git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page diff c53e116 -- client/console/Diomedes.tsx client/console/diomedes-view.ts client/console/diomedes.css tests/diomedes-view.test.ts; rg -n -i 'everything|ev-trigger' tests -g '*.spec.ts' -g '*.ts' | Select-Object -First 150; rg -n -C 3 'plan|only|nothing' client/console/Composer.tsx
```

Batch 20:

```powershell
Get-Content -Encoding UTF8 client/console/console.css | Select-Object -Skip 380 -First 54; Get-Content -Encoding UTF8 client/console/console.css | Select-Object -Skip 760 -First 60; Get-Content -Encoding UTF8 client/console/console.css | Select-Object -Skip 1295 -First 110; rg -n -C 2 'overflow-wrap|word-break|\.bar|\.instr|\.ledger.*sub|\.dio-screen' client/console/console.css client/styles.css client/console/diomedes.css; git log --oneline dadb72d..cdfc845; git show --format= --stat c53e116; Get-Content -Encoding UTF8 client/console/home.css | Select-Object -First 145
```

Batch 21:

```powershell
rg -n -C 4 '@media|\.rail|ledger' client/console/console.css | Select-Object -Last 150; Get-Content -Encoding UTF8 docs/DIOMEDES_CORE_PILLARS.md; Get-Content -Encoding UTF8 docs/DIOMEDES_LIVE_ROADMAP.md
```

Batch 22:

```powershell
Get-Content -Encoding UTF8 docs/DIOMEDES_PROJECT_MEMORY.md; Get-Content -Encoding UTF8 client/console/console.css | Select-Object -Skip 1428 -First 86; rg -n 'Diomedes|Home|loadInitial' F:/Diomedes/diomedes-wt/core-agent-page/client/App.tsx; git diff dadb72d cdfc845 -- client/console/Shell.tsx; rg -n -C 2 'pins|automations|togglePin' client/console/Shell.tsx
```

Batch 23:

```powershell
Get-Content -Encoding UTF8 docs/DIOMEDES_CORE_PILLARS.md | Select-Object -Skip 118; Get-Content -Encoding UTF8 docs/DIOMEDES_LIVE_ROADMAP.md | Select-Object -First 43; rg -n 'DEFAULT_PINS|pinned' client/console/Shell.tsx client/console/Home.tsx; git show c53e116:client/console/diomedes.css | ForEach-Object -Begin { $n = 0 } -Process { '{0,4}: {1}' -f (++$n), $_ }; rg -n -C 2 'container-name|container-type|container:' client/styles.css
```

Batch 24:

```powershell
git status --short; git rev-parse HEAD; git diff cdfc845 HEAD -- client/console/Everything.tsx client/console/Rail.tsx client/console/Shell.tsx client/console/console.css tests/everything-hover.test.ts; git show c53e116:client/console/console.css | Select-String -Pattern '\.console \.ledger|@media \(max-width: 860px\)|@container app \(max-width: 1100px\)' -Context 0,3; git show c53e116:server/store.ts | Select-String -Pattern 'PROJECT_ID =|id: identifier\(\)|typeof id' -Context 0,2; Test-Path docs/implementation/2026-09-21-core-agent-client-review.md
```

Batch 25:

```powershell
git show c53e116:client/console/console.css | ForEach-Object -Begin { $n = 0 } -Process { $n++; if (($n -ge 1290 -and $n -le 1313) -or ($n -ge 1404 -and $n -le 1415)) { '{0,4}: {1}' -f $n, $_ } }; git show c53e116:server/store.ts | ForEach-Object -Begin { $n = 0 } -Process { $n++; if (($n -ge 49 -and $n -le 54) -or ($n -ge 368 -and $n -le 378) -or ($n -ge 732 -and $n -le 736)) { '{0,4}: {1}' -f $n, $_ } }; rg -n 'dio-screen' client F:/Diomedes/diomedes-wt/core-agent-page/client
```

Final report/scope check:

```powershell
git status --short; git diff --check; Get-Content -Encoding UTF8 docs/implementation/2026-09-21-core-agent-client-review.md | Select-Object -First 58; $reviewText = Get-Content -Raw -Encoding UTF8 docs/implementation/2026-09-21-core-agent-client-review.md; if ($reviewText -match '[^\x00-\x7F]') { throw 'Review contains non-ASCII text' }; git -c safe.directory=F:/Diomedes/diomedes-wt/core-agent-page -C F:/Diomedes/diomedes-wt/core-agent-page status --short
```

