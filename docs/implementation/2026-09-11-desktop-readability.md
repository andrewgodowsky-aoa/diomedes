# Desktop readability correction

## Diagnosis before implementation

Inspected the maximized live Windows desktop and its actual `resources/app.asar`,
then compared it with main. The running application is Electron 44, not Tauri or
WebView2. The package and current source differ substantially.

- The installed Console defaults to CSS zoom 0.95 when `interfaceScale` is absent.
  Its shell is 13px, several labels are 11px, and some activity labels are 10.5px.
  Thus 11px labels render at 10.45 CSS pixels before OS scaling. Current main
  already defaults to 1, but uses one 14px value for both body and caption roles.
- The installed work column is capped at 760px regardless of the space available.
  Main already raises it to 880px. Neither has independent wide-content policy.
- The installed Thread puts a permission note between the instruments and
  transcript. Its four-row grid assigns the flexible third row to that note,
  pushing the transcript down and creating a large empty region. Main already
  moves this note into the transcript. Preserve and test that correction.
- Electron's zoomIn/zoomOut/resetZoom menu roles operate Chromium zoom independently
  of Settings' persisted CSS interface scale. These controls can disagree.
- No viewport-dependent root font size, font-size in vw, or blanket transform was
  found. Existing media/container queries change layout. The visible regression
  is not evidence that maximizing itself changes the font size: small defaults,
  package drift, a narrow measure, and incorrect grid placement explain the live
  appearance. An independent native zoom state remains an additional risk.

The previous live screenshot is a Windows native capture; physical screenshot
dimensions alone do not establish the CSS viewport or devicePixelRatio. The
verification below must record those separately in the actual desktop runtime.

## Intended change

Keep the Field shell and font families. Introduce stable rem-based semantic roles:
16px prose/body, 15px input, 14px navigation/control, 13px caption, 12px metadata,
18px section, and 20px title at the standard 16px root. Use 1.5-1.55 prose leading.
Use a 920px ordinary work column with independently constrained prose and a wider
content measure for code/tables. Keep existing container-driven narrow layouts.

Retain `appearance.interfaceScale` as the authority, with visible 90%, 100%, 110%,
and 125% presets and preserved legacy/custom values. Ctrl+Plus/Minus/0 and desktop
View menu commands must use this same setting, not native WebContents zoom. CSS
zoom is only the explicit user's whole-interface preference, not the baseline
readability fix. No transform scaling, new provider route, or credential changes.

## Implemented

- Added shared semantic rem roles in `client/styles.css` and applied them across
  Console, Board, Team, Workbook, navigation, inspectors, settings, menus, dialogs,
  connections, wake/activity status and work views. Board task titles are 15px;
  Team messages are 16px. The Workbook composer mode strip uses four equal columns
  with 14px control text so its labels fit the narrow margin.
- The ordinary work measure is 57.5rem (920px), with 68ch prose and a 75rem wide
  measure. Removed older Workbook large-screen overrides that narrowed content.
  Existing Workbook code documents can grow; Thread has layout support for wide
  pre/table content but its current renderer still presents plain paragraphs.
  This patch does not add a rich-text renderer.
- Named Thread grid areas make header, instruments, transcript and composer
  placement explicit. Density and wider viewports do not reduce typography.
- Added a shared interface-scale stepping helper. Settings preserves existing
  custom values and exposes 90%, 100%, 110% and 125%. Renderer shortcuts and native
  View menu actions write the same appearance field. Repeated shortcuts serialize
  writes. Electron's independent zoom controls are replaced and native zoom stays 1.

## Verification

- Typecheck and Vite production build passed, including the final commit check.
- Full unit suite: 83 files passed, 1,403 tests passed, one skipped. Source:
  `test-unit-readability-serial.log`. Earlier parallel runs had timing failures in
  existing harness/backend tests; the complete serial run passed.
- Full UI suite after the final application changes: 52 passed. Source:
  `test-ui-readability-final.log`.
- The responsive matrix covers windowed 1440x900, 1920x1080, 2560x1440,
  3840x2160 at DPR 1, 4K-equivalent CSS viewports at DPR 1.5 and 2, 3440x1440
  ultrawide, 1024x768 laptop at DPR 1.25 and 800x600. Existing responsive cases
  also exercise 390px width and enlarged interface scales. Checks include all
  principal surfaces, text minimums, overflow, stable body/composer sizes,
  transcript placement, scale persistence and legacy scale values.
- One responsive test originally sampled before the transcript finished loading
  after reload. It now waits for visible transcript content before measuring.
  The final rerun passed all 19 tests. Source: `test-responsive-readability-commit.log`.
- Packaged Electron desktop smoke passed native maximize, restart persistence at
  125%, keyboard scaling/reset, native menu scaling and principal-surface
  navigation. It used isolated synthetic data and no live inference or credentials.
  Evidence: `test-results/desktop-readability-1789177779443/report.json` and sibling
  screenshots. Windowed CSS viewport was 1440x960; maximized was 2560x1392 on a
  2560x1440 Windows display, DPR 1. Native zoom remained 1. Body/input/navigation
  stayed 16/15/14px, and the maximized work column measured 920px.
- Personally inspected the earlier packaged candidate in the actual maximized
  Windows app and reviewed its principal surfaces. That pass found Board/Team
  sizing and Workbook composer clipping, corrected in the final patch. The
  rebuilt candidate passed automated native checks, but final manual confirmation
  was stopped by the user's Escape key. Physical 4K/ultrawide hardware and final
  subjective reading comfort remain unverified; those viewport/DPI cases are
  browser emulation, not claims of physical monitor testing.
- The Impeccable detector reported only existing accent borders and a Team width
  transition. These are outside this typography correction and were retained.

## Scope and publication

Implementation branch: `codex/desktop-readability-20260911`, based on `b6d26ec`.
The user's explicit readability request includes Workbook; no new Workbook
screens or product semantics were introduced. Pillars 2026-09-10.1, roadmap
2026-09-10.8 and project memory 2026-09-10.7 were checked. No roadmap status or
canonical product definition is changed. This is an isolated development
candidate, not a shipped release. The live installation, settings and credentials
were preserved. Generated gate logs and screenshots are local verification
artifacts rather than release inputs.

## Changed files

- `client/App.tsx`, `client/Settings.tsx`
- `client/styles.css`, `client/ai-setup.css`
- `client/console/console.css`, `client/console/board.css`,
  `client/console/team.css`, `client/console/wake.css`
- `client/connections/connections.css`, `client/workbench/workbench.css`
- `desktop/main.mjs`, `shared/interface-scale.ts`
- `playwright.responsive.config.ts`
- `tests/interface-scale.test.ts`, `tests/readability.spec.ts`,
  `tests/responsive.spec.ts`, `tests/ui.spec.ts`
- `scripts/readability-desktop-smoke.mjs`, `scripts/desktop-smoke.mjs`
- This implementation record.
