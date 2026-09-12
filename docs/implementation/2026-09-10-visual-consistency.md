# Settings visual consistency

Andrew's approved Settings typography now applies to the existing Workbook and
Console. All ordinary interface, response and document text uses Schibsted
Grotesk. The IBM Plex Serif imports are removed, including the standalone
Connections fixture. Code and technical measurements retain IBM Plex Mono.

Ember remains a selectable preference. Field/cyan and all other packages remain
available. No saved user preferences were changed.

## Diagnosis and changes

The reference Settings page already used Schibsted Grotesk. Workbook `.prose`,
home headings and composers explicitly selected IBM Plex Serif; ordinary replies
also inherited the document reading scale. In addition, an unset interface scale
meant 110% in Guided and 95% in Console. Switching surfaces therefore changed both
the font and its apparent size. Fixed-height headers and intrinsic grid/flex
minimums caused narrow layouts to collide or overflow.

Shared tokens now establish 14px UI/body/captions, 16px section headings, 18px page
headings and a 1.5 body line height, before an explicit UI scale is applied. An
unset UI scale is consistently 100%. The existing explicit reading and code size
controls remain separate. Documents use the same sans-serif face, with their own
reading size. Reading columns have an 880px maximum measure.

Headers grow when necessary; long titles truncate with a full title available;
paths and body text wrap. Grid/flex children can shrink. Container breakpoints
respond to the space available after UI zoom. Narrow navigation remains reachable
by scrolling, supplementary columns stack, and Team messages have distinct lanes.
Existing approval, runtime, permission and durable workspace behavior is preserved.

The synthetic Sample work engine row, usage sidebar entry, picker entry, response
author suffix and helper caption are removed. With no real engine connected, the
picker says "Choose an engine". The sample project and its files remain available;
actual scripted changes are still identified as examples in work/review records.
Real engine usage is retained. A reported allowance window suppresses the stale
"allowance not reported" fallback, while freshness and plan lines come from the
same usage snapshot. No allowance or account plan is inferred.

Muted text tokens were adjusted within Graphite, Ember, Dusk and Paper to meet
4.5:1 against their raised surfaces. Accent choices are unchanged.

## Verification

Source base: `2e230c89020d1ddb4fd51720a201ad0b562fbef8` on
`codex/settings-visual-consistency-20260909`. The main checkout was clean at the
start and final inspection. Work is isolated at
`F:\Achilles\diomedes-wt\settings-visual-consistency`.

| Check | Result |
| --- | --- |
| TypeScript | `tsc --noEmit` passed |
| Unit suite | 620 passed; final usage-helper follow-up: 5 passed |
| Existing app browser suite | 27 passed across UI, native fixture and Field tests |
| Added responsive suite | 9 passed |
| Client build and desktop packaging | Passed |
| Website | Astro check: 0 errors/warnings; build, copy check and Worker compilation passed; 21 responsive checks passed |

Website checks used the separate, unchanged local checkout at
`F:\Achilles\diomedes-site`, commit
`2b50189828ae5c83b350f1c41bd288aef368a203`. They do not establish a new production
deployment. The website already uses Schibsted Grotesk.

The responsive tests visit Workbook Home, Ask, Plan, Work, Review, Tasks,
Documents, History and Settings, plus Console Thread, Board, populated Team,
Connections, engine menu and command palette. They use long project, worker,
model and path values at 1280x720/100%, 960x900/125%, 640x800/150% and
390x844/100% UI scale. They check visible horizontal overflow, document width,
reply fonts, keyboard opening/closing of dialogs, separate reading scale, and
Ember/Field/Paper accent selection. Existing regressions exercise permission,
proposal preview, approval, review, history, draft recovery and usage state races.

Impeccable's final detector reports three existing warnings: the two semantic
error/conflict borders and the small Team context-meter width transition. The
borders remain deliberate state indicators. Existing reduced-motion rules disable
the transition. This pass does not claim a complete accessibility certification.

### Captures and scaling

All artifacts are in
`F:\Achilles\diomedes-wt\settings-visual-consistency\evidence\visual-consistency`.
Each capture manifest records actual viewport, devicePixelRatio, loaded fonts,
computed type sizes and line heights, UI/reading/code scales, overflow and page
errors. Packaged manifests also record Electron zoom and display information.

| Capture set | Coverage | Result |
| --- | --- | --- |
| `before/` | 21 matched desktop views at 1280x720, 1920x1080 and 2560x1440; UI scale 1.1 | Original typography baseline; usage presentation fix was already present |
| `after/` | 47 views, including the same 21, narrow layouts, Field/Paper Settings and three populated Team views | No visible overflow or page errors; no Sample work text or loaded serif face |
| `packaged/` | 21 actual Electron views, same desktop sizes; UI scale 1.1 | Windows displays reported scale 1; DPR 1, Electron zoom 1; no overflow/errors |
| `packaged-125/` | 21 actual Electron views with forced device scale 1.25 | DPR 1.25; Electron zoom 1; no overflow/errors |
| `packaged-150/` | 21 actual Electron views with forced device scale 1.5 | DPR 1.5; Electron zoom 1; no overflow/errors |

The 125%/150% runs simulate display scaling through Electron's device-scale
override. Windows display settings were not changed. Browser phone sizes are
responsive simulations; the native app's existing 800px minimum window width is
unchanged. Screenshots capture web contents, not native Windows caption buttons.
The package was launched with owned empty profiles; no user credentials were
copied. Usage values and conversations in these captures are test fixtures,
not live model/account proof. No live model turns were used for styling checks.
One bounded implementation subtask used the authorized OpenCode Go Muse route.

The primary agent inspected the rendered phone response, desktop Settings,
Home, populated Team and packaged display-scale captures. Assertions cover the
tested states; they cannot promise every possible future content combination.

Matched 1280x720 examples (the other two desktop sizes follow the same filenames):

| View | Before | After |
| --- | --- | --- |
| Engines | [Before](../../evidence/visual-consistency/before/settings-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/settings-1280x720-1.1-ember.png) |
| Projects | [Before](../../evidence/visual-consistency/before/projects-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/projects-1280x720-1.1-ember.png) |
| Home | [Before](../../evidence/visual-consistency/before/home-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/home-1280x720-1.1-ember.png) |
| Ask | [Before](../../evidence/visual-consistency/before/ask-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/ask-1280x720-1.1-ember.png) |
| Review | [Before](../../evidence/visual-consistency/before/review-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/review-1280x720-1.1-ember.png) |
| Team | [Before](../../evidence/visual-consistency/before/team-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/team-1280x720-1.1-ember.png) |
| Connections | [Before](../../evidence/visual-consistency/before/connections-1280x720-1.1-ember.png) | [After](../../evidence/visual-consistency/after/connections-1280x720-1.1-ember.png) |

## Build / publication / deployment status

Candidate executable:
`F:\Achilles\diomedes-wt\settings-visual-consistency\release\Diomedes-win32-x64\Diomedes.exe`.
It was built and opened in isolation, then closed. It is an unsigned test candidate
from **local uncommitted source**, not an approved release or installed update.

- Build timestamp: `2026-09-10T04:07:50.604Z`.
- Source digest: `a62e54ebc48067b6291b0dd1affa23b06e9d56887946b528ad6f2022549f3280`.
- Base commit: `2e230c89020d1ddb4fd51720a201ad0b562fbef8`.
- Build identity and individual source hashes: `evidence/visual-consistency/build-info.json`.

Andrew's installation, existing main release, saved appearance and accounts were
not replaced. No commit, merge, push, release, website deployment or cloud roadmap
write was performed. A release Andrew installs should be built from the approved
committed main source under the existing release process.

## Roadmap impact

The inspected repository roadmap remains **2026-09-09.7**. Its documented cloud
basis is **2026-09-09.6**; the cloud was not refreshed or written in this pass.
The existing pending cloud reconciliation remains pending. No Runtime, Trust,
capability or public-release milestone is advanced by these styling checks.

Exact additional proposed patch for section 14, after refreshing and reconciling
the live revision under the existing revision-protection rule:

1. Replace `- graphite flat surfaces;` with `- flat surfaces in the selected theme;`.
2. Replace `- sparse semantic cyan;` with `- sparse semantic accents from the selected theme, including cyan and Ember;`.
3. Insert the following paragraph after the section's final paragraph:

> On September 10, Andrew approved Engines Settings as the typography and spacing
> reference across the existing Workbook and Console. Use Schibsted Grotesk for
> interface, response and document text; retain monospace for code and technical
> measurements. Preserve selectable themes and explicit size controls. Remove
> synthetic Sample work engine labels and meters. The isolated implementation has
> passed 620 unit, 27 existing app browser, 9 responsive and 21 website responsive
> tests plus packaged Windows font and scaling checks. It is local and uncommitted;
> installation, publication and deployment have not changed.

## Proposed commit and changed-file list

Proposed message: `fix(ui): unify Settings typography and contain responsive layouts`

No commit has been created. Proposed files:

- `AGENTS.md`
- `client/App.tsx`
- `client/Settings.tsx`
- `client/Workspace.tsx`
- `client/components.tsx`
- `client/main.tsx`
- `client/styles.css`
- `client/usage-presentation.ts`
- `client/connections/desktop.css`
- `client/connections/fixture-main.tsx`
- `client/console/Picker.tsx`
- `client/console/board.css`
- `client/console/console.css`
- `client/console/palette.css`
- `client/console/schemes.ts`
- `client/console/team.css`
- `tests/ui.spec.ts`
- `tests/responsive.spec.ts`
- `tests/usage-presentation.test.ts`
- `playwright.responsive.config.ts`
- `scripts/visual-consistency-proof.mjs`
- `docs/implementation/2026-09-10-visual-consistency.md`
- `evidence/visual-consistency/` (capture manifests, PNGs, build identity and verification logs)

Ignored profiles, dependency junctions, test-output scratch files and the candidate
release directory are not part of this proposal. Older release evidence is preserved.
