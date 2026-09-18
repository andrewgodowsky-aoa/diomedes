# Design Center verification evidence — 2026-09-17 / 2026-09-18

An index of this folder, so a reader knows what made each file and what it shows. The run
notes, counts and measurements are in
`.superpowers/sdd/app-design-studio-plan/task-6-report.md`.

Branch `feature/app-design-studio-20260917`. Nothing here was merged, pushed, released or
deployed. Every run used a throwaway data directory created by the Playwright config; no real
profile and no installed copy of Diomedes was touched.

| File | Made by | Shows |
|---|---|---|
| `01-design-mode-selection.png` | `tests/design-studio-ui.spec.ts` D04 | Design mode selects a real button; the action log is empty |
| `02-preview-before-edit.png` | D05 | The preview on the applied theme, before any edit |
| `03-radius-edited-app-unchanged.png` | D05 | Radius changed in the preview; the app behind it unchanged |
| `04-website-target.png` | D06 | Compatibility stated, and how to start the Website Studio |
| `05-picture-placed.png` | D07 | An imported picture placed in the bust slot |
| `06-picture-round-trip.png` | D07 | The same picture after export and re-import |
| `07-texture-under-labels.png` | D08 | A texture never covering an approval control's label |
| `08-contrast-over-texture.png` | D09 | Every button state readable over the composited background |
| `09-refused-picture.png` | D10 | A file the app cannot read, refused in a sentence |
| `10-acceptance-open.png` | `tests/a6-acceptance.spec.ts` A6-01 | Step 1: one entry point, opening on the theme the app wears |
| `11-acceptance-select-without-running.png` | A6-02 | Step 2: selecting a real component without running it |
| `12-acceptance-edit-app-unchanged.png` | A6-03 | Step 3: the preview moves, the app does not |
| `13-acceptance-applied.png` | A6-04 | Step 4: Apply, with the Console not remounted and the draft message intact |
| `14-acceptance-picture-placed.png` | A6-05 | Step 5: a picture placed |
| `15-acceptance-picture-round-trip.png` | A6-05 | Step 5: the same picture after a `.diomedes-theme` round trip |
| `16-acceptance-website-target.png` | A6-06 | Step 6: the Website target |
| `17-acceptance-versions.png` | A6-07 | Step 7: the version list |
| `18-acceptance-after-reset.png` | A6-07 | Step 7: after the free reset |
| `19-narrow-window.png` | A6-08 | 900×700, nothing pushed off the side |
| `20-large-text.png` | A6-09 | Interface scale 1.5 |
| `21-reduced-motion.png` | A6-10 | Reduced motion: see the note below |
| `22-malformed-package.png` | A6-11 | A broken package refused in a sentence |
| `23-cross-scope-personal-list.png` | A6-12 | A business theme absent from the personal scope |
| `measurements.json` | `tests/a6-acceptance.spec.ts` | Responsiveness and idle cost, written by the run itself |

01–09 are rewritten by the ordinary browser suite. 10–23 and `measurements.json` come from the
acceptance pass, which is deliberately outside the suite and is re-run with:

```
npx playwright test --config playwright.acceptance.config.ts
```

## A note on 21-reduced-motion.png

Two different mechanisms, on purpose.

- **The app** obeys the computer's own setting. Under `prefers-reduced-motion: reduce`,
  `--dm-t-quick` at `:root` is `0ms` and the media block in `client/styles.css` kills every
  animation and transition with `!important`.
- **The preview stage** does not inherit the designer's own setting, because the stage shows
  what *someone else* would see. The designer asks for that reading with **Preview with
  reduced motion**, and the stage then reports `data-motion="reduced"`,
  `data-motion-preset="none"` and `--dm-t-quick: 0ms`.

A reader expecting the stage to freeze by itself will think this is a bug. It is not, and it
is written here so nobody has to re-derive it.
