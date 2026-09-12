# The thread picker, the permission panel's "Unavailable", and the AI-setup race

September 12, 2026. Worktree `F:\Diomedes\diomedes-wt\opus-picker`, branch
`slice/opus-picker-20260912`, cut from `main` at `baa7c77`. Nothing is pushed, packaged or
released.

Three gaps measured on the packaged candidate in
[`2026-09-12-demo-journey-b.md`](2026-09-12-demo-journey-b.md) (steps 9–12, §"What is not
reachable") and [`2026-09-12-integration.md`](2026-09-12-integration.md) §7. Two of the three sit in
different source than the journey named. What follows is where they are, what was changed, and what
is still not fixed.

## 1. The thread picker listed nothing for a signed-in OpenCode account

**The journey's reading.** "Nothing in `server/discovery.ts` or `server/integrations.ts` ever sets
that flag for OpenCode — the three writers of `available: true` (`server/integrations.ts:566`,
`:628`, `:697`) are other paths."

**What the source says.** `GET /api/integrations` does not use those writers for an external engine.
`server/app.ts` maps every external id through `EngineService.integration()`
(`server/engines/service.ts`), which is the fourth writer and the only one that matters here. That
`available` is a conjunction of five facts: found, a supported version, signed in, at least one
model, **and a check less than 300 s old**. `available: false` in `server/discovery.ts` is correct
and was left alone — finding a binary proves nothing about an account.

So two things made the menu empty beside a connected account:

- The Console reads `/api/integrations` once, in `loadInitial` (`client/App.tsx`), and nothing
  refetches it after Settings runs a sign-in check. The roster the thread holds predates the account
  it is meant to describe.
- Even once refetched, the freshness term makes a working account disappear silently five minutes
  later, with no sentence anywhere saying why.

**What changed.** `client/console/Picker.tsx` now reads external engines from `GET /api/ai/status` —
the same answer AI setup renders — on mount and again each time the menu opens. That read is
answered from the `EngineService` map in memory: it starts no process and sends nothing to a
provider. Codex and Sample keep the existing `GET /engines/:id/models` path unchanged.

An external engine is offered when the person has turned it on and the engine's own check reports
found, a supported version, signed in and at least one model. The freshness window no longer decides
whether the account exists; it decides what the heading says: `Signed in · Ready` inside it, and
`Signed in · checked HH:MM:SS, rechecked before sending` outside it. That last sentence is true —
`EngineService.generate()` re-runs discovery, the version check, the sign-in check and the model
check before every send, and refuses when any of them fails. Listing a stale check therefore claims
nothing the send would not verify.

The models offered are the ones the engine reported, with the provider-qualified slugs the adapter
requires (`opencode-go/<id>`, built in `catalogue()` at `server/engines/opencode.ts:188`). Nothing is
invented, and an engine that reports no models is not offered.

An engine the person turned on that has **not** passed a check no longer leaves a silent gap: the
menu names it and names the control that fixes it — Settings > Engines, "Check sign-in and models".

**Not changed.** `server/engines/service.ts`, `server/discovery.ts` and `server/integrations.ts` are
untouched. `IntegrationStatus.available` still means "ready and freshly checked" for every other
reader.

## 2. The permission panel printed "Unavailable"

**The journey's reading.** "The same flag makes the thread permission panel print 'Unavailable'
beside the OpenCode preset (`client/console/PermissionPanel.tsx:164`) while Settings reports the same
account as connected."

**What the source says.** It is not the same flag and not an engine flag at all. The panel renders
`PermissionChoice.available`, built by `describePermissionChoices` in `shared/permissions.ts` from
`scopedWritesSupported`, which `server/permission-routes.ts:32` computes as `routeId === 'codex'`.
`Work in this project` and `Approve for me` are off on **every** route but Codex, because only Codex
has a verified boundary for a scoped automatic write (`shared/capabilities.ts`, and the
`preExecutionInterception` and `revocationStopsFutureEffects` facts behind it). A signed-in, ready
OpenCode reads exactly the same as a disconnected one, which is what made the word misleading.

**What changed.** `client/console/PermissionPanel.tsx` only. For the two scope-backed options on a
known non-Codex route, the tag reads `Codex only` rather than `Unavailable`, and one line names the
route, says the fact is about the route rather than the connection, gives the two actions that change
the answer — set the thread to Codex in the engine picker, or connect Codex in Settings > Engines —
and says that Review changes stays available where they are. `Full access` keeps `Unavailable`: its
reason is an environment fact, and it already carries its own "What it would take" disclosure.

`shared/permissions.ts` and `server/permission-routes.ts` are untouched. Preset meanings are not an
agent's to change (`AGENTS.md`, *Not yours to decide*), and no option became available that was not
available before.

## 3. AI setup could lose one of two writes

**The journey's reading.** The brief pointed at `server/configuration-routes.ts` and
`server/configuration.ts`. Those are the business-setup compile/activate/rollback surface and have
nothing to do with engine settings.

**What the source says.** Two controls write, by two routes:

- The On switch called `save({...settings, services: {...settings.services, [engine]: on}})` — a
  whole settings object built from a React prop snapshot — through `PUT /api/settings`.
- "Use as default" called `POST /api/ai/select`, which read-modify-writes `store.settings`
  server-side.

`validateSettings` (`server/app.ts`) **replaces** `result.services` wholesale rather than merging it.
Both routes run inside `store.locked()`, so the server never interleaves them; the loss is entirely
the client's stale base. A switch whose snapshot predates a select discards `defaultEngine`,
`<engine>Model` and `<engine>AccountRoute`. The reverse was possible too, because
`useAsDefault` echoed the select result back through the parent as a second whole-object PUT.

**What changed.**

- **`POST /api/ai/enabled`** (new, `server/app.ts`). The switch names one key; the read-modify-write
  happens on the server under the same store lock `/api/ai/select` holds. The two writes now commute:
  neither can lose the other, in either order, at any speed. The switch remains a preference and not
  a readiness claim — `EngineService.generate()` still refuses an account that cannot answer.
- **The expected-hash write guard.** Settings carry `"<sha256 of the stored JSON>"` as an `ETag` on
  `GET /api/settings`, `PUT /api/settings`, `POST /api/ai/select` and `POST /api/ai/enabled`. A PUT
  that echoes a stale tag in `If-Match` is refused with 409 and the message "Settings changed while
  this screen was saving. The saved settings were reloaded.", carrying `settings` and `etag` so the
  caller re-applies its change to the truth. A caller that sends no `If-Match` is unguarded exactly
  as before, so the guarantee is added without removing one.
- **`client/api.ts`** (additive): `engineConnections`, `readSettings`, `writeSettings` (guarded),
  `patchSettings` (unguarded, one field, still records the tag), `setEngineEnabled`,
  `selectEngineModel`, and a `SettingsConflict` error carrying the saved settings.
- **`client/AISetup.tsx`**: the switch calls `setEngineEnabled`; "Use as default" calls
  `selectEngineModel`. Neither writes anything back. A first draft echoed each response through the
  parent's guarded PUT, which re-opened the race it was meant to close: both responses land in the
  same tick, so the client keeps one hash — the later one — and a PUT of the *earlier* body then
  measures as current, is accepted, and silently reverts the later write. The hash guard cannot see
  this, because the hash is honest and only the body is old. `store.saveSettings` emits `settings`,
  the app re-reads on that event, and the screen shows what was stored.
- **`client/App.tsx`**: `saveSettings` writes through the guard and, on a conflict, adopts the saved
  settings *and says so*. The change the person just made did not land; staying silent would leave
  them reading a screen that quietly disagrees with what they pressed. The three one-field writes (interface scale, open projects, last page) go
  through `patchSettings`, so they stay unguarded but keep the tag current and cannot cause a
  spurious refusal later.

No client-side lock was added.

## Sources touched

| File | Change |
|---|---|
| `client/console/Picker.tsx` | Reads `GET /ai/status` for external engines; offers a signed-in account regardless of check age; states when it last looked; names an on-but-unchecked engine and its fix. |
| `client/console/PermissionPanel.tsx` | `Codex only` plus one next action for the two scope-backed options on a non-Codex route. |
| `client/AISetup.tsx` | Switch and default-model writes go through the two server-side routes and write nothing back; the screen shows the saved settings the server publishes. |
| `client/api.ts` | Additive: engine connections, guarded and unguarded settings writes, the two AI-setup writes, `SettingsConflict`. |
| `client/App.tsx` | Guarded `saveSettings` that adopts *and reports* the saved state on conflict; one-field writes keep the tag current. |
| `server/app.ts` | Settings ETag on four routes, the `If-Match` guard, and `POST /api/ai/enabled`. |
| `tests/picker-setup.test.ts` | New. |

## Tests

`tests/picker-setup.test.ts`, twelve cases over an injected `EngineService` whose adapter never
starts a native engine, reads a credential store or contacts a provider.

- Before any check: `/ai/status` reports not-checked with no account route and no models,
  `/integrations` reports not found, `/engines/opencode/models` is empty. An empty menu can only mean
  an empty account.
- After discovery and a check: the account route and both provider-qualified slugs on `/ai/status`,
  the same list on `/engines/opencode/models`, and the integration row reading `Ready`.
- A sign-out empties the offered list rather than keeping a stale one.
- The picker's own gate: a signed-in account an hour past its check is still offered and its heading
  says so; missing, not-checked, unsupported, signed-out, unknown and empty-model accounts are not.
- Write ordering: the switch and "Use as default" in both orders, both surviving; the switch turned
  off without discarding the model it was given.
- The echo hazard itself: PUT-ing the switch route's response body with the select route's (current,
  honest) tag is accepted and loses the model. This is the loss the screen no longer risks, and the
  reason AI setup writes nothing back.
- The guard's three outcomes: a whole-object write against a moved hash refused with the saved
  settings and their tag, the same write against the current tag accepted, and a caller that sends no
  tag unaffected. Plus two refusals on `/ai/enabled` (a non-boolean switch, a non-external engine).

`tests/ai-engines-ui.spec.ts` already drives the thread picker through four signed-in fixture engines
and was re-run: it still passes, so the change did not narrow the proven path.

## Gates

Run in this worktree on the tree this report lands with:

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 90 files, 1524 passed, 1 skipped (1525 total).
- `npx vite build` — built.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/ai-engines-ui.spec.ts` —
  21 passed. Under the shared lock at
  `F:\Diomedes\diomedes-wt\.playwright.lock`, taken and deleted by this branch.

## Known limits

- **This was not verified against the real OpenCode account on this machine.** Every assertion here
  is source, unit and browser-fixture evidence. Journey B's live gap should be re-measured on a
  packaged build before it is called closed.
- **Two files outside the brief's owned list were edited**, because the gaps are there and not in
  the files the brief named: `server/app.ts` (the settings routes and the new `/ai/enabled`),
  `client/App.tsx` (the guarded write path). `server/configuration.ts` and
  `server/configuration-routes.ts`, which the brief did name, were not touched — they are business
  setup and unrelated. A merger should look at those two files first.
- **`IntegrationStatus.available` still folds freshness into readiness** for every reader other than
  the picker. That is a wider design question about what the flag means, and it was not answered
  here.
- **The Console still never refetches `/api/integrations`** after a sign-in check. The picker no
  longer depends on that roster, but anything else that reads `available` — the palette's Models
  group in `client/console/Shell.tsx`, for one — still does.
- **A whole-object PUT that sends no `If-Match` can still clobber.** The guard is opt-in so existing
  callers keep working. Every caller in this tree now sends a tag or owns one field.
- **The permission panel's next action assumes Codex is connectable.** It says where to go; it does
  not check whether Codex is signed in on this machine before saying it.
- **AI setup's own screen now depends on the `settings` event to update.** The saved state arrives
  through `/api/events`; with the stream down the switch will not move, and the app's offline
  indicator is the only sign. There is no browser test for the no-echo behaviour — this tree has no
  component-test tooling, and the Playwright budget for this slice was spent — so the guarantee rests
  on the two server routes, the vitest case above, and the re-run of `tests/ai-engines-ui.spec.ts`.

## PILLAR IMPACT

Advanced: **truthful state**. Three surfaces stopped saying something the system did not mean. The
picker no longer hides a signed-in account behind a staleness term it never explained; the permission
panel no longer reports a route capability as if it were an account fault; AI setup no longer shows
an optimistic value that a concurrent write had already replaced. Standing decision 8 (truthful
attribution) and the found/installed/signed-in/ready contract are the specific things served.

Advanced: **one surface**. Choosing the engine and model on the thread was previously reachable only
through Settings > Engines. It is now reachable where the work is.

No conflict identified. Nothing here widens authority: the permission presets are unchanged, no
option became available that was not available before, activation still grants nothing, and the
engine On switch remains a preference that the send path re-verifies. No capability is described as
shipped that is not shipped — in particular, scoped automatic writes remain Codex-only and the panel
now says so plainly.

## ROADMAP IMPACT

None claimed. Journey B's steps 9 and the "not reachable" entry for the thread picker have a
candidate fix with unit and browser-fixture proof, but no live re-measurement, so no roadmap status
was changed.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Nothing built for distribution, packaged, versioned, pushed or released. Two commits on
`slice/opus-picker-20260912` plus the commit carrying this report. `dist/` was rebuilt in this
worktree only, for the Playwright gate.
