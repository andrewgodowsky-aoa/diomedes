# 5-tests — Console (`tests/field.spec.ts`) report

## Files changed

- `tests/field.spec.ts` (new, ~250 lines, 6 tests, serial).
- `playwright.config.ts` — one line: `testMatch` gained `'field.spec.ts'`.
- Nothing in the app changed. No commit.

## Setup helper (written once, used by every test)

- `test.beforeAll` (via the `request` fixture): `GET /api/settings` and keeps the
  whole object; `PUT /api/settings` (header `X-Diomedes-Client: 1`)
  `{onboarding:{resumeAt:'done',work:'business',detail:'technical',familiarity:'comfortable'},surface:'console',detail:'technical'}`;
  `POST /api/projects {"name":"The Console under test"}`; `POST
  /api/projects/:id/tasks {"name":"File the field notes"}` (`name`, confirmed in
  `server/app.ts`); `POST /api/projects/:id/threads {"name": ...}` for `Alpha
  thread` and `Beta thread`; `PUT` `{openProjects:[projectId]}`.
- `openConsole(page)`: `PUT {surface:'console', openProjects:[projectId]}` so the
  Console lands on our project deterministically, `goto('/')`, expects
  `.console` or the project card, clicks the card as fallback (the top-strip
  crumb path was never needed — the app reopens the last project), expects
  `html[data-surface="console"]`.
- `test.beforeEach`/`afterEach`: same `pageerror` guard as `ui.spec.ts`.
- `test.afterAll`: `PUT`s the exact saved settings object back (header
  `X-Diomedes-Client: 1`).

## The six tests

1. **C01 rail** — nav `Threads and views` shows `h2` Threads, a `New` button, the
   Alpha/Beta thread rows, and view buttons Thread / Board~ / Team~. Clicking
   Beta then Alpha moves the `.on` class (asserted with `/\bon\b/`, see below).
2. **C02 view switch** — Board button shows `.board[aria-label="Board"]` and
   `#scrThread` drops to count 0; Team button shows `.team[aria-label="Team"]`;
   Thread button brings `#scrThread` back.
3. **C03 board** — Ready column holds the API-created task with a `Start` verb.
   Policy radio `Show me first` clicked; `Start` opens the inline `.confirm`
   (`Hand to You?` with `Start` / `Not now`); `GET state` shows 0 sessions
   before and after (no run started); `Not now` closes the confirm. Column
   captions `Start hands it to its worker` / `waits on you` asserted visible
   after expanding compact (see below).
4. **C04 palette** — `Control+K` opens dialog `Find and act`; its search box
   (`Find a task, worker, model, project or action`) filled with `field notes`
   shows the Ready task, filled with `pause` removes it (count 0); `Escape`
   closes the dialog. Then surface `workbook` + reload: `Control+K` opens the
   Workbook's own `Open a project` dialog; surface set back to `console` +
   reload, `.console` visible.
5. **C05 wake** — after `.console` is visible, `navigator.webdriver` is `true`
   and `.dm-wake` has count 0 (matches `useWake.ts`: webdriver suppresses).
6. **C06 scheme** — Settings > Appearance, `Ember` radio: `dataset.package`
   polls to `ember` and `--light` polls to `#ff8a5b`; `Field` radio clicked at
   the end, package polls back to `field`, so later specs see the default.

Rules kept: role/accessible-name assertions only (class used solely for the
rail `.on` mark, where the code offers no aria state), no snapshots, no
`waitForTimeout`, no `test.skip`. Wall time for the file: ~8 s (limit 60 s).

## Selectors changed because the code differed from the brief

- **Rail `.on`**: the row class is `console-thread on`, so bare `/on/` also
  matches `console-thread` itself (`not.toHaveClass(/on/)` can never pass).
  Used `/\bon\b/` for both directions.
- **Board captions hidden by default**: the board mounts with `compact=true`,
  and `board.css` sets `.columns.compact .column .why { display: none }`. The
  test clicks the `compact` toggle first, then asserts the captions. Also
  `waits on you` needs `{exact:true}` — the Review empty state reads `Nothing
  waits on you.` and substring-matches otherwise.
- **Two `Start` buttons after confirm**: scoped the confirm assertions to
  `row.locator('.confirm')` (strict-mode violation otherwise).
- **`Show me first` exists twice in the app**: ThreadView head (`What Diomedes
  may do`) and Board head (`Board policy`); board radio queries are scoped to
  the board locator. Board's second radio is `Go ahead for tasks` (ThreadView's
  is `Go ahead for this task`).
- **Board/Team aria-labels nest**: `section.screen[aria-label="Board"]` wraps
  `div.board[aria-label="Board"]`; locators use `.board[aria-label="Board"]`
  and `.team[aria-label="Team"]`.

## Not covered (per brief, engine runs are out of scope)

- `Start` under `Go ahead for tasks` (would start a real run).
- Palette `pause` positive path (needs a working task, i.e. a run).
- Team lanes/messaging beyond the view switch (no members exist on a fresh
  project; the empty `No team yet` state was not asserted to keep the file
  inside the time budget).

## The trap: restoring settings is NOT enough — F01-F02 still fails

Proof run `npx playwright test tests/field.spec.ts tests/ui.spec.ts
tests/native-ui.spec.ts` (field sorts/runs before ui regardless of CLI order):

- The settings restore **works**: F01-F02 clicks all the way through the
  first-run wizard to `ui.spec.ts:75`, which is only reachable with onboarding
  unfinished.
- F01-F02 then fails at line 75:
  `expect(page.getByText(/a project for a restaurant's menus, suppliers and
  schedules/))` — that prose renders only when `projects.length === 0`
  (`client/App.tsx` projects page), and the failure DOM shows our row
  (`button "The Console under test 0 of 1 tasks done"`, `option "The Console
  under test"`). The mandated `POST /api/projects` persists in the shared data
  dir; there is no project-delete API, and the server holds the registry in
  memory, so file surgery would not unregister it either.

Smallest fix proposed (not applied — `ui.spec.ts` was not touched): in F01-F02,
gate the empty-state prose assertion on the project list being empty:

```ts
const { projects } = await (await page.request.get('/api/projects')).json();
if (projects.length === 0)
  await expect(page.getByText(/a project for a restaurant's menus, suppliers and schedules/)).toBeVisible();
```

(`Project` is already imported in `ui.spec.ts`.) Identical behavior on a clean
slate; tolerant of any earlier spec's leftover project.

## Exact verification output

- `npx tsc --noEmit` — clean.
- `npx vitest run --configLoader runner` — `Test Files 10 passed (10)`,
  `Tests 227 passed (227)`.
- `npx vite build` — `✓ built in 815ms`.
- `npx playwright test tests/field.spec.ts` — `6 passed (7.9s)` (C01–C06 ok).
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` (field not in
  the run) — `17 passed (26.6s)`: 16 in `ui.spec.ts`, 1 in `native-ui.spec.ts`,
  i.e. the pre-change counts.
- Combined run with `field.spec.ts` included — F01-F02 fails at `ui.spec.ts:75`
  for the leftover-project reason above; everything else passes.

Environment notes: each Playwright run orphans its `scripts/dev.mjs` children
(vite on 5174, service on 47632 survive the parent on Windows) — kill them
before the next run or the new run errors `.../api/settings is already used`.
One transient `Usage` chip failure in a long serial run passed on rerun and in
the clean 17-pass baseline; unrelated to this change (no app code touched).
