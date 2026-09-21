# Vercel SDK model bridge

Owner: Codex in the integrator seat. Feature: vercel-model-bridge. Work item:
SDKR.VERCEL, a bounded prerequisite slice of SDKR, not acceptance of the full
numbered SDKR work order. Branch: feature/vercel-model-bridge. Worktree:
F:/Diomedes/diomedes-wt/vercel-model-bridge. Base: 7eb5918c4d7e8a821c889618af819d755f7d191e.

Andrew authorized implementation, verification, PR, main integration, deployment
and packaging on 2026-09-21. The current CD conversation, UI and admission files
remain with their active owner until a reviewed composition or handoff exists.

## Design and boundaries

Use the Vercel AI SDK under the existing ModelAdapter. The first provider is
Amazon Bedrock with GPT-5.6 Luna. The SDK is a library, not a new runtime. The
existing RunService authorizes and records model steps and dispatches tools.
Account, region, exact model and limits are explicit and immutable per adapter.
Neither the SDK default Gateway nor another provider supplies a fallback.

AWS documents the US cross-region identifier as us.openai.gpt-5.6-luna and
supports Converse on bedrock-runtime. Cross-region scope must be visible in
configuration. A deployment uses the configured credential route; the desktop
must never bundle a company-wide AWS key.

## Work and verification

1. Pin compatible SDK/provider versions and inspect their actual exported types.
   Write failing tests at the real SDK transport boundary with synthetic Bedrock
   responses. Assert explicit credentials, model and region, disabled retries,
   cancellation, bounded output, correct usage and zero tool execution callbacks.
2. Implement one model operation. Reject unoffered tools, malformed arguments,
   multiple proposals, refusal and empty answers. Preserve opaque provider
   continuation separately from portable context. Bind resumed state to the
   original model/account/profile; keep private reasoning out of UI and logs.
3. Add provider/model discovery through an explicit provider descriptor. Cache
   freshness must be visible, a refresh failure preserves last known data, and
   discovery never silently changes the selected model. Configuration is not
   proof that a model is accessible.
4. Verify the adapter through the existing NativeAgent and RunService, including
   host authorization, payer/profile binding, replay and unknown outcomes. Supply
   the exact production seam and evidence to the separate CD bot lane. Andrew
   clarified on 2026-09-21: keep Claude on the bot and finish the separate Bedrock
   integration here. Bot UI, conversation admission and bot acceptance stay in
   that lane; do not edit those claimed files or create another bot page.
5. Run focused conformance and recovery tests, typecheck, all unit tests, Vite,
   required browser tests and the host integration. Exercise the actual SDK transport in
   tests; label any missing live AWS access separately.
6. On a clean, reviewed and passing candidate: commit, PR, hosted checks, drift
   check, merge/push main, build a named package and verify it. Update the existing
   release/site channel only for behavior proven in that exact package.

## Review focus

- Missing credentials cannot select an ambient payer or Gateway.
- No SDK tool callback or retry can repeat an effect.
- Cancellation and account/profile changes fence dispatch and result acceptance.
- A partial or unknown provider result remains distinct from a successful turn.
- Stale model discovery cannot replace an explicit selection.
- The live CD owner and the shared heavy-test slot must remain respected.

Pre-flight: the model bridge consumes ModelAdapter/ModelRequest/ModelResult;
configuration and the bot host consume the same explicit provider profile.
Transcript storage must retain private provider state without changing the
portable conversation or inventing a second run lifecycle. Exact interfaces are
checked against the pinned SDK before the first production adapter edit.

## Evidence sources

- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html
- https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
- F:/Diomedes/deliverables/harness-research-2026-09-21/RESEARCH.md

No live provider, bot acceptance, release or deployment proof exists for this
slice at plan creation. Package-wide SDKR stays open until its full scope passes.

## Execution ledger

- User confirmed AWS means Amazon Bedrock Luna. Vercel AI SDK is the library;
  AWS is the explicit provider/account, with no Vercel AI Gateway inference hop.
- Dependencies installed in this isolated worktree only: ai 7.0.107 and
  @ai-sdk/amazon-bedrock 5.0.88. Existing control-plane dependencies installed
  from their lockfile for repository typechecking.
- First 10 SDK transport tests: RED (10 failures), then GREEN (10 passed).
- Continuation/cancellation expansion: RED (one body-reader cancellation hang),
  then GREEN (15 passed). Private transcript persistence: RED (4 failures), then
  GREEN (19 tests across both files). Typecheck passed at this point.
- Existing-runtime integration: RED (3 failures). Model steps were declared local,
  bypassing host egress authorization and marking lost cloud results failed instead
  of reconcile_required. Added an adapter destination consumed by NativeAgent;
  existing local fixture adapters retain their local destination.
- Ruling: the SDK bridge has no independent bot or HTTP lifecycle. The active CD
  lane consumes this adapter and its explicit account/profile configuration after
  its own contract acceptance. This preserves the user's clarified division of work.
- Runtime fix passed with 73 tests (including the existing harness tests). Catalog
  discovery passed 6 tests after correcting inference-profile ARN matching.
- Final storage/host regressions: RED (2 failures), then GREEN (30 focused tests).
  Canonical bytes are now computed after SDK schema normalization; the desktop
  host exposes an explicit construction-only factory, with private storage and
  secret scrubbing. Admission remains with CD, with no activation on construction.
- Dependency notices regenerated from the installed production graph. The pinned
  Codex notices needed their original LF bytes restored in this isolated checkout
  after Git's CRLF conversion. Native runtime inputs were copied from an existing
  release only after all three pinned SHA-256 hashes matched; no installation changed.
- Whole-candidate gates: TypeScript passed, 4,250 unit tests passed with 4 skipped
  (228 files), Vite passed, and 36 required browser tests passed. The five SDK
  suites account for 34 of those tests. Review was performed in this task; no
  independent model review or live AWS call is claimed.
