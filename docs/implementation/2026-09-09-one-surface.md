# Decision: the Workbook retires into the Console

**Decided by Andrew on 2026-09-09.** This is the standing answer; it is not open for
re-litigation by an agent, and it changes what every later pass is allowed to build.

## The decision

Diomedes has **one surface**: the Console. The Workbook (`client/App.tsx`, `client/Workspace.tsx`,
`client/components.tsx`, and its half of `client/styles.css`) is **frozen today** and ported into
the Console page by page, after which it is deleted.

"For everyone" — the reason the Workbook existed — becomes a **density of the Console**, delivered
by defaults and copy rather than by a second UI.

## Why, so it does not get reopened

Two re-skin passes (wave 4B, then 7b) tried to make the Workbook look like the Console and neither
converged, because the mismatch is structural rather than chromatic. The two surfaces already share
every colour token; what differs is:

- **Register.** `styles.css` sets a 14 px body and a 36 px minimum on every button, input and
  select, and `tests/ui.spec.ts:409-413` asserts that floor on Home — every text node ≥ 14 px, every
  button ≥ 35.5 px. The Console runs 13 / 12 / 11 px under a 0.95 zoom. A re-skin has to beat the
  project's own test suite to win.
- **Page grammar.** `.workbook-layout` is a two-column grid with a fixed 440 px margin column;
  `.page-frame` floats the page 20 px inside the window. The Console is edge-to-edge hairlines.
- **Components.** Cards: `.notice`, `.dialog`, task cards, a raised composer with a serif textarea.
  The Console's canon has no cards.
- **Voice.** Captions on everything, "Diomedes …" sentences where the Console uses a verb.

The seam also ran *into* the Console: `ThreadView` mounted the Workbook's `Notice` card for the
needs-you moment, so the moment the app most needed to look like itself looked like the other
surface. That import is gone as of `8bc7d7f` (`client/console/Need.tsx`).

## What this means for anyone working in this repo

1. **Every new feature is Console-only, from today.** Nothing new is built on the Workbook —
   not the triage column, not the runtime/routing controls, not Connections, not the harness
   surfaces. If a feature seems to need a Workbook screen, it needs a Console screen instead.
2. **No further re-skin passes on `styles.css`.** Do not "bring the Workbook closer"; that work is
   superseded by the port.
3. **Port order:** Review → Documents → History → Home. **Settings stays** where it is.
4. Only after the port do `tests/ui.spec.ts:409-413` (the F17 floor checks) and `Workspace.tsx` go.
   Until then the Workbook keeps working and keeps its tests passing.
5. The reading face (IBM Plex Serif) survives where reading actually happens: documents and plans.

## Still open

**What "Guided" means as a Console density** is not yet decided. Proposal on the table, awaiting
Andrew: a wider measure, the instrument line and the Activity column hidden, plainer captions, the
mode strip kept. Nothing in the port should assume more than that until it is answered.

Background: `planning/2026-09-09-advisor/00-fable-advisor-opinion.md` §1 and §2.3. Handoff:
`planning/2026-09-09-advisor/01-astra-prompt.md`.
