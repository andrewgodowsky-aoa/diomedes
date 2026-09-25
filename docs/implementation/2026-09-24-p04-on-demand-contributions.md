# P04: pack contributions load on demand

Date: September 24, 2026. Lane `p04-on-demand`, branch `feature/p04-on-demand-contributions`,
Linear DIO-30. Base `integration/overnight-batch-5` (`bc7833f`).

Canonical documents read: Core Pillars 2026-09-22.1, Live Roadmap 2026-09-24.1, Project Memory
2026-09-24.1. None is edited here; the proposed patch is at the end. Also read:
`docs/product/2026-09-10-capability-packs.md`, the P01–P03 lifecycle record, H11 nested-rule
delivery, H12 mediated effects, H18 context accounting.

---

## What was true before this slice

- Activation was per Project and recorded (P03), and `loadedContributions` answered "which packs
  are on here" with every contribution declaration of each active pack. Nothing distinguished an
  index from a body, nothing recorded a body being used, and no digest was checked at use.
- A Small Business skill reached a model only on the `/ask` route, only when the person chose it,
  rendered from code at send time. The turn recorded pack id and version, not what bytes went.
- Model-API conversation routes (AWS, Azure, OpenRouter, Google Cloud) offered no playbooks at all.
- Software Engineering instruction files were already delivered per run by H11, each body read at
  delivery and named by sha on the session record. That remains the path for them (see below).

## What shipped

### 1. The contribution index (`shared/pack-contributions.ts`, `server/pack-contributions.ts`)

Turning a pack on registers a `RegisteredPackIndex` on the Project's own state (`packIndex[packId]`):
one entry per contribution with its kind, id, name, a one-line description (at most 160
characters), its triggers and the sha-256 digest and byte size of its body. **No body is read or
stored.** The body of a Small Business skill is its rendered playbook
(`renderSkillPlaybook`, exactly what a request carries); the body of any other contribution is its
declaration in canonical JSON (so its digest does not depend on file formatting).

Registration happens inside the one activation writer, `recordPackActivation`, for built-in and
installed packs alike, in the same write and on the same History entry that says the pack was
turned on (decision 4: said once). Update and rollback re-register the index for every Project
where the pack is on, on the History entry that already says so.

### 2. Load on demand, pinned, digest-checked and recorded

- `PackContributions.admit(state, runKey)` pins the indexes of the packs that are on at
  admission. It only reads; a pack that was turned on before indexes existed (or a built-in this
  build carries at a new version) gets its index computed into the pin and registered at first
  load, with a record that says so.
- `load(pin, { packId, kind, id }, { reason })` resolves through the pin only. A pack not on at
  admission is refused (`pack_inactive`), as is an id not in its index (`unknown_contribution`).
  The body is read for the **pinned** version, hashed, and compared with the registered digest; a
  mismatch is recorded and refused (`digest_mismatch`), and so is a pinned version this build no
  longer has (`version_unavailable`). A body loads once per run; a second ask is free and records
  nothing.
- Every registration, load, refusal and unload appends a `ContributionRecord` to
  `contributionRecords` (append-only, decision 10) and is stated in History with the
  contribution's identity, the pack version and the digest — for example
  `Diomedes loaded the playbook Cash flow snapshot from Small Business 0.1.0 (0ad7659d4922) because
  you opened it.` Loads are Diomedes application actions (`actor: 'diomedes'`), and the sentence
  says who or what asked (decision 8).

Where each kind loads today:

| Contribution | Loads when | Wired to |
|---|---|---|
| Skill (Small Business playbook), chosen | the person sends with a skill picked | `/ask`: the body sent is the loaded, digest-checked body; the turn's `skill.digest` records it |
| Skill, triggered | a model-API Ask/Plan turn calls `load_playbook` with an id from the index | `server/harness/capabilities/pack-playbooks.ts`, registered by `model-session-run.ts` |
| UI panel | a person opens a playbook from the palette (`Read`) | `POST /api/projects/:id/packs/:packId/contributions/:kind/:id/open`, `PlaybookPanel.tsx` |
| Tool, Agent, workflow, UI of an installed pack | a caller loads it with `selected` / `opened` | the loader and the open route; **no Runtime consumer yet** (see gaps) |

Triggers remain hints, never commands: the host does not parse the person's message against them.
On a model-API turn the index (id, name, one line, up to four trigger phrases each) is the
description of one read tool; the model decides to load, and the playbook comes back with the same
four rules a chosen playbook carries (acts on nothing, uses only supplied facts). The index is
offered only in Ask and Plan, and only for packs whose playbooks this build runs.

### 3. Budget: only the index counts until a body loads

Measured on this build (`tests/pack-contributions.test.ts` and `tests/pack-playbooks-driver.test.ts`
print these; the estimate is H18's `utf8-bytes/4`, rounded up):

| Small Business, 12 playbooks | Bytes | Estimated tokens |
|---|---:|---:|
| **Before (all twelve bodies in context at once)** | 27,016 | 6,754 |
| **After: the index alone** (`renderIndex`, 12 lines) | 2,490 | 623 |
| Saved | 24,526 (90.8%) | 6,131 |
| After, as H18 accounts a real model-API turn: `load_playbook` in *tool definitions* | 3,056 | 764 |
| A turn that loads one playbook (Cash flow snapshot): *tool results* on that turn only | 3,734 | 934 |

"Before" is the all-at-once load the task names; this build never actually put all twelve in a
request (the `/ask` route sent only the chosen one, unchanged here). The driver test proves the
H18 difference end to end: a turn with the pack off, a turn with it on and nothing loaded (tool
definitions grow by the index, tool results 0), a turn that loads (tool results carry the body),
and a turn admitted after the pack is off (tool definitions back to the off size). The
`/packs/contributions` route reports `indexBytes` against `bodyBytes` for each active pack.

### 4. Deactivation and rollback

- Turning a pack off removes its index and appends an `unloaded` record naming what it had loaded,
  in the same write and on the same History entry as the turn-off. `loadedIn(state)` — what is
  loaded now, derived from the records alone — is empty for that pack afterwards.
- A run admitted before keeps its pin: its later loads still resolve at the pinned version and are
  recorded with `pinnedAt`. A run admitted after sees the pack off and is refused, or on a
  model-API turn is simply offered nothing.
- Rollback composes with P03: the lifecycle keeps every installed version on disk, so a run pinned
  at 1.1.0 still loads 1.1.0's bodies (verified against their digest through
  `PackLifecycle.verifiedManifest`) after a rollback to 1.0.0, while new runs load 1.0.0. Rollback
  still grants and restores nothing.

### 5. Console

With Small Business on, each playbook in the Ctrl K palette offers **Read** beside **Use**. Opening
one loads that single body in the click (never in a render or an effect, so one open is one
record) and shows it with its version and digest; the digest truncates where it is written
(decision 5). With the pack off the palette shows only the existing "off" row and the open route
refuses. No new surface: the panel is the existing `Modal`.

## Tests

| File | Covers |
|---|---|
| `tests/pack-contributions.test.ts` (11) | index registered on activation (12 playbooks + 1 panel, digests, no bodies, rides the turn-on entry); an inactive project admits nothing and records nothing; measured index vs bodies; load on trigger, once per run, recorded with identity, version, digest, History sentence and `actor: diomedes`, authority unchanged; installed-pack tool loads on `selected`, panel on `opened`, Agent and workflow never loaded; **digest mismatch refused** (changed body, and a registered digest altered in state); **pinned across deactivation mid-run**, unload record rides the turn-off entry, new run refused; composes with rollback (1.1.0 pin vs 1.0.0 new run); restart durability; first-use registration for a pack turned on before indexes |
| `tests/pack-playbooks-driver.test.ts` (2) | real `ModelSessionRuns` + `RunService`: off/on/loaded/after-off turns, H18 tool-definitions and tool-results difference, **pack turned off while the model decides, load still served by the pin**, unknown id answered and not recorded |
| `tests/small-business-skills.test.ts` (+2) | `/ask` with a chosen skill: History names the load with the turn's id and the same digest as `turn.skill.digest`; open route refused off, served on, unload visible after turn-off; palette offers Read only where the Console can open it |
| `tests/p04-pack-panel.spec.ts` (2, Playwright) | off: no Read, no panel, no index, no records; on: turning on registers the index only, Read opens the panel, exactly one load recorded, History sentence with digest, no horizontal overflow; off again: no Read, open refused |

**Red, then green (digest mismatch).** With the digest comparison disabled the two mismatch tests
failed (`AssertionError: expected { …(9) } to match object { status: 409, …(1) }` and `promise
resolved "{ …(9) }" instead of rejecting`); with it restored both pass. The Playwright spec also
caught a real defect on its first screenshot: the panel's effect ran twice under React StrictMode
and recorded two loads for one open. The load moved into the click, and the spec now asserts
exactly one record.

## Known gaps (not shipped, and not claimed)

1. **No Runtime consumer for installed packs' tools, Agents, context or workflows.** The index,
   pin, digest check and records cover them, and a tool loads with reason `selected` when a caller
   asks, but no plan in this build selects a pack tool and the tool host does not execute one (P03
   gap 2 stands). "A tool loads when a run's plan selects it" is the mechanism, not a live path.
2. **Context contributions are not assembled by H18.** Software Engineering instruction files keep
   their existing H11 path, which already reads each body per run and names it by sha on the
   session record; they are indexed as declarations here but their bodies are not re-recorded as
   contribution loads (said once). Installed packs' `context` declarations are indexed only.
3. **Triggered loading is on model-API conversation routes only.** External engines (Codex, Claude
   Code, OpenCode, ACP) manage their own context; they receive a chosen playbook through `/ask` as
   before, and no index.
4. **The Diomedes home conversation** is unchanged; whether it should offer playbooks is still the
   open question recorded in the capability-packs document §4b.
5. **The client still bundles the Small Business playbook data** (`SMALL_BUSINESS_PACK.skills`) for
   the palette rows and the composer starter. That is Console code, not model context; the index
   route exists for a later change to read rows from the host.
6. **Pins live in memory for a run's life.** A run that survives a restart re-admits; its earlier
   loads remain in the records.

## Proposed defaults recorded here (Andrew's to confirm)

- **A built-in pack whose content changes without a version change is refused at load**, not
  silently re-indexed: the version is the identity and the digest pins its bytes. Shipping a
  change to a playbook therefore needs a version bump; a project then re-indexes at first use and
  says so. The refusal names the fix (turn the pack off and on to accept the new bytes).
- **Opening a playbook to read it is recorded** as a load with reason `opened`, the same as a run's
  load, because History should say what was read at which digest. It is a Diomedes application
  action and grants nothing.
- **Triggered loading lets the model choose a playbook** from the index in Ask and Plan on
  model-API routes. The playbook's own terms still hold (drafts only, acts on nothing); a person
  can see every such load in History. If Andrew prefers person-only selection, removing the tool
  registration is a one-line change and the index route remains.

## Proposed canonical-doc patch

For the integrator. Nothing below is applied on this branch.

**`docs/DIOMEDES_LIVE_ROADMAP.md`, section 5, append after the paragraph beginning "Packs compose
tools, Agents, rules, context, workflows and relevant UI…":**

> P04 landed (2026-09-24, DIO-30, `docs/implementation/2026-09-24-p04-on-demand-contributions.md`):
> turning a pack on registers an index of its contributions (names, one-line descriptions,
> triggers, a digest per body) and loads no body. A body loads through the run's pin only when it
> is used — a Small Business playbook when the person chooses it or a model-API Ask/Plan turn asks
> for it by its index entry, a playbook panel when a person opens it — is checked against its
> registered digest (a mismatch is refused) and is recorded in History with pack version and
> digest. Turning a pack off unloads it; a run already admitted keeps the version it pinned, and
> this composes with rollback. For the twelve Small Business playbooks the index costs 2,490 bytes
> (~623 tokens) against 27,016 (~6,754) for all bodies. Installed packs' tools, Agents and context
> are indexed and loadable but still have no Runtime consumer.

**`docs/DIOMEDES_PROJECT_MEMORY.md`, definitions, add:**

> **Contribution index.** What a Project registers when it turns a pack on: one entry per
> contribution (kind, id, name, one line, triggers, body digest), never the bodies. Only the index
> counts toward a request until a body is loaded.
>
> **Contribution load.** One contribution body read for one run or one opened panel, through the
> indexes pinned when that run was admitted, checked against the registered digest, and recorded
> with the pack version and digest. A run admitted before a pack was turned off, updated or rolled
> back keeps the version it pinned.

**`docs/product/2026-09-10-capability-packs.md` §4b, replace the "Delivery" bullet's last sentence
and append a bullet:**

> The message stays as typed; the turn records which playbook, pack version and body digest ran.
>
> - On demand (P04, 2026-09-24): turning the pack on registers the playbooks' index only. A
>   playbook's body loads when the person chooses it, when a model-API Ask or Plan turn asks for it
>   by its index entry, or when a person opens it to read; each load is digest-checked and recorded
>   in History.

**`QUESTIONS.md`:** no question is answered. The three proposed defaults above are recorded for
Andrew to confirm.

---

PILLAR IMPACT: advances decision 14 ("do not inject or load a pack's toolset for users or projects
that do not need it") from activation-gated to use-gated, with truthful attribution of every load
(decision 8) and append-only records (decision 10). Loading is not authorization: tests compare
grants, Needs, sessions, tasks and conversations before and after loads. No pillar conflict.

ROADMAP IMPACT: P04 (DIO-30) implemented for skills (chosen and triggered) and playbook panels,
with the index, pinning, digest refusal, unload and rollback composition; installed-pack tool,
Agent and context loads are mechanism-only (gap 1–2).

BUILD STATUS: feature branch only; draft pull request against `main`; not merged, not packaged, no
version bump, no native-runtime hash change.
