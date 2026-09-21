# Bedrock model operations through Vercel AI SDK

This is the separate Bedrock integration Andrew requested on September 21, 2026.
Claude retains the bot, conversation admission and Console work. This slice does
not enable a bot route or add an HTTP endpoint. SDKR remains open: its broader
context, streaming, live-provider and bot acceptance requirements are not closed
by this prerequisite.

Canonical versions checked: Core Pillars 2026-09-19.1, Live Roadmap 2026-09-19.2,
Project Memory 2026-09-19.2. The change uses the existing ModelAdapter, NativeAgent,
RunService, ToolRegistry and private provider-transcript reference. It introduces
no additional agent loop, permission authority, conversation store or screen.

## Provider and model

- Library: `ai@7.0.107` with `@ai-sdk/amazon-bedrock@5.0.88`.
- Provider: Amazon Bedrock Converse at the explicitly selected AWS region.
- Luna example: `us.openai.gpt-5.6-luna`, in `us-east-1`.
- Vercel AI SDK supplies the client library. This route sends inference directly
  to AWS; it does not use Vercel AI Gateway or a Vercel deployment.
- Host code supplies an explicit account route, exact model ID and either a
  Bedrock bearer key or SigV4 credentials. The adapter never reads ambient account
  credentials, silently changes provider, or falls back to a different payer.
- A selected model is recorded as configured, not independently attested. Converse
  does not identify the actual serving weights, so transcript `modelId` stays null.

The AWS [Luna model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html)
documents the Converse route and inference-profile IDs. Region availability,
account access and quotas must still be checked with the intended account.
The [Vercel provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock)
and the installed pinned SDK types are the implementation references.

## Host integration contract for the bot lane

The packaged desktop's existing harness exposes:

```ts
const { adapter, catalog } = harness.createBedrockModelRoute({
  profile: {
    id: 'bedrock-luna',
    accountRoute: selectedConnection.accountRoute,
    region: 'us-east-1',
    modelId: 'us.openai.gpt-5.6-luna',
    maxOutputTokens: 4096,
  },
  credentials: selectedConnection.credentials,
});
```

`selectedConnection` denotes the host's explicitly selected, current credential
binding; it is not a new settings field or a credential reader in this slice.
The factory creates no run and performs no network access. It registers credentials
with the host scrubber and keeps continuations under the host data directory at
`private/bedrock-transcripts`. It refuses construction after host shutdown.

The bot owner must admit its task through its existing Trust route and drive
`new NativeAgent(harness.runs, adapter, harness.tools)` under an authorized run and
lease. The host's current default egress authorizer does not grant Bedrock access;
that admission remains with the bot lane. Its authorizer must check the frozen
`intent.input.request.sdkProfile` and `sdkProfileHash` at dispatch and result
acceptance against the selected connection, current principal and permitted scope.
Creating the adapter or listing a model is never authorization.

`sdkProfile` contains the profile ID, provider, account route, exact model, region
and output-token ceiling. The profile hash also binds instructions, input/output
byte limits and SDK version. Credentials themselves never enter this request.
Rotate or replace the adapter when its credential binding changes; do not mutate
a live binding or reuse a friendly account label for a different payer.

## Execution and recovery

- One `generateText` operation, one SDK step and zero SDK retries. No `execute`
  callback is installed on tools. A single proposal returns to the owning host;
  multiple proposals are rejected together. Tool-specific input validation and
  execution remain with ToolRegistry and Trust.
- External model steps are explicitly marked external. RunService authorizes both
  dispatch and result acceptance. Lost results require reconciliation; replay does
  not send the request again. Local fixture adapters retain their local destination.
- Context, wire response and final output have byte limits. Abort propagates to
  the request and pending body reads. Redirects are refused. Cancellation does not
  establish zero AWS usage or a confirmed server-side stop.
- Empty answers, refusals, length-truncated output, invalid tool proposals, provider
  failures and unknown outcomes have distinct error codes. Measured usage is kept
  in successful durable outputs. Rejected answers carry any measured usage on the
  adapter error, but the existing RunService error record does not persist those
  token fields; failed-call billing reconciliation remains open with SDKR. Missing
  usage is not fabricated as zero. Errors do not expose raw SDK responses or credentials.
- The private SDK transcript preserves supported reasoning blocks and tool-call
  IDs. Immutable, bounded, hashed records are verified before continuation, bound
  to run, capability, profile and portable-message prefix. Missing/corrupt records
  fail closed. The portable conversation receives only an opaque reference.
- There is no transient streaming preview, live reconciliation API, local runtime
  installation, universal provider sign-in or automatic selection change here.

## Model freshness

`catalog.get()` refreshes the AWS account/region inventory on the first read and
the next read after the default one-hour TTL. `catalog.get(true)` requests refresh.
Concurrent reads share one refresh. ListFoundationModels and paginated
ListInferenceProfiles use explicit SigV4 credentials, fixed AWS endpoints, bounded
response/page limits, a timeout and no client retries. This implementation's
catalog requires SigV4; bearer inference remains supported separately.

Failures return an explicit unavailable/stale state with the prior retrieval time;
they never fabricate a current list or replace a saved model. Listed access remains
`unverified`. Foundation-model metadata alone is not proof that its raw ID accepts
regional inference. Use the documented inference-profile ID where required.

This design follows the useful Hermes separation of provider profiles, discovery
freshness and explicit selection. No Hermes, Devin, Claude Desktop or Codex Desktop
implementation was copied. The earlier research is recorded in the local artifact
`F:/Diomedes/deliverables/harness-research-2026-09-21/RESEARCH.md`.

AWS discovery references:
[foundation models](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html),
[inference profiles](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html).

## Verification and release boundary

Tests exercise the actual pinned SDK and its Converse encoding with synthetic
HTTP transport, plus the real RunService, file stores and host factory. This
proves the transport contract and recovery behavior without making a paid call.
Required repository gates and package evidence are recorded with the merge report.

Local verification of this candidate: TypeScript passed; Vitest passed 4,250 tests
with 4 skipped across 228 files; Vite production build passed; the required
`ui.spec.ts`, `native-ui.spec.ts` and `field.spec.ts` browser run passed all 36 tests.
The five Bedrock suites contain 34 tests within that unit run. These are synthetic
transport/host checks, not a live AWS model result. The existing client chunk-size
advisory remains. Source whitespace checks passed; one trailing space in a copied
third-party license was retained with its original notice text.

Code review was performed in this task against the full change. It caught and
fixed skipped egress authorization, a body-reader cancellation hang and the
normalized-transcript hash mismatch. No separate model reviewer was used. The
limitations stated here remain open rather than being promoted to SDKR acceptance.

Production dependency notices were regenerated. The provider-utils npm archive
omits its top-level license file; `licenses/ai-sdk-provider-utils-LICENSE.txt`
additionally retains the upstream notice from its
[matching 5.0.45 tag](https://github.com/vercel/ai/blob/%40ai-sdk%2Fprovider-utils%405.0.45/LICENSE).
The full Apache 2.0 text is also present in the packaged notices. The collector's
inventory still truthfully reports that the installed npm archive lacks that file.

No AWS credentials were available for a live request in this task. No live AWS
response, Console bot acceptance or public bot deployment is claimed. This bridge
does not change the SDKR roadmap status or mark any numbered prompt DONE.
