# Nectovia: the desktop app's name and skin

Date: 2026-09-22. Lane: APP SKIN, branch `feature/nectovia-skin` (worktree
`F:/Diomedes/diomedes-wt/nectovia-skin`, base `c10b7b2`). Status: built and verified in the worktree,
uncommitted, awaiting Andrew's review. The implementation record is
[`docs/implementation/2026-09-22-nectovia-skin.md`](../implementation/2026-09-22-nectovia-skin.md).

## What Andrew decided

The desktop app's display name becomes **Nectovia**. The company stays **Diomedes Systems**.

On the design (2026-09-22):

> "this design is perfect ... go with the mythic synthwave, fractured signal design/palette. this bust is
> the one [concept A] ... go crazy, give us excellent design, transitions"

On the segment bar:

> "we need that. like, now."

On the agent page, which Home.dc.html draws:

> "one page that reports progress and conversationally but isn't overly technical"

## What was built

**A scheme named Nectovia.** It is one appearance package among the twelve, chosen in Settings >
Appearance, and it is the default for new installs. Its palette follows the contract:
- ink #08080c, surface #0d0d12, raised #14141a
- text #e6e9ed, #a4acb6, #838d99
- a cyan lead #44d2c9, a violet trail #b569fb, and a coral tab #f97c65 used once
- amber #e0a94a for needs you, which is never violet

Choosing any other scheme removes every part of it. That is proved by a test: every rule in its
stylesheet is anchored on the scheme.

**The name, everywhere a person reads it.** This covers the headings, labels, placeholders, messages,
the wordmark and the conversation's speaker. A new name contract test finds any stray product name in
client code. Settings > About reads "Nectovia by Diomedes Systems." and then the installed version.

**The devices**, only where they carry meaning:
- The plate, a panel with its top right corner cut and a lit edge on the bevel, marks the person's
  input (the composer, the palette), live work (an open run record) and what needs the person (the
  needs-you block, a document conflict, a Workbook needs notice).
- The seam steps beside the selected rail row.
- The status glyph is a small cut plate, and done is its outline.
- Mono instrument labels appear on ledgers, board columns and inspectors.
- One serif accent phrase sits in the agent home's greeting.

**The segment bar, in every scheme.** It is a feature, not skin. It appears on the Projects list, the
agent home report and the Board's plans. It is drawn only from counts a record already keeps, and it is
indeterminate where nothing was counted.

**The agent home, built to Home.dc.html.** It has the date, a greeting with one accent phrase that says
what most needs saying, and a plain report across the projects: needs you, working, done. Each row has
its sentence, its task bar and a way in. Bust A stands over the one horizon line with its registration
mark.

**Motion.** Once a session, the bust arrives as the fractured signal and resolves to the oracle. Views
shear in, the header seam draws, and plates light their edge last. Nothing moves under reduced motion,
the reduced-motion setting, a motion preset of none, or a motion intensity of 0.

## The conflict with Decision 2 (contract A7)

Decision 2 makes the Settings > Engines screen the visual reference: "flat graphite/dark surfaces, thin
separators, restrained accent use, compact controls". Nectovia's plates (cut corners and lit edges), its
seams, its serif accent phrase, the bust and its loud transitions do not fit that sentence.

Andrew's 2026-09-22 approval, quoted above, is his newest explicit decision. AGENTS.md's precedence
table ranks that first, so it supersedes Decision 2 for the Nectovia scheme. The decision keeps its
force for the structure every scheme renders: one Console language, compact controls, no second
Workbook design language. The Nectovia devices are presentation on that structure. Each lives in
`client/console/nectovia.css` and nowhere else.

AGENTS.md and STANDING_DECISIONS.md are not edited here. The integrator proposes the canonical-docs patch
to Andrew.

### PROPOSED appended decision (not adopted)

The brief asked for "Decision 10". Number 10 is taken ("History is evidence"), and AGENTS.md says the
numbering is stable because tests and comments cite it. This proposal therefore takes the next free
number, 15 at the time of writing.

> **15. A scheme may carry its own devices.** Proposed 2026-09-22. An appearance package may add
> presentation devices to the Console's shared structure (shaped panels, seams, an accent face, art
> and transitions) when Andrew approves them for that package. The devices live in the package's own
> stylesheet, anchored so that choosing any other package removes every one. They never change a
> control's behaviour, a machine identifier or what a screen says. They are drawn only where they
> carry meaning (live work, the person's input, what needs the person). Every one of them honours
> reduced motion completely. Decision 2 continues to govern the structure all packages share. The
> Nectovia package (2026-09-22) is the first.

## Decisions still open

These are Andrew's calls. The skin makes no claim about any of them.

1. **Window title and native dialogs.** The window title, the taskbar name and native error dialogs
   still say Diomedes (contract A3: the desktop shell's names are unchanged, and a test holds it so).
   They are named by `desktop/main.mjs`, whose `setName`, `title` and `showErrorBox` strings this lane
   may not touch. The lane changed only that file's title bar colours and its first-paint colour.
2. **The taskbar and app icon.** The icon is still drawn from `client/console/Mark.tsx`, the
   Diomedes mark, and the installer icon is unchanged. The Nectovia mark exists in the app
   (`NectoviaMark.tsx`) but is not an icon asset yet.
3. **The About line.** It now reads "Nectovia by Diomedes Systems." and then "Version <n>.", with
   the installed version read from the update service. The version is left out when it cannot be read.
   Confirm the wording.
4. **Whether existing installs move to Nectovia.** New installs start on Nectovia. Existing installs
   keep the scheme they saved, and nothing migrates them (contract A5).
5. **Retiring Mark.tsx.** It stays as the icon source until item 2 is decided.
6. **The ThemePack handoff to the site.** Adding `nectovia` to `BASE_THEME_IDS` changes the frozen
   ThemePack contract. The site pins its copy by hash (`scripts/verify-theme-pack-snapshot.mjs`) and
   rejects Nectovia-based themes until the integrator runs `npm run theme-pack:handoff`.

## Names the skin does not change

These say Diomedes and are data, not screen copy. Changing them is a separate decision.

- **Thread names.** The server creates each project's first conversation and the home conversation
  named "Diomedes" (`HOME_THREAD_NAME`, `PROJECT_THREAD_NAME` in server code). A person sees that name
  as a thread title.
- **Recorded History sentences.** The server writes the product name into History ("Diomedes ...")
  as a record. The app renames it where it formats an origin for display, never in the record itself.
- **Other shared strings.** Strings in `shared/` that the server or the capability record also read
  keep their wording. Two client-only modules were renamed.
- **Company and folder names.** The company name "Diomedes Systems", the on-disk projects folder
  (Documents/Diomedes), the `X-Diomedes-*` request headers, the app id, the storage keys and every
  other machine identifier keep their names.
