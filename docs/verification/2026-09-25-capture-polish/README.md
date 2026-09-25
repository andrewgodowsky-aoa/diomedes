# Capture polish verification — 2026-09-25

Evidence for the fixes to what the site's product captures of the sample bakery (Juniper Street
Bakery, 2026-09-24) showed wrong. Branch `feature/capture-polish`, from `origin/main` a36a98d.

Every `before-*` and `after-*` PNG is 1440x900 and was written by `tests/capture-polish.spec.ts`
with `CAPTURE_DIR` set to this folder: `CAPTURE_PHASE=before` on the unmodified a36a98d client and
composer, `CAPTURE_PHASE=after` on this branch. The spec runs the real host, Store and built
bundle in a throwaway data directory, with only the model scripted
(`BAKERY_ANSWERS` in `tests/fixtures/scripted-artifacts.ts`, text and numbers taken from the
captures). Each test saves its screen before it asserts anything.

The three `site-0.1.11-*` PNGs are the owner's original windows, copied unchanged from the site
repository (`docs/verification/2026-09-24-product-captures/` on its `origin/main`). They were
taken on the 0.1.11 demo build.

| Item | Before | After | Notes |
|---|---|---|---|
| 1. Raw asterisks | `site-0.1.11-saturday-staffing.png`, `before-1-saturday-staffing.png` | `after-1-saturday-staffing.png` | Already fixed on main by 837a426 (PR #72, in 0.2.0): the 0.1.11 reader had no emphasis span. `before-1` shows main already renders it. This branch adds emphasis inside bold, and tests for list items, table cells and a literal `5 * 3`. |
| 2. Chart x-axis labels | `site-0.1.11-nine-weeks.png`, `before-2-nine-weeks-chart.png`, `before-2-long-labels-chart.png` | `after-2-nine-weeks-chart.png`, `after-2-long-labels-chart.png`, `after-2-*-narrow.png` | The `-narrow` shots are the same answer in the column the open Files pane leaves. |
| 3. Board | `site-0.1.11-board.png`, `before-3-board.png` | `after-3-board.png`, `after-3-board-title-focused.png` | The focused shot shows the whole title on keyboard focus. The tasks are new, so the age reads `now`; its title says "Added just now". |
| 4. Brief title | `site-0.1.11-board.png` (the Files pane) | `after-4-6-weekly-brief.png` | Already fixed at the source on main by 837a426: `composeBrief` titles the brief `outputName(label)`. `before-4-6` shows main already writes "Weekly operations brief". The capture shows a brief file written by 0.1.11 and never rewritten. |
| 5. Acronyms | `before-4-6-weekly-brief.png` ("Pos weekly summary") | `after-4-6-weekly-brief.png` ("POS weekly summary") | |
| 6. Citation tags | `before-4-6-weekly-brief.png`, `before-6-answer-citation.png` | `after-4-6-weekly-brief.png`, `after-6-answer-citation.png` | |
| 7. Nine-weeks finding | `site-0.1.11-nine-weeks.png` | none | Investigation only; see the pull request. |
