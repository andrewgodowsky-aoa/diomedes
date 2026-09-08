# 1b — Diomedes mark + wake sequence

## Files

- `client/field/Mark.tsx` (new) — `Mark({ state, word, size })` and `MarkGlyph`.
  SVG geometry 1:1 with the prototype top strip: shaft line (5,3)-(5,21),
  blade path `M5 3 C 14 3, 18 7.5, 18 12 C 18 16.5, 14 20.2, 9 21`, circle
  (20.5,12,r=1.6) with `data-mark-point` so the wake can land on it. Strokes
  `var(--t1)`, width 1.6, round caps; point `var(--t2)`, `var(--light)` +
  2px drop-shadow when `live`, `var(--attn)` when `attn`. Wordmark
  "Diomedes", Schibsted Grotesk 400, 12.5px, uppercase, ls .32em, gap 12px.
- `client/field/wake.css` (new) — all mark (`.dm-mark` prefix) and wake
  (`.dm-wake*`) styles, 1:1 with the prototype `.mark`/`.wake` blocks.
  Every `var()` has a prototype-value fallback until the token pass lands.
- `client/field/Wake.tsx` (new) — the wake layer. Props
  `{ short, failed, projects, workers, reduced, onDone, onRetry }`.
- `client/field/useWake.ts` (new) —
  `useWake({ loaded, online, reduced, firstOpen })`.
- `client/App.tsx` (edited) — mounts `<Wake>` at the top of both returned
  trees (loading + main), driven by `useWake`; initial load factored into
  `loadInitial` so `onRetry` can re-run it. No other behaviour/markup
  changed.

## Timings (state-driven `setTimeout` chain + two CSS keyframe animations)

- Point: CSS `dm-gp` 400ms ease, 200ms delay. Thread: CSS `dm-th` 600ms
  ease, 500ms delay. Both run off the `.playing` class, as in the prototype.
- Letters: one `setTimeout` per letter at 1000+i*60ms flips that letter's
  `on` class (opacity 260ms); tracking .9em→.32em flips at 1050ms via the
  `resolved` class (900ms transition).
- Status (`role="status"`): 1200ms `recovering the field` (+ skip hint),
  1900ms `restoring context   N projects   M workers` (workers segment
  omitted when `workers` is undefined), 2600ms `field established`,
  3200ms end. Short form: letters pre-resolved, `restoring context` at
  200ms, `field established` at 1000ms, end at 1400ms.
- Reduced motion collapses every timer to 0ms, but `reduced` renders
  nothing at all unless `failed` (static failure layer, no animation).
- End: capturing `keydown` on `document` + `pointerdown` on the layer call
  end early (no-ops when `failed`). The guiding point translates into the
  centre of `[data-mark-point]` (420ms `cubic-bezier(.16,1,.3,1)`, fading),
  or just fades when no mark is mounted yet; the layer fades 320ms
  (+120ms exit delay, as the prototype `.gone`) then calls `onDone`.
  All timers/listeners are cleared on unmount or when the effect re-runs.

## Reconnect

After the first successful load, each `online` false→true transition shows
the short wake once (`short` latches true; the full form only ever plays on
first mount). `done()` only completes when `loaded` is true: an end that
arrives early sets a held flag, and the hide happens when the load lands.
A failed initial load (`!loaded && !online`) latches `failed`: last line
`field not reached` + plain "Try again" button → `onRetry` re-runs
`loadInitial`; the layer stays until the retry succeeds, then hides.
Under `navigator.webdriver` (Playwright) or `reduced`, `show` is false
except for the failed state. Only transform/opacity animate; no spinner;
the point never exceeds scale 1 except the landing.

## Could not do / deviations

- No pixel-level screenshot: this environment has no browser-screenshot
  tool, so the visual check was serve-level only (dev server on ports
  5175/47633 served `/` 200, the transformed `Wake.tsx` module contained
  the layer, `/api/settings` 200; server stopped afterwards). Fable/review
  should eyeball the 3.2s ceremony in Electron.
- `client/field/schemes.ts` appeared from a concurrent agent; untouched.
- Tokens are consumed, not defined (the other agent owns `:root`); the
  fallbacks in `wake.css` carry the prototype values until then.
- Hold edge case: if the sequence ends before `loaded`, `useWake` keeps
  the layer mounted until the load lands, but the layer has already run
  its 320ms fade (invisible chrome veil, pointer-events none) rather than
  holding the `field established` line visible. In practice the load lands
  in <1s against a 3.2s ceremony, so the hold never triggers.
- `dist/` was rebuilt via `npx vite build` to satisfy the native-ui spec's
  fresh-bundle gate (git-ignored, not part of this change).

## Test summary (exact lines)

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run --configLoader runner` — `Test Files 10 passed (10)`,
  `Tests 227 passed (227)`.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` —
  `16 passed` on the first run; `tests/native-ui.spec.ts` failed with
  `ENOENT: dist/index.html` (no production bundle in this worktree, fails
  before touching the app); after `npx vite build`, rerun:
  `1 passed`, i.e. all 17 green. The wake is skipped under webdriver, so
  timings are unaffected.
