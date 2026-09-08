# 4a — Living Thread motion (field report, 2026-09-08)

One travelling point explains continuity between the thread, the board and the
team, plus the mode strip's spring. Nothing waits on motion: every destination
is live before the point flies, no caller awaits an animation, and Enter
triggers nothing.

## What changed

- `client/console/motion.ts` (new): `reducedMotion`, `travel`, `spring`,
  `anchors` (`threadAnchor`, `boardAnchor`, `teamAnchor`, `railAnchor`) and the
  `useTravelOnView` hook. Mechanics copied 1:1 from
  `05-instrumented-density-prototype.html`: per-kind `travelCount` (trips 5+ of
  a kind run at 160 ms without the landing pulse, nothing after 8), the
  mid-point arc, `EASE_ARRIVE = cubic-bezier(.16,1,.3,1)`, the `landed` class
  on arrival, `activeTravel` cancel. The traveller is one `span.traveller`
  appended to `.console` (falling back to `document.body`); centres resolve
  with `getBoundingClientRect` at call time; `travel` never throws and returns
  at once. `spring` is the prototype's k 210 / c 22 loop at 120 Hz.
- `client/console/motion.css` (new, imported by `Shell.tsx`): `.traveller`
  (fixed, 8 px, `--light`, pointer-events none, `left/top: 0` so WAAPI
  translates map exactly to viewport coordinates, z-index 4 — below the
  palette veil at 5, above everything else, winning ties with the toast by DOM
  order), `.pt.landed` (1.25 scale over 180 ms, transform only), and a
  reduced-motion block that hides the traveller and shortens fades to 120 ms.
- `Shell.tsx`: owns a `rootRef` on the `.console` div and calls
  `useTravelOnView(view, selectedTask?.id ?? null, rootRef)`.
- `ThreadView.tsx`: each Diomedes turn carries `data-thread-point`; the
  greeting does too when there are no turns.
- `BoardView.tsx`: `noteTravel` remembers the row point's rect and column
  before Start / Route to / Review; a `useEffect` on `tasks` flies the point
  to `[data-task-point=id]` in a `requestAnimationFrame`. The `arrived` fade
  is untouched.
- `Composer.tsx`: the ink line's position and scale run on WAAPI over
  `spring()` frames (`translateX()` on `.ind`, `scaleX()` on the line — scale,
  never width). A new mode cancels the running animation and springs from the
  current computed position (read before cancel). Instant placement on first
  paint and under reduced motion.
- `console.css`: removed only the two transitions motion.ts now owns
  (`.modes .ind`, `.modes .ind b`). The rail's `.spine .gp` keeps its CSS
  transition (a state change, not a trip).
- `TeamView.tsx`: deliberately untouched — `[data-focus-point]` already
  exists and the lane handoff traveller already appends inside `.console`.

## Anchor strategy

Where the selected thread's work lives on each screen: Thread → the latest
`[data-thread-point]` (last Diomedes turn, else the greeting); Board →
`[data-task-point="<focusTaskId>"]` (first row point when no task is focused);
Team → `[data-focus-point]` (the task point above the lanes). If a source
element is gone, the trip starts from the rail's `.spine .gp`.

## Pre-render capture

`useTravelOnView` keeps a ref updated on every commit with the current view's
anchor centre. When `view` changes, that ref still holds the old screen's
point (captured before React re-rendered); after the new view commits, one
`requestAnimationFrame` lets it paint then `travel`s old point → new anchor,
kind `screen`, 260 ms. Focus-task moves re-record the ref without travelling.

## Durations by kind

`screen` 260 ms · `start` 280 ms · `route` 420 ms (the one board handoff) ·
`review` 220 ms · mode spring settles under 300 ms · landing pulse 180 ms ·
arrival fades 160–180 ms (120 ms under reduced motion).

## What could not attach (plainly)

- Board travel fires only when the row actually changes column. The gate was
  earned the hard way: a failed Start (409, one run at a time) reloaded tasks
  and flew a phantom trip to the unmoved row. Motion must not lie about
  movement that did not happen.
- `route` (420 ms) is wired but does not fire with the current service:
  Route to only reassigns `assignedTo`, so the row stays in its column and the
  gate holds the trip. It will fly the day routing moves the row.
- `review` (220 ms) is wired but unreachable in the current flow: Review
  always navigates to the Thread (the `screen` trip covers that leg) and
  unmounts the Board, discarding the pending trip. It will fire if a review
  ever resolves to Done while the Board stays mounted.
- Verified live instead: Thread → Board → Team → Thread screen trips,
  a Start trip on a real Ready → Review column change, the mode-strip spring,
  and reduced motion (zero travellers, views still switch, state unchanged).

## Test summary

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run --configLoader runner` — `Test Files 10 passed (10)` /
  `Tests 227 passed (227)`.
- `npx vite build` then
  `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` —
  `17 passed (26.0s)` (16 ui + 1 native-ui). Two transient failures on the way
  were proven unrelated by re-run: a Usage-chip timeout under full-suite load
  (passes alone with and without this change) and a trace-file ENOENT during
  context teardown.
- Live instrumented check (Edge, dev server on 5185/47645, fresh data dir,
  MutationObserver counting `.traveller` insertions, zero page errors):
  Thread → Board 1 traveller, Board → Team 1, Team → Thread 1, Start on column
  change 1, mode strip `matrix(…, 10, 0)` → `matrix(…, 108, 0)`, reduced motion
  0 travellers with views still switching. Screenshots live outside the repo
  (`F:\Temp\andre\opencode\motion-4a\`); the dev server was stopped after.

Not committed, per instructions.
