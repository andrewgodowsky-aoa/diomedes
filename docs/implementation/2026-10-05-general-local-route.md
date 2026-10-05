# A general local model route, read from the model's own folder, 2026-10-05

| Field | Value |
| --- | --- |
| Feature | general-local-route (DIO-201) |
| Branch | `feature/general-local-route` |
| Worktree | `F:/Diomedes/diomedes-wt/general-local-route` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5), under the DIO-201 general local route brief |
| Base | `51b3130`, with `feature/three-model-team` (`6d4d93c`) merged in |

The local model was one fixed model with two fixed profiles written into the app. It is now any model
whose folder holds a `nectovia-connection.json`. What the app shows comes from that file and from the
model's running server. No product name is written into the app.

## Where the folder comes from

1. Settings, "Local model folder", in the Helpers on this computer section (Engines at technical
   detail). It takes a full path of up to 260 characters. Empty clears it.
2. The `NECTOVIA_LOCAL_MODEL_HOME` environment variable.
3. The older `NECTOVIA_BONSAI_HOME` environment variable.

With none of them set, no local model is offered and the option stays hidden. The earlier default
folder, `F:\Bonsai-2`, is gone. Tests never read the computer's environment
(`server/app.ts`, `options.localModel.env`).

On Andrew's PC: set Settings, Local model folder, to `F:\Bonsai-2`, or set
`NECTOVIA_LOCAL_MODEL_HOME=F:\Bonsai-2`. The older `NECTOVIA_BONSAI_HOME` also works.

## What is read from the file

`shared/local-model.ts` checks the file with zod. It reads only these keys and ignores every
other key, so an installer may write more:

| Key | Use |
| --- | --- |
| `name` | The integration's label, as Settings and the integration list show it. |
| `model` | The model id. The running server must list it. |
| `openaiCompatibleBaseUrl` | Where inference goes: `<base>/chat/completions`, and the llama.cpp root (the base without `/v1`) for `/apply-template`, `/tokenize` and `/props`. |
| `profiles.<Name>.contextTokens` | The profile's context. The running profile is the one whose context the server runs. |
| `profiles.<Name>.inputModalities` | Text, or text and images. |
| `profiles.<Name>.outputTokens` | The profile's output allowance and its deadlines. |
| `profiles.<Name>.defaultReasoningEffort` | The default level when it is `medium` or `xhigh`; otherwise `medium`. |
| `lifecycle.startScript`, `lifecycle.stopScript` | The scripts the host runs to start and to switch profiles. |
| `lifecycle.startModeArgument` | Only its first parameter name, such as `-Mode`, which takes the profile's name. |
| `lifecycle.healthUrl` | The first status read. |

`reasoningBudget` is not read. The file is read again when its size or time changes, and a file over
64 KB is refused.

### Refusals

Each refusal is one sentence that names the field, shown in Settings and in the integration list:

| Case | Sentence |
| --- | --- |
| A base URL that is not plain http on 127.0.0.1, localhost or [::1], or that has credentials, a query or a fragment | "openaiCompatibleBaseUrl in nectovia-connection.json must be plain http on this computer: 127.0.0.1, localhost or [::1]." |
| A health URL on another address | "lifecycle.healthUrl in nectovia-connection.json must be on the same address as openaiCompatibleBaseUrl." |
| A start or stop script that is not a `.ps1` file inside the folder: another drive, a share, a `..` step | "lifecycle.startScript in nectovia-connection.json must be a .ps1 file inside F:\Bonsai-2." |
| A script that resolves outside the folder through a link or junction | The same sentence, from `server/bonsai/descriptor.ts`, which follows every link. |
| A script that does not exist | "lifecycle.startScript in nectovia-connection.json names F:\Bonsai-2\Start-Bonsai.ps1, which does not exist." |
| No profiles | "profiles in nectovia-connection.json lists no profile." |
| A profile name that cannot be a script argument | "profiles in nectovia-connection.json has a profile named "Full mode". A profile name starts with a letter and uses only letters, digits, - and _." |
| A missing or wrong field | "nectovia-connection.json has no valid model." |
| No file, bad JSON, too large, a relative folder | "There is no nectovia-connection.json in D:\Models\Meadow.", "... is not valid JSON.", "... is larger than 64 KB.", "The local model folder must be a full path, such as F:\Models\Local." |

A relative script name is read from the folder.

## What is read from the running server

`server/bonsai/probe.ts`, in order. Reading it starts nothing.

1. The descriptor's health URL. No answer: not running. 503, or a JSON status other than `ok`:
   starting. Another HTTP status or a redirect: needs attention.
2. `<base>/models`. The descriptor's `model` must be listed; the status names the listed ids when
   it is not.
3. llama.cpp's `<base without /v1>/props`, `default_generation_settings.n_ctx`. The running profile
   is the one whose `contextTokens` equals it. A profile that takes images is not chosen when the
   server says `modalities.vision` is false.

| Server | State | Detail |
| --- | --- | --- |
| Runs a profile's context | ready, with `mode`, `model` and `contextTokens` | "meadow-9b Quick is ready." |
| Runs a context no profile declares | ready, no `mode` | "meadow-9b is running with 32,768 tokens of context, which matches none of its profiles." |
| Has no `/props` | ready, no `mode` | "meadow-9b is running, but it did not report its context size." |
| Down | unloaded | "Meadow Local isn't running." |
| Health fails | error | "Meadow Local's health check answered HTTP 500." |

With no known profile, work that names a profile is refused: "The local model is running with
32,768 tokens of context, which matches none of its profiles. Start Quick first." A server without
a llama.cpp style `/props` can never run work.

The name the ask row shows is the served model id with the profile's name, such as
"meadow-9b Quick". Since the served id must equal the descriptor's `model`, the two agree. The
context ring, the turn's context account and the engine's token check use the running profile's
context as the server reports it.

## Profile slugs

A profile is listed as `local:` and its name in lower case: `local:gaming`, `local:full`.

Threads, settings and work saved before this change hold `bonsai-gaming` and `bonsai-full`. Those
read as the descriptor's Gaming and Full profiles wherever it has them, on the client and the
server. A thread choice that echoes one back, such as an Agent pick, is written under the new slug.
Where the descriptor has no such profile, the sentence is "The local model has no Gaming profile
now. Choose one of its profiles." Any other unknown slug: "Choose a local model profile." The Start
(`POST /api/ai/local-models/wake`) takes either form.

## The host script

`resources/bonsai-host.ps1` keeps its name. The app passes it the checked descriptor as JSON in
`NECTOVIA_LOCAL_MODEL` and the profile as `-Mode <name>`. It runs the descriptor's own start script
with the profile as its mode argument (`-Mode Gaming` for Bonsai, `-Profile Quick` for a model whose
argument is `-Profile`), and its stop script only to switch profiles on a Start. Unchanged:

- The lease, `delegate.lock` in the descriptor's folder, held for the whole call.
- One queue for selection and inference.
- Inference passes `-NoStart` and never starts or switches the worker. Only the person's Start does.
- A worker started outside Nectovia is never stopped.

The server is whatever single process listens on the base URL's port. Ownership is written to
`local-model-ownership.json`, and `bonsai-ownership.json` from earlier builds is still honored. The
script's Status action is gone: the app reads status over HTTP itself. The checks against Bonsai's
own server binary and state file are gone; the descriptor's scripts own those.

## Deadlines

The descriptor names no deadline, so a profile's deadlines follow its output allowance: fifteen
minutes per 32,768 output tokens, at least two minutes a call, and a turn of four calls, at most
thirty minutes. Bonsai's profiles keep their earlier values: Gaming 2 and 8 minutes, Full 15 and
30 minutes.

## What stays the same

Saved records keep their values, so nothing needs a migration: the route id `bonsai`, the account
route `bonsai:local`, the connection `bonsai-local`, the SDK `bonsai-local/1`, the error codes
`bonsai_<state>`, the zero rate card `bonsai-local-zero-inference-cost/1`, and the transcript folder
`model-transcripts-bonsai`. The price stays zero. Customers see the descriptor's and the server's
names; "Local model" where neither applies.

The three-model team (DIO-216, merged from `feature/three-model-team`) keeps its route-on gate and
its sentences. A local role may name `bonsai-gaming` or `local:gaming`.

## What it does not do

- No automatic install and no model download.
- No start except the person's Start. A send, an Automatic run or a Routine never starts or switches
  the model.
- No stop except to switch profiles on the person's Start, on a server Nectovia started.
- It never runs anything a model's output names.

## Tests

- `tests/local-model-descriptor.test.ts`: every refusal, Bonsai's own file parsed from a copy
  (`tests/fixtures/local-model.ts`), slugs, deadlines, and the folder on disk: Settings, then the
  environment, then nothing, links out of the folder.
- `tests/local-model-probe.test.ts`: the live identity from a fake server: present, no `/props`, an
  unknown context, down, failing, starting, a redirect, a slow health check.
- `tests/local-model-settings.test.ts`: the app's folder order and the hidden option, profiles
  named by the server, wake by slug, the Settings field's checks.
- `tests/local-model-host-script.test.ts`: the real host script under PowerShell with `-NoStart`
  against a fake server. It never runs a start or stop script.
- Updated for data instead of fixed names: `bonsai-runtime`, `bonsai-provider`, `bonsai-integration`,
  `bonsai-windows-host`, `bonsai-controls`, `model-api-thinking`, `three-model-team` and
  `bonsai-ui.spec.ts`, which now runs on a fixture model that is not Bonsai and checks that no
  "Bonsai" shows on screen.
