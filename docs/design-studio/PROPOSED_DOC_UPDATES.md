# Proposed wording for the canonical documents — Design Center

**2026-09-18 — the owner decided, and one sentence below is superseded.** Andrew decided that
the Design Center is published on diomedes.net as `in-progress`, and that the appearance work
is included in a Diomedes Business subscription — our own design team builds and installs the
first look and delivers one graphical update a month — with no price moved and no add-on
created. That decision is recorded in the website repository as commit `5272b97` with its
verification record `docs/verification/2026-09-18-design-included.md`. It supersedes the
closing sentence of this file — "it must not appear on the website at all until it can produce
an honest capture of something a visitor could actually buy or use" — and with it the "No
mention on the website" bullet in the roadmap section, which omitted the capability because it
is not purchasable. The release notes for v0.1.3 are written to agree with the decision.
Everything else in this file stands as the historical proposal it was written as, unedited.

**Status: proposed, unpublished, and not applied.** Nothing in
`docs/DIOMEDES_CORE_PILLARS.md`, `docs/DIOMEDES_LIVE_ROADMAP.md`,
`docs/DIOMEDES_PROJECT_MEMORY.md` or `docs/business/PRICING_STRATEGY_2026-09-15.md` was
edited by this work. This file exists so Andrew can accept, change or reject exact sentences
rather than a summary of them.

Every proposal below is bounded by one rule: the branch is not merged, not pushed, not
released and not deployed, and customization is not purchasable. No proposed sentence may
read as a capability announcement.

---

## PILLAR IMPACT

**Pillars advanced.**

- **Pillar 05 — Self-setup and self-maintenance are primary product requirements.** The
  Design Center needs no AI, no account, no internet, no model, no token budget and no chat
  prompt. It runs on the computer in front of the person, has one entry point inside the app
  (Settings → Design Center), and the way back is always available: Settings → Appearance and
  a built-in scheme, ungated, no network. Proof: `A6-07` and `A6-10` in
  `docs/verification/2026-09-17-design-center/`, and the free-half assertions in
  `tests/customization-entitlement.test.ts`.
- **Pillar 09 — Trust, data choice and billing are part of the architecture.** Entitlement
  is a separate enforced concept, resolved in one place (`server/customization-gate.ts`) from
  records rather than from client input, and enforced at the route rather than by hiding
  buttons — proven by raw requests in `tests/customization-entitlement.test.ts` and by `D12`.
  Basic safety is not premium: reading, discarding a draft, the safe reset and text size are
  never gated, and the contrast and reduced-motion floors are mandatory and cannot be
  designed away. The one outward request in the whole feature is a loopback probe to
  `127.0.0.1:4400` with a one-second cap.
- **Pillar 12 — One strong core; different experiences without artificial crippling.** The
  preview is the app's own components with fixture data, not a mock-up of them, so the
  simple view is not a fake one. A theme is data mapped onto existing custom properties; it
  can never carry CSS, HTML, script, a remote URL or a font download.

**Risks and conflicts, named.**

- **Pillar 12 tension.** Customization is a paid capability while the Inspector stays fully
  editable without it. Someone on the free tier can change everything, watch the preview, and
  then find there is no way to keep it. Today a banner states the situation up front; the
  alternative is gating controls, which is the "artificial crippling" the pillar warns
  against. This is an owner decision, recorded in `SHIPPED_VS_BLOCKED.md` §4.5.
- **Pillar 09 tension.** There is no offline grace. A customer who has paid loses authoring
  the instant the entitlement cannot be checked. That is right in the strict direction and
  wrong for a paying customer on a plane. Owner decision, `SHIPPED_VS_BLOCKED.md` §4.2.
- **Honest-status risk.** The single largest drift risk in this whole lane is a document or
  a website page describing the Design Center as available. It is not purchasable, and in a
  real build it is refused unless the service was started with `DIOMEDES_DESIGN_AUTHORING=1`.
  Every proposal below is written to make that impossible to misread.

**Observable proof.** Four gates green, 83/83 browser tests, 13/13 acceptance checks, the
desktop smoke passing on a test profile, and twenty-three screenshots plus
`measurements.json` in `docs/verification/2026-09-17-design-center/`. Counts and commands are
in `.superpowers/sdd/app-design-studio-plan/task-6-report.md`.

---

## 1. `docs/DIOMEDES_LIVE_ROADMAP.md`

### 1a. Section 4, item A — one clause, corrected

**What is there now (line 92):**

> A. Finish the usable shared Console experience around the approved Settings > Engines
> typography/spacing/controls while deliberately retiring Workbook functionality. User-selected
> theme remains intact. Technical depth is optional, not another visual product.

**Why it needs a word.** "User-selected theme remains intact" now has a second meaning: a
person can author a theme, not only select one of the built-ins. The sentence is not wrong,
but it no longer says everything a reader needs.

**Proposed replacement for that one clause:**

> User-selected appearance remains intact, and now includes an author-made theme where the
> capability is granted.

Nothing else in item A changes.

### 1b. Section 10 — a new change-record line

The roadmap records implementation status in section 10. This is the honest form of that
record. It is not a release line and does not change any status elsewhere.

**Proposed new line, to be inserted above `2026-09-15.5`:**

> 2026-09-17.3: implemented the in-app **Design Center** on `feature/app-design-studio-20260917`
> — **not merged, not pushed, not released, not deployed.** One entry point inside the app
> (Settings → Design Center) where a person changes colour, type, surfaces, motion and
> artwork with no AI, no account, no internet, no model and no prompt involved. A theme is
> data — ThemePack v1 in `shared/theme-pack/` — validated against a closed key set and mapped
> onto existing CSS custom properties and dataset attributes; it can never carry CSS text,
> HTML, script, a remote URL, a font download or executable motion. Applying one changes
> presentation without remounting the app, restarting an engine, navigating or reloading.
> The preview is the app's own components with fixture data; Design mode selects a control
> without firing it, and nothing in the screen can call a provider, start an agent, approve
> an action or send a message. Storage is scoped per workspace and person, revisions are
> never rewritten, drafts are never the applied theme, and contrast and reduced-motion floors
> are mandatory and override any theme. A theme exports as one `.diomedes-theme` file that
> carries its pictures, for upload to the website's own Website Studio, which the app detects
> over a single loopback probe with a one-second cap and never edits. **Customization is a
> paid capability that cannot be bought:** there is no hosted identity (WorkOS AuthKit, B02.I),
> no billing integration, no plan catalogue and no entitlement service, so
> `entitlementFor()` returns `none` by design and a real build refuses the Design Center
> unless started with `DIOMEDES_DESIGN_AUTHORING=1` — a launch-time authorization that grants
> authoring on the local scope only and grants no organization activation and no agent
> authority. The included "we will design it with you" engagement exists as a ledger
> (`server/customization-benefit.ts`) that records where one engagement stands; it is not a
> billing system and nothing charges for it. Verified on the branch tip: `tsc` clean, 2077
> unit tests passed and 1 skipped across 112 files, `vite build` clean, 83 browser tests
> passed across 14 specs with none skipped and none flaky, the packaged desktop smoke passed
> on a throwaway profile, and a 13-step acceptance walk with screenshots is in
> `docs/verification/2026-09-17-design-center/`. What is built, what has known gaps and what
> is blocked is enumerated in `docs/design-studio/SHIPPED_VS_BLOCKED.md`. This line records
> implementation status on an unmerged branch, not a release.

### 1c. Section 9 — one addition to the open decisions

**What is there now (first sentence of section 9):** a list beginning "Production identity
provider/recovery and device-key compatibility; billing provider implementation and offline
entitlement rules; …".

**Proposed:** add two items to that same list, in the same style:

> …; whether appearance customization is a paid capability at all and under which plan;
> whether an offline entitlement grace window exists for authoring, and if so its length and
> whether it survives a reinstall (it must not, or it is a bypass); …

"offline entitlement rules" is already in the list, which is why the second item narrows it
rather than repeating it.

### 1d. What must **not** be added

- No status change for any capability. The Design Center is not on a shipped list.
- No entry in section 3 ("Current published evidence checkpoint"). Nothing was published.
- No mention on the website. Under the website translation contract (Core Pillars, item 7),
  a capability that cannot produce an honest available-today capture is labelled planned or
  omitted. This one is not purchasable, so it is omitted.

---

## 2. Pricing — proposed **note only**, no price

`docs/business/PRICING_STRATEGY_2026-09-15.md` is the pricing authority and is not edited
here. No price is proposed, because proposing one would be inventing a product boundary that
has not been decided.

**What is true today and can be written down without deciding anything:**

- There is no plan catalogue in the code: no plan table, no plan version registry, no price.
  `plan_business` is a fixture id whose doc comment points back at the pricing document.
- The code names two separate things, and they should not be conflated in any future pricing
  line:
  1. **The customization capability** — may this person author and apply a theme. Checked by
     `canEditThemeScope`.
  2. **The included customization engagement** — one "we will design it with you", recorded
     as a ledger that is consumed once per organization and is still owed if a draft fails.
     This is delivery work, not a capability badge, and the standing rule that service scope
     is not a capability badge applies to it directly.

**Proposed addition to `docs/business/PRICING_STRATEGY_2026-09-15.md`, as a note under the
Business subscription scope** (wording for Andrew to accept or reject; not a price):

> Appearance customization. Diomedes Business is expected to include the ability for a
> business to give the app its own colours, type and artwork, and one included
> "we will design it with you" engagement per organization, delivered once. Neither is
> purchasable today: there is no plan catalogue, no billing integration and no entitlement
> service, and the capability check in the product refuses without one. The included
> engagement is bounded delivery work, not an unlimited design service, and like every other
> service scope it is not a capability badge. No separate price, add-on or per-theme charge is
> approved.

**What must not be written anywhere until it is decided:**

- A per-theme, per-brand or per-location customization charge.
- "Custom branding included" on any public page, since organization branding — one
  company-wide theme every member wears — is checked but has no surface.
- Any implication that a customer can buy customization now.

---

## 3. Design and terminology — `docs/DIOMEDES_PROJECT_MEMORY.md`

That document holds definitions. Five words in this lane are load-bearing and are currently
defined only in code comments and reports.

**Proposed definitions, for the definition index:**

> **Design Center.** The one place inside the Diomedes app where a person changes how
> Diomedes looks. Console-only. Needs no AI, account, internet, model or prompt. It designs
> two targets — this app, and the website — and it never edits website pages.
>
> **Theme / ThemePack.** A theme is data, never a plugin: a validated ThemePack v1 document
> whose values the renderer maps onto existing CSS custom properties and dataset attributes.
> A theme cannot contain CSS text, HTML, script, a remote URL, a font download or executable
> motion, and applying one never navigates, reloads or restarts anything.
>
> **`.diomedes-theme`.** The one-file package a theme exports to: a JSON container holding the
> pack, its pictures and a manifest whose checksums are verified on the way in. It is how a
> theme made in the app reaches the website.
>
> **Website Studio.** The website's own editor, a separate program on the same computer. The
> app detects it with a single loopback probe to `127.0.0.1:4400` with a one-second cap, links
> to it, and does nothing else with it.
>
> **Design authoring (`DIOMEDES_DESIGN_AUTHORING=1`).** A launch-time authorization, read once
> from the environment the service started in, that grants theme authoring on the local scope.
> It cannot be turned on from inside the running app. It grants no organization activation,
> no spending and no agent authority. It exists because customization is not purchasable yet,
> and it is not a plan.

**Proposed usage rule, for the same document:** in any user-facing text the screen is the
**Design Center**, never "Design Studio" or "theme editor"; **Website Studio** is the
website's program and is always named in full.

---

## 4. If a single line is wanted for a status registry

Should the Design Center ever appear in a capability registry, the honest row is:

> **Appearance customization** — *planned*. Built and verified on an unmerged branch; not
> purchasable, and refused in a real build without a launch-time authorization. Blocked on
> hosted identity (B02.I), billing and a plan catalogue.

It must not appear as available, in progress, or nearly ready, and it must not appear on the
website at all until it can produce an honest capture of something a visitor could actually
buy or use.
