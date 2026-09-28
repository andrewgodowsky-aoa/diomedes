# Follow-ups after the harness green

These source observations are covered by six cases in three owned test files.
All six pass in the composed 10:32 UTC run: 77 control-plane and 55 root tests,
plus both TypeScript checks. No production service has been changed. Original
failures and source manifests remain in `review-record.md`.

- The versioned gateway links request cancellation to its provider controller
  after awaiting the dispatch record. If cancellation occurs inside that write,
  the later event listener missed the already-aborted signal. Aborting immediately
  after the real FundingService.markDispatched resolved reproduced one unintended
  provider invocation and a settled 14 micro-USD debit. The narrow repair checks
  the signal before sending, retains the committed uncertain hold and returns
  499. The unchanged test now verifies zero sends/backups, no settlement and no
  cooldown. Later in-flight cancellation still depends on transport signal support.
- The direct OpenRouter connection now supports an explicit endpoint ZDR flag.
  The new guard case admits the exact true flag and refuses its removal or
  weakening before reading credentials or making a network call. It passes.
- Two real Nectovia ModelAdapter cases carry derived restrictions through the
  account gateway: eligible routing succeeds, while a disallowed connection
  stops before provider send or attempt reservation. Both pass alongside the
  generic harness suite.
- Request-level checks for missing and v1 protocol negotiation both return 426
  before a versioned route reserves or sends. Neither activates a legacy route.

The original six-case diagnostic is
`test-results/operations-routing-followup-red-20260928-102453/`; the repaired
composed run is `test-results/operations-routing-integration-green-20260928-103253/`.
All 1,472 source hashes remained unchanged during each run. These results apply
to the recorded feature candidate, before PR #176/main composition.

Browser preparation found a fixture selector mismatch: the actual shared
Composer exports `COMPOSER_LABEL = 'Message this thread'`, while the unrun
journey located `Message Nectovia`. Both locators were corrected after the
integration freeze completed. Product labels are unchanged. The first browser
window is now held for PR #176/migration-009 reconciliation; no browser command
has run.
