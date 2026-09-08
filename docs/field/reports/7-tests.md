# Brief 7d — Restore the landing empty-state coverage (report)

Branch: `main`, checkout `F:\Achilles\diomedes`. No commit, no stash, no worktree touched.
Only source file changed: `tests/ui.spec.ts` (plus this report).

## 1. Verification done before accepting the premise

- `server/app.ts` contains **zero** `app.delete(` routes (grepped `app\.(delete|get|post)\s*\(`:
  43 matches, all `app.get` / `app.post`). So there is no `DELETE /api/projects/:id`,
  and deleting `field.spec.ts`'s project at the end is not available. Not attempted.
- `client/App.tsx` loads the landing list with `api<{ projects: Project[] }>('/projects')`,
  and `client/api.ts` prefixes `/api`, so the landing fetch is exactly
  `GET /api/projects` via page `fetch`. The `page.route('**/api/projects', …)` glob
  matches that URL and does **not** match the `**/api/projects/**` sub-routes
  (no trailing `/**` in the glob); the handler additionally guards with
  `new URL(request.url()).pathname !== '/api/projects'` plus a `GET`-only check,
  and calls `route.fallback()` for everything else.

## 2. Exact diff made to `tests/ui.spec.ts`

```diff
diff --git a/tests/ui.spec.ts b/tests/ui.spec.ts
index a35b17e..907bab1 100644
--- a/tests/ui.spec.ts
+++ b/tests/ui.spec.ts
@@ -72,12 +72,29 @@ test('F01-F02: first run resumes, chooses a surface, and opens the selected surf
   await expect(page.getByRole('heading', { name: 'Ready.' })).toBeVisible();
   await page.getByRole('button', { name: 'Open Diomedes' }).click();
   await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
-  // The empty-state prose only renders with no projects, and field.spec.ts sorts
-  // ahead of this file and leaves one behind in the shared data folder. Assert it
-  // where it is meant to appear rather than depending on the run order.
-  const landing: { projects: Project[] } = await (await page.request.get('/api/projects')).json();
-  if (landing.projects.length === 0)
-    await expect(page.getByText(/a project for a restaurant's menus, suppliers and schedules/)).toBeVisible();
+  // The shared data folder is not guaranteed empty by the time this file runs
+  // (field.spec.ts sorts first and leaves a project behind), so the empty state
+  // is asserted against an intercepted empty list rather than the live folder.
+  let emptyListServed = false;
+  await page.route('**/api/projects', async route => {
+    const request = route.request();
+    if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/api/projects') {
+      await route.fallback();
+      return;
+    }
+    emptyListServed = true;
+    await route.fulfill({
+      status: 200,
+      contentType: 'application/json',
+      body: JSON.stringify({ projects: [] }),
+    });
+  });
+  await page.reload();
+  await expect(page.getByText(/a project for a restaurant's menus, suppliers and schedules/)).toBeVisible();
+  expect(emptyListServed).toBe(true);
+  await page.unroute('**/api/projects');
+  await page.reload();
+  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
   const settings: Settings = await (await page.request.get('/api/settings')).json();
   expect(settings.detail).toBe('guided');
   expect(settings.surface).toBe('workbook');
```

Notes:

- The prose assertion is now **unconditional** — no `if`, no `skip`/`fixme`, no soft
  assertion, no `try/catch`.
- The `Settings` assertions (`detail`, `surface`, `permissions.changingFiles`,
  `explanations`, `onboarding.completedAt`) and the `resume` block run after
  `unroute` + reload, against the real service, exactly as before.
- Nothing else in `F01-F02` changed: every other `expect` is untouched, in order,
  with identical strings. (`Project` import is still used by later tests, so no
  import change was needed — confirmed by clean `tsc`.)
- `route.fallback()` is used (Playwright `^1.55.0` supports it; precedent for
  `page.route` interception exists in `tests/native-ui.spec.ts`).

## 3. Proof the assertion is live

### 3a. Negative control — deliberately broken string FAILS

Temporarily changed the regex to
`/a project for a restaurant's menus, suppliers and DELIBERATELY-BROKEN/` and ran
`npx playwright test tests/ui.spec.ts -g "F01-F02"`. Verbatim output:

```
Running 1 test using 1 worker

  x  1 tests\ui.spec.ts:55:1 › F01-F02: first run resumes, chooses a surface, and opens the selected surface (13.9s)


  1) tests\ui.spec.ts:55:1 › F01-F02: first run resumes, chooses a surface, and opens the selected surface

    Error: expect(locator).toBeVisible() failed

    Locator: getByText(/a project for a restaurant's menus, suppliers and DELIBERATELY-BROKEN/)
    Expected: visible
    Timeout: 12000ms
    Error: element(s) not found

    Call log:
      - Expect "toBeVisible" getByText(/a project for a restaurant's menus, suppliers and DELIBERATELY-BROKEN/) with timeout 12000ms
      - waiting for getByText(/a project for a restaurant's menus, suppliers and DELIBERATELY-BROKEN/)


      91 |   });
      92 |   await page.reload();
    > 93 |   await expect(page.getByText(/a project for a restaurant's menus, suppliers and DELIBERATELY-BROKEN/)).toBeVisible();
         |                                                                                                         ^
      94 |   expect(emptyListServed).toBe(true);
      95 |   await page.unroute('**/api/projects');
      96 |   await page.reload();
        at F:\Achilles\diomedes\tests\ui.spec.ts:93:105

  1 failed
    tests\ui.spec.ts:55:1 › F01-F02: first run resumes, chooses a surface, and opens the selected surface
```

The failure is at the new unconditional line, **after** the intercepted reload —
i.e. the empty landing rendered and the matcher ran against it. The test is live,
not vacuously green. (The string was restored immediately after; the diff in §2
is the final state.)

### 3b. Interception-fire proof

`expect(emptyListServed).toBe(true)` sits directly after the prose assertion: the
run only passes if the route handler actually served the empty list. All green
runs below therefore prove the interception fired on each run.

### 3c. Positive run (same filter, correct string) PASSES

```
Running 1 test using 1 worker

  ok 1 tests\ui.spec.ts:55:1 › F01-F02: first run resumes, chooses a surface, and opens the selected surface (2.6s)

  1 passed (6.0s)
```

## 4. Gate outputs verbatim

### `npx tsc --noEmit` → exit 0, no diagnostics

```
TSC_EXIT:0
```

(no compiler output at all)

### `npx playwright test tests/ui.spec.ts` → 16 passed, exit 0

```
Running 16 tests using 1 worker

  ok  1 tests\ui.spec.ts:55:1 › F01-F02: first run resumes, chooses a surface, and opens the selected surface (3.1s)
  ok  2 tests\ui.spec.ts:146:1 › F04, F06: sample project opens and a plan edit survives reload with History (944ms)
  ok  3 tests\ui.spec.ts:186:1 › F10: plan steps become real tasks with provenance and a History entry (963ms)
  ok  4 tests\ui.spec.ts:213:1 › F11-F13: work asks twice, decline skips creation, and the remaining change is recorded (5.1s)
  ok  5 tests\ui.spec.ts:256:1 › F15-F16: Review keeps the changed file and History exposes the recorded change (751ms)
  ok  6 tests\ui.spec.ts:271:1 › F07-F08: restore and Undo recover both versions; newer edits expose conflict choices (1.3s)
  ok  7 tests\ui.spec.ts:312:1 › F14: Stop settles a started sample promptly and expires its approval (1.0s)
  ok  8 tests\ui.spec.ts:327:1 › F17, F20-F22: surface switches preserve data; visible pages meet copy and layout checks (2.5s)
  ok  9 tests\ui.spec.ts:458:1 › Draft recovery: Settings, reload and same-named files in separate projects preserve writing and stale-save conflicts (2.2s)
  ok 10 tests\ui.spec.ts:554:1 › Services roster: every reported engine listed with switch discipline; Guided hides non-ready adapters; Console has no Connections (2.4s)
  ok 11 tests\ui.spec.ts:613:1 › Usage: chip, signal bar and Settings bars from the test-mode snapshot (704ms)
  ok 12 tests\ui.spec.ts:661:1 › Landing: ask box carries a draft into the chosen project (478ms)
  ok 13 tests\ui.spec.ts:701:1 › Verified helper: a helper turn shows its runtime caption (496ms)
  ok 14 tests\ui.spec.ts:711:1 › Engine choices: the list comes from the engine, and the levels follow the choice (620ms)
  ok 15 tests\ui.spec.ts:794:1 › Modes: the Workbook composer shows four modes and Fix needs what is failing (623ms)
  ok 16 tests\ui.spec.ts:844:1 › Enter sends from the Workbook composer and Shift+Enter adds a line (553ms)

  16 passed (26.4s)
```

### Full run `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` → 25 passed, exit 0

```
Running 25 tests using 1 worker

  ok  1 tests\field.spec.ts:102:1 › C01: the rail lists threads, carries New, marks the selection, and offers the three views (1.3s)
  ok  2 tests\field.spec.ts:122:1 › C02: the view switch swaps Thread, Board, and Team (456ms)
  ok  3 tests\field.spec.ts:137:1 › C03: the Board shows the Ready task, and Show-me-first confirms instead of starting (495ms)
  ok  4 tests\field.spec.ts:165:1 › C04: the palette finds and filters, Escape closes, and the Workbook keeps its own search (694ms)
  ok  5 tests\field.spec.ts:201:1 › C05: the wake is skipped under automation (392ms)
  ok  6 tests\field.spec.ts:208:1 › C06: the Ember scheme applies its package and token, then Field is restored (676ms)
  ok  7 tests\native-ui.spec.ts:115:1 › Native UI: consent, exact proposal preview, approval, Review and History with an injected generator (1.4s)
  ok  8 tests\native-ui.spec.ts:207:1 › Console task Start recovers both lost responses from state without duplicating Work (1.2s)
  ok  9 tests\native-ui.spec.ts:273:1 › Console exact approval recovers both lost responses from durable state even with task permission (1.0s)
  ok 10 tests\ui.spec.ts:55:1 › F01-F02: first run resumes, chooses a surface, and opens the selected surface (1.7s)
  ok 11 tests\ui.spec.ts:146:1 › F04, F06: sample project opens and a plan edit survives reload with History (851ms)
  ok 12 tests\ui.spec.ts:186:1 › F10: plan steps become real tasks with provenance and a History entry (920ms)
  ok 13 tests\ui.spec.ts:213:1 › F11-F13: work asks twice, decline skips creation, and the remaining change is recorded (5.0s)
  ok 14 tests\ui.spec.ts:256:1 › F15-F16: Review keeps the changed file and History exposes the recorded change (656ms)
  ok 15 tests\ui.spec.ts:271:1 › F07-F08: restore and Undo recover both versions; newer edits expose conflict choices (1.1s)
  ok 16 tests\ui.spec.ts:312:1 › F14: Stop settles a started sample promptly and expires its approval (960ms)
  ok 17 tests\ui.spec.ts:327:1 › F17, F20-F22: surface switches preserve data; visible pages meet copy and layout checks (2.2s)
  ok 18 tests\ui.spec.ts:458:1 › Draft recovery: Settings, reload and same-named files in separate projects preserve writing and stale-save conflicts (2.0s)
  ok 19 tests\ui.spec.ts:554:1 › Services roster: every reported engine listed with switch discipline; Guided hides non-ready adapters; Console has no Connections (2.3s)
  ok 20 tests\ui.spec.ts:613:1 › Usage: chip, signal bar and Settings bars from the test-mode snapshot (701ms)
  ok 21 tests\ui.spec.ts:661:1 › Landing: ask box carries a draft into the chosen project (478ms)
  ok 22 tests\ui.spec.ts:701:1 › Verified helper: a helper turn shows its runtime caption (496ms)
  ok 23 tests\ui.spec.ts:711:1 › Engine choices: the list comes from the engine, and the levels follow the choice (600ms)
  ok 24 tests\ui.spec.ts:794:1 › Modes: the Workbook composer shows four modes and Fix needs what is failing (623ms)
  ok 25 tests\ui.spec.ts:844:1 › Enter sends from the Workbook composer and Shift+Enter adds a line (537ms)

  25 passed (33.4s)
```

Note on the count: the brief says "expect 26+". The suite as it exists in this
checkout contains exactly **25** tests (6 field + 3 native-ui + 16 ui) — the same
25 recorded in `09-verify-features.md` §3 — and all 25 pass. There is no 26th
test to find; nothing was skipped. The full run also demonstrates the fix under
the real ordering hazard: `field.spec.ts` ran first (tests 1–6) and left its
project behind, yet F01-F02 (test 10) still asserted the empty state
unconditionally via the interception.

Port 5174 was checked before every Playwright gate (`Get-NetTCPConnection
-LocalPort 5174`): free before the first gate; only `TimeWait` leftovers from my
own just-finished run before the later gates (no listener — Playwright's
`reuseExistingServer: false` webServer started cleanly each time). No foreign
process was ever killed. No background dev server on 5203/47663 was started by
this pass (Playwright manages its own 5174/47632 webServer, which exits with the
run); post-run checks show no listeners on 5174/47632/5203/47663, only `TimeWait`
remnants.

## 5. Worktree state at report time (`git status --porcelain`)

```
M client/Settings.tsx
M client/Workspace.tsx
M client/styles.css
M evidence/screenshots/approval-console-record.png
M evidence/screenshots/approval-workbook-preview.png
M evidence/screenshots/work-admission-workbook.png
M tests/ui.spec.ts
```

- `tests/ui.spec.ts` — this pass's change (diff in §2).
- `client/Settings.tsx`, `client/Workspace.tsx`, `client/styles.css` — other
  passes' mid-flight edits; never opened for writing by this pass.
- `evidence/screenshots/*.png` — rewritten as a side effect of running the
  Playwright gates (the specs' own screenshot outputs; same side effect noted in
  `09-verify-features.md` §9). Left dirty, not reverted, not committed.

## 6. What was not done and why

- `npx vitest run --configLoader runner` and `npx vite build` were **not** run:
  they were only required as a fallback if port 5174 stayed busy. It never was,
  so the primary gates (`tsc`, `tests/ui.spec.ts`, full three-file run) were run
  instead. Nothing in this change (test-only) could affect either fallback gate.
- The `docs/field/reports/7-tests.md` path required creating a new file; per the
  brief this report is the mandated exception to the "only `tests/ui.spec.ts`"
  rule. No other file was written.
- No dev server on 5203/47663 was started: nothing in this fix needed manual
  browser exploration — the Playwright gates (which bring their own server on
  5174/47632) covered verification end to end.
