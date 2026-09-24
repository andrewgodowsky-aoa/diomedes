# H09: exact-model Agent profiles, routing preferences and immutable resolution

Date: 2026-09-24 · Lane `h09-agent-profiles` · Branch `feature/h09-agent-profiles` · Linear DIO-14

Re-derived from current source; no earlier H09 branch was used.

## What shipped

**Profiles.** A profile (`shared/agent-profiles.ts`, `server/agent-profiles.ts`) names one route,
the exact model id as that route lists it, the reasoning level where the route has one, the Agent it
works as (`shared/agents.ts` catalogue id or `auto`), and up to eight rules of the person's own.
Profiles are person-level, kept in `<data>/agent-profiles.json`. Revisions are append-only: an edit
is a compare-and-set against the revision the editor read (`409 profile_stale` otherwise) and appends
revision n+1. Deleting archives the profile; its revisions stay readable for the runs that used them.
Each revision has a `sha256:` digest over every field a run pins.

**Routing preferences.** Per project, an ordered list of profile ids plus a fallback flag; per task,
an override of the same shape (`PUT /api/projects/:id/agent-routing`,
`PUT /api/projects/:id/tasks/:taskId/agent-routing`, `null` or `{clear:true}` removes the override).
Fallback is **off** unless the request says `fallback: true`, every time it is saved.

**Resolution table** (`resolveProfileRoute`, pure, table-tested):

| First profile | Fallback | Outcome |
|---|---|---|
| available | off or on | runs the first profile, `fallback: null` |
| unavailable or deleted | off | **refused by name**: "`<name>` cannot run: `<reason>` Fallback is off for this project, so no other profile was tried." Nothing is admitted. |
| unavailable or deleted | on | runs the next available profile; the pin records `fallback {fromProfileId, fromName, reason}` and every skipped profile; the run log says "Ran on B (Route · model) because A was unavailable: reason" |
| every profile unavailable | on | refused, naming each profile and its reason |

Which list applies, in order: the thread's own profile pick (followed by the task or project list
only when fallback is on there) → a thread that pinned its own model or WorkStyle is left to that
choice → the task override → the project list → no profile (the pre-H09 route and model choice,
unchanged).

**Availability** is read from host facts only, and an unavailable profile is always listed with its
reason: route not in this build; route off in Settings > Engines; a non-Codex route with no connected
account route ("not connected in AI setup"); an engine that reports its catalogue but does not list
the model, or does not offer the reasoning level; the Agent missing in this project or incompatible
with the route (`agentCompatibility`). An engine that reports no catalogue is sent the model as named,
and the runtime's own report is what the run records.

**Immutable resolution.** At admission `NativeWorkService.start` resolves the profile before any other
check, then uses the pick's route, model, effort and Agent. The pick is pinned into the run's Agent
resolution as `Session.agent.profile` (revision, digest, route, model, effort, Agent, rules, source,
fallback policy, fallback, skipped). `resolutionSchema` validates it strictly on load and recovery,
and `validateAgentResolutions` refuses a pin whose route or model disagrees with the resolution, or
that records a fallback under a fallback-off policy. Nothing recomputes a pin: a later edit makes a
new revision and the admitted run keeps naming the old one, across a restart (tested). The profile's
rules travel in the instruction section, headed with the profile name and revision.

**Truthful attribution (decision 8).** `runtimeModelDifference` compares the requested model with the
runtime-reported one. The run details show "Ran on `<reported>`, as the runtime reported. Requested
`<requested>`." whenever they differ, for any run, profile or not. The pin keeps the request; it is
never rewritten to the reported model.

**Console.**
- Settings > Agent profiles, in the Engines language (hairline `service` sections, state mark, mono
  route · model · effort · Agent line, revision caption). New / Edit ("Save as revision n") / Delete.
  Unavailable profiles show "Unavailable: `<reason>`". A Project routing block orders profiles, adds
  and removes them, and has the fallback checkbox, off by default.
- The composer's Agent picker gains a "Profiles · Build and Fix runs" group. An unavailable profile
  stays in the menu, disabled, with its reason. Picking one sets `requested = {model: null,
  effort: null, profile}`; the button reads "Profile · `<name>`". Picking an Agent or Auto clears it.
- Run details (`RunInspector`) add Profile (name · revision · short digest), Resolved by (source,
  fallback policy, fallback sentence) and Model (requested vs runtime-reported).

## Decisions taken tonight (conservative defaults, for Andrew to confirm)

1. **Fallback is off by default** and is re-stated on every save; omitting the flag turns it off.
2. **A thread's own model pin or WorkStyle outranks a project or task list.** The owner's tier map
   (Efficient = GPT-5.6 Luna on AWS Bedrock, Focused = Gemini 3.8 Flash on Vertex, Thorough refused
   until a model is qualified) is untouched: a thread on a tier keeps resolving through it, and no
   profile gives Thorough a model. A profile *may* name a Bedrock or Vertex model exactly; it then
   needs that route on and connected like any other.
3. **A thread's explicit profile pick uses the project's (or task's) fallback policy** for the rest of
   the list. With fallback off, the pick is the only candidate.
4. **Profiles are person-level; routing is per project** and lives beside the profiles, not in project
   state, because it is configuration. What a run used is evidence and lives in the run record.
5. **Retry and Resume re-resolve.** Each is a new admission and pins what it resolved then.
6. **A pick from a profile counts as `manual` model selection; a pick from a routing list as
   `automatic`**, in the existing `modelSelection` vocabulary.

## Tests

- `tests/agent-profiles.test.ts` (17): the resolution table (7 rows plus none/label/exact-pin
  cases), revision append and stale refusal, validation refusals, archive, routing per project and
  task, schema acceptance and fail-closed on an unknown pinned field.
- `tests/agent-profiles-routing.test.ts` (9, real HTTP): a thread pick pins engine/model/effort/
  revision and sends the rules; an edit and a full app restart leave the pin unchanged and the next
  run uses the new revision; the runtime-reported model wins and the difference is kept; fallback off
  refuses by name with nothing admitted; fallback on runs the next profile and logs why; a task
  override outranks the project; unavailable profiles are listed with their reasons (unlisted model,
  unsupported effort, route off, route not connected); a thread's own model/WorkStyle is not
  overridden.
- `tests/agent-profiles-ui.spec.ts` (3, Playwright, own server on the built UI): Settings create and
  edit to revision 2 with an unavailable profile's reason shown; the picker shows an unavailable
  profile disabled with its reason and picks an available one; run details show the pinned revision
  after a later edit, the resolution source and the runtime-reported model beside the requested one.

The unit and HTTP tests were written first and run red (missing module, then 7 of 8 failing, then
the not-connected case) before the implementation. The Playwright spec was written after the Console
code and passed on its first run; it was not shown red.

## Known gaps

- **Only guarded Build/Fix runs** (`NativeWorkService.start`: Work start and a thread's Build/Fix
  send) resolve profiles. Ask and Plan text turns, the Home conversation, the Claude Code session
  route and team helpers do not yet; the picker labels the group "Build and Fix runs" so it does
  not claim otherwise.
- The thread header's "next request" line still describes the route default or tier, not a picked
  profile. The run's own details are correct.
- The Settings routing block edits the project list only; the per-task override has an API and
  tests but no Console control yet.
- Availability is checked at admission. A route that fails later, mid-dispatch, fails that run; it is
  not retried on the next profile.
- Model ids for engines that report no catalogue are not verified before sending (by design: the
  runtime report is recorded), so a mistyped id surfaces as the engine's own refusal.

## Proposed canonical-doc patch

Cloud synchronisation is pending; this lane does not edit the canonical documents.

**Project memory — add a definition under the Agent/Model terms:**

> **Agent profile.** A person's saved, versioned choice of one exact model: route, model id as the
> route lists it, reasoning level where the route has one, the Agent it works as, and the person's
> own rules. Editing appends a revision. A profile chooses intelligence and never grants authority.
> **Routing preference.** A project's ordered list of profiles, with an optional per-task override.
> Fallback to the next profile is off unless the person turns it on for that project or task, and
> every fallback is recorded on the run with the profile it skipped and why. At admission the
> resolved profile revision, route and model are pinned into the run record and never recomputed.

**Roadmap — H09 status:** "Exact-model Agent profiles, routing preferences with explicit fallback
(off by default) and immutable resolution pinned at admission: implemented for guarded Build/Fix runs
(DIO-14, `docs/implementation/2026-09-24-h09-agent-profiles.md`). Open: Ask/Plan text turns, Home
conversation, Claude Code session route and team helpers; per-task override control in the Console;
comparative evidence across profiles (H20)."

**Pillars:** no change proposed. The work advances decision 8 (runtime-reported model shown beside
the requested one) and keeps decision 7 (a profile never widens authority; the Agent ceiling and
grant still decide) and the trust boundary against silently changing a provider or billing route.

## Gates

Filled from the final run on the pushed head; see the PR description.
