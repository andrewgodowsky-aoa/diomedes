# Engine updates and current model discovery

Owner decision, 2026-09-27: connected engines must follow their own updates.
A vendor version is diagnostic evidence, never an admission allowlist. The
runtime that answers the capability and model checks must serve the request.

The reported GPT-6 Luna failure combined two different runtimes: the bundled
Codex was 0.153.4, while the shared account model cache came from the installed
desktop runtime. That cache is not proof that the selected runtime offers a model.

Implementation and acceptance scope:

- Discover the current installed Codex, retaining explicit operator selection and
  a bundled fallback. Bind read-only proofs and warm processes to executable
  identity so an update causes another check before work.
- Read models and reasoning options from the active authenticated engine. Refresh
  on connection checks and before dispatch. Withdraw stale choices on failure;
  never silently switch a person's explicit model or billing route.
- Admit each supported protocol through its capability, account, isolation and
  lifecycle checks. Keep protocol negotiation and artifact integrity checks;
  remove exact vendor build equality as a compatibility requirement.
- Resolve current official installer metadata when offering installation. Record
  the selected artifact and digest for that operation instead of freezing future
  installations to a source-code version.
- Retain historical tested versions as evidence only. New engine versions do not
  inherit claims of live-provider acceptance from an old build.

Product boundary: free accounts retain manual task boards and direct use of
their own connected engines. Nectovia Agent supervision requires a paid product
entitlement, independently of subscription/ACP transport or inference payer.
Managed GPT-5.6 Luna is the owner's temporary AWS selection and uses the account
tier's credit allowance. The separate
native ChatGPT route uses that account's subscription and its live model list.

Native provider verification, 2026-09-28 00:55 UTC:

- The production Codex conversation adapter selected the installed
  `0.158.0-alpha.2.1` runtime, proved its protocol and Windows read-only boundary,
  and read GPT-6 Luna and its reasoning choices from that authenticated process.
- Two subscription calls passed: a new `gpt-6-luna` conversation returned
  `ADAPTER_GPT6_LUNA_OK`; after closing the process, the same native thread resumed
  and returned `ADAPTER_RESUME_OK`. Start and resume reported `gpt-6-luna`; turn
  responses did not repeat the model identity. No injected transport or sandbox
  verifier was used. This proves the production adapter, not desktop UI acceptance.
- Windows sandbox setup can change executable metadata without changing bytes.
  Runtime identity now rehashes changed metadata and follows file identity plus
  content, avoiding a false update refusal while still rejecting replaced bytes.
- The real model-list protocol names reasoning options `reasoningEffort`; the
  projection now consumes that field instead of the account-cache field `effort`.

An additional low-effort native check acknowledged Stop after output began,
reported `TURN_INTERRUPTED`, closed the process, resumed the same thread and
returned `STOP_RESUME_OK`. Neither native check emitted reasoning-summary text;
Thinking display and full installed-desktop acceptance remain unproved.

AWS Luna provider acceptance remains blocked. The model agreement was accepted with
owner approval. Availability reports authorized/available, the inference profile
is active, and the existing key's model list includes Luna. Inference nevertheless
returned HTTP 403 after activation with both the existing key and account-root
SigV4 authentication. GPT-5.6 Luna was then activated separately with owner
approval; both the Runtime and Mantle Responses endpoints rejected the same
account. Five bounded Luna attempts each reserved at most $0.01, within
the approved $1 proof maximum and existing $100 testing ceiling; responses returned
no usage, and actual billed cost was not independently established.

AWS Support case `179055771300245` was submitted on 2026-09-28 at 01:08 UTC.
An additional observation from the live [OpenRouter provider page](https://openrouter.ai/openai/gpt-6-luna?endpoint=0bdc5375-9362-4fcb-9460-157e7f364a71#providers)
showed the Bedrock us-east-1 endpoint at 0.00% uptime. This supports investigating
provider availability as well as account eligibility; it does not establish a
global AWS outage or the cause of this account's rejection. Both possibilities
were supplied to AWS.

The owner subsequently approved a tiny Anthropic control and its separate model
agreement. At 02:43 UTC, `us.anthropic.claude-haiku-4-5-20251001-v1:0` returned
HTTP 200 and `BEDROCK_OK` through Converse using the same existing Worker key:
14 input tokens, 8 output tokens, thinking disabled, at most 32 output tokens.
Request ID: `100b2b93-d545-48be-ae11-2084b41c5c80`. This separate diagnostic
reserved another $0.01 and was added to the AWS case. It proves Anthropic
connectivity, not Luna eligibility, reasoning summaries, customer funding
admission or a production Agent model change.

The temporary GPT-5.6 selection carries the verified US Geo agreement prices:
short input/output $0.22/$1.32 per million tokens; long input/output $0.44/$1.98.
The managed gateway still rejects input above 272,000 tokens. Existing owner
connections to GPT-6 require an explicit reconnect and retain increasing
revisions; no saved connection is silently moved to another model.

Historical managed-install hashes remain only as migration receipts for existing
private copies. New installs resolve current official metadata and bind their
own verified receipt. These receipts do not allowlist vendor versions. Ordinary
application dependency lockfiles are outside this engine compatibility change.

Settings publishes each engine's choices independently, cancels superseded
requests and inspects installed or enabled engines. A held-catalog browser
regression checks that one slow engine cannot hide ChatGPT's choices. Historical
route descriptors retain the versions their evidence actually covered; these
metadata values do not restrict runtime admission or claim newer live proof.
Readiness compares validation records with an observed engine's current build,
so a compatible update neither inherits old proof nor needs a code change to
accept fresh proof for the newer build.

The combined checks also exposed a pre-existing containment defect: distinct
64-bit filesystem identifiers can round to the same JavaScript number. A
deterministic replacement regression failed before the repair and passed with
bigint identities at every comparison, preserving uncertain-effect and no-retry
behavior. That two-file repair is being integrated separately on main.

Final source-gate results are recorded against the candidate in the pull request.
The final candidate also repairs findings mapped from the independent review of
historical `93bdfaa`: account identity is checked by the process making a fork
before any thread effect, failed cleanup is exposed and retains the session's
process handle for a retry, and a selected model is never substituted for missing
runtime attribution. Native final answers are scrubbed before durable evidence,
saved conversations and replay, including route-specific secrets.

Channel switches no longer flush a partial redaction window. Text, thinking and
tool frames reserve their positions and are emitted in producer order once the
preceding text is safe. An incomplete channel can delay later frames until the
attempt ends. Stop drops held text and queued tool frames; continuous text still
streams. Pending output is bounded by characters and frame count. Answer and
activity overflow stays a refusal even if a transport catches its callback
error. Thinking preserves its optional narration contract: any redaction failure
discards that channel and its saved record for the rest of the attempt. Native
notification callbacks settle their own turn on failure instead of escaping the
host's process event handler.
Regressions cover split secrets across repeated switches, HTTP Store events,
durable output and replay. The focused live-redaction file passed all 27 tests;
two guard-removal mutations produced three intended assertion failures, and the
exact source was restored and passed again. The subsequent native-process/HTTP
batch passed the redaction, account-fork and cleanup checks. Its aggregate was
189 passed, two failed and one skipped: an absent-model origin was still stored
as an empty string, and a sandbox child process timed out. The origin is now
normalized to null; the repaired aggregate and final source gates remain required.

The Windows CI sandbox failure was a separate temporary manifest-replacement
error. Sandbox metadata now reuses the existing durable JSON writer's bounded
rename retry; new tests cover transient sharing errors and persistent failure
without losing the prior manifest or leaving a temporary file. Its source received
a bounded independent review, and all four focused metadata checks passed.
This does not erase the separate process-timeout result or replace the final gates.

Other engines have fixture coverage; this change does not claim new live Claude,
ACP, OpenCode or Devin provider acceptance, desktop packaging, deployment, or
completion of the required AWS proof.
