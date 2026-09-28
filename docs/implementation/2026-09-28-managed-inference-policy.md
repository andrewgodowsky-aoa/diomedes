# Managed inference commercial policy

The pricing policy left extra usage unresolved and the setup flow led with external
tools. The approved policy now prefers Nectovia-managed inference, uses the included
allowance first and describes additional usage at Nectovia's current usage rate.
Customer-owned commercial API/cloud accounts remain Advanced or contract-specific.
Subscription-backed engines are confined to provider-permitted use by their licensed
user on that user's device; they cannot fund shared organizational Agent work.

## Reconciliation

- Base: GitHub main `66334d512ef51c808d460b6e177690d87ecfaaa0`.
- Canonical commercial source: [Nectovia pricing and service scope](https://docs.google.com/document/d/1OrjI7NCBf4YRt2TGgBvPS52GW8LM3hgXCnN6lp7sxIQ/edit), updated in place to NC-2026-09-28.1 with revision-guarded writes and verified by readback. The old markup/open-decision paragraph, optional customer model-picker instruction and stale source-status paragraph were replaced. The Individual amendment and unrelated service scope were preserved.
- The repository is public. Internal pricing economics and negotiated exceptions stay
  in the private commercial authority; no internal formula is added to this repository.
- Core Pillars, Live Roadmap and Project Memory all report version `2026-09-27.1` at
  this base. Entitlement, payer, permissions, provider cost, customer debit and invoice
  remain separate. No roadmap item or released capability is marked complete here.
- Current provider references were inspected: [Claude Agent SDK plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [ChatGPT Business FAQ](https://help.openai.com/en/articles/8542115-chatgpt-business-general-faq). The product policy does not assert that all business use of provider subscriptions is forbidden.

## Source changes

- Existing pricing, managed-usage engineering and routing-handoff documents replace
  stale funding directions and remove public cost derivations from those active terms.
- Account and AI Setup share the public managed-usage wording. Billing copy stays
  within Account's existing plan-visibility permission. Free external-engine setup
  remains available without claiming an included managed allowance.
- Advanced account information is collapsed by default. Existing provider cards and
  tier mapping retain their host owner-route guard and sit behind a separate Advanced
  disclosure. Opening either disclosure grants no routing or spending authority.
- The account usage panel warns at 75%, 90% and exhaustion, including pending and
  uncertain reservations. Purchased balances do not move the monthly denominator;
  stale and unavailable data cannot produce a current warning. The panel refreshes
  while open.

## Export repair found during verification

The first full regression run found an existing export refusal for a generated
`actorPersonId` whose digits happened to pass the card-number detector. The generated
field matcher missed this multi-word key. The repair permits UUID-shaped values in
that exact field. Regression cases verify that API keys, bare card numbers and
user-entered text still receive the existing credential checks.

## Funding boundary

The existing funding service consumes monthly allowance before recorded purchased
top-ups and refuses unfunded calls. It has finite parent-job caps and conservative
reservations; changing a job cap does not authorize organization overage.

This patch does not implement postpaid billing. The commercial requirements now
explicitly demand organization-authorized rate/currency/period, a monthly charge
cap, atomic pre-dispatch enforcement, revocation and alerts at allowance/cap
thresholds. Postpaid extra usage remains unavailable until those requirements are
implemented together. No activation switch, payment request, provider call,
production migration or deployment is added by this patch.

## Verification

- New allowance-warning cases failed before the change: 8 failed, 13 passed.
- Focused app tests: 136 passed across 7 files on the final application source.
- Focused control-plane funding tests: 57 passed across 3 files.
- The first full app run reported 8,258 passed, 4 skipped and the export failure
  described above. A deterministic actor-ID regression failed before the repair;
  the repaired export suites pass all 19 tests across 2 files.
- TypeScript: passed after reusing compatible installed dependencies. No package or
  lockfile change was needed.
- Vite production build: passed, with the existing large-chunk advisory.
- Browser checks: 47 passed, 0 failed, 0 skipped across the required `ui`,
  `native-ui` and `field` suites plus the changed `allowance-ui` and
  `vertex-setup-ui` suites. The first browser run exposed a nested-summary locator
  ambiguity; selecting the direct summary fixed the test, and all five suites
  passed together against a fresh build.
- Final full app regression on the repaired source: 8,261 passed, 4 skipped,
  0 failed across 493 files. The isolated Windows run used two workers and the
  same 90-second per-test/hook bound as CI; no signed-in engine profile was used.

Local evidence is retained under `output/managed-inference-policy/`: focused app
results in `focused-app.json`, export regression results in `export-red.log` and
`export-green.json`, browser results in `browser-final.json`, and compilation
results in `typecheck-final.log` and `build-final.log`. The initial failed full
run remains in `unit-results.json`; the final run writes `unit-final.json`.

This records source and fixture verification only. Hosted billing, installed desktop,
live-provider and postpaid-cap acceptance are not claimed.

## Changed files

- `client/ManagedInferencePolicy.tsx`: shared public policy and Advanced disclosure.
- `client/AISetup.tsx`: preferred managed path and collapsed owner provider settings.
- `client/AccountSettings.tsx`: the same policy within existing plan permissions.
- `client/console/NectoviaUsage.tsx`: visible warnings and periodic refresh.
- `client/console/nectovia-usage-model.ts`: allowance thresholds including reservations.
- `docs/business/PRICING_STRATEGY_2026-09-15.md`: existing pricing authority reconciled.
- `docs/implementation/2026-09-22-nectovia-routing-handoff.md`: existing routing directions reconciled.
- `docs/product/personal-business/05_MANAGED_USAGE.md`: existing engineering terms reconciled.
- `docs/implementation/2026-09-28-managed-inference-policy.md`: this implementation and verification record.
- `tests/managed-inference-policy.test.ts`: public wording, Advanced defaults and plan permission checks.
- `tests/nectovia-usage-ui.test.ts`: threshold, correction, stale and missing-data checks.
- `tests/allowance-ui.spec.ts`: browser proof that allowance warnings refresh.
- `tests/vertex-setup-ui.spec.ts`: Advanced provider access and Account/Engines policy checks.
- `server/organization-export.ts`: the specific generated audit actor UUID exception.
- `tests/organization-export-archive.test.ts`: deterministic ID and credential boundary regressions.
