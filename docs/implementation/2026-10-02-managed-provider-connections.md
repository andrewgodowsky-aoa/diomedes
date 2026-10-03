# Managed provider connections, 2026-10-02

Andrew asked for the company gateway to reach his Azure AI Foundry deployments (`gpt-6.1-sol`,
`gpt-6-luna`, `claude-opus-5-5`), Kimi K3 on Bedrock, OpenRouter and Google Vertex.

## What changed

- **Foundry host.** An Azure connection may set `host: "services.ai.azure.com"`. Absent, the gateway
  keeps `openai.azure.com`. Microsoft's v1 API answers on both hosts for OpenAI and Foundry Models
  (`/openai/v1/responses` and `/openai/v1/chat/completions`, deployment as the model).
- **Claude on Foundry.** An Azure binding may use `messages`, only for a `claude-*` model on the
  services host. The request goes to `https://{resource}.services.ai.azure.com/anthropic/v1/messages`
  with `api-key`, `anthropic-version: 2023-06-01` and the deployment as `model`. It reuses the
  existing Anthropic Messages body and stream handling.
- **Vertex API key.** A Vertex connection may name `VERTEX_API_KEY` instead of the hourly
  `VERTEX_ACCESS_TOKEN`. The key goes in `x-goog-api-key`, never as a bearer or in the URL, and
  `x-goog-user-project` is not sent with it. A key reaches Google models only.
- **Receipts.** Azure's `apim-request-id` is read as the provider request id.
- **Approved connections.** `MANAGED_CONNECTIONS` in both wrangler files, checked by
  `tests/deploy-config.test.ts` the way the gateway reads it:

| Id | Provider | Secret | Approves |
| --- | --- | --- | --- |
| `azure-foundry-dev` | Azure, `diomedes-foundry-dev-rg`, services host | `AZURE_OPENAI_API_KEY` | `gpt-6.1-sol`, `gpt-6-luna`, `claude-opus-5-5` |
| `aws-bedrock-us-east-1` | Bedrock runtime, us-east-1 | `BEDROCK_API_KEY` | `us.moonshotai.kimi-k3`, Chat Completions |
| `openrouter` | OpenRouter, global ingress | `OPENROUTER_API_KEY` | `deepinfra/fp8`, `baseten/fp8`, `fireworks/us`, `sail-research/us` |
| `vertex-diomedes-dev` | Vertex, project `diomedes-dev`, global | `VERTEX_API_KEY` | Google models |

Kimi K3 needed no code. AWS's model card (read 2026-10-02) lists `us.moonshotai.kimi-k3` on
`bedrock-runtime`, recommends Chat Completions there, and prices US cross-Region inference at
$3.30 input, $16.50 output, $0.33 cache read and $4.125 cache write per million tokens. The
OpenRouter tags and provider names are the exact ones OpenRouter's public endpoint list gave on
2026-10-02 for DeepSeek V4.1 Flash, MiMo v2.6 Pro and Flash, and GLM 5.3 Flash.

## Order of operations

1. Merge. Workers Builds deploys the Worker with these connections. No secret is set and no route
   exists yet, so nothing serves differently.
2. Andrew sets `AZURE_OPENAI_API_KEY`, `VERTEX_API_KEY` and `OPENROUTER_API_KEY` with
   `npx wrangler secret put <NAME> --name diomedes`. `BEDROCK_API_KEY` is already set.
3. Routes are saved in Operations. `saveRoute` accepts a binding only for a connection the deployed
   Worker approves, so this step waits for step 1.
4. One short probe per route, each approved for spend first. Access, health and privacy evidence
   come from those probes and from the provider terms, not from this record.

## Not done here

- The GLM 5.3 Flash deployment on Foundry is not approved yet: its deployment name is unknown. It
  will get its own connection so the Azure connection's revision and routes stay as they are.
- No route records, prices for Azure or Vertex, privacy evidence or probes. No live call was made.
- The Claude deployment's `modelVersion` is whatever Foundry reports in `message_start`. It is set
  after the first probe, not guessed.

## Gates (2026-10-02)

- `services/control-plane`: `npm run typecheck` passed. `npm test`: 953 passed, 55 skipped
  (52 files passed, 5 skipped).
- Root `npx tsc --noEmit` passed.
- Root routing and managed tests (`managed-gateway`, `managed-inference-policy`,
  `operations-routing-client`, `operations-routing-harness`, `managed-client-bundle`,
  `vertex-managed-funding`, `jev-managed-evaluations`): 105 of 105 passed.
- The full root suite, the build and the Playwright specs run before any push.
