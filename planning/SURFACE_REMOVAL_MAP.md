# Surface removal map: retiring the Workbook/Console split

Worktree: `workbook-removal-everything-bubble-20260919`, branch
`feature/workbook-removal-everything-bubble-20260919`, from `8026320`.

This is a removal map, not a removal. No production code was changed to write it.
Every claim below was read in source at the cited line.

## 0. Read this before you touch anything

Three corrections to the brief, established by grep and confirmed by reading:

| The brief says | Source says |
| --- | --- |
| "roughly 85" references | **164** true references across **43** files, after excluding homonyms (§1.0) |
| "Nine test files reference it" | **29** test files. Nine contain the words; **22** write a `surface:` fixture to reach the Console, and those break differently (§5, §6.3) |
| `Intent` needs mapping onto Console destinations | `Intent` is **already dead code** — `shared/types.ts:17` is its only occurrence in the repository (§2.3) |

A raw grep for `surface` returns 203 hits. Roughly a fifth of them belong to two
unrelated things that a find-and-replace will destroy. Read §1.0 first.

---

## 1. Every reference, grouped, with its disposition

### 1.0 Homonyms — DO NOT TOUCH

There are **three** unrelated meanings of "surface" in this codebase, and two of
them have nothing to do with the Workbook/Console split.

**(a) The theme-pack `Surface` — a different type with the same name.**

`shared/theme-pack/types.ts:255-256`
```ts
export const SURFACES = ['app-console', 'website'] as const;
export type Surface = (typeof SURFACES)[number];
```

This is "which product is being painted", not "which shell is showing". It is
exported under the same identifier as `shared/types.ts:15`. Its users, all of
which stay exactly as they are:

- `shared/theme-pack/types.ts:373` (`surfaces?: Partial<Record<Surface, ArtworkOverride>>`), `:463` (`surfaces: Surface[]`), `:480`
- `shared/theme-pack/resolve.ts:37`, `:86`, `:313` (`layers.surface ?? 'app-console'`), `:379`
- `shared/theme-pack/compatibility.ts:13`, `:22`, `:52`, `:138`, `:146`, `:156`, `:160-161`
- `client/App.tsx:298` — `surface: 'app-console'` passed to `resolveAppearance`. **This line survives the refactor unchanged.** It sits 14 lines after `root.dataset.surface = surface` (`:281`), which is deleted. They are not the same thing.
- `tests/theme-pack.test.ts` — **all 16 hits**. Zero change.

**(b) `surface` the colour role.** `--surface` is a CSS custom property and
`colors.surface` a palette slot: `shared/theme-pack/types.ts:66`, `:92`, `:108`,
`:124`, `:140`, `:156`, `:172`, `:188`, `:204`, `:220`, `:236`;
`shared/theme-pack/resolve.ts:126`, `:241`, `:251`, `:256`, `:259`, `:447`,
`:454`, `:464`; `tests/a6-acceptance.spec.ts:56`;
`tests/design-studio-ui.spec.ts:44`, `:707-708`, `:729`. Zero change.

**(c) Prose and unrelated words.**

- `server/harness/adapters.ts:143` — "the flag removes the tool surface entirely". Prose about `--no-tools`.
- `client/console/ImportFiles.tsx:144` — "Images, PDF and spreadsheet **workbooks**". A file format. Not the Workbook.
- `tests/design-center.test.ts:464` — the path string `client/console/design-center.css`, matched on `console`. Zero change.
- `client/console/Shell.tsx:304` — `'history'` inside the SSE event-name array at `:298-309` (`[...].forEach((n) => es.addEventListener(n, update))`). A server event channel, **not** a `Page` and not a route. Zero change.
- `StepIntent` (`shared/harness.ts:90`) and its ~20 `server/harness/*` users are **not** `Intent`. Excluded from every count here.

**(d) `.workbook-layout` is a shared CSS primitive, not Workbook-only.** Covered
in §6.4 — it is the single most likely thing to be deleted by mistake.

### 1.1 The type and its helper — the core deletion

| Site | What it is | Becomes |
| --- | --- | --- |
| `shared/types.ts:14` | Doc comment, "The two surfaces..." | Deleted |
| `shared/types.ts:15` | `export type Surface = 'workbook' \| 'console'` | **Deleted** |
| `shared/types.ts:37` | `surface?: Surface` on `Settings` | **Deleted — persisted field, see §3.2** |
| `client/components.tsx:10` | `Surface` in the type import | Deleted |
| `client/components.tsx:40-45` | `surfaceDescriptions` — the two marketing blurbs | Deleted; nothing replaces them |
| `client/components.tsx:46-51` | `surfaceOf(settings)` | **Deleted.** Step 2 (§4) first makes it `return 'console'`, so call sites go green before they go away |

### 1.2 `client/App.tsx` — the shell branch (18 refs)

| Line | What it is | Becomes |
| --- | --- | --- |
| `:7` | `Surface` type import | Deleted |
| `:24` | `surfaceOf` import | Deleted |
| `:94-95` | Comment: Ctrl+K opens the console palette "instead of the Workbook's project search" | Reworded — there is one palette now |
| `:178` | Comment: "A page the Workbook rail no longer offers — Connections is Console-only" | Deleted with the `Page` restore logic (§3.4) |
| `:281` | `root.dataset.surface = surface` | **Do not delete outright — becomes the constant `'console'`.** `client/console/console.css:6` is `html[data-surface='console'] body { background: var(--chrome); }`, so deleting the attribute leaves the *surviving* shell without a body background. See §6.7 for the trade |
| `:284` | `root.dataset.detail = surface === 'console' ? 'technical' : settings.detail` | Collapses to a constant `'technical'`. No CSS or TS reads `data-detail` (only 11 Playwright assertions do), so this is inert for styling — but it is where the `Detail` setting stops being settable, see §6.2 |
| `:326` | Comment, "Surface changes never resize the interface" | Deleted |
| `:384` | Comment, "Settings replaces the Workbook and the Console" | Reworded |
| `:403` | `const onConsole = ... surfaceOf(s) === 'console' && !showSettings` | Simplifies to `!!selected && !showSettings` |
| `:478` | `const surface: Surface = settings ? surfaceOf(settings) : 'workbook'` | **Deleted** |
| `:480-481` | `consoleActive` | Simplifies to `!!selected && !showSettings` |
| `:534` | `'Opening your workbook...'` — the loading string | Replaced. Copy decision, not a mechanical one |
| `:633-653` | The account-menu Surface picker (`['workbook','console'].map`) | **Deleted whole** |
| `:653-660` | `surface === 'workbook' && (<p className="caption">Detail</p> ...)` — the guided/standard picker, gated on Workbook | **Deleted with the gate — this is where `Detail` disappears from the UI (§6.2)** |
| `:702` | `selected && surface === 'console' ? <Shell .../>` | Becomes the only branch |
| `:711-718` | `openInBook={(p) => { saveSettings({...settings, surface: 'workbook'}); navigate(p); }}` | **Deleted — this is the Console's only route to Home and History (§6.1)** |
| `:762` | `<div className="workbook-layout home">` | **KEPT.** This is the *projects landing page*, not the Workbook (§6.4) |
| `:942` | Comment, "a full-surface workspace" | Prose; unrelated sense |

### 1.3 `client/Settings.tsx` (11 refs)

| Line | What it is | Becomes |
| --- | --- | --- |
| `:28` | `surfaceOf` import | Deleted |
| `:141` | `const surface = surfaceOf(settings)` | Deleted |
| `:231` | `<div className="workbook-layout">` | **KEPT.** Settings survives and uses this class (§6.4) |
| `:236` | Copy: "how much detail the Workbook shows" | Reworded |
| `:238-262` | `<h2>Surface</h2>` + the `['workbook','console']` radio group | **Deleted whole** |
| `:250` | `s === 'workbook' && settings.detail === 'technical'` coercion | Deleted |
| `:263-277` | `{surface === 'workbook' && (...)}` — the Detail radio group, and `save({...settings, detail: d, surface: 'workbook'})` | **Deleted gate. See §6.2 before deleting the inner control** |
| `:724` | Copy: "A workbook for your projects, documents, plans, tasks..." | Reworded |

### 1.4 `client/Setup.tsx:60`

`You'll work in the {settings.surface === 'workbook' ? 'Workbook' : 'Console'}` —
onboarding copy. Becomes a constant string. One line.

### 1.5 The Console's own escape hatches back to the Workbook

These are in `client/console/` and are **deletions inside the surface that
survives** — easy to miss when scoping by "delete the Workbook".

| Site | What it is | Becomes |
| --- | --- | --- |
| `client/console/Shell.tsx:79` | `openInBook: (page: Page) => void` prop | **Deleted from `ShellProps`** |
| `client/console/Shell.tsx:107` | The destructured param | Deleted |
| `client/console/Shell.tsx:1036` | `<div className="surface-menu">` | Deleted, or repurposed |
| `client/console/Shell.tsx:1040` | `aria-label="Interface detail menu"` on a menu whose only contents are Surface buttons | Deleted. Note the label already lies about its contents |
| `client/console/Shell.tsx:1046-1070` | `<p className="caption">Surface</p>` + "The Workbook" / "The Console" buttons | **Deleted whole.** `tests/ui.spec.ts:155`, `:757` click "The Workbook" by name |
| `client/console/Shell.tsx:1096` | `onHome={() => openInBook('home')}` | Deleted |
| `client/console/Shell.tsx:1097` | `onHistory={() => openInBook('history')}` | **Cannot simply be deleted — History has no Console implementation (§6.1)** |
| `client/console/Rail.tsx:26`, `:49` | `onHistory(): void` prop | Kept, but must point at a new Console History |
| `client/console/Rail.tsx:33` | Doc comment, "the files/workbook/engine foot" | Reworded |
| `client/console/Rail.tsx:108-110` | `<button onClick={onHome}>Workbook</button>` | **Deleted** |
| `client/console/Rail.tsx:90-103` | The `['Thread','Board','Team','Connections']` view switch | Folded into the Everything flyout |
| `client/console/Rail.tsx:104-117` | The foot: Files (`:105-107`), Workbook (`:108-110`), History (`:111-113`), Engines (`:114-116`) | Folded into the Everything flyout, minus Workbook |
| `client/console/Need.tsx:8`, `:17` | Doc comments comparing the Console's register to the Workbook's | Reworded; they explain a real styling decision, so do not just delete the sentences |

### 1.6 Server (§3 has the analysis)

`server/store.ts:124-128`, `:148-152`, `:174`; `server/app.ts:219-227`, `:2492`.

### 1.7 Prose only — reword, do not delete

`client/api.ts:57`, `shared/harness.ts:10`, `:275`,
`server/harness/present.ts:3`, `server/harness/adapters.ts:214`,
`tests/harness-present.test.ts:11`. Every one is a doc comment naming "the
Workbook and Console" as the vocabulary a boundary maps onto. The boundary is
unchanged; only the sentence is wrong afterwards.

`server/harness/adapters.ts:214` is the interesting one: *"The Workbook's copy
rules ban technical words, so these stay on the Console."* That sentence encodes
a **copy policy**, not a fact about code. With one surface, the policy question
"may engine details use technical words?" has no answer any more. Flag it to the
owner rather than deleting it quietly.

---

## 2. `client/Workspace.tsx` — what the Workbook actually is

2,547 lines. It renders, in order:

1. **A nav rail** (`:1145-1165`) built from `pages` imported from
   `client/components.tsx:19-28`. Per-page counts (`:871-876`) and, at `guided`
   detail, per-page descriptions (`:865-870`). `Ctrl+1..8` hints at `technical`
   detail (`:1157-1159`).
2. **A page header** with a computed `contentTitle` (`:648-657`) and per-page
   `headerActions`.
3. **A composer** (`:658+`) with four modes from `MODE_ORDER` (`:48`) and its own
   captions and placeholders, `BOOK_CAPTIONS` / `BOOK_PLACEHOLDERS` (`:49-55`).
4. **Nine mutually exclusive page blocks.**
5. **A restore dialog** (`:2278-2300`) — the only caller of
   `restoreEntry` (`:452-497`).

### 2.1 The client and the server disagree about how many pages there are

- `shared/types.ts:18-27` — `Page` has **nine** values.
- `server/app.ts:118-128` — the server's `pages` validation array has the same **nine**.
- `client/components.tsx:19-28` — the client's `pages` array has **eight**. `'connections'` is absent.

So the Workbook rail never offered Connections; `client/App.tsx:177-179`
defensively drops a stored `lastPage` that is not in the client's list. That
mismatch is a live, load-bearing piece of behaviour and it is also the migration
template for §3.4.

### 2.2 The nine pages, mapped

| `Page` | Workbook block | Console equivalent | Verdict |
| --- | --- | --- | --- |
| `home` | `:1234-1424` — "Needs you" cards plus the intent rail "What do you want to do?" | None. It is a launcher | **Lost as a page.** This is precisely what the Everything flyout plus the rail's "New chat" is meant to absorb. Note the *same* intent rail exists independently at `client/App.tsx:762-770` on the projects landing page and survives |
| `ask` | `:1425-1516` — thread list plus composer | `client/console/ThreadView.tsx` + `client/console/Composer.tsx`, `Shell.tsx:1105-1199` | **Equivalent** |
| `plan` | `:1517-1551` — plan picker, plan document, "turn steps into tasks" | Plans are `.md` in the project (`server/app.ts:2504-2510`); `FilesPane` previews them | **Partly lost** — viewing yes, editing no (see `documents`) |
| `work` | `:1608-1658` — running sessions, Need cards, session status | `Shell.tsx:1105-1199` ThreadView + `client/console/Need.tsx` + `client/console/BoardView.tsx` | **Equivalent** |
| `review` | `:1659-1695`, `:1844-1893` — change cards, approve/reject | `client/console/ChangeReview.tsx`; `Shell.tsx:1430` renders `<ChangeCard detail={settings.detail}>` | **Equivalent** |
| `tasks` | `:1188-1230` — four-column task board, `stateNames` columns, list/board toggle via `settings.tasksView` | `client/console/BoardView.tsx`, `Shell.tsx:1240-1281` | **Equivalent** |
| `documents` | `:1552-1607` — document list, viewer, **and editor**: `<textarea>` at `:1114-1128` with `Ctrl+S` → `saveDocument` (`:306`), dirty-state guard (`:1560-1563`) | `client/console/FilesPane.tsx` | **Editing is lost.** `FilesPane.tsx:21-22` states it outright: *"It is not an editor: the pack tier owns code reading, editing, Git and diffs, and none of that is here."* Previews are read-only (`:16`) |
| `history` | `:1696-1843`, `:1977-1985` — full History browser, per-entry detail, approval status, and **restore with conflict handling and undo** (`restoreEntry`, `:452-497`, hitting `POST /history/:id/restore`) | `client/console/Ledger.tsx:79-90` shows `state.history.slice(-3)` — the last three entries, as a summary | **Lost.** Browsing, restore, conflict resolution and undo have no Console implementation. Nothing under `client/console/` calls the restore route |
| `connections` | Not rendered by the Workbook at all — absent from `client/components.tsx:19-28` | `Shell.tsx:1100-1104`, `client/connections/Connections.tsx` | **Already migrated.** Console-only today, per `tests/connections-ui.spec.ts:52-54` |

Three genuine losses: **Home as a launcher**, **document editing**, **History
browsing and restore**. The first is the intended trade. The second and third are
not mentioned in the decision and are the subject of §6.1.

### 2.3 `Intent` — already dead

`shared/types.ts:17`:
```ts
export type Intent = 'ask' | 'work' | 'plan' | 'review';
```

A repository-wide grep for `Intent` returns 33 hits. Every one of them is
`StepIntent`, `connectionIntentSchema`, or the word "Intentionally"
(`scripts/connections-process-proof.ts:47`). **`shared/types.ts:17` is the only
occurrence of the standalone `Intent` type.** It is unreferenced today.

Disposition: delete the line. There is nothing to map and no call site to find.
Do not spend time looking for one. The concept it named lives on untyped as the
`.intents` / `.intent-rail` markup at `Workspace.tsx:1242-1244` and
`App.tsx:766`, neither of which imports it.

---

## 3. Server and shared plumbing — carried through, except once

### 3.1 `server/modes.ts` — both halves are dead copy

`ModeDefinition` (`:8-19`) declares:
```ts
workbook: { caption: string; placeholder: string };
console: { placeholder: string };
```
and `MODES` (`:32-91`) fills both for all four modes.

**Neither is read anywhere.** Every read of `MODES` in the repository takes only
`.instructions` or `.effort`:

- `server/app.ts:2452`, `:2474` — `MODES[mode].instructions`
- `server/app.ts:2477` — `MODES[mode].effort`
- `server/native-work.ts:562`, `:570`, `:573` — `modeDef.instructions`, `modeDef.effort`

The Workbook uses its *own* copy (`Workspace.tsx:49-55`, `BOOK_CAPTIONS` /
`BOOK_PLACEHOLDERS`), and the Console uses its own at
`client/console/Composer.tsx:13-18` (`PLACEHOLDERS`, read at `:243`).

The two copies have **already drifted**, which is the proof that nothing reads
the server's: `server/modes.ts:41` says `'Ask or think out loud...'` while
`Composer.tsx:14` says `'Ask or think out loud'` (no ellipsis), and
`server/modes.ts:83` says `'What should be fixed?'` while `Composer.tsx:17` says
`'What went wrong?'`. If either field were live, that drift would be a visible
bug. It is not, because both fields are dead.

Disposition: **delete both fields** from `ModeDefinition` and from all four
entries in `MODES`. This is dead-code removal, not a surface change, and it can
land independently at any point. It is the only part of this refactor with no
risk attached.

### 3.2 `server/store.ts` — this is a data-model change, and it is the loud one

**`Settings.surface` is persisted to disk.** It is not a runtime flag.

`defaults()` at `:174` writes `surface: 'console'`.

`migrateSettings()` at `:130-153` is where existing users are decided:
```ts
const stored = settings.surface as string | undefined;
if (stored === 'book') settings.surface = 'workbook';
else if (stored === 'desk' || stored === 'technical') settings.surface = 'console';
if (settings.surface === undefined)
  settings.surface = settings.detail === 'technical' ? 'console' : 'workbook';
```

So the stored value is one of five spellings across the install base: `book`,
`desk`, `technical`, `workbook`, `console`, or absent.

**What happens to an existing user's stored settings.** Anyone whose `detail` is
`guided` or `standard` and who never opened the picker has `surface: 'workbook'`
written to their settings file right now — `migrateSettings` puts it there on
first read if it is missing (`:151-152`). After this refactor they open the app
and are on the Console. That is the intended outcome of the decision, but it is a
**visible, unannounced relocation for every non-technical user**, which is the
exact failure `tests/surface.test.ts:5-11` was written to prevent: *"they open
the app and find themselves on a surface they never chose, with no error to
explain it."* The owner should be told this in those words before the step lands.

**How to retire the key.** The precedent is in the same function. History
retention was retired at `:141-143`:
```ts
delete (settings as { history?: unknown }).history;
```
and `tests/surface.test.ts:60-69` explains why deletion — not omission — is
required: *"Settings load with no merge against the defaults, so a key left in a
stored file would be read back and rewritten forever. Migration is the only thing
that can retire one."*

So: `delete (settings as { surface?: unknown }).surface;` replaces the five-way
coercion, and `surface: 'console'` comes out of `defaults()` at `:174` — **in
that order**, for the reason in §6.3.

### 3.3 `server/app.ts` — one API contract and one real behaviour branch

**Carried through (`:219-227`).** `validateSettings` accepts five spellings and
normalises to two:
```ts
const named = choice(supplied.surface, ['workbook','console','book','desk','technical'], 'surface');
result.surface = named === 'book' ? 'workbook' : named === 'workbook' ? 'workbook' : 'console';
```
The server stores it and never reads it back to decide anything here. This is
the HTTP contract, and it is what the 22 Playwright fixtures write to. Its
removal is governed by §6.3, not by this section.

**Real behaviour (`:2489-2494`).** The single place the surface changes what the
server *does*:
```ts
store.settings.surface === 'console'
  ? 'Turn an engine on in Settings > Engines.'
  : 'Turn a helper on in Settings > Helpers on this computer.'
```
This is the sample-route answer when no engine is connected. It becomes the
Console string unconditionally. Two lines — and the most consequential two lines
in the refactor, for the reason in §6.5.

### 3.4 The persisted `Page` fields — a second migration the brief does not mention

Deleting `Page` is not a type deletion. `Page` is stored in **two** persisted
places:

| Field | Declared | Written | Validated |
| --- | --- | --- | --- |
| `Settings.lastPage: Record<string, Page>` | `shared/types.ts:90` | `client/App.tsx:390-393` | `server/app.ts:389-395`, `choice(page, pages, 'page')` → **400** on an unknown value |
| `Project.leftOff: { page: Page; ... }` | `shared/types.ts:120` | `server/app.ts:1150`, via `PUT /api/projects/:id/left-off` | `server/app.ts:1144`, `choice(b.page, pages, 'page')` → **400** |

Two mitigating facts, both verified:

- **`leftOff.page` is write-only.** The only client caller is
  `client/Workspace.tsx:295`, and the only *reads* anywhere are
  `Workspace.tsx:1348` and `:1350`, which read `leftOff?.document` — never
  `.page`. Deleting the Workbook removes the sole writer and the sole reader of
  the route. The route `server/app.ts:1139-1154` becomes unreachable and can go
  with it. `leftOff` itself is still read for `document`, so keep the field and
  drop the `page` member, or keep it as `string`.
- **`lastPage` already has a tolerance pattern.** `client/App.tsx:177-179`:
  ```ts
  const restored = s.lastPage[id];
  setPage(restored && (pages as readonly Page[]).includes(restored) ? restored : 'home');
  ```
  An unrecognised stored page silently falls back. This is the template, and it
  is the reason a data rollback is survivable (§4).

`lastPage` has no reader outside the Workbook, so it is retired the same way
`history` was: `delete` it in `migrateSettings`, then drop it from `defaults()`.
Test fixtures set it at `tests/native-ui.spec.ts:103`,
`tests/readability.spec.ts:37`, `tests/responsive.spec.ts:42`, `:200`,
`tests/ui.spec.ts:738`, `:1155`, `:1251`, `:1280`, `tests/engine-selection.test.ts:27`,
`tests/onboarding.test.ts:28`.

---

## 4. Order of operations

Each step must leave `npx tsc --noEmit` and `npx vitest run` green, and the
Playwright configs in the root green too.

**`tsconfig.json` includes `"tests"`.** So a test file holding a typed `Settings`
literal is typechecked: removing a field from the interface turns
`tests/onboarding.test.ts:9` (`surface: 'console'`), `:28` (`lastPage: {}`) and
`tests/engine-selection.test.ts:27` (`lastPage: {}`) into TS2353 excess-property
errors. Those are **not** fixture nuisances deferred to a tidy-up pass; they are
`tsc` failures that must land in the same commit as the field removal. Every step
below names the tests that ship with it.

**Step 1 — Build the Everything flyout and a Console History. Nothing is removed.**
This comes first, not third. Until it lands, `Shell.tsx:1097` →
`App.tsx:711-718` is the Console's *only* route to History, and
`Rail.tsx:104-117` is the only route to Files/History/Engines (§6.1). Doing this
after step 2 leaves History dark in between — reachable only by a surface switch
that step 2 has already made a no-op.
The flyout's own contract is `planning/RAIL_DESTINATIONS.md` in this worktree; it
reaches the same conclusion independently (`:101` "History is the only Workbook
page with no Console equivalent", `:185` "the rail's History button must stop
exiting the Console", `:660` History earns a permanent rail entry rather than a
place behind the flyout). Build against that document, not against this one.
Ships with: new tests only. Green throughout — the flyout is additive.

**Step 2 — Make the Console the only answer.**
`client/components.tsx:46-51`: `surfaceOf` returns `'console'` unconditionally.
`server/store.ts:148-152`: every legacy spelling coerces to `'console'`; keep
writing the key. `server/store.ts:174` unchanged.
Every call site still compiles and every branch still exists; the Workbook simply
stops being reachable. Reversible by reverting one function.
**Ships with (or the suites go red here, not at step 7):**
`tests/surface.test.ts:19`, `:28`, `:34`, `:43` — all four assert a `'workbook'`
outcome; `tests/backend.test.ts:575` (asserts at `:585`).
Every `data-surface='workbook'` assertion, because `App.tsx:281` writes the
constant from this step on: `tests/ui.spec.ts:156`, `:183`, `:600`, `:758`;
`tests/native-ui.spec.ts:119`, `:626`; `tests/field.spec.ts:190`;
`tests/readability.spec.ts:189`; `tests/responsive.spec.ts:86`, `:184`, `:190`.
Plus the 11 `data-detail` assertions that expect a non-`technical` value
(`tests/ui.spec.ts:145`, `:157`, `:160`, `:262`, `:270`, `:506`, `:581`, `:603`,
`:753`, `:759`; `tests/native-ui.spec.ts:120`), since `App.tsx:284` also becomes
a constant here.

**Step 3 — Delete the switchers.** `client/App.tsx:633-653`,
`client/Settings.tsx:238-262`, `client/console/Shell.tsx:1036-1070`,
`client/console/Rail.tsx:108-110`, and `Shell.tsx:1096` (`onHome`).
`client/App.tsx:711-718` (`openInBook`), `Shell.tsx:79` (the prop type) and
`:107` (the destructure) go **only once step 1 has repointed `Shell.tsx:1097`**
— deleting the prop while `:1097` still calls it does not compile. If step 1 has
not landed, leave all four in place; they are one unit.
Ships with: `tests/ui.spec.ts:155`, `:599`, `:757` (click "The Workbook" by
name), `tests/field.spec.ts:167` (title and Workbook half).

**Step 4 — Delete the Workbook.** `client/Workspace.tsx` (all 2,547 lines),
`client/components.tsx:19-28` (`pages`), `:40-45` (`surfaceDescriptions`),
the `page` state and `navigate` in `client/App.tsx`, `shared/types.ts:17-27`
(`Intent` and `Page`), the `lastPage`/`leftOff.page` migration (§3.4),
`server/app.ts:118-128` (`pages`), `:389-395`, `:1139-1154`
(`PUT /left-off`), `server/modes.ts:12-13` and the eight copy blocks (§3.1).
CSS: only `.workbook-layout.home .section-title` (`styles.css:2747`) is provably
Workbook-only — `section-title` appears in `client/Workspace.tsx` (`:1238`,
`:1306`, `:1323`, `:1339`, `:1345`, `:1377`, `:1763`) and nowhere else in
`client/**/*.tsx`. See §6.4 before touching the other 19.
**Ships with:** removing `lastPage` from `Settings` breaks the typed literals at
`tests/onboarding.test.ts:28` and `tests/engine-selection.test.ts:27` at **`tsc`**,
and the fixtures at `tests/native-ui.spec.ts:103`, `tests/readability.spec.ts:37`,
`tests/responsive.spec.ts:42`, `:200`, `tests/ui.spec.ts:738`, `:1155`, `:1251`,
`:1280`. Also every Workbook-only spec: `tests/native-ui.spec.ts:622`,
`tests/ui.spec.ts:1130`, `:1199`, and the Workbook halves of
`tests/responsive.spec.ts:82`.
**This is the irreversible step** — see below.

**Step 5 — Retire the persisted key, part one.** `server/store.ts:148-152`
becomes `delete (settings as { surface?: unknown }).surface;`.
`server/app.ts:219-227` keeps accepting `surface` but **drops it silently**
instead of storing it. `defaults()` at `:174` still has the key.
Ships with: `tests/surface.test.ts` becomes an assertion that the key is *absent*
after migration; `tests/ai-setup-api.test.ts:121` (`expect(initial.surface).toBe('console')`).
Green, and critically: old stored files and old fixtures both still work.

**Step 6 — Retire the persisted key, part two.** Remove `surface` from
`defaults()` (`server/store.ts:174`) and `Settings` (`shared/types.ts:37`).
**Only now** does `validateSettings`'s `Unknown setting` guard (`server/app.ts:208`)
start rejecting `surface`.
**Ships with: every file in §5.2, plus the fixture lines in the five §5.1 files
that also carry one — 22 files in all, in this one commit.** `tsc` fails first on
the typed literal at `tests/onboarding.test.ts:9`; the 21 Playwright files then
fail at runtime with 400s (§6.3). There is no partial version of this step.

**Step 7 — Delete the type.** `shared/types.ts:14-15`, the two imports
(`client/App.tsx:7`, `client/components.tsx:10`), and `surfaceOf`
(`client/components.tsx:46-51`). Reword the §1.7 prose.
**Do not delete `client/App.tsx:281`** unless you have also handled
`client/console/console.css:6` and `client/ai-setup.css:83` — see §6.7. Keeping
it as the constant `root.dataset.surface = 'console'` is the cheaper option and
leaves the 7 `data-surface='console'` assertions passing.

### Which step is irreversible

**Step 4**, and it is irreversible in the source, not in the data.

Judged on "can an older build read the data directory afterwards", nothing here
is destructive. `migrateSettings` at `server/store.ts:151-152` derives a surface
from `detail` when the key is missing, so a rolled-back build meets a
surface-less settings file and lands the user somewhere coherent rather than
crashing. `lastPage` has the same tolerance at `client/App.tsx:177-179`, and
`leftOff.page` is never read. **Data rollback is safe at every step**, which is
worth saying plainly because it is the usual reason to fear step 5.

Step 4 is irreversible because `client/Workspace.tsx` is 2,547 lines of
UI with capabilities the Console does not have (§2.2). Restoring it after step 6
would mean restoring `Page`, `lastPage`, the `left-off` route and the surface key
together. Everything before step 4 is a revert; step 4 is a commitment.

---

## 5. The tests

**29 files: 7 need rewriting, 18 need only a fixture change, 4 need nothing.**
They fail in three distinct ways, and the distinction decides the work.

**Which step each one ships with is named in §4, not here.** None of these is a
tidy-up pass: `tsconfig.json` includes `"tests"`, so a typed `Settings` literal in
a test is a `tsc` failure, and the Playwright fixtures 400 rather than degrade
(§6.3). A step that does not carry its tests is not green.

### 5.1 Rewrite — the test is *about* the surface

| File | Test | Disposition |
| --- | --- | --- |
| `tests/surface.test.ts` | `'carries the old names onto the new ones'` (`:19`), `'still honours the detail level retired before the rename'` (`:28`), `'leaves the current names alone'` (`:34`), `'falls back to the detail level when nothing was stored'` (`:43`), `'is settled after one pass...'` (`:51`) | **Rewrite, do not delete.** All five become one test: every legacy spelling is *dropped* and never written back — modelled on the `history` tests in the same file. The second `describe`, `'the retired history retention settings'` (`:71-89`), is unrelated and **stays untouched**; deleting the file deletes it |
| `tests/backend.test.ts` | `"settings without surface get 'workbook' (standard) and 'console' (technical)"` (`:575`, asserts at `:585`, `:593`) | **Rewrite** to assert the key is absent after migration |
| `tests/ui.spec.ts` | `:155`, `:599`, `:757` click "The Workbook"; `:144`, `:156`, `:183`, `:580`, `:600`, `:752`, `:758` assert `data-surface` | **Rewrite.** Surface-switching tests lose their subject |
| `tests/native-ui.spec.ts` | `'Workbook Tasks header keeps every view label on one line'` (`:622`) plus `data-surface` asserts at `:119`, `:227`, `:342`, `:581`, `:626` | **Rewrite or delete `:622`** — it tests a Workbook layout that will not exist. The Board equivalent should replace it |
| `tests/field.spec.ts` | `'C04: the palette finds and filters, Escape closes, and the Workbook keeps its own search'` (`:167`, Workbook half at `:183-190`) | **Rewrite** — drop the Workbook half; the title changes |
| `tests/responsive.spec.ts` | `open(page, surface, ...)` helper (`:32`, selector switch at `:55`), `` `Workbook and Settings contain long content at ${width}px and ${scale} scale` `` (`:82`, called at `:86`, `:184`, `:190`), Console at `:161` | **Rewrite** — the helper's `surface` parameter goes; the Workbook-parameterised cases collapse into the Console ones |
| `tests/readability.spec.ts` | `:189` switches to `surface: 'workbook'` mid-test | **Rewrite** that assertion |

### 5.2 Fixture change only — the test writes `surface: 'console'` to get to the Console

These do not test the surface; they pass through it. Each needs the
`surface: 'console'` line removed once step 6 lands — and **not before**, because
of §6.3.

`tests/a6-acceptance.spec.ts:100`, `:154` · `tests/agent-ui.spec.ts:137` ·
`tests/ai-engines-ui.spec.ts:216`, `:426`, `:479`, `:524`, `:548` ·
`tests/allowance-ui.spec.ts:74` · `tests/app-updates-ui.spec.ts:157` ·
`tests/autonomy-ui.spec.ts:222` (plus `data-surface` asserts `:281`, `:469`, `:578`) ·
`tests/change-review-ui.spec.ts:46`, `:134`, `:145` ·
`tests/configuration-ui.spec.ts:104` · `tests/connections-ui.spec.ts:9` ·
`tests/design-studio-ui.spec.ts:95`, `:139`, `:150` ·
`tests/file-imports-ui.spec.ts:82` · `tests/files-pane-ux-20260917.spec.ts:94` ·
`tests/h01-preview-repair.spec.ts:83` ·
`tests/independent-h01-final-20260917.spec.ts:80` ·
`tests/onboarding.test.ts:9` · `tests/reviewer-ui.spec.ts` ·
`tests/workspace-ui.spec.ts:70` · `tests/ai-setup-api.test.ts:121`
(asserts `initial.surface === 'console'` — a real assertion, delete the line).

Seven of these also assert `data-surface` on `<html>` and break at **step 7**,
not step 6: `autonomy-ui`, `change-review-ui`, `design-studio-ui`, `field`,
`native-ui`, `reviewer-ui`, `ui`.

### 5.3 No change at all

| File | Why |
| --- | --- |
| `tests/theme-pack.test.ts` | All 16 hits are the theme-pack `Surface`, `SURFACES` and the `--surface` colour role. Unrelated type (§1.0a) |
| `tests/theme-runtime.test.ts:87`, `:97` | Sets `root.dataset.surface = 'console'` purely as a **foreign sentinel**, to prove `clearResolvedAppearance` leaves other people's dataset keys alone (`:97-99`). The theme runtime never reads `data-surface`. The value could be any string |
| `tests/design-center.test.ts:464` | A path string containing `console` |
| `tests/harness-present.test.ts:11` | One doc comment |

---

## 6. What makes this harder than it looks

### 6.1 History and document editing have no Console equivalent, and the Console's only route to History is the Workbook

This is the finding that changes the shape of the work.

`client/console/Shell.tsx:1097`:
```ts
onHistory={() => openInBook('history')}
```
and `client/App.tsx:711-718` implements `openInBook` by **switching the surface
to `'workbook'`** and navigating. The Console's History button is not a Console
feature — it is a door out of the Console.

The same is true of `onHome` (`Shell.tsx:1096`). And `Rail.tsx:104-117` is today
the *only* entry to Files, History and Engines.

What is actually lost, verified:

- **History browsing, restore, conflict handling and undo.** `Workspace.tsx:452-497`
  (`restoreEntry`, hitting `POST /history/:id/restore`) and `:1696-1843`. Nothing
  under `client/console/` calls that route. `client/console/Ledger.tsx:79-90`
  shows `state.history.slice(-3)` — three entries, read-only, no restore.
  Beware one homonym while checking this: the Console *does* have a restore, at
  `client/console/design-center/themes-api.ts:44`
  (`/themes/:id/restore/:revision`), but that restores a **theme version**, not a
  file. It is the only `/restore` under `client/console/` and it is unrelated.
- **Document editing.** `Workspace.tsx:1552-1607`, the `saveDocument` writer at
  `:306`, its Save button at `:1095` and the `Ctrl+S` handler at `:1122-1125`.
  `client/console/FilesPane.tsx:21-22` rules it out by design:
  *"It is not an editor: the pack tier owns code reading, editing, Git and diffs,
  and none of that is here."*

Consequence for the plan: the Everything flyout is **not sufficient** to replace
the Workbook. A flyout that lists a destination which does not exist is worse
than the rail button it replaced. Either a Console History gets built (step 1),
or the owner accepts losing restore — and restore is the recovery path for
`review`, which makes it a safety decision, not a UI one. Do not let step 4 be
scheduled before this is answered.

### 6.2 Removing the Workbook silently retires the `Detail` setting

`Detail` (`shared/types.ts:13`, `'guided' | 'standard' | 'technical'`) is the
*other* simplicity lever, and it dies as a side effect nobody asked for.

- `client/App.tsx:284`: `root.dataset.detail = surface === 'console' ? 'technical' : settings.detail`. With one surface this is the constant `'technical'`. **This attribute is inert for styling** — a repository-wide grep for `data-detail` / `dataset.detail` finds `App.tsx:284` as the only writer and *no* CSS or TypeScript reader. Its only readers are 11 Playwright assertions (§4 step 2). So nothing renders differently because of this line; the damage is done by the two bullets below, not by this one.
- `client/Settings.tsx:263-277`: the guided/standard picker is inside `{surface === 'workbook' && (...)}`. Delete the gate and the control goes with it.
- `client/App.tsx:653-660`: the account-menu Detail picker has the same gate.
- Both surface switchers actively *demote* technical on the way to the Workbook (`App.tsx:642-644`, `Settings.tsx:250`, `Shell.tsx:1056`), which is the coupling in reverse.

The Console is not indifferent to `detail`. It reads it at
`client/console/Shell.tsx:1430` — `<ChangeCard ... detail={settings.detail}>`.
So after the refactor `settings.detail` is still *consumed* by the Console while
having become *unsettable* by the user and pinned to `'technical'` at the root.
That is an incoherent end state either way it is resolved.

**This is an owner decision and it blocks the contract being complete.** Either
(a) the Console starts honouring `detail` and keeps the picker, or (b) `Detail`
is retired too — which is a *third* persisted-field migration (`Settings.detail`
at `shared/types.ts:13`/`:35`, `Settings.onboarding.detail` at
`shared/types.ts:43`, `server/app.ts:217-218`, `server/store.ts` defaults) and a
larger job than the one being scoped. Do not pick one in the implementation.

### 6.3 Removing `surface` from `defaults()` turns every stale client and fixture into a 400

`server/app.ts:206-208`:
```ts
for (const key of Object.keys(supplied))
  if (!Object.hasOwn(defaults(), key)) throw new ApiError(400, `Unknown setting: ${key}`);
```

`validateSettings` rejects **any** key absent from `defaults()`. And the client
does not send deltas — it echoes the whole settings object:
`client/Settings.tsx:277` (`save({ ...settings, detail: d, surface: 'workbook' })`),
`client/console/Shell.tsx:1053-1057`, `client/App.tsx:638-646`, `:712-717`, all
through `writeSettings` / `patchSettings` (`client/api.ts:193`, `:203`).

So the moment `surface` leaves `defaults()`:

- Any client holding a settings object read *before* the migration started
  deleting the key echoes `surface` back and gets **400 Unknown setting: surface**
  — a failed save, not a silent no-op.
- **All 22 fixture files fail** — 21 Playwright specs plus
  `tests/onboarding.test.ts` (vitest) — because they `PUT /api/settings` with
  `surface: 'console'` to reach the Console. They do not degrade; they 400 in
  `beforeEach` and take every test in the file with them. That is most of the
  suite, and it will look like a catastrophic regression rather than a fixture
  problem. `tests/onboarding.test.ts:9` fails earlier still, at `tsc`, because
  `tsconfig.json` includes `"tests"` and the literal is typed `Settings`.

This is why §4 splits the retirement across steps 5 and 6: **migration must
delete the key, and `validateSettings` must accept-and-drop it, for one release
before `defaults()` loses it.** Doing steps 5 and 6 in one commit is the single
most likely way to make this refactor look broken.

The identical trap applies to `lastPage` (§3.4), which has fixtures in ten files.

### 6.4 `.workbook-layout` is a shared layout primitive — deleting it breaks Settings

The name is a lie about its scope. Three components use it, and **two of them
survive**:

- `client/App.tsx:762` — `<div className="workbook-layout home">`. This is the **projects landing page**, not the Workbook. Confirmed by the selector `.projects-page > .workbook-layout` at `client/styles.css:1262`, `:2190`, `:2225`, `:3005`.
- `client/Settings.tsx:231` — `<div className="workbook-layout">`. **Settings.** Also keyed by `client/ai-setup.css:83`: `:root[data-surface='console'] .settings-layout .workbook-layout`.
- `client/Workspace.tsx:1231` — the actual Workbook.

Of the 20 `.workbook-layout` selectors in `client/styles.css` (`:880`, `:909`,
`:1262`, `:2088`, `:2096`, `:2150`, `:2190`, `:2215`, `:2225`, `:2346`, `:2735`,
`:2738`, `:2741`, `:2744`, `:2747`, `:2993`, `:2997`, `:3004`, `:3005`, `:3067`),
**none can be deleted on the grounds that the Workbook is gone.** Even the
`.workbook-layout.home` ones (`:2735-2747`, `:2993-2997`) are claimed by
`App.tsx:762`. Only `.workbook-layout.home .section-title` (`:2747`) has no
surviving user, and `.workbook-layout.working` (`:909`) loses its `working`
modifier, which is set at `Workspace.tsx:1231`.

Correct disposition: **keep the class, rename it later in a separate commit.**
The two CSS rules that also key on `[data-surface='console']` are covered in
§6.7; do not touch them here.

### 6.5 Surface-conditioned text is written into persisted conversation history

`server/app.ts:2489-2494` chooses between *"Turn an engine on in Settings >
Engines."* and *"Turn a helper on in Settings > Helpers on this computer."* based
on `store.settings.surface`.

That string is assigned to `answer`, which becomes `turn.text` at
`server/app.ts:2566`, is pushed onto `conversation.turns` at `:2584`, and is
persisted by `store.persist(state)` at `:2586`.

So **the surface is already recorded, permanently, inside stored conversation
history**. Every existing user who hit the sample route without an engine has a
turn in their history whose wording is determined by a concept that is about to
stop existing. Those turns are immutable evidence — History is treated as
evidence throughout this codebase (`server/store.ts:136-138`,
`tests/surface.test.ts:62-66`) — so they cannot be rewritten.

Two consequences:

1. The refactor cannot claim "no trace of the surface remains". It will remain in
   user data, in words, indefinitely. If anything asserts on historical turn text,
   it will see both strings.
2. The "Settings > Helpers on this computer" phrasing points at a Settings
   section that the Workbook's removal may also rename or delete. Check that
   destination still resolves before changing the surviving string.

### 6.6 Smaller traps, each of which has bitten a find-and-replace before

- **Two exported types named `Surface`** (§1.0a). `client/App.tsx:281` and `:298` are fourteen lines apart and belong to different systems. `:281` becomes a constant (§6.7); `:298` is untouched.
- **`client/components.tsx:19-28` has eight pages; `shared/types.ts:18-27` and `server/app.ts:118-128` have nine** (§2.1). Anyone reconciling the lists by making them match will re-add Connections to a rail that is being deleted.
- **`Intent` is already dead** (§2.3). Time spent mapping it is wasted; the answer is a one-line delete.
- **`server/modes.ts`'s `console` field is as dead as its `workbook` field** (§3.1). Do not "keep the Console half" — nothing reads either.
- **`client/console/Shell.tsx:1040`** labels the surface menu `aria-label="Interface detail menu"` though it contains only surface buttons. Any test or query selecting by that label is selecting the surface menu.
- **`client/console/ImportFiles.tsx:144`** says "spreadsheet workbooks". `server/harness/adapters.ts:143` says "tool surface". Both match a naive grep.
- **`tests/theme-runtime.test.ts:87`, `:97`** set `dataset.surface` as a deliberate foreign value to prove isolation. "Fixing" it defeats the test's purpose.
- **`client/console/Shell.tsx:304`** is the string `'history'` in an SSE event-name list (`:298-309`), not a page or a route (§1.0c).

### 6.7 Deleting `data-surface` breaks the surface that survives

The obvious last step — "remove `root.dataset.surface` now that there is one
surface" — takes styling off the **Console**, not the Workbook.

`client/App.tsx:281` writes the attribute. Two stylesheets read it:

- `client/console/console.css:6-8` — `html[data-surface='console'] body { background: var(--chrome); }`. This is the Console body background. Nothing else sets it: `.console` paints itself `var(--chrome)` at `console.css:18`, but the `<body>` behind that grid is painted only by this rule. Delete the attribute and the body falls back to whatever `client/styles.css` gives it, which will show through wherever the `.console` grid does not cover — overscroll, rubber-banding, and any viewport taller than the grid.
- `client/ai-setup.css:83` — `:root[data-surface='console'] .settings-layout .workbook-layout { ... }`. The AI-setup layout inside Settings, which survives (§6.4).

Seven Playwright files also assert `data-surface='console'`
(`autonomy-ui`, `change-review-ui`, `design-studio-ui`, `field`, `native-ui`,
`reviewer-ui`, `ui`).

**Two options; the document does not pick one, but the cheaper is obvious.**

1. **Keep the attribute as a constant.** `client/App.tsx:281` becomes
   `root.dataset.surface = 'console'`, exactly as `:284` becomes a constant
   `'technical'`. Cost: one vestigial attribute naming a concept that no longer
   varies. Benefit: `console.css:6` and `ai-setup.css:83` keep working untouched,
   and all seven assertions keep passing. Nothing else in step 7 changes.
2. **Delete it.** Then `console.css:6` must be rewritten to an unconditional
   `body { background: var(--chrome); }` — check it does not then apply on the
   projects landing page or Settings, which are `body` too — `ai-setup.css:83`
   must lose its prefix, and all seven assertions must be removed.

Option 1 is one line and zero risk; option 2 is a CSS specificity question on the
surviving shell's background. If the goal is "no dead concepts in source", option 2
is the honest one, but it is a separate, verifiable piece of work and should not
ride along inside step 7.
