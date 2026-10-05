# A three-model team: Sol leads on Azure, the local model works, K3 advises on AWS, 2026-10-05

| Field | Value |
| --- | --- |
| Feature | three-model-team (DIO-216) |
| Branch | `feature/three-model-team` |
| Worktree | `F:/Diomedes/diomedes-wt/three-model-team` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5), under the DIO-216 brief |
| Base | `04954ab` on `feature/model-routes-integration`: origin/main `0104556`, route qualification (`b1d6037`) and the local model connection (`41d0981`) |

## Slice A: the local model as an H14 role

### What it does

- The loop start (`POST /api/projects/:id/loop/start`) asks whether a route is on the way every
  other send does. `mountNativeLoopRoutes` receives the app's own `routeOn` (`server/app.ts`)
  through a new trailing `gates` argument. For a provider route that is still its Settings switch,
  so every provider route behaves as before. The local model has no switch. It is on where it is
  set up on this computer.
- For the local route, admission then reads which profile the local model is running. That read is
  `BonsaiRuntime.refusal` (`server/bonsai/runtime.ts`), a status read that never starts or switches
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
    "worker": { "route": "bonsai", "model": "bonsai-gaming", "accountRoute": "bonsai:local" },
    "advisor": { "route": "aws-bedrock", "model": "us.moonshotai.kimi-k3" }
  }
}
```

- `model` on the lead is the Azure deployment's logical model. The lead's account route and the
  advisor's come from their saved connections.
- A local role carries its profile slug (`bonsai-gaming`, or `bonsai-full` for Full) and the local
  account route constant `BONSAI_ACCOUNT` (`shared/bonsai.ts`). Without that account route the
  route's own admission refuses ("Connect this route and choose its model in AI setup first.").
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
  lead on `azure-openai`, the worker on `bonsai` with `bonsai-gaming`, and the advisor on
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
  characters; a local member must now name a profile, and every other route keeps that check
  unchanged.
- The host's connection read (`localConnection`) has a local branch: no key, no account setting
  (the account route is `BONSAI_ACCOUNT`), the local lane's zero-cost price card, no expiry, and
  the same status read as slice A (`BonsaiRuntime.refusal`). A profile that isn't running refuses
  the member in the runtime's own words.
- A member still runs at medium reasoning, and plan gating, Trust authority, consent and cloud
  sharing are unchanged: a local member passes the same checks every member does.
- The start dialog (`client/console/LoopStart.tsx`) lists a local member like any other. While its
  profile isn't running the option is unavailable and the runtime's sentence shows with the other
  refusals. The host names the model for a person (`modelName`, the profile's display name), so the
  option reads "Counter · Bonsai Gaming". The dialog has no control that starts the local model.
- `GET /api/projects/:id/team/routes` lists the local route as ready where it is set up here, with
  its two profiles by name. Where it isn't, the reason is "The local model isn't installed on this
  computer."
- Only the person puts the local model on the Team (`isPersonOnlyTeamRoute`): "Nectovia chooses"
  skips it, mail never wakes a local member into a run (it waits for the person's own Wake), and
  automatic work never picks a local member.

### Adding a local member

```json
{ "name": "Counter", "role": "member", "engine": "bonsai", "model": "bonsai-gaming" }
```

The member's thread then needs medium reasoning, as every Agent Team member does:
`PUT /api/projects/:id/threads/:threadId` with
`{ "engine": "bonsai", "requested": { "model": "bonsai-gaming", "effort": "medium" } }`.

### What is refused, and why

| Case | Where | Sentence |
| --- | --- | --- |
| A local member names no profile | Roster add, 400 | "Choose a local model profile." |
| The profile isn't running | Start dialog, and a start that names the member anyway (409 `collaboration_refused`) | "The local model isn't running. Start it first." |
| Full runs and the member is on Gaming | The same | "The local model is running its Full profile, not Gaming. Start Gaming first." |
| The local model isn't set up, or reports itself missing | The same | "The local model isn't installed on this computer." |
| The member's thread isn't on medium reasoning | The same, unchanged | "The selected Team member must use medium reasoning." |

### Tests

- `tests/three-model-team-host.test.ts`, fixtures only (`tests/fixtures/three-model-team.ts`): a
  running profile is admitted and named by its profile; not running, the wrong profile and a
  missing installation each refuse in the runtime's words, with no run, call, hold or start; the
  roster add takes a local member only with a profile and leaves other routes' checks alone; the
  routes view lists the local route; "Nectovia chooses" never picks it; mail never wakes it; and
  one Agent Team start runs a Sol lead on Azure, the local member and a Kimi K3 helper profile on
  AWS through to the report proposal, with holds only on the two cloud connections.
- `tests/three-model-team-ui.spec.ts` (`playwright.agent-team.config.ts`), in the built Console:
  the dialog lists the stopped local member with the runtime's reason and no Start control, then,
  with Gaming running, starts the same three-model run from the dialog.

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
