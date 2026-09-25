# Sample businesses

Five **fictional** businesses with realistic, deliberately imperfect history, for product
captures, demos and manual testing. Every business, person, supplier, customer and address
in them is invented; phones are 555-0100 to 555-0199 and email is on example.com. None names
an AI vendor or model.

| Slug | Business | What its files hold |
|---|---|---|
| `juniper-street-bakery` | Juniper Street Bakery & Cafe | Nine weeks of sales, the W36 croissant price rise, pumpkin passing croissants in W38, catering quotes and Saturday staffing |
| `larch-and-lantern-wine` | Larch & Lantern Wine Shop | 90 days of distributor invoices, receiving, credits and statements, the weekend reorder, declined club charges |
| `brandt-and-rowe-remodeling` | Brandt & Rowe Remodeling | Three active jobs, the Henderson walkthrough, change orders, subs and draws |
| `kestrel-row-auto` | Kestrel Row Auto Repair | Repair orders, parts, estimates and a technician schedule |
| `quarry-hill-cabinetworks` | Quarry Hill Cabinetworks | Sheet goods, cut lists and remnants, a remake, a punch list |

All five are anchored to one "today": **Monday 2026-09-21**, ISO week 39. Each folder has:

- `README.md`, what the business is and which site claims its files back;
- `workspace/`, the business's own files, and the only thing a reset copies;
- `planted.md`, every planted problem with its exact file and row;
- `scenarios.md`, four to six requests to hand Nectovia, each tied to a feature the site marks
  Available now, with what a good answer contains.

`planted.md` and `scenarios.md` stay out of the workspace, so the app never reads the answers.

## Reset a business

```
npm run samples:reset -- <slug|all> [--root <folder>]
```

This rebuilds each business under `<root>/<slug>/` and prints the paths it wrote. The root
defaults to `%LOCALAPPDATA%\nectovia-sample-businesses` (or the system temp folder where
that is not set); `DIOMEDES_SAMPLES_DIR` or `--root` overrides it. It is idempotent: running
it twice gives byte-identical folders and prints the same digest.

```
<root>/<slug>/
  projects/<Business Name>/   the workspace, copied byte for byte
  data/                       empty app data
  profile/                    empty desktop profile
  env.ps1                     sets DIOMEDES_DESKTOP_PROFILE, DIOMEDES_DATA_DIR, DIOMEDES_PROJECTS_DIR
  .nectovia-sample.json       marks the folder as a sample reset's own
```

To open one, dot-source its `env.ps1` in PowerShell, start Nectovia from that window and open
the project folder. For a source checkout, set `DIOMEDES_DATA_DIR` and
`DIOMEDES_PROJECTS_DIR` the same way and run `npm run dev`.

### Where the app keeps its state, and why this starts empty

Threads, tasks, the Board, History and settings are not in the project folder. The app
records them in its data folder keyed by project id (`registry.json`, `settings.json`,
`projects/<id>/state.json`, see `server/store.ts`); the project folder holds only the
business's files. The desktop app takes its data folder from `DIOMEDES_DATA_DIR`, its
Electron profile (browser storage and sign-in) from `DIOMEDES_DESKTOP_PROFILE` and its
projects folder from `DIOMEDES_PROJECTS_DIR`, and never runs its first-launch reset on a
location chosen that way (`desktop/main.mjs`).

So a sample starts empty because the reset gives it its own empty `data/` and `profile/`,
not because anything is deleted from the real app. A reset:

- never reads or writes `%APPDATA%\Diomedes`, except to read its `registry.json` so it can
  refuse any real project folder;
- refuses a target that overlaps this repository, `%APPDATA%\Diomedes`,
  `%LOCALAPPDATA%\Diomedes`, `Documents\Diomedes`, any registered project folder, the home
  folder itself or a drive root, judged after resolving links and 8.3 names;
- replaces only a folder carrying its own `.nectovia-sample.json` marker;
- refuses while a Nectovia process holds that sample's `data/service.lock`;
- refuses to delete through a junction or symbolic link.

## Check the data

```
npm run samples:check [-- <slug>] [-- <slug> --table]
```

The check recomputes every planted problem from the raw files with plain rules (short
delivery, price over list, credit never applied, change order never billed, and so on) and
fails when:

- a file shows a problem `planted.md` does not list, or `planted.md` lists one the files no
  longer show, or a row, line or amount differs;
- totals stop adding up (invoice lines to registers, draws to contracts, POS summaries to
  item sales, running balances on statements);
- the site's Lookback totals no longer hold: wine shop 7 items and $1,230.00, remodeler 9
  items and $13,621.50;
- a workspace carries anything but `.md`, `.csv` and `.txt`, a CRLF line ending, a phone
  outside 555-01xx, an email off example.com, an AI vendor or model name, or a Markdown file
  without the fictional notice.

`--table` prints the computed `planted.md` table, which is how to update `planted.md` after
a deliberate data change. `tests/sample-businesses.test.ts` covers the check and the reset.

## Conventions

- A CSV "row" is its spreadsheet row: the header is row 1 and the first record row 2. The
  CSV files have no comment lines, so this is also the editor line number.
- The site's Lookback names its sources `.pdf`. The app reads text and only previews PDFs, so
  these files carry the same names as `.csv` or `.md`.
- The site's scenarios are dated around Tuesday 09-15; here the same events sit in the week of
  09-14, before "today".
- These files ship inside a desktop package, because packaging copies `resources/` whole. They
  are inert there: nothing in the app reads them.
