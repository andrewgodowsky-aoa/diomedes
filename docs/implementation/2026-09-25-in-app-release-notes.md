# In-app release notes: Settings > What's new, the post-update notice, and notes on an offered update

Date: 2026-09-25 · Lane: `in-app-release-notes` · Branch: `feature/in-app-release-notes`

Andrew asked for a release-notes section inside the app that shows every update we ship. Two other
lanes share the data: the website (`andrewgodowsky-aoa/diomedes-site`) and the release pipeline.
All three read one file, `resources/release-notes/releases.json`, through one contract,
`shared/release-notes.ts`.

## The shared contract

`resources/release-notes/releases.json` has the shape the sprint brief fixed, unchanged:
`schemaVersion: 1` and `releases`, each with `version`, `date`, `channel` (`stable` or `draft`),
`platforms` (`windows`, `macos`), `headline` and `sections` of `{ title, items }`.

`validateReleaseNotes` enforces what the brief states and adds only what follows from it. **These
are rules, not changes to the shape, and the other two lanes should know them:**

- Releases are newest first by version, compared numerically so 0.1.10 comes before 0.1.9. Dates
  never increase down the list. Versions are unique, stable `X.Y.Z` with no `v`.
- A `draft` sits above every `stable` release, because a draft is the next release being written.
- Every string is one line of plain text. HTML tags and entities are refused. So are the Markdown
  markers a reader would act on: `**`, `__`, backticks, `[text](url)`, and a leading `#`, `- `,
  `* `, `+ `, `> ` or `1. `. A spaced hyphen inside a sentence is fine.
- Bounds: headline 240 characters, section title 40, item 1,200, at most 8 sections per release
  and 40 items per section. A section title appears once per release.
- Unknown fields are refused, not ignored. A field one reader acts on and another drops is how the
  three surfaces would start to disagree.
- `publishedReleases` shows stable entries only. A file that fails the contract shows nothing
  rather than a guess.

`tests/release-notes.test.ts` validates the committed file with the same function.

## What the file holds

**Seeded stable releases.** 0.1.11 back to 0.1.2, dated by their GitHub publication day (UTC) and
all `["windows"]`. Sources:

- 0.1.2–0.1.4, 0.1.6 and 0.1.8–0.1.11: `docs/releases/notes/v*.txt`.
- 0.1.5: `docs/releases/2026-09-20-v0.1.5.md`.
- 0.1.7: its GitHub release body. It has no notes file in the repository.

The words are the notes' own, sorted into `New`, `Fixed`, `Updating` and `Known limits`. They are
trimmed only where a sentence was for an engineer rather than a person: commit hashes, file paths
under `server/`, the `DIOMEDES_DESIGN_AUTHORING` variable and the launcher script, and model slugs
in parentheses. Nothing was added. 0.1.4 and 0.1.11 have a `Fixed` section: its lines are the
notes' own "no longer" statements, moved out of "What is new". The three 0.1.1 experimental
prereleases are not seeded. They were never on the stable channel and no update ever offered them.

**Draft 0.2.0.** `channel: "draft"` and `["windows"]`. Its date, 2026-09-25, is a placeholder
the pipeline replaces at release. It covers what is on `main` at `9ce62ee` (batches 1 to 6, PRs #70
to #119), taken from the overnight sprint summary
(`docs/implementation/2026-09-24-overnight-sprint-summary.md`, on `main` since PR #120) and the lane records. It is written in plain
language, and each UI label in it was checked against `client/`.

It says "Nectovia can now" only for things a person can reach in the Console. Work that exists
with no way to start it from the app is listed under Known limits instead: the plan-act-check loop,
the lead with helpers, kept OpenCode, Cursor and Devin sessions, and write reconciliation.

The limits also cover the rest honestly:

- Nothing was tested live against a real provider.
- The build is unsigned, and Windows x64 only. The CI macOS job packages nothing.
- Some work is not yet independently reviewed.
- Several Console controls are still missing.

One item describes this lane's own feature. It becomes true on `main` only when this PR merges.
No internal work-item codes appear, and a test checks that.

## In the app

**Settings > What's new** is a new rail entry after App updates (`client/WhatsNew.tsx`). It lists
every stable release in the bundled file, newest first. Each release is an Engines-style
`.service` block holding a native `<details>`:

- the version is the summary;
- the caption holds the day, the platform, and **Installed** on the installed release (once);
- the headline is followed by the sections.

The installed release starts open and the rest start closed. Each one opens and closes by pointer
or keyboard. The version and the caption carry `min-width: 0` and wrap (decision 5). The chevron's
turn is a transition, and the Console's reduced-motion rules remove it. Nothing sets a column
margin (decision 6).

**The post-update notice** uses the app's existing bottom notice bar (`role="status"`). It says
"Updated to X." and gives that version's headline, with **What's new** and **Dismiss**. Either
button writes the version to `settings.seen.releaseNotes`, a new optional list of stable versions
capped at 50. What's new also opens Settings > What's new with that release open. The notice waits
while an error or another notice is showing.

`releaseNoticeFor` decides when to show it. It needs all of these:

- the installed version has published notes;
- that version is not in `seen.releaseNotes`;
- setup is done;
- setup finished (`onboarding.completedAt`) on a day before that release's date.

The last condition is what tells an update from a new install without writing anything at launch.
It has one edge: someone who finishes setup and then updates on the release day itself sees no
notice. Settings > What's new still has the notes. With no recorded finish time the notice is not
offered, because that case cannot be told apart from a new install.

**Notes on an offered update.** The existing check (`server/app-updates.ts`, GitHub's `latest`
release) adds `check.notes` to its snapshot while a newer release is on offer:

- If this build's bundled file knows that version as stable, the notes come from there
  (`source: 'bundled'`), drawn with the same sections.
- Otherwise they are the person-facing part of the release body the check already fetched
  (`source: 'release-page'`). That runs from the first `WHAT IS NEW`/`UPDATES`/`NEW` heading on,
  with control characters removed and the length capped at 12,000. The card draws it as
  pre-wrapped text, never as markup.

Nothing extra is fetched. The notes sit in a scrollable, focusable region above Download, so a
person reads them before confirming. The digest and asset rules are untouched: release prose is
still never consulted for verification.

## Files

| File | Change |
|---|---|
| `resources/release-notes/releases.json` | New: 10 stable releases and the 0.2.0 draft |
| `shared/release-notes.ts` | New: types, validator, published view, notice rule, body extraction |
| `shared/app-updates.ts` | `UpdateReleaseNotes`; optional `check.notes` in the snapshot |
| `server/app-updates.ts` | Reads the bundled file; carries the offered release's notes |
| `shared/types.ts`, `server/app.ts` | Optional `seen.releaseNotes`, validated as a list of stable versions (additive; hot files, flagged for Fable) |
| `client/WhatsNew.tsx`, `client/ReleaseNotesBody.tsx`, `client/release-notes.css` | New |
| `client/Settings.tsx`, `client/App.tsx`, `client/AppUpdates.tsx` | The rail entry, the notice, and the card's notes |
| `tests/release-notes.test.ts` | New: 31 unit tests |
| `tests/release-notes-ui.spec.ts` | New: 5 browser tests, added to `playwright.config.ts` |
| `tests/app-updates-ui.spec.ts` | Asserts the offered notes show before Download |

## Tests

- **Schema.** The committed file validates. Each rule is refused on its own, and every problem is
  named with its location.
- **Drafts.** They are hidden from the list, from lookup by version, from the notice and from the
  update card.
- **The notice.** It shows once per version and each version is remembered on its own. It is not
  shown on a new install, during setup or without a finish time. The seen list stays bounded, and
  the server refuses a malformed list.
- **Ordering.** Newest first, by numeric version, with dates never increasing.
- **Update check.** Notes come from the bundled file when it knows the version, and from the body
  otherwise. There are none when nothing is offered.
- **Browser.** Settings > What's new covers the order, the draft hidden, the one Installed mark,
  and collapse by pointer and keyboard. The zoom test uses 720 x 450 (200 percent of 1440 x 900)
  with reduced motion: no sideways scroll, and the chevron has no transition.
- **Browser, the notice.** A simulated version change shows the notice. Dismiss settles it across a
  reload, and What's new opens the notes and settles it too. A new install shows none.

The version change is simulated in the page: the status route answers with the newest published
release as the installed version, and setup finished the day before it. The rest is the real dev
server.

## Gates

Run on Linux with the Chromium under `/opt/pw-browsers`. `main` brought in documentation only (PR #120). Counts:

- `npx tsc --noEmit`: passed, no errors
- `vitest run --maxWorkers=3`: 409 files passed, 1 skipped; 7,304 tests passed, 18 skipped (7,322), 0 failed (run on this branch's code before the docs-only merge of `a37e2f6`)
- `npx vite build`: passed, 2,505 modules
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts tests/release-notes-ui.spec.ts tests/app-updates-ui.spec.ts`: 42 passed, 0 failed, 0 skipped (the three standing specs, the 5 new tests and the updated App updates test)

## Gaps

- **Nothing here has been packaged or installed.** The notice and the card were exercised in the
  browser against the dev server only.
- **0.1.11 and earlier cannot show any of this.** The update card's notes and the notice begin
  with the first build that carries this code. An update from 0.1.11 shows no notes before its
  download, but it shows the notice once 0.2.0 opens.
- **The body extraction is a heuristic** that matches the release bodies written so far. If the
  pipeline lane writes bodies from `releases.json`, the bundled source already covers every version
  this build knows, and the body is only the fallback for a newer one.
- **The website reads the file raw from `main`, draft included.** Hiding drafts is its job under
  the contract. `publishedReleases` is the reference behaviour.
- **The notice's day rule** has the same-day edge described above.
- **The seeded entries are trimmed.** They are not verbatim copies of the `.txt` files, as
  described above. The `.txt` files and the GitHub bodies stay the full record.

## Proposed canonical-doc patch

Not applied. The canonical documents and `QUESTIONS.md` are not edited by this lane.

**Live Roadmap** (release and distribution section, beside App updates):

> **In-app release notes: implemented on `feature/in-app-release-notes` (PR pending), not
> released.**
> `resources/release-notes/releases.json` (schema 1, validated by `shared/release-notes.ts`) is the
> single source of release notes for the app, the website and the release pipeline.
> - Settings > What's new lists stable releases newest first.
> - A one-time notice follows an update, remembered per version in `settings.seen.releaseNotes`.
> - The update card shows an offered release's notes (bundled entry, else the GitHub release body)
>   before Download.
> - Drafts are never shown. 0.2.0 is held as a draft until the pipeline flips it at release.
>
> Evidence: `docs/implementation/2026-09-25-in-app-release-notes.md`,
> `tests/release-notes.test.ts`, `tests/release-notes-ui.spec.ts`. No packaged or installed proof.

**Project Memory** (terminology):

> **Release notes.** One entry per release in `resources/release-notes/releases.json`, plain text
> for a person. Sections are conventionally New, Fixed, Updating and Known limits. `stable` entries
> are published. A `draft` is the next release being written and is shown nowhere. A release is
> described there before anything else repeats it: the GitHub body, the site and the app all read
> the same words.
>
> **What's new** is the Settings section that shows them. The **post-update notice** is its
> one-time pointer after an update.

**QUESTIONS.md** (proposed open question, for Andrew):

> **Post-update notice on a same-day update.** The notice tells an update from a new install by
> comparing the setup finish day with the release day. Someone who sets up and updates on the same
> day sees no notice. Should launches record the last-run version so the rule becomes exact? That
> is one more settings write at every version change. Proposed default: keep the day rule.
