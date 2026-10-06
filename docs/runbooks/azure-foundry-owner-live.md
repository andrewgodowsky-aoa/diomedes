# Owner-live proof: GPT-6.1 Sol on Azure AI Foundry

Who runs it: Andrew, with the company's Azure subscription.
Where from: an app build that has the Azure AI Foundry choice on the Azure OpenAI card in AI setup.
Who pays: the Azure subscription that owns the Foundry resource. The owner route uses no Nectovia
credits. Customer-managed inference goes through the gateway, which main already wires (section 5).

Nothing in this runbook has been run by an agent. Andrew runs every step that talks to Azure or
spends money. Steps marked **APPROVAL** need his go-ahead at that moment.

## 0. Decisions (Andrew, 2026-10-06)

- Efficient is **GPT-6.1 Sol** on Azure AI Foundry. Focused is **Kimi K3** on AWS Bedrock
  (`us.moonshotai.kimi-k3`, over Chat Completions; see the AWS Bedrock card). Thorough is
  **GPT-6.1 Sol** at high reasoning, and xhigh where the route offers it.
- GPT-6 Luna is no longer in the tier plan.
- Sol is called on the Foundry host of the company resource, `diomedes-foundry-dev-rg` (the name the
  gateway's approved connection uses): `https://diomedes-foundry-dev-rg.services.ai.azure.com/openai/v1/responses`,
  with the resource key in the `api-key` header and no `api-version` query.
- The app's logical model name is `gpt-6.1-sol`. The tier map sends it, and the connection maps it to
  the Azure deployment.

## 1. Deployment

In the Azure AI Foundry portal, on `diomedes-foundry-dev-rg`:

1. Confirm a GPT-6.1 Sol deployment exists, and write down its name exactly as Azure shows it. If
   it doesn't exist, check quota first, then **APPROVAL: create it**.
2. Note its price per 1M tokens (input, cached input, output) for that deployment type.
3. Copy a resource key from Keys and Endpoint straight into the app (next step). Do not paste it
   into chat, email, a file or a terminal.

## 2. Connect in the app (no spend yet)

AI setup › Azure OpenAI:

1. Resource type **Azure AI Foundry (services.ai.azure.com)**, resource name `diomedes-foundry-dev-rg`.
2. Deployment 1: model `gpt-6.1-sol`, the Sol deployment name, reasoning ticked, its prices.
3. Paste the key, tick consent, **Connect**. The card should show
   `https://diomedes-foundry-dev-rg.services.ai.azure.com/openai/v1`.
4. **APPROVAL: spend limit.** Enter `10.00` and save.
5. **Check setup**: every line says Yes. This check sends nothing.

## 3. First calls

1. **APPROVAL: first paid call.** Start an Efficient conversation and ask one short question. Expect
   an answer, a receipt naming `gpt-6.1-sol` on Azure, and a settled cost.
2. Do the same on Thorough. Expect the same model at high reasoning.
3. Focused needs the AWS Bedrock card connected for Kimi K3 and a current route check.
4. If a call fails, keep the HTTP status, the error body and the `apim-request-id`. A 404 usually
   means the deployment name is wrong; a 401 the key; a 429 capacity.

## 4. What this proves and what it does not

It proves the owner route reaches Sol on the Foundry host. It does not prove reasoning summaries on
Azure, xhigh on Azure (the desktop model-API routes send low, medium or high today), customer-managed
inference, or any packaged release.

## 5. Managed gateway (customers)

Main already approves the Foundry connection (`azure-foundry-dev`, host `services.ai.azure.com`) and
the Bedrock Kimi K3 connection in `MANAGED_CONNECTIONS`. What customers get per tier is the published
routing policy in Operations, not this file's defaults. **APPROVAL** before publishing: bind
`gpt-6.1-sol` to Efficient and Thorough and `us.moonshotai.kimi-k3` to Focused, with their access,
price, privacy and qualification evidence.
