# A three-model team: Sol leads on Azure, the local model works, K3 advises on AWS, 2026-10-05

| Field | Value |
| --- | --- |
| Feature | three-model-team (DIO-216) |
| Branch | `feature/three-model-team` |
| Worktree | `F:/Diomedes/diomedes-wt/three-model-team` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5), under the DIO-216 brief |
| Base | `04954ab` on `feature/model-routes-integration`: origin/main `0104556`, route qualification (`b1d6037`) and the local model connection (`41d0981`) |
| Merged | `feature/general-local-route` at `541bd65` (DIO-201): the local model comes from its folder's `nectovia-connection.json` |
| Contract | The escalation controls (`shared/escalation-controls.ts`), cherry-picked from `3bea42b` as `99f1fbd`. The account service serves the read and the gateway check on main since #226 (`746616e`) |
| Commits | A `6d4d93c`; B `a9adeb6`; merge `ce46934`; C `02bb22a`, `70bb4a5`, `2f4f932`, tests `b459897`; fresh status read `9cac36d`; Nectovia role egress `06bd638` |

## Slice A: the local model as an H14 role

### What it does

- The loop start (`POST /api/projects/:id/loop/start`) asks whether a route is on the way every
  other send does. `mountNativeLoopRoutes` receives the app's own `routeOn` (`server/app.ts`)
  through a new trailing `gates` argument. For a provider route that is still its Settings switch,
  so every provider route behaves as before. The local model has no switch. It is on where it is
  set up on this computer.
- For the local route, admission then reads which profile the local model is running. That read is
  `LocalModelRuntime.refusal` (`server/bonsai/runtime.ts`), a status read that never starts or switches
  the model. Running means ready or busy, as the integration reports it, so a model that is still
  starting counts as not running. A profile that isn't the running one is refused with 409, code
  `local_model_not_ready`, and the runtime's own sentence (table below).
- The check runs before consent, cloud sharing and the route's own admission. Every route a loop
  admits passes through `admitRoute`, so it covers a worker, an advisor, a delegate, a lead and an
  H08 Retry alike.
- A team's roles are now admitted before their lead, as S3's subscription worker already was. A role
  that refuses leaves nothing admitted for the lead. Admission holds no spend: spend is held per
  model call.
- Consent and the project's cloud sharing apply to the local route as to any model-API route. The
  local route is not added to `MODEL_API_PROVIDERS`.
- A local call holds no spend: the local adapter reserves nothing (`server/engines/bonsai.ts`). The
  cloud roles hold and settle on their own connections.
- Each local model call after the start still acquires the model without starting it. If the person
  stops the model during a run, that call is refused by the runtime, the worker fails and its lead
  stops for a retry. Nothing moves to a cloud model.

### The API start

The exact body for the three-model team, as `tests/three-model-team.test.ts` sends it:

```json
{
  "protocolVersion": 1,
  "commandId": "three-model-1",
  "taskId": "<the task's id>",
  "goal": "Compare the delivery with the order and say what is short.",
  "route": "azure-openai",
  "model": "gpt-5.6-sol",
  "consent": true,
  "sources": ["order.md", "delivery.md"],
  "team": {
    "worker": { "route": "bonsai", "model": "local:gaming", "accountRoute": "bonsai:local" },
    "advisor": { "route": "aws-bedrock", "model": "us.moonshotai.kimi-k3" }
  }
}
```

- `model` on the lead is the Azure deployment's logical model. The lead's account route and the
  advisor's come from their saved connections.
- A local role carries the slug the local model's folder gives its profile (`local:gaming`, or
  `local:full` for Full) and the local account route `LOCAL_MODEL_ACCOUNT` (`shared/local-model.ts`),
  saved as `bonsai:local`. A slug saved before profiles came from the folder (`bonsai-gaming`) still
  names its profile. Without that account route the route's own admission refuses ("Connect this
  route and choose its model in AI setup first.").
- Before it can start: Azure connected with the Sol deployment and a spend limit; AWS connected on
  K3 with a spend limit and a current route check receipt; the project sharing the sources with
  `azure-openai`, `bonsai` and `aws-bedrock`; and the local model running the named profile, started
  by the person's own Start.

### What is refused, and why

| Case | Answer | Sentence | Why |
| --- | --- | --- | --- |
| The local model isn't running the asked profile | 409 `local_model_not_ready` | "The local model isn't running. Start it first." | A send never starts the model. Only the person's Start does. |
| It runs Full and Gaming was asked | 409 `local_model_not_ready` | "The local model is running its Full profile, not Gaming. Start Gaming first." | Switching profiles is a Start too. |
| Nothing is installed here | 409 `local_model_not_ready` | "The local model isn't installed on this computer." | The route is not on. |
| The role names no local profile | 409 `local_model_not_ready` | "Choose a local model profile." | Only a profile can run. |
| An earlier slug whose profile the folder no longer lists | 409 `local_model_not_ready` | "The local model has no Gaming profile now. Choose one of its profiles." | The folder decides which profiles exist. |
| A K3 advisor without a current receipt | 409 `route_refused` | "Kimi K3 needs a passing route check on this connection before it sends. Run the route checks in AI setup." | The route check receipt rule, unchanged. |
| A provider route switched off | 409 | "Turn the selected route on in Settings before using it." | Unchanged. |

The first two sentences are the ones the host script gives an inference acquire with `-NoStart`
(`resources/bonsai-host.ps1`). The host's own words for a missing installation name the product,
so the app says it plainly instead. The AWS route adds its existing closing sentence to the K3
refusal; this lane wrote no new closing sentence. Each refusal comes before any provider call, any
spend hold and the lead's admission.

### Tests

`tests/three-model-team.test.ts`, fixtures only: the real app and engine service, one transport that
answers Azure, AWS and the local server by host, and a mocked local host that reports which profile
runs.

- One H14 run: a Sol lead on Azure plans, hands `delivery.md` to the local worker, asks the K3
  advisor once and answers. All three routes are called through their own adapters. The worker reads
  the file through its own scoped tool. The Team view (`GET /api/projects/:id/loop/team`) shows the
  lead on `azure-openai`, the worker on `bonsai` with its profile slug, and the advisor on
  `aws-bedrock` with K3, each with the model the runtime reported. Holds exist only on the Azure and
  AWS connections, all settled. The local connection holds nothing. Every acquire was without a
  start.
- Refusals, each with no provider call, no hold, no run and no admission of the lead: the local
  model not running; running Full when Gaming was asked; a K3 advisor with no receipt; the local
  route not installed; an installation that reports itself missing.
- Every provider route still refuses, as a lead and as a role, when its Settings switch is off.

## Slice B: the local model as an Agent Team member

### What it does

- One list decides which model routes a team role may run on: `TEAM_MODEL_ROUTES` and
  `isTeamModelRoute` in `shared/model-api.ts`, the four provider routes and the local model. The
  Agent Team grant's binding schema (`shared/agent-collaboration.ts`), the collaboration harness
  (`server/harness/agent-collaboration.ts`: the member binding, the root route and the helper) and
  the host (`server/agent-team-host.ts`: saved profiles, Team members, helper bindings and the
  helper offers) all ask it instead of `isModelApiProvider`.
- The Team roster carries the local route with host carriage (`TEAM_ROUTES` and `TEAM_CARRIAGE` in
  `shared/team-routes.ts`). A local member's model is a profile slug. The roster add
  (`POST /api/projects/:id/team/members`) checked every model only as a name of up to 200
  characters. A local member must now name a profile the local model's folder lists: the team
  service asks the runtime (`TeamService.setLocalModel`, wired in `server/app.ts`). A slug saved
  before still names its profile, and the member keeps the slug listed now. Every other route keeps
  that check unchanged.
- The host's connection read (`localConnection`) has a local branch: no key, no account setting
  (the account route is `LOCAL_MODEL_ACCOUNT`), the local lane's zero-cost price card, no expiry,
  and the same status read as slice A (`LocalModelRuntime.refusal`). A profile that isn't running refuses
  the member in the runtime's own words.
- A member still runs at medium reasoning, and plan gating, Trust authority, consent and cloud
  sharing are unchanged: a local member passes the same checks every member does.
- The start dialog (`client/console/LoopStart.tsx`) lists a local member like any other. While its
  profile isn't running the option is unavailable and the runtime's sentence shows with the other
  refusals. The host names the model for a person (`modelName`, the profile's name in the local
  model's catalogue: the model's id and the profile), so with the fixture's folder the option reads
  "Counter · bonsai-2-27b Gaming". The dialog has no control that starts the local model.
- `GET /api/projects/:id/team/routes` lists the local route ("Local model") as ready where it is set
  up here, with the profiles its folder lists, by name. Where it isn't, the reason is "The local
  model isn't installed on this computer."
- Only the person puts the local model on the Team (`isPersonOnlyTeamRoute`): "Nectovia chooses"
  skips it, mail never wakes a local member into a run (it waits for the person's own Wake), and
  automatic work never picks a local member.

### Adding a local member

```json
{ "name": "Counter", "role": "member", "engine": "bonsai", "model": "local:gaming" }
```

The member's thread then needs medium reasoning, as every Agent Team member does:
`PUT /api/projects/:id/threads/:threadId` with
`{ "engine": "bonsai", "requested": { "model": "local:gaming", "effort": "medium" } }`.

### What is refused, and why

| Case | Where | Sentence |
| --- | --- | --- |
| A local member names no profile the folder lists | Roster add, 400 | "Choose a local model profile." |
| The local model isn't set up here | Roster add, 409 | "The local model isn't installed on this computer." |
| The profile isn't running | Start dialog, and a start that names the member anyway (409 `collaboration_refused`) | "The local model isn't running. Start it first." |
| Full runs and the member is on Gaming | The same | "The local model is running its Full profile, not Gaming. Start Gaming first." |
| The local model isn't set up, or reports itself missing | The same | "The local model isn't installed on this computer." |
| The member's thread isn't on medium reasoning | The same, unchanged | "The selected Team member must use medium reasoning." |

### Tests

- `tests/three-model-team-host.test.ts`, fixtures only (`tests/fixtures/three-model-team.ts`): a
  running profile is admitted and named by its profile; not running, the wrong profile and a
  missing installation each refuse in the runtime's words, with no run, call, hold or start; the
  roster add takes a local member only with a profile its folder lists, keeps the listed slug for an
  earlier one, refuses where nothing is set up, and leaves other routes' checks alone; the
  routes view lists the local route; "Nectovia chooses" never picks it; mail never wakes it; and
  one Agent Team start runs a Sol lead on Azure, the local member and a Kimi K3 helper profile on
  AWS through to the report proposal, with holds only on the two cloud connections.
- `tests/three-model-team-ui.spec.ts` (`playwright.agent-team.config.ts`), in the built Console:
  the dialog lists the stopped local member with the runtime's reason and no Start control, then,
  with Gaming running, starts the same three-model run from the dialog.

### Fixed after the merge

The general local route keeps one status check for ten seconds (`LOCAL_MODEL_STATUS_TTL_MS`), and
`LocalModelRuntime.refusal` answered from it. The host's `localConnection` and the loop start's
`gates.localRefusal` therefore admitted a member or a role on a check made before the person
stopped or switched the model, and the integration run's host test caught it. `refusal` now takes
`{ fresh: true }`, and both admissions pass it (`9cac36d`). Other status questions still share the
last check.

## Slice C: Nectovia roles at a tier under a lead that is not Nectovia

### What it does

- A team role may run on Nectovia when its lead does not. It names its tier, never a model:
  `TeamRole.tier` (`shared/team-delegation.ts`), one of `efficient`, `focused` and `thorough`. The
  model is whatever the account's routing publishes for that tier when the role is admitted.
- A role is admitted in this order (`admitNectoviaRole`, `server/native-loop-routes.ts`):
  1. Consent, in the role's own sentence.
  2. The project's sharing with Nectovia for the role's files.
  3. The managed checks the managed loop uses (`managedChoiceAt`, `server/app.ts`): signed in, the
     work's business includes the Nectovia Agent and managed AI usage, and the tier has a published
     model. The routing is read again first.
  4. The account's escalation control, read again. It must allow the tier, and a control that
     can't be read refuses.
  5. The paid managed admission (`engines.admitModelApi`, surface `loop`) under the role's own job,
     `<run>-worker` or `<run>-advisor`, at its tier, under the lead's root job.
- Job caps pin a tier per job: `JobCaps.scope` takes the tier a Nectovia role names and pins it on
  a new record. A job already running under another tier is refused with 409 `job_tier_pinned`. The
  lead's root job keeps its thread's tier.
- When the lead hands the role work, the child run is admitted under its own run id at the role's
  tier. The app re-checks the escalation control, from a read at most a minute old. The managed
  adapter admits again on every step with the same tier and role. Each managed call carries
  `x-nectovia-tier` for the role's tier, `X-Nectovia-Escalation` for the role (`worker` or
  `advisor`), and the lead's root job in `x-nectovia-job`. The gateway checks the role header
  against the account's control on every call (main, #226). A Nectovia lead's calls and a
  conversation's calls carry no role header.
- A worker or advisor child on Nectovia passes the loop's egress check as a Nectovia lead does:
  only while the signed-in account is the one it was admitted under (`loopEgressAuthorizer`,
  `server/harness/capabilities/native-loop.ts`). A delegate never sends to Nectovia.
- A Nectovia lead still takes no delegate and no team the person names, and nothing takes Nectovia
  as a delegate or through a saved profile.
- The lead's instructions say once that its Nectovia roles use the account's credits, and that it
  should hand work to them only when a task needs more than it can do itself.

### The API start

A local lead with a Nectovia Focused worker and a Nectovia Thorough advisor:

```json
{
  "protocolVersion": 1,
  "commandId": "escalation-1",
  "taskId": "<the task's id>",
  "goal": "Compare the delivery with the order and say what is short.",
  "route": "bonsai",
  "model": "local:gaming",
  "accountRoute": "bonsai:local",
  "consent": true,
  "sources": ["order.md", "delivery.md"],
  "team": {
    "worker": { "route": "nectovia", "tier": "focused" },
    "advisor": { "route": "nectovia", "tier": "thorough" }
  }
}
```

Before it can start, the person must be signed in to a business whose plan includes the Agent and
managed AI usage. The project must belong to that business and share the sources with `bonsai`
and `nectovia`. The account's control must allow both tiers, and the local model must be running
Gaming. Any lead on a model-API route takes the same team. `GET /api/projects/:id/loop/escalation`
answers, for every tier, whether it could join now and why not, without admitting anything:
`{ "offers": [{ "tier", "name", "admitted", "reason" }], "credits" }`.

### The default roles of a local lead

- A local lead the person starts through the loop start route takes Nectovia roles by default
  (`DEFAULT_ESCALATION_ROLES`, `shared/escalation-roles.ts`): a Focused worker, then a Thorough
  advisor. This applies only when the start names no `team`, no delegate, no Agent Team, no review
  and no composition. A Retry of a lead that took them takes them again, checked afresh, and a lead
  that took none takes none on its Retry. A host start (Board work, the Ready queue, a follow-up)
  never takes them.
- Each role is read first without admitting anything. The read checks the project's sharing, the
  managed checks and the escalation control. A role that can't join is left out with its reason,
  and an advisor joins only beside a worker. When none can join, the lead starts alone without
  asking.
- When any can join, the first answer is 409 with `consentRequired: true`, the sentence from
  `escalationConsentText` and `escalation`, the roles that would join (for example
  `{ "worker": "focused", "advisor": "thorough" }`). `"escalation": true` on the next start confirms
  them, and each is then admitted as above. A role refused between the read and its admission is
  left out the same way. `"escalation": false`, or `"team": null`, starts the lead alone and reads
  nothing.
- The team uses the limits every lead's team has (`TEAM_LIMITS`) and is recorded with origin
  `escalation-default`. The run records which roles joined and why any were left out:
  `LoopRunInput.escalation`, `{ "attached": [{ "role", "tier" }], "leftOut": [{ "role", "tier",
  "reason" }] }`. `GET /api/projects/:id/loop/runs/:runId` returns it as `escalation`, and the
  Team view as `team.escalation` beside `team.origin`.

### In the Console

- The Loop run dialog (`client/console/LoopStart.tsx`) reads the offers when it opens. A lead on
  one of the person's own connected services shows two more fields, "Nectovia worker" and
  "Nectovia advisor", usable while no Agent Team, helper or review is chosen. Each lists the tiers
  by name ("Nectovia Focused"). A tier that can't join is disabled, and its reason is shown once. The advisor waits
  for a worker. The consent box then says where each role's work goes and that the roles use the
  account's credits. Start stays disabled while a chosen tier is unavailable. The command sends
  `team: { scope, worker: { route: "nectovia", tier }, advisor }`, never a model and never a
  composition (`loopStartCommand`, `client/console/loop-start-model.ts`).
- The Team view's lead and workers panel (`client/console/LeadWorkers.tsx`) names a Nectovia role
  by its tier instead of a model. For default roles it says which joined and which were left out,
  with why, and it says the roles use the account's credits (`client/console/lead-workers-model.ts`).
- Nothing in Agent Team or Console copy names a model, a vendor or a route for a Nectovia role.

### What is refused, and why

| Case | Answer | Sentence |
| --- | --- | --- |
| A tier on a route that isn't Nectovia | 400 `team_role_invalid` | "Only a Nectovia role names a tier." |
| A Nectovia role without a tier | 400 `team_role_invalid` | "A Nectovia role names its tier: efficient, focused or thorough." |
| A Nectovia role that names a model, or an account | 409 `route_refused` | "The Nectovia model is managed. Send without choosing one." (or "account") |
| A Nectovia lead with a team or a delegate the person names | 409 `loop_route_unsupported` | The existing `NECTOVIA_LOOP_TEAM_REFUSED` |
| A Nectovia role as a delegate, by a saved profile, or under a Nectovia lead | 409 `team_route_unsupported` | The same sentence |
| No consent | 409 `consentRequired`, with the role | "This loop hands tasks to Nectovia Focused with the files they need. It uses your account’s credits. Confirm before sending." (the advisor's line for an advisor) |
| The project doesn't share the files with Nectovia | 403 `cloud_sharing_denied` | The sharing sentence, unchanged |
| Signed out | 401 `sign_in_required` | "Sign in to use the Nectovia Agent." |
| The plan doesn't include the Agent | 403 `AGENT_NOT_INCLUDED` | The plan's reason, else "This account does not include the Nectovia Agent." |
| The plan includes the Agent but not managed AI usage | 403 `AGENT_NOT_INCLUDED` | "This account does not include managed AI usage." |
| The tier has no published model | 409 | The tier sentence, unchanged |
| Handing work to Nectovia is off | 409 `escalation_refused`, with the role | "Handing work to Nectovia is turned off for this account." |
| The control leaves out the tier | 409 `escalation_refused`, with the role | "Handing work to Nectovia Thorough is turned off for this account." |
| The control can't be read | 409 `escalation_refused`, with the role | "The account’s settings for handing work to Nectovia could not be checked." |
| A child admitted at a tier off the Nectovia route, or without its run or role | 409 `team_role_invalid` | "Only a Nectovia role runs at a tier." |

### Tests

`tests/three-model-team-escalation.test.ts` runs the real app over the faux account service in this
process. Its gateway answers with the offline scripted provider, and a mocked host and a scripted
transport stand in for the local lead. The escalation read is answered by the test, so each case
sets the control it needs. Its first run, on the integration branch at `55e04f7`, failed four cases
and found the fix below. With the fix it passes 20 of 20, on this branch and on a trial merge with
main at `edac503`.

- A local lead with a Focused worker and a Thorough advisor completes. Each role is admitted under
  `<run>-worker` and `<run>-advisor` at its tier under the root job, and again under its own child
  run at the same tier. The managed adapter runs each child at its tier. The job records pin those
  tiers while the root keeps its thread's. Every managed call names its role, its tier and the root
  job.
- What a Nectovia role may send: a worker and an advisor send as a lead does, only while the
  account they were admitted under is signed in, and a delegate never does.
- Refusals before anything is admitted or sent: signed out, a business without the Agent, a plan
  without managed AI usage, a Nectovia lead with a team, a tier on the local route, a Nectovia role
  without a tier or with a model, and no consent.
- The escalation control: turned off, so every tier is offered as unavailable and a role is
  refused. Missing one tier, so that tier alone is refused and the others join. Unreadable, so every
  role is refused. A Nectovia lead's own calls name no role and read no control.
- The default roles: they join after the start asks, recorded on the run and in the Team view. They
  are left out when signed out, without managed AI usage, with a tier turned off or with handing
  work off. They are not taken with `escalation: false` or `team: null`, and a Nectovia lead takes
  none.
- The role copy, server and Console, names no model, vendor or route, and uses no dashes or
  emphasis. The Loop run dialog's command sends tiers only and refuses a Team beside Nectovia
  roles.

### Deviations from the brief, with reasons

- An advisor joins by default only beside a worker. A team without a worker has no lead handoff for
  an advisor to sit beside, and the team schema requires a worker.
- Default roles are taken only on the person's own start and on a Retry of one. Host starts stay
  single-agent, as S3's subscription worker does (D12).
- A `team` the person names wins: `escalation: true` beside a team adds no default roles.
- The first start of a local lead with no team now answers 409 when the account has roles that can
  join. `escalation: false` keeps slice A's behaviour.
- A local lead that isn't running is refused before any role is admitted. It used to be refused at
  the lead's own admission, after its roles.
- Default roles can be reached only through the API in this build. The Loop run dialog does not
  offer the local model as a lead.
- Named roles are admitted one after another. When the advisor refuses, the worker's paid admission
  has already been recorded, though no run starts and no call is sent.
- The roster add (from the merge) refuses a local member with 409 where nothing is set up, and
  keeps the slug the folder lists now.

### Fixed after the integration run

The integration run at `55e04f7` failed four of the escalation file's cases, each a run in which a
Nectovia worker took a task. Each ended cancelled while every one of the lead's steps succeeded.
The worker's child run was refused before its first call, so the lead recorded its stop
(`stop:worker`) and cancelled itself, as a lead does when a worker fails. The refusal came from the
loop's egress check (`loopEgressAuthorizer`). It let only a loop lead send to Nectovia and gave the
reason as "The signed-in Nectovia account no longer matches this run." Slice C made a Nectovia
worker and advisor possible without widening it. The tests were right and the check was wrong.
Now a worker or an advisor child sends to Nectovia as a lead does, only while the account it was
admitted under is signed in. A delegate is still refused, with "Nectovia works only as a loop lead,
a worker or an advisor." The test's wait now ends when the run ends and says how it ended, with
each role's child run (`06bd638`).

## What is not claimed

- No live run. Nothing here reached Azure, AWS or a real local model, and nothing started one. The
  live three-model run waits for Andrew's keys (an Azure Sol deployment and an AWS K3 connection)
  and a passing route check on the K3 connection.
- How well the local model works as a worker is not measured.
- The Console's loop route offer (`GET /api/projects/:id/loop/routes`) is unchanged: it does not
  offer the local model as a lead.
- The status read is a moment's answer. A model stopped after the start is caught by its next call,
  as above, not by admission.
- The Console's add-member form still offers only "Nectovia chooses" by tier (owner decision
  2026-09-23), so a local member is added through the roster API, as any explicit route is.
- Saved Agent profiles (H09) do not run on the local model: their availability check is the
  Settings switch, which the local model doesn't have. The host refuses a saved local profile, as a
  helper or behind a member's thread, with "Saved profiles don't run on the local model yet."
- No Nectovia role reached a live tier, the live account service or the live gateway. The
  escalation read in the tests is the test's own answer, in the shape of the account service's.
  The gateway's own refusal of a role call was not exercised, because the desktop refuses first.
- How well a local lead decides when to hand work to Nectovia, and what that costs in credits, is
  not measured.
- The escalation control is read again at a role's start, and at a later handoff it may be up to a
  minute old. The gateway checks every call.
