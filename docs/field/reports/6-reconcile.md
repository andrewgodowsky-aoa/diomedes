# 6 — reconcile Astra's work with the Field

Branch: `field/density-20260908`. This pass was dispatched to Muse against
`brief-6-reconcile.md`. Muse landed the record's type and colour
(`client/components.tsx`, `client/styles.css`, `client/console/console.css`)
and ran tsc, vitest and vite build clean, then wedged: forty-one minutes with
no output and no CPU, after killing its own dev server. Fable stopped it,
verified what it had landed, finished the remaining two items, and ran the
gates. This report is Fable's, written in the pass's place.

## What Astra added that a person can see

Walking `git diff 218f325..0ad3951 -- client/ shared/types.ts`, the whole
visible surface is one component and its mount points. There are no new
screens, no new Settings rows, no new buttons except one that Astra *removes*
conditionally.

1. **`ApprovalStatus`** (`client/components.tsx`) — the decision record: an
   outcome sentence, a `<details>` "Decision record" and a `dl.facts` of four
   digests. Before a receipt exists it is a single line instead ("This OK
   covers only this proposal. Expires …").
2. **Its mount points** — the `Notice` block, the History entry, the work
   session and the preview Modal in the Workbook; the thread and the preview
   Modal in the Console, both put there by pass 6a.
3. **"Go ahead for this whole task" hidden** when `need.approval` exists —
   in `Notice`, in the Workbook's task actions and in both preview Modals. An
   absence, not a new control; nothing to skin.
4. **The outcome sentence in the Workbook's toast** (`say(decided.execution
   …)`) — existing toast styling, nothing to skin.

Everything else in Astra's diff is `client/work-start.ts`,
`client/approval-decisions.ts`, `shared/types.ts` and the server: no
presentation.

## What was done to the record

`.approval-status` had no CSS at all. It now carries the instrument register,
one rule set in `client/styles.css` so both surfaces get it, with the Console
setting only its own rhythm (`margin`, `padding-left`) in `console.css`:

- a 1 px `--dm-rule` hairline at the left instead of a card, bubble or box;
- the outcome sentence in the UI face at 13.5 px `--dm-text-1`, preceded by a
  point — `--dm-signal` (amber) for `conflicted` and `not-applied`, `--dm-text-3`
  for `declined`, the live colour otherwise;
- "Decision record" as an 11 px mono uppercase tracked 0.08em summary that
  reads as a control and lifts to `--dm-text-1` on hover;
- the four digests as 11.5 px lowercase mono, terms `--dm-text-3`, values
  `--dm-text-1`, wrapping on `overflow-wrap: anywhere`;
- the pre-receipt line and the "Recorded by the local service at …" line in
  the same 11.5 px lowercase mono.

The `--dm-*` names are the bridged legacy names for the Field tokens, which is
what the rest of `client/styles.css` uses; same values, so every scheme holds.
The inline `style={{ overflowWrap: 'anywhere' }}` moved into the stylesheet.
Every sentence Astra wrote is unchanged, and no role, aria-label or test id
moved: `aria-label="Approval record"` and the "Decision record" summary text
are what `tests/native-ui.spec.ts` drives, and both still pass.

Small size lives here only. The Workbook's 14 px floor is enforced on Home,
and the record never renders on Home — it appears on a task, in History, on a
work session and in the preview Modal.

## Hard-coded colour and shadow audit

The brief asked for every hex, `rgba(` and stray `box-shadow` **that Astra
introduced**. Astra introduced none: its only CSS-bearing change was the
unstyled `.approval-status` wrapper. The grep did, however, turn up six real
violations left by this branch's own earlier waves, all of them the `field`
scheme's cyan or a light grey written literally, which is exactly the class of
bug that breaks Paper. Fixed here:

| file | was | now |
| --- | --- | --- |
| `console.css` `.pt.live` | `box-shadow: 0 0 4px rgba(63, 214, 223, .35)` | `color-mix(in srgb, var(--light) 35%, transparent)` |
| `console.css` `.record` point | `0 0 6px rgba(63, 214, 223, .6)` | `color-mix(… var(--light) 60% …)` |
| `console.css` `.turn.dio.live::before` | `0 0 6px rgba(63, 214, 223, .6)` | `color-mix(… var(--light) 60% …)` |
| `console.css` `.turn.you .body` | `color: #d3d9e0` | `color-mix(in srgb, var(--t1) 80%, var(--t2))` |
| `console.css` `.bar .send.ready:hover` | `background: rgba(63, 214, 223, .08)` | `color-mix(… var(--light) 8% …)` |
| `wake.css` live point | `drop-shadow(… rgba(63, 214, 223, .4))` and `box-shadow: 0 0 5px rgba(63, 214, 223, .4)` | `color-mix(… var(--light) 40% …)` |

`.turn.you .body` was the serious one: `#d3d9e0` is a pale grey, so on Paper's
white surface everything the person had typed was very nearly invisible.

Checked live in Paper on a background dev server: the wake point and its glow
are the paper teal, `.pt.live`'s shadow computes to
`color(srgb 0.054902 0.486275 0.52549 / 0.35)` and `.turn.you .body` computes
to a dark ink.

## Left alone, deliberately

- **`client/console/schemes.ts`** is the token *source* — the ten schemes'
  literal values. Hex belongs there.
- **`wake.css`'s `var(--t1, #e6e9ed)` fallbacks.** The second argument only
  applies if the token is undefined, and the tokens are always set. Harmless;
  they cost nothing to keep and a token change would not go stale through them.
- **Two shadows, not one.** `palette.css` has its sanctioned one; the package
  menu (`console.css` `.pmenu`) carries the same
  `0 24px 60px -30px rgba(0, 0, 0, .9)`. Both are black, which is right in a
  light scheme as well as a dark one, and the menu is a floating layer over
  content. Removing it is a design decision, not a reconcile; flagged, not taken.
- **The permission-explainer sentence** Astra's old Console showed for
  approval-versioned needs ("Each proposed file change needs its own exact
  OK."). The new thread head has no explainer line to hang it on; pass 6a
  recorded the same gap.

## Gates

Run by Fable on the finished tree:

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run --configLoader runner` — `Test Files 14 passed (14)` /
  `Tests 361 passed (361)`.
- `npx vite build` — `✓ built in 709ms`.
- `npx playwright test` — `25 passed (31.8s)`.

One earlier full-suite run reported `1 failed` on
`ui.spec.ts:596 Usage: chip, signal bar and Settings bars` with 5 not run.
That test passes alone (`1 passed (4.7s)`) and the next full run was
`25 passed`, so it was a run-order/port flake of the kind this branch has seen
before, not a regression.
