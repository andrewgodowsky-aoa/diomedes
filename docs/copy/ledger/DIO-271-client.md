# DIO-271 client copy ledger

Base: bae249b60ffafa3934d775c6d59fbac80990a83e. Each old string was reread in source before editing. Line numbers are the old base lines. JSX entries are literal source spans; interpolations remain in source. This ledger has 141 changed text fragments across 29 source files.

## C001 client/AppUpdates.tsx:124

Now: "Nectovia checks the official release page only when you ask. A newer version downloads first for verification; nothing installs without your explicit close-and-install."

New: "Check for an update, then download it. Choose Close and install when you're ready to update."

Why: VOICE 6/7, a/b/d/e: shorten update narration and verification jargon; retain verification and the install action.

## C002 client/AppUpdates.tsx:184

Now: "size, origin and published digest verified"

New: "Download matches the official release"

Why: VOICE 6/7, a/b/d/e: shorten update narration and verification jargon; retain verification and the install action.

## C003 client/AppUpdates.tsx:185

Now: "Published digest verification unavailable"

New: "Download verification unavailable"

Why: VOICE 6/7, a/b/d/e: shorten update narration and verification jargon; retain verification and the install action.

## C004 client/AppUpdates.tsx:188

Now: "Close and install exits Nectovia and opens the verified installer. The existing per-user installer preserves project and profile data."

New: "Close and install closes Nectovia and opens the installer."

Why: VOICE 6/7, a/b/d/e: shorten update narration and verification jargon; retain verification and the install action.

## C005 client/AppUpdates.tsx:194

Now: "Download checks the official asset's size and published SHA-256 before installation."

New: "The download is checked against the official release before installation."

Why: VOICE 6/7, a/b/d/e: shorten update narration and verification jargon; retain verification and the install action.

## C006 client/AppUpdates.tsx:248

Now: "Update handoff accepted. Nectovia is closing; the installer will open after it exits."

New: "Nectovia is closing. The installer opens next."

Why: VOICE 6/7, a/b/d/e: shorten update narration and verification jargon; retain verification and the install action.

## C007 client/AwsBedrockSetup.tsx:21

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 6/7, b/d/e: remove hardcoded model labels and tails; retain account, geography, response-storage request and Nectovia's total spending limit.

## C008 client/AwsBedrockSetup.tsx:114

Now: "Forget the saved AWS key and switch AWS Bedrock off? Spend records are kept."

New: "Forget the saved AWS key and switch AWS Bedrock off?"

Why: VOICE 6/7, b/d/e: remove hardcoded model labels and tails; retain account, geography, response-storage request and Nectovia's total spending limit.

## C009 client/AwsBedrockSetup.tsx:139

Now: "AWS Bedrock (Kimi K3)"

New: "AWS Bedrock"

Why: VOICE 6/7, b/d/e: remove hardcoded model labels and tails; retain account, geography, response-storage request and Nectovia's total spending limit.

## C010 client/AwsBedrockSetup.tsx:139

Now: "aws-bedrock"

New: ""

Why: VOICE 6/7, b/d/e: remove hardcoded model labels and tails; retain account, geography, response-storage request and Nectovia's total spending limit.

## C011 client/AwsBedrockSetup.tsx:150

Now: "Your company’s own AWS account, us-east-1, US processing. AWS keeps nothing between calls (store:false), and every call is billed to that account."

New: "Uses your business's AWS account in us-east-1, with US processing. Requests disable saved responses. AWS bills that account."

Why: VOICE 6/7, b/d/e: remove hardcoded model labels and tails; retain account, geography, response-storage request and Nectovia's total spending limit.

## C012 client/AwsBedrockSetup.tsx:254

Now: "Approve this as the most Nectovia may send to AWS in total, estimated from AWS list prices."

New: "Allow Nectovia to spend up to this total, estimated at AWS list prices."

Why: VOICE 6/7, b/d/e: remove hardcoded model labels and tails; retain account, geography, response-storage request and Nectovia's total spending limit.

## C013 client/CodexSetup.tsx:75

Now: "This route currently supports Windows."

New: "This connection requires Windows."

Why: VOICE 6, a/b/d: shorten setup instructions; retain the account the person connects and its subscription usage.

## C014 client/CodexSetup.tsx:77

Now: "Codex is bundled with Nectovia. No separate ChatGPT app or Codex installation is needed."

New: "Codex comes with Nectovia."

Why: VOICE 6, a/b/d: shorten setup instructions; retain the account the person connects and its subscription usage.

## C015 client/CodexSetup.tsx:78

Now: "The bundled runtime is missing. Reinstall Nectovia to restore it."

New: "Codex is missing. Reinstall Nectovia."

Why: VOICE 6, a/b/d: shorten setup instructions; retain the account the person connects and its subscription usage.

## C016 client/CodexSetup.tsx:82

Now: "Uses the native Codex account on this computer. Signing in can change that account. ChatGPT subscription usage applies to Ask, Plan, and Work in projects."

New: "Uses your ChatGPT subscription. Signing in can change the Codex account on this computer."

Why: VOICE 6, a/b/d: shorten setup instructions; retain the account the person connects and its subscription usage.

## C017 client/CodexSetup.tsx:86

Now: "Check connection looks at what is installed, which version it is and whether you are signed in, and confirms it can only read. It starts no work, so it uses none of your plan."

New: "Check connection checks the installation and sign-in without using your subscription allowance."

Why: VOICE 6, a/b/d: shorten setup instructions; retain the account the person connects and its subscription usage.

## C018 client/CodingTools.tsx:24

Now: "`${AGENT_NAME} does it with your ${AGENT_NAME} credits`"

New: "`${AGENT_NAME} uses your credits for the task`"

Why: VOICE 6, a/c: remove repeated Agent name and negative contrast; retain which plan pays.

## C019 client/CodingTools.tsx:141

Now: "can hand a task in your Personal work to a coding tool you already pay for. That task runs on your plan, not your"

New: "Use a coding tool you already pay for on Personal tasks. Those tasks use that tool's plan."

Why: VOICE 6, a/c: remove repeated Agent name and negative contrast; retain which plan pays.

## C020 client/CodingTools.tsx:142

Now: "credits."

New: ""

Why: VOICE 6, a/c: remove repeated Agent name and negative contrast; retain which plan pays.

## C021 client/ErrorBoundary.tsx:105

Now: "Nectovia stopped drawing"

New: "Nectovia couldn't display the window"

Why: VOICE 6, b/d: replace render narration and unsupported reassurance with the recovery action.

## C022 client/ErrorBoundary.tsx:108

Now: "Something in this screen failed while it was being drawn, so Nectovia closed it rather than showing you half of it."

New: "Reload Nectovia to reopen this screen."

Why: VOICE 6, b/d: replace render narration and unsupported reassurance with the recovery action.

## C023 client/ErrorBoundary.tsx:109

Now: "Something failed while the window was being drawn, so there is nothing on it."

New: "Reload Nectovia to reopen the window."

Why: VOICE 6, b/d: replace render narration and unsupported reassurance with the recovery action.

## C024 client/ErrorBoundary.tsx:110

Now: "Your files and your work were not changed by this, and nothing was sent."

New: ""

Why: VOICE 6, b/d: replace render narration and unsupported reassurance with the recovery action.

## C025 client/LocalModelFolder.tsx:57

Now: "The folder a local model is installed in. Nectovia reads its nectovia-connection.json for the model&apos;s name, server and profiles. The model starts only when you press Start."

New: "Choose the folder that holds your local AI and its nectovia-connection.json file. Press Start to use it."

Why: VOICE 6/7, b/e: lead with choosing the folder; retain the required connection filename.

## C026 client/ManagedInferencePolicy.tsx:7

Now: "Nectovia-managed AI is the default for paid Agent work. Any included allowance is used first, with model routing managed by Nectovia."

New: "By default, paid Agent work uses Nectovia's AI and draws from your included allowance first."

Why: VOICE 6/7, b/e: state usage and payment rules plainly; retain business approval, monthly cap, provider billing and subscription restrictions.

## C027 client/ManagedInferencePolicy.tsx:11

Now: "Additional managed usage is billed at Nectovia's current usage rate. It requires your organization's authorization and a monthly spending cap; it never starts automatically. A higher limit for one job does not authorize extra monthly spending."

New: "Extra usage needs your business's approval and a monthly spending limit. It's billed at Nectovia's current rate. Raising one job's limit doesn't approve extra monthly spending."

Why: VOICE 6/7, b/e: state usage and payment rules plainly; retain business approval, monthly cap, provider billing and subscription restrictions.

## C028 client/ManagedInferencePolicy.tsx:20

Now: "Advanced: organization-owned API or cloud account"

New: "Your business's own AI account"

Why: VOICE 6/7, b/e: state usage and payment rules plainly; retain business approval, monthly cap, provider billing and subscription restrictions.

## C029 client/ManagedInferencePolicy.tsx:22

Now: "Supported commercial API or cloud credentials are an optional, contract-specific setup. Contact Diomedes Systems to confirm eligibility. Your provider bills that usage separately; it does not use your included Nectovia allowance or grant Nectovia Agent access."

New: "Contact Diomedes Systems to arrange a supported business AI account. The provider bills you separately. That usage doesn't use your Nectovia allowance. You still need a plan that includes the Nectovia Agent."

Why: VOICE 6/7, b/e: state usage and payment rules plainly; retain business approval, monthly cap, provider billing and subscription restrictions.

## C030 client/ManagedInferencePolicy.tsx:27

Now: "Consumer, Pro, Max, Team and Business AI subscriptions cannot fund shared organization-wide Nectovia Agent work. A permitted subscription-backed external engine is for its licensed user on that user's device, subject to the provider's rules."

New: "AI subscriptions can't fund shared Agent work. Supported subscriptions cover the licensed person's work on their device, under the provider's terms."

Why: VOICE 6/7, b/e: state usage and payment rules plainly; retain business approval, monthly cap, provider billing and subscription restrictions.

## C031 client/ProviderSetup.tsx:8

Now: "../shared/agent-name"

New: ""

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C032 client/ProviderSetup.tsx:33

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C033 client/ProviderSetup.tsx:146

Now: "`Forget the saved ${name} key and switch ${name} off? Spend records are kept.`"

New: "`Forget the saved ${name} key and switch ${name} off?`"

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C034 client/ProviderSetup.tsx:218

Now: "Approve this as the most"

New: "Allow Nectovia to spend up to this total on"

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C035 client/ProviderSetup.tsx:218

Now: "may send to"

New: ", estimated from the prices you entered."

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C036 client/ProviderSetup.tsx:218

Now: "in total, estimated from the prices you entered."

New: ""

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C037 client/ProviderSetup.tsx:441

Now: "Your company’s own Azure AI Foundry or Azure OpenAI resource. Only the deployments you list are called, and every call is billed to that Azure subscription."

New: "Uses the deployments you list in your business's Azure resource. Azure bills your subscription for each request."

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C038 client/ProviderSetup.tsx:498

Now: "gpt-6-luna"

New: "model-name"

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C039 client/ProviderSetup.tsx:508

Now: "luna-prod-eastus2"

New: "deployment-name"

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C040 client/ProviderSetup.tsx:517

Now: "This is a reasoning model"

New: "Supports reasoning"

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C041 client/ProviderSetup.tsx:526

Now: "It takes the extra-high reasoning level"

New: "Supports extra-high reasoning"

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C042 client/ProviderSetup.tsx:621

Now: "Your own OpenRouter account. Only the models and endpoints you list are used; provider data collection is refused and fallbacks are off. Every call is billed to that account."

New: "Uses the AI and addresses you list in your OpenRouter account. Data collection and fallbacks are refused. OpenRouter bills that account."

Why: VOICE 6/7, b/d/e: shorten setup and approval copy, remove model codenames from placeholders; retain selected deployments, Nectovia's limit and collection/fallback refusals.

## C043 client/TierSetup.tsx:76

Now: "People choose Efficient, Focused or Thorough, never a route or a model. Choose which of your company accounts, and which model, serves each one. A tier whose account is not connected is refused by name; it never moves to another account."

New: "Choose the business AI account and model for each tier. A tier needs its chosen account connected before it can run."

Why: VOICE 6/7, b/c/e: describe selecting business AI directly; keep owner control and connection requirements.

## C044 client/TierSetup.tsx:131

Now: "For the owner and technical staff only. Pins one route, and optionally one model, for every tier on this computer while you test it. People still see only the tiers. Clear it when you are done."

New: "Test every tier on one connection on this computer, with an optional model choice. Clear the test setting when you're done."

Why: VOICE 6/7, b/c/e: describe selecting business AI directly; keep owner control and connection requirements.

## C045 client/VertexSetup.tsx:16

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 6/7, b/d/e: remove hardcoded model naming and tails; retain global location, business payer and Nectovia's limit.

## C046 client/VertexSetup.tsx:106

Now: "`Forget the ${name} connection and switch it off? Spend records are kept.`"

New: "`Forget the ${name} connection and switch it off?`"

Why: VOICE 6/7, b/d/e: remove hardcoded model naming and tails; retain global location, business payer and Nectovia's limit.

## C047 client/VertexSetup.tsx:138

Now: "Owner route: Gemini 3.8 Flash on Google’s global endpoint, billed to your own Google Cloud project, with an API key from that project (kept in protected storage) or the Google sign-in on this computer. Which work runs here is set by the Focused tier, not by this card."

New: "Uses Google's global service, billed to your Google Cloud project. Connect with the project's key or this computer's Google sign-in. The Focused tier decides which jobs use this connection."

Why: VOICE 6/7, b/d/e: remove hardcoded model naming and tails; retain global location, business payer and Nectovia's limit.

## C048 client/VertexSetup.tsx:230

Now: "Approve this as the most"

New: "Allow Nectovia to spend up to this total on"

Why: VOICE 6/7, b/d/e: remove hardcoded model naming and tails; retain global location, business payer and Nectovia's limit.

## C049 client/VertexSetup.tsx:230

Now: "may send to"

New: ", estimated at Google's standard price."

Why: VOICE 6/7, b/d/e: remove hardcoded model naming and tails; retain global location, business payer and Nectovia's limit.

## C050 client/VertexSetup.tsx:230

Now: "in total, estimated at Google’s standard price."

New: ""

Why: VOICE 6/7, b/d/e: remove hardcoded model naming and tails; retain global location, business payer and Nectovia's limit.

## C051 client/WhatsNew.tsx:49

Now: "This build carries no release notes."

New: "No release notes are included."

Why: VOICE 7, e: replace build jargon with the missing release notes.

## C052 client/ai-setup-state.ts:213

Now: "`The installation you chose${at} is no longer there. Nectovia will not switch to another copy on its own.`"

New: "`The installation you chose${at} is missing. Choose an installation again.`"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C053 client/ai-setup-state.ts:215

Now: "`The installation you chose${at} has changed since you chose it. Nectovia will not run it until you choose again or install a compatible copy.`"

New: "`The installation you chose${at} has changed. Choose it again or install a compatible copy.`"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C054 client/ai-setup-state.ts:221

Now: "Nectovia cannot read which installation you chose for this service, so it will not use one. Choose an installation again. The record it could not read is kept."

New: "Nectovia can't read your saved installation choice. Choose an installation again."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C055 client/ai-setup-state.ts:224

Now: "`The installation${at} failed its integrity check. Nectovia will not run it.`"

New: "`The installation${at} failed its integrity check.`"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C056 client/ai-setup-state.ts:243

Now: "This installation needs attention for a reason this version of Nectovia cannot put into words. Choose an installation again, or install the compatible copy."

New: "This installation needs repair. Choose an installation again, or install a compatible copy."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C057 client/ai-setup-state.ts:280

Now: "This is the local service the tool runs on this computer, not your provider account."

New: "Check the tool's connection on this computer."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C058 client/ai-setup-state.ts:282

Now: "The provider refused this account for this route. Check the account this route uses."

New: "The service refused this account. Check the account used for this connection."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C059 client/ai-setup-state.ts:287

Now: "The request reached the provider and did not finish."

New: "The request reached the service and didn't finish."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C060 client/ai-setup-state.ts:289

Now: "The tool may still be running. Wait before trying this route again."

New: "The tool may still be running. Wait before trying this connection again."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C061 client/ai-setup-state.ts:306

Now: "Not checked yet"

New: "Not checked"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C062 client/ai-setup-state.ts:307

Now: "The last check carries no usable time. Check again."

New: "The last check has no valid time. Check again."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C063 client/ai-setup-state.ts:318

Now: "Never verified by a real request"

New: "No successful test request"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C064 client/ai-setup-state.ts:335

Now: "Nectovia verified these bytes against the release it pinned."

New: "Matches the verified release."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C065 client/ai-setup-state.ts:336

Now: "Your own copy; Nectovia did not verify its publisher."

New: "Your own copy. Nectovia hasn't verified its publisher."

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C066 client/ai-setup-state.ts:391

Now: "`${name} reported no account this adapter accepts.`"

New: "`${name} reported no supported account.`"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C067 client/ai-setup-state.ts:392

Now: "`This route uses ${c.routeIssue.required} only. Other accounts you hold are not used here, and Nectovia does not switch to one of them.`"

New: "`This connection requires ${c.routeIssue.required}.`"

Why: VOICE 6, a/b/d: use direct setup actions and check results; retain separate checks, uncertain dispatch and integrity failures.

## C068 client/aws-bedrock-view.ts:69

Now: "Not approved: nothing can be sent"

New: "Approval required"

Why: VOICE 6, a/d: replace a repeated no-spend tail with Approval required; preserve cap state.

## C069 client/conversation-send.ts:70

Now: "The saved message is damaged; nothing was sent."

New: "The saved message is damaged."

Why: VOICE 6, d: remove redundant send tails and contract the error; preserve uncertain outcomes and retry behavior.

## C070 client/conversation-send.ts:72

Now: "This browser cannot save the message before sending it; nothing was sent."

New: "This browser can't save the message for sending."

Why: VOICE 6, d: remove redundant send tails and contract the error; preserve uncertain outcomes and retry behavior.

## C071 client/conversation-send.ts:74

Now: "Another window is still sending on this conversation. Nothing was sent from this one."

New: "Another window is sending a message in this conversation."

Why: VOICE 6, d: remove redundant send tails and contract the error; preserve uncertain outcomes and retry behavior.

## C072 client/conversation-send.ts:76

Now: "That message was discarded or settled in another window. Nothing was sent from this one."

New: "That message was discarded or settled in another window."

Why: VOICE 6, d: remove redundant send tails and contract the error; preserve uncertain outcomes and retry behavior.

## C073 client/conversation-send.ts:86

Now: "Nectovia could not confirm this message. Send it again to check what happened."

New: "Nectovia couldn't confirm this message. Send it again to check what happened."

Why: VOICE 6, d: remove redundant send tails and contract the error; preserve uncertain outcomes and retry behavior.

## C074 client/job-cap-gate.ts:106

Now: "Nothing was sent."

New: "Message canceled."

Why: VOICE 6, d: remove the guide's named reassurance tail; state the canceled message outcome.

## C075 client/provider-setup-view.ts:78

Now: "Not approved: nothing can be sent"

New: "Approval required"

Why: VOICE 6, a/d: replace a repeated no-spend tail with Approval required; preserve cap state.

## C076 client/route-cache-view.ts:20

Now: "No cache instruction is sent. The provider decides what it reuses."

New: "The provider decides what to reuse."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C077 client/route-cache-view.ts:37

Now: "Every call is sent with store set to false, so the provider keeps no response object. That is not the same as caching off."

New: "Each request disables saved responses. Prompt caching has its own setting."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C078 client/route-cache-view.ts:86

Now: "Caching off is confirmed. The newest route check saw no cache reads or writes with it."

New: "The latest check confirmed caching was off."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C079 client/route-cache-view.ts:88

Now: "Caching off is not confirmed. The newest route check still saw cache reads or writes with it."

New: "The latest check still found caching with this setting off."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C080 client/route-cache-view.ts:90

Now: "The provider refused the caching off request in the newest route check."

New: "The provider refused to turn caching off in the latest check."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C081 client/route-cache-view.ts:92

Now: "No current route check has tried caching off on this connection."

New: "Caching off hasn't been checked on this connection."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C082 client/route-cache-view.ts:100

Now: "With no cache instruction, the newest route check saw a repeated prefix read from a cache."

New: "The latest check found caching with the provider default."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C083 client/route-cache-view.ts:102

Now: "With no cache instruction, the newest route check saw no cache reads."

New: "The latest check found no cache reads with the provider default."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C084 client/route-cache-view.ts:104

Now: "No current route check shows what the provider caches by default."

New: "The provider default hasn't been checked."

Why: VOICE 6, a/b/c: state each observed result once; keep saved responses and caching distinct, with unknown and checked states.

## C085 client/vertex-setup-view.ts:75

Now: "Not approved: nothing can be sent"

New: "Approval required"

Why: VOICE 6, a/d: replace a repeated no-spend tail with Approval required; preserve cap state.

## C086 client/vertex-setup-view.ts:134

Now: "`Your Google Cloud project ${a.payer.projectId}, not Nectovia credits`"

New: "`Your Google Cloud project ${a.payer.projectId}`"

Why: VOICE 6, a/d: replace a repeated no-spend tail with Approval required; preserve cap state.

## C087 client/vertex-setup-view.ts:148

Now: "`Google’s, not Nectovia’s: see ${a.invoice.where}`"

New: "`Google's invoice. See ${a.invoice.where}`"

Why: VOICE 6, a/d: replace a repeated no-spend tail with Approval required; preserve cap state.

## C088 client/api.ts:64

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 5/6, b: contract common request failures and replace save-conflict narration with review of the latest settings.

## C089 client/api.ts:260

Now: "Settings changed while this screen was saving. The saved settings were reloaded."

New: "Settings changed during saving. Review the latest settings before saving again."

Why: VOICE 5/6, b: contract common request failures and replace save-conflict narration with review of the latest settings.

## C090 client/api.ts:277

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 5/6, b: contract common request failures and replace save-conflict narration with review of the latest settings.

## C091 client/approval-decisions.ts:24

Now: "Approval could not be confirmed. The request may have been accepted; "

New: "Approval couldn't be confirmed. The request may have been accepted; "

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C092 client/approval-decisions.ts:131

Now: "Approval was accepted, but this browser could not clear its saved request. Check approvals before deciding again."

New: "Approval was accepted, but this browser couldn't clear its saved request. Check approvals before deciding again."

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C093 client/approval-decisions.ts:132

Now: "The approval request was refused, but this browser could not clear its saved request."

New: "The approval request was refused, but this browser couldn't clear its saved request."

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C094 client/approval-decisions.ts:184

Now: "Saved approval requests could not be checked because browser storage is unavailable. Check approvals before deciding again."

New: "Saved approval requests couldn't be checked because browser storage is unavailable. Check approvals before deciding again."

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C095 client/approval-decisions.ts:207

Now: "A saved approval request could not be checked. It has been kept; check approvals before deciding again."

New: "A saved approval request couldn't be checked. It has been kept; check approvals before deciding again."

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C096 client/approval-decisions.ts:214

Now: "A saved approval request could not be checked. It has been kept; check approvals before deciding again."

New: "A saved approval request couldn't be checked. It has been kept; check approvals before deciding again."

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C097 client/approval-decisions.ts:295

Now: "Provide a valid version 1 exact approval identity."

New: "This approval request is invalid. Refresh the proposal before deciding."

Why: VOICE 5/6, b/e: contract recovery messages and replace a protocol assertion with refreshing the proposal. Keep possible acceptance and same-request retries.

## C098 client/work-start.ts:30

Now: "Work start could not be confirmed. The request may have been accepted; "

New: "Work start couldn't be confirmed. The request may have been accepted; "

Why: VOICE 5/6, b: contract recovery messages. Keep accepted/refused/uncertain states, original request retry and browser cleanup warnings.

## C099 client/work-start.ts:126

Now: "Work was accepted, but this browser could not clear its saved request. Check Work before starting again."

New: "Work was accepted, but this browser couldn't clear its saved request. Check Work before starting again."

Why: VOICE 5/6, b: contract recovery messages. Keep accepted/refused/uncertain states, original request retry and browser cleanup warnings.

## C100 client/work-start.ts:127

Now: "The request was refused, but this browser could not clear its saved request."

New: "The request was refused, but this browser couldn't clear its saved request."

Why: VOICE 5/6, b: contract recovery messages. Keep accepted/refused/uncertain states, original request retry and browser cleanup warnings.

## C101 client/work-start.ts:163

Now: "Saved Work requests could not be checked because browser storage is unavailable. Check Work before starting again."

New: "Saved Work requests couldn't be checked because browser storage is unavailable. Check Work before starting again."

Why: VOICE 5/6, b: contract recovery messages. Keep accepted/refused/uncertain states, original request retry and browser cleanup warnings.

## C102 client/work-start.ts:184

Now: "A saved Work request could not be checked. It has been kept; check Work before starting again."

New: "A saved Work request couldn't be checked. It has been kept; check Work before starting again."

Why: VOICE 5/6, b: contract recovery messages. Keep accepted/refused/uncertain states, original request retry and browser cleanup warnings.

## C103 client/task-create.ts:16

Now: "The saved task request could not be checked. It has been kept; check the Board before creating another task."

New: "The saved task request couldn't be checked. Check the Board before creating another task."

Why: VOICE 5/6, b/d: contract recovery messages and remove a saved-record tail. Keep Board check and same-request retries.

## C104 client/task-create.ts:21

Now: "Task creation could not be confirmed. Retry create checks the same request."

New: "Task creation couldn't be confirmed. Retry create checks the same request."

Why: VOICE 5/6, b/d: contract recovery messages and remove a saved-record tail. Keep Board check and same-request retries.

## C105 client/task-create.ts:92

Now: "This browser could not clear its saved task request. Check the Board before creating another task."

New: "This browser couldn't clear its saved task request. Check the Board before creating another task."

Why: VOICE 5/6, b/d: contract recovery messages and remove a saved-record tail. Keep Board check and same-request retries.

## C106 client/inventory/receipt-client.ts:58

Now: "Saved receipt intent is unreadable. Preserve it and reconcile before receiving more stock."

New: "The saved receipt request can't be read. Keep it and confirm what happened before receiving more stock."

Why: VOICE 6/7, b/e: use receipt and status wording instead of intent, reconciliation and operation jargon. Preserve uncertain or mismatched receipt outcomes.

## C107 client/inventory/receipt-client.ts:114

Now: "Receipt identity does not match the pending operation."

New: "The reply belongs to a different receipt. Check the original receipt's status."

Why: VOICE 6/7, b/e: use receipt and status wording instead of intent, reconciliation and operation jargon. Preserve uncertain or mismatched receipt outcomes.

## C108 client/inventory/receipt-client.ts:116

Now: "Uncertain receipt identity does not match the pending operation."

New: "The uncertain reply belongs to a different receipt. Check the original receipt's status."

Why: VOICE 6/7, b/e: use receipt and status wording instead of intent, reconciliation and operation jargon. Preserve uncertain or mismatched receipt outcomes.

## C109 client/inventory/receipt-client.ts:136

Now: "Status response does not match the pending operation."

New: "The status belongs to a different receipt. Check the original receipt's status."

Why: VOICE 6/7, b/e: use receipt and status wording instead of intent, reconciliation and operation jargon. Preserve uncertain or mismatched receipt outcomes.

## C110 client/workbench/RunInspector.tsx:111

Now: "Run evidence could not be loaded."

New: "Task records couldn't be loaded."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C111 client/workbench/RunInspector.tsx:139

Now: "Isolation and execution host are not recorded in this session."

New: "The computer and its isolation controls aren't recorded for this session."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C112 client/workbench/RunInspector.tsx:167

Now: "`Ran on ${modelDifference.reported}, as the runtime reported. Requested ${modelDifference.requested}.`"

New: "`Reported ${modelDifference.reported}. Requested ${modelDifference.requested}.`"

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C113 client/workbench/RunInspector.tsx:175

Now: "`${session.agent.policy.effective}. See the recorded authorization below. A thread preference is not a grant.`"

New: "`${session.agent.policy.effective}. Thread settings choose how it runs. Permission is checked before each action. See the recorded authorization below.`"

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C114 client/workbench/RunInspector.tsx:176

Now: "See the recorded authorization below. A thread preference is not a grant."

New: "Thread settings choose how it runs. Permission is checked before each action. See the recorded authorization below."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C115 client/workbench/RunInspector.tsx:226

Now: " · new, resume not possible"

New: " · new session, can't resume"

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C116 client/workbench/RunInspector.tsx:247

Now: "No effect authorization record yet."

New: "No action approval is recorded."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C117 client/workbench/RunInspector.tsx:284

Now: "This records past authorization; current grant validity is checked before each effect."

New: "Past approval. Permission is checked again before each action."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C118 client/workbench/RunInspector.tsx:312

Now: "No effect authorization record yet"

New: "No action approval is recorded"

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C119 client/workbench/RunInspector.tsx:369

Now: "Loading run evidence..."

New: "Loading task records..."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C120 client/workbench/RunInspector.tsx:378

Now: "No detailed Runtime record is linked to this session. Tool and budget evidence is unavailable."

New: "No detailed task record is linked to this session. Tool use and spending limits aren't recorded here."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C121 client/workbench/RunInspector.tsx:427

Now: "Unknown; call counts are not provider charges."

New: "Unknown. Call counts don't show the billed cost."

Why: VOICE 6/7, b/c/e: state record gaps and permissions plainly. Keep actual model attribution, per-action permission checks and unknown charges.

## C122 client/workbench/run-evidence.ts:98

Now: "`Nothing records ${what} for this session yet.`"

New: "`No record of ${what} for this session.`"

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C123 client/workbench/run-evidence.ts:112

Now: "This job did not run as part of a team."

New: "This job wasn't part of a team."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C124 client/workbench/run-evidence.ts:119

Now: "The runtime did not report which model answered."

New: "The tool didn't report which model answered."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C125 client/workbench/run-evidence.ts:122

Now: "The runtime did not identify itself."

New: "The tool didn't identify itself."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C126 client/workbench/run-evidence.ts:135

Now: "See the recorded authorization below."

New: "See the recorded authorization."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C127 client/workbench/run-evidence.ts:136

Now: "This has not been checked yet."

New: "No check result is recorded."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C128 client/workbench/run-evidence.ts:140

Now: "Nobody is recorded as having proposed this."

New: "No proposer is recorded."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C129 client/workbench/run-evidence.ts:141

Now: "Nobody reviewed this."

New: "No reviewer is recorded."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C130 client/workbench/run-evidence.ts:142

Now: "See the recorded authorization below."

New: "See the recorded authorization."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C131 client/workbench/run-evidence.ts:143

Now: "Nobody has checked the result."

New: "No checker is recorded."

Why: VOICE 6, a/b/e: remove formulaic Nothing/Nobody status prose while preserving every unknown field. Missing records do not prove no person reviewed or checked the work.

## C132 client/ready-queue.ts:25

Now: "`All queues paused · ${view.allPaused.reason}`"

New: "`All Ready work paused · ${view.allPaused.reason}`"

Why: VOICE 6/7, b/e: name Ready tasks and automatic starts; preserve pause reasons and running counts.

## C133 client/ready-queue.ts:26

Now: "`Queue paused · ${view.paused.reason}`"

New: "`Ready work paused · ${view.paused.reason}`"

Why: VOICE 6/7, b/e: name Ready tasks and automatic starts; preserve pause reasons and running counts.

## C134 client/ready-queue.ts:27

Now: "You start Ready work"

New: "Start Ready tasks yourself"

Why: VOICE 6/7, b/e: name Ready tasks and automatic starts; preserve pause reasons and running counts.

## C135 client/ready-queue.ts:28

Now: "`Starts automatically · ${view.running} of ${view.limits.global} running across projects`"

New: "`Automatic starts on · ${view.running} of ${view.limits.global} tasks running across projects`"

Why: VOICE 6/7, b/e: name Ready tasks and automatic starts; preserve pause reasons and running counts.

## C136 client/RouteChecks.tsx:14

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 6/7, e: replace route jargon with connection tests; keep live paid tests distinct from the bounded connection check.

## C137 client/RouteChecks.tsx:27

Now: "Route checks"

New: "Connection tests"

Why: VOICE 6/7, e: replace route jargon with connection tests; keep live paid tests distinct from the bounded connection check.

## C138 client/RouteChecks.tsx:124

Now: "Run route checks"

New: "Run connection tests"

Why: VOICE 6/7, e: replace route jargon with connection tests; keep live paid tests distinct from the bounded connection check.

## C139 client/PromptCaching.tsx:15

Now: "The request could not be completed."

New: "The request couldn't be completed."

Why: VOICE 5, e: contract the common request failure. Owner caching controls keep their precise technical labels.

## C140 client/AccountSettings.tsx:71

Now: ". Test data on this computer; nothing here was bought."

New: ". Sample accounts on this computer."

Why: VOICE 6, d: identify sample accounts once without the reassurance tail. The billing claim was released before this file was claimed and edited.

## C141 client/AccountSettings.tsx:105

Now: "You do not belong to a business yet. Personal work uses your own AI tools directly; the Nectovia Agent works for a business whose plan includes it."

New: "You don't belong to a business yet. Personal work uses your own AI tools directly; the Nectovia Agent works for a business whose plan includes it."

Why: VOICE 5: contract the UI negative while preserving the plan boundary. The two business empty states render mutually exclusively, so they are not redundant on one screen.

## Findings retained

- Named providers on their own connection buttons remain so people know which account they connect. Model identifiers in attribution and owner inputs remain truthful technical records.
- The italic font in client/main.tsx serves user-authored Markdown emphasis. Removing the font alone would leave italic CSS active and alter document rendering. It is retained.
- Retry warnings explain possible accepted requests and safe same-request retries. They carry information the person cannot infer and are retained with contractions.
- Caching verdicts remain scoped to the latest check. No observed cache reads does not mean caching is disabled.
- The three Not checked rows report independent installation, sign-in and model checks.
- Mandatory record fields retain individual unknown reasons. A missing reviewer/check record does not prove nobody reviewed/checked the work.
- Common API fallback errors remain standard across callers and now use contractions in owned paths. Advanced technical caching labels remain precise. Storage keys, theme extension, ids, routes and protocols are unchanged.

## Blocked ownership

- DIO-252 owns App.tsx, components.tsx, Settings.tsx and client/console/design-center/. Findings there remain pending their owner.
- DIO-267 owned AISetup.tsx, AccountGate.tsx, Setup.tsx, detail-words.ts and tests/ai-engines-ui.spec.ts at the initial source freeze. Its claim was released after the integrator verified the owner's process exit, absence of helpers and clean worktree. Only assertions were reopened; the unchanged source findings remain deferred.
- AccountSettings.tsx was originally held by B04.BILLING. Its claim was released during this pass; claim_muxqfdx3_98fbf1ac then acquired it for the two confirmed voice changes above.
- Conversation-send, thread-send and native-ui copy assertions were applied after fresh exact-path claims; their async, identity, no-network and durable recovery checks remain intact. The final two client handoff assertions in ai-engines-ui and ui were applied under claim_muxx1x3t_de42d1de after the DIO-267 owner exited. docs/copy/handoffs/DIO-271-client-tests.patch is now a fully applied historical record with no unapplied hunks. Still-held tests are unchanged.

## Verification

Static TypeScript/TSX source parsing: 29 passed, 0 syntax failures. Existing owned assertions were updated. Root's combined implementation report records gate results. Syntax parsing is not runtime or type acceptance.

## Original client finding reconciliation

All 167 original groups were checked against source and claims at the initial source freeze: 74 occur in the 29 edited files, 83 had external ownership exclusions, and 10 are retained or fixture-only. This is source-level disposition; the changed files retain precise findings documented above. The 83 initial ownership exclusions were DIO-252 (60), DIO-267 (18), and connection-reauth (5). DIO-267's claim was later released, but its 18 source groups remain deferred in the assertion-only reopen. Standalone fixture-main copy is used only by the disposable connections-demo script, not server/app.ts or desktop.

Independent semantic review corrected three draft mistakes before freezing: unknown repair reasons do not prove a read failure, recorded approvals do not establish current permission, and receipt recovery does not imply an existing support procedure.
