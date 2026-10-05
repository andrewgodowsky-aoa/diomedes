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

## What is not claimed

- No live run. Nothing here reached Azure, AWS or a real local model, and nothing started one. The
  live three-model run waits for Andrew's keys (an Azure Sol deployment and an AWS K3 connection)
  and a passing route check on the K3 connection.
- How well the local model works as a worker is not measured.
- The Console's loop route offer (`GET /api/projects/:id/loop/routes`) is unchanged: it does not
  offer the local model as a lead.
- The status read is a moment's answer. A model stopped after the start is caught by its next call,
  as above, not by admission.
