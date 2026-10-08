# The detail levels retired, 2026-10-08

Andrew asked for the Guided, Standard and Technical levels to go because they are unnecessary:
business owners get something close to Guided, and the Software Engineering Capability Pack brings
the full technical view (QUESTIONS.md R17, raised as O46). Decision 14 already lets a pack compose
the interface, so the technical view now arrives with the pack, never with a level.

## Change

- `client/console/technical-view.ts` answers one question: is this project in the technical view?
  It is while the Software Engineering pack is active for the project. Settings belongs to no one
  project, so it asks whether the pack is on for any project.
- What the technical view shows is what Technical showed: each tool call's name and detail
  (`ToolActivity.tsx`, the thread, the home conversation), the whole diff of a waiting change with
  Open diff, the model and level behind a work style, the per-task profile choice in the task
  inspector, each project's folder on the Projects page, and the name Engines for Settings' helpers
  section. Each place asks `technical-view.ts` about its own project; nothing reads
  `settings.detail`.
- Everyone else gets the plain view, which is what Guided showed: a waiting change carries its plain
  explanation. Standard's middle ground is gone, and so is `App.tsx`'s "Ready when you are." branch,
  which the strip already never showed (standing decision 4).
- The controls are gone: Settings > Interface detail (Settings now opens on Account), the Detail
  items in the ··· menu, the Interface detail rows on the Projects and Nectovia pages, and the setup
  question "How much detail do you want?". The ··· button is named More options and keeps the text
  size and, in a conversation, Cloud sharing. `data-detail` is no longer set on the page; no
  stylesheet read it.
- Setup asks two questions (`SETUP_ORDER` is welcome, q1, q3, ai, ready). The steps keep their
  names so a saved `q3` still means the file-changes question. Setup saved on the old question
  resumes at q3: `migrateSettings` moves it on load, and the settings API stores `q2` as `q3`.
  The ready page no longer names a level.
- A stored level stays. `settings.detail` and `onboarding.detail` are kept and still accepted, as
  `onboarding.familiarity` is, and nothing reads them. The update reconcile still tracks `detail`,
  so an install's provenance and held-default records are unchanged, and a write from an older
  client still saves.
- `appearance.showThinking` stays its own switch, untouched by any of this.
- The packaged smoke and demo scripts that walked the setup question or opened Engines by name
  follow the new flow (`scripts/ai-setup-desktop-smoke.mjs`, `demo-journey-a.mjs`,
  `readability-desktop-smoke.mjs`, `visual-consistency-proof.mjs`). `demo-journey-b.mjs` still
  drives the Workbook's surface menu and was already stale; it is left as it was.

## Tests

- `tests/live-activity-client.test.ts`: the thread shows the tool and its detail in the technical
  view, and a stored Technical level now shows the plain view. That second test fails on the
  previous ThreadView.
- `tests/onboarding.test.ts`: q1 goes straight to q3 on Continue and on Skip, and the stored level
  is carried along untouched. `tests/retired-workbook-settings.test.ts`: setup saved on q2 resumes
  at q3 on load, and every other step stays. `tests/backend.test.ts`: the API stores `q2` as `q3`
  and still keeps a stored level.
- `tests/ui.spec.ts`: first run asks two questions and resumes a saved q2 at q3; the More options
  menu offers only the text sizes; Settings has no Interface detail and opens on Account; the
  Services roster is checked in the plain view and again with the pack on, when the section is named
  Engines. Settings reads every project's packs, and earlier specs leave the pack on for their own
  projects, so that scenario turns it off where it is on and back on after. The guarded settings
  write is now driven by the text size, which writes the whole settings object as the Detail items
  did.
- `tests/cd05-zoom-motion.spec.ts`, `tests/responsive.spec.ts`, `tests/native-ui.spec.ts` and
  `tests/update-notice.spec.ts` follow the new names; the update notice checks the kept level
  through the API.

## Canonical documents: proposed patch, cloud synchronisation pending

The three canonical documents still name the levels. Their Google Docs are canonical and their
repository mirrors must carry the same version, so this branch leaves both unchanged. The proposed
wording, for the next version of each:

- Core Pillars (2026-10-06.1), Pillar 12's technical contract. Replace "Guided/Standard/Technical
  presentation changes information density, not authority." with "The plain view and the technical
  view that the Software Engineering pack brings change information density, not authority."
- Live Roadmap (2026-10-06.1), item A of the Console section. Replace "Guided/Standard/Technical
  changes density, not authority;" with "The plain view and the technical view that the Software
  Engineering pack brings change density, not authority;".
- Project Memory (2026-10-06.1), the Console paragraph. Replace "Guided/Standard/Technical changes
  density, not authority." with "There are no detail levels to choose (Andrew, 2026-10-08). The
  plain view and the technical view that the Software Engineering pack brings change density, not
  authority."

`README.md`'s "Two surfaces over one project" section still describes the Workbook and its levels.
It was stale before this change and is left for the README's own pass.
