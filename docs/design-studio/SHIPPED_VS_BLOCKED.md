# Design Center — what is built, what is not, and what is blocked

Dated 2026-09-18, for branch `feature/app-design-studio-20260917` (`033dd27..`), which has
**not** been merged, pushed, released or deployed. Nothing here is a claim about a shipped
product; it is a claim about what is on this branch and what it does when run.

The point of this file is that nobody has to guess. Every row says which of three things it
is: **built and proven**, **built with a known gap**, or **blocked** — and blocked rows say
what is blocking them rather than implying they are nearly done.

---

## 1. Built and proven

Each row names the code and the test that proves it. "Proven" means a test in this branch
fails if the behaviour goes away.

| What | Where | Proof |
|---|---|---|
| ThemePack v1: a theme is data, validated, with no CSS strings, HTML, scripts, remote URLs or font downloads | `shared/theme-pack/` | `tests/theme-pack.test.ts` |
| A theme applies by setting custom properties and dataset on `document.documentElement` — no reload, no remount, no engine restart | `client/theme-runtime.ts` | `tests/theme-runtime.test.ts`, browser `D01` |
| An unreadable or corrupt active pack falls back to last-known-good, then to the base scheme, and says so | `server/themes.ts` | `tests/themes.test.ts`, browser `D03` |
| Theme storage is scoped per workspace and person; two accounts cannot see each other's themes | `server/themes.ts` (`themeScopeKey`) | `tests/themes.test.ts`, acceptance `A6-12` |
| Recorded revisions are never rewritten; a save without the revision being edited is a 409, not a merge | `server/themes.ts` | `tests/themes.test.ts` |
| The editor: real components in the preview, Design vs Interact, undo/redo/reset, before/after | `client/console/design-center/` | browser `D04`, `D05` |
| Design mode selects a real control and never fires its action — nothing runs, nothing is sent | `client/console/design-center/Preview.tsx` | browser `D04` |
| Autosaved drafts are never the applied theme; the applied theme changes only on Apply | `client/console/design-center/session.ts`, `server/theme-routes.ts` | browser `D01`, `D15` |
| An edit made before the entitlement status arrives is held and autosaved once it does | `client/console/design-center/session.ts` | browser `D15` |
| Artwork import: a picture is read from its bytes, stored in the pack, and travels with it | `client/console/design-center/Artwork.tsx`, `server/theme-assets.ts` | `tests/theme-assets.test.ts`, browser `D07`, `D11` |
| A texture is capped so text over it stays readable, and the cap is explained in the screen | `shared/theme-pack/resolve.ts` | browser `D08`, `D09` |
| A file the app cannot read is refused with a sentence, not a stack trace, and nothing is stored | `client/console/design-center/` | browser `D10`, acceptance `A6-11` |
| `.diomedes-theme` export and import round-trip, assets included, every hash checked on the way in | `shared/theme-pack/package.ts` | `tests/theme-pack.test.ts`, acceptance `A6-05` |
| The Website target states compatibility before exporting, and detects the local Website Studio over loopback only | `server/website-studio.ts`, `client/console/design-center/WebsiteTarget.tsx` | `tests/design-center.test.ts`, browser `D06` |
| The capability check is real and enforced at the route, not in the buttons | `server/customization-gate.ts`, `shared/customization-entitlement.ts` | `tests/customization-entitlement.test.ts`, browser `D12`–`D14` |
| The free half — reading, discarding a draft, the safe reset, text size — is never gated | `server/theme-routes.ts` | `tests/customization-entitlement.test.ts` |
| An entitlement that cannot be checked refuses new premium changes, and the applied theme keeps being applied | `server/customization-gate.ts` | `tests/customization-entitlement.test.ts` |
| The included customization benefit is a ledger: consumed once, retries are not second events, a failed draft is still owed | `server/customization-benefit.ts` | `tests/customization-benefit.test.ts` |
| The desktop titlebar resolves a chrome/text pair from a custom theme's base scheme | `desktop/main.mjs` | `npm run test:desktop` |

## 2. Built, with a known gap

These work. Each one has something a reader should know before relying on it. They are the
deferred minors from the A1–A5 reviews and the implementers' own concerns, gathered in one
place rather than left in five report files.

| Gap | Why it is a gap | Where it is written down |
|---|---|---|
| **The texture ceiling is worst-case.** There is no image decoder, so a dark texture on a dark theme is capped as hard as a white one — 0.03–0.08 on the shipped schemes. | A theme author expecting a bold texture gets a subtle grain. The screen says why. The honest fix is lighter text roles, or decoding the picture, which is one function with one call site. | A4 report, concerns 1–2 |
| **No derivatives.** A 16-megapixel picture is downloaded and scaled by the browser on every paint. | Fine for a logo on loopback; it is not a thumbnail pipeline. | A4 report, concern 3 |
| **Orphaned asset bytes are never collected.** Removing a picture from a pack leaves its bytes on disk. | Storage grows with editing. Nothing reads them. | A4 review, deferred |
| **The preview restates rules from `client/styles.css`.** `client/console/design-center.css` mirrors them scoped to the stage. | A change in one place that misses the other makes the preview lie. A drift test in `tests/design-center.test.ts` fails when a rule is added to one and not the other, with an allowlist for the deliberate exceptions. | A3 report, concern 3 |
| **The stage cannot reproduce the `!important` reduced-motion freeze**, so reduced motion in the preview is a control the designer turns on rather than the designer's own setting. | This is correct behaviour — the designer is previewing what *someone else* sees — but it means the two are not the same mechanism. Proven and screenshotted in `A6-10`. | A3 review, deferred |
| **`--dm-texture-opacity` is emitted and nothing paints it.** | The channel is declared and `data-texture='off'` zeroes it; no painted texture layer exists in the app outside the artwork slots. The bundle README says so. | A2 report, concern 2 |
| **`client/Settings.tsx` still saves the whole settings object in three places.** | The known 409 race (QUESTIONS O9). `If-Match` mitigates it and the Design Center itself uses the narrow patch. | A2 review, deferred; A3 report |
| **Draft PUTs create one folder per theme id with no bound.** | A person who types many names while saving-as leaves folders behind. Nothing reads them. | A3 review, deferred |
| **The Website Studio probe cannot tell the studio from anything else on port 4400.** | A foreign listener on 4400 makes the app say the studio is running. This actually happened twice during A4 and A5. | A4 report, concern 5 |
| **The Inspector is fully editable without the capability.** | Someone with no plan can change everything and watch the preview, then find there is no way to keep it. The locked banner states this up front instead of gating every control. Worth a UX decision. | A5 report, concern 4 |
| **The per-request fixture header is a test seam in a shipped file.** | Double-gated (`DIOMEDES_TEST_MODE=1` *and* a launch fixture), with negative-control tests, and as of `eae1333` an unrecognised name is a 400 rather than a quiet fallback. It is still a line whose only purpose is testing. | A5 report, concern 3 |
| **Three existing test files depend on a fixture profile.** | Removing `DIOMEDES_ENTITLEMENT_FIXTURE` would silently turn 37 storage tests into 403s. Commented in each file. | A5 report, concern 5 |
| **The handoff bundle in `F:\Diomedes\deliverables\theme-pack-v1\` is a copy, not a package.** | If any of the five source files changes, the bundle goes stale silently. `npm run theme-pack:handoff` re-makes it. | A1 report, concern 5 |
| **Motion preset ids (`none|settle|drift|signal|lift`) were chosen here**, not by the owner, and the website's Motion V3 Signal work may have its own vocabulary. | They are the app's vocabulary and the website extends rather than shares them, but the two should be reconciled before anything public depends on the names. | A1 report, concern 4; A1 ruling |
| **`paper.attn` differs between `client/schemes.ts` and `client/styles.css`.** | The mirror follows `schemes.ts` and a drift test pins it there. Someone should decide which is canonical. | A1 report, concern 2 |
| **`themeScopeKey` is duplicated in `desktop/main.mjs`.** | Six lines, because Electron cannot import the service's TypeScript. A text-level guard fails when the two stop agreeing; no test drives a real Electron titlebar against a custom theme. | A2 report, concern 4 |
| **There is no delete route for a theme.** | Nothing needs one yet. | A2 report, concern 5 |
| **Every refused write inside `store.locked` costs a store reload.** | Pre-existing `locked` behaviour, not introduced here. The editor validates before sending to keep refusals off the hot path. | A2 report, concern 6 |

## 3. Blocked — and what is blocking it

Nothing in this section is partially present. Each is named so no reader mistakes a test
fixture for a purchase.

| Blocked | State in this repository | Blocked on |
|---|---|---|
| **Buying customization at all** | There is no signup, no checkout and no plan to be on. | Everything below. |
| **Hosted identity** | No hosted identity provider is installed. `verifySubject` in the control-plane contract refuses every claim a `development-fixture` produces, and `HOSTED_BUSINESS_UNAVAILABLE_REASON` is the honest answer for creating an organization. | WorkOS AuthKit, work order **B02.I**. Without a verified subject there is nobody an entitlement can be bound to. |
| **Billing** | `server/billing-events.ts` is a processor for a stream nothing produces. No webhook endpoint, no signature verification, no Stripe SDK, no customer or subscription mapping. | Stripe integration. Not started. |
| **Plan catalogue** | No plan table, no plan version registry and no price anywhere in the code. `plan_business` is a fixture id whose doc comment points at `docs/business/PRICING_STRATEGY_2026-09-15.md`. | A catalogue decision. `CUSTOMIZATION_PLAN_IDS` is the placeholder it would replace. |
| **Entitlement service** | `entitlementFor()` in `shared/workspaces.ts` returns `none` by design, and `snapshotFromView` can only ever produce `none`. Every `active` snapshot in this codebase comes from a named fixture, and fixtures are unreachable without `DIOMEDES_TEST_MODE=1`. | Identity and billing above. |
| **Organization branding** — one company-wide theme every member wears | `canActivateOrganizationRevision` checks it and refuses correctly. There is no surface for it. | A product decision plus the entitlement service. |
| **Offline grace** | There is none. An entitlement that cannot be checked refuses new premium changes immediately; the applied theme keeps being applied, and reset and accessibility always work. | An owner decision: no grace (shipped), a bounded window of N days that must not survive a reinstall, or nothing. See §4. |

**None of the above may be described as shipped, in progress, or nearly ready.**

## 4. What only an owner can decide

These are written down because the code deliberately does not prejudge them.

1. **A shipped build refuses the whole Design Center.** With no entitlement service,
   `hasCustomizationEntitlement` is always false. Unless Diomedes is started with
   `DIOMEDES_DESIGN_AUTHORING=1`, nobody can save, apply or import a theme in a real build.
   That is the honest behaviour, and it means A1–A4's work is reachable today only through
   that launch-time authorization. This needs an explicit acknowledgement before any release.
2. **Offline grace.** No window exists. A paying customer on a plane loses authoring the
   instant the check cannot be made. The alternatives and their costs are in the A5 report,
   §6. It would be one branch in `CustomizationGate.snapshotFor` plus one durable record.
3. **`customer_review` has no failure path.** `fail` is accepted from `draft` only, per the
   brief. A customer who rejects at review leaves the record stuck in `customer_review` with
   no step that moves it. Either `fail` also from `customer_review`, or a separate `revise`.
4. **Who may move the benefit.** `request`, `draft`, `review`, `accept` and `fail` are
   member-level today. Owner/admin may be the right bar for `accept`.
5. **Whether the Inspector should be gated on the free tier**, or keep stating the situation
   in a banner and letting people play.
6. **Whether the motion preset names are the product's names.**

## 5. How to use it today

For a person: `docs/design-studio/QUICK_START.md`.

For a build: start the service with `DIOMEDES_DESIGN_AUTHORING=1` in the environment. It is
read once, at construction, from the environment the service was started in; it cannot be
turned on from inside the running app, it grants authoring on the local scope only, and it
grants no organization activation and no agent authority whatsoever.

## 6. Where the evidence is

- Gate results, per-spec counts and the acceptance walk:
  `.superpowers/sdd/app-design-studio-plan/task-6-report.md`.
- Screenshots and measurements: `docs/verification/2026-09-17-design-center/`.
- The acceptance walk is re-runnable:
  `npx playwright test --config playwright.acceptance.config.ts`.
- The per-task records, with each review and each fix round:
  `.superpowers/sdd/app-design-studio-plan/task-1-report.md` … `task-6-report.md`.
