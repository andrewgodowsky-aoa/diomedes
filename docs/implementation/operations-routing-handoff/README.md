# Operations routing handoff

The forward composition with the merged Individual and security changes is
recorded in [combined-acceptance.md](combined-acceptance.md). Its app source
checkpoint is `a23b27ed65b90ef697c78e48f4f58792d5f55fa9`; Operations remains
`fdd73a74b87bcbcf0ddec123cf78117efcf8fa8a`. The source checkpoints below
pin the routing owner's earlier handoff and its exact manifest.

Current local code is app `dae3a4b60feef2baec1ce15defcb3542c3c5a41c` and
Operations `fdd73a74b87bcbcf0ddec123cf78117efcf8fa8a`. Both include the new
Individual main commits. Two Business/Personal browser journeys, root TypeScript
and both builds pass on the exact app tree `e810433d10d0f26480b9cc23d92ebd0ea31f0f46`.
Operations production bytes remain the browser-tested `e8366b4`; its subsequent
single-file fixture repair passes all 24 Operations tests with no skips.
The Home receipt mount was repaired after a real failing browser assertion.
The separate plan and managed-usage agreement retain Personal-only scope.

Start with [finish.md](finish.md), [coverage.md](coverage.md) and
[source-candidate.json](source-candidate.json). The latter lists exact committed
files for the current source checkpoints. `candidate-manifest.json` describes
the historical old-base checkpoint and must not be used as the current manifest.
The real PostgreSQL gate and funded live-provider, packaged and deployed
acceptance remain unverified. See [review-record.md](review-record.md) for
original failures, bounded checks and independent review.

The following sections preserve the earlier patch handoffs and their status
at the time they were written. Their pending/unrun wording is historical;
the current records above supersede it. Do not apply these patches again to
the composed checkpoint.

## Historical desktop patch handoff

Applied locally after composition; focused verification is in progress. App/service ownership transferred to this feature under
`handoff_mukxudp0_eb0e8b54` and `claim_mukxvns8_c7d3cc5a`. The full committed
dependency was composed in merge `2b231c80` from provisional engine `8ce83140`
and merged policy main `2e6c785`. The original target blobs remain unchanged
from the frozen handoffs below. This artifact is not
a tested or accepted desktop implementation.

`desktop.patch` binds to candidate
`b4a1e92f74fe0938d8c7a43ba36b8f1cd1636957` (the two target blobs are unchanged
from the earlier `357c79ea09f0b7d689d99e0f091850cc220954d8` handoff):

- `server/app.ts`: blob `c2b7cabaa91aacbf0a6cb959e9f4e91b981e6a24`
- `server/engines/service.ts`: blob `e617a04d5588bf6f4c6c78e912afe0c0fe3be969`

It consumes this feature's `AccountRoutingSession`, scoped admission, resolved
policy, customer preference schema and dynamic price/limit changes. It mounts the
customer consent endpoint, makes conversation and native-loop selection resolve
the owning scope, and binds all service rate-card and refresh calls to the same
project. Personal workspace work uses a real Individual billing scope. Fixture
connector capabilities keep their existing local-only boundary.

Dependencies before acceptance:

1. Reconcile the account-security owner's frozen session implementation and its
   current rotation/account-switch race repair.
2. Compose the exact provisional PR #169 dependency in the routing feature
   worktree, apply this delta, and resolve owned conflicts. That dependency is
   draft and has separate provider acceptance gates. Do not overwrite peer files.
3. Reconcile the separately owned Account/AI Setup policy UI; mount
   `RoutingPreferences` in the existing Account view after that owner's freeze.
4. Apply the separately reviewed harness source-restriction/receipt patch; prove
   derived input restrictions remain attached through every model step.
5. Run type checks, account-switch/revocation regressions, actual adapter fixtures,
   the Operations-to-customer journey and inspect both UIs on the composed source.

No provider credentials, production data or live readiness evidence are embedded
in this handoff. New production publication remains separately authorized.

`fixture-server.ts` and `journey.config.ts` support the authored browser journey
in `tests/operations-routing-journey.spec.ts`. It starts owned loopback services,
uses the real staff bridge and provider binding, and records screenshots and a
durable receipt. Both applications must first be built from the composed source.
No browser journey has run. The test slot and remaining UI/harness handoffs are
required before that work.

`conversation-receipts.patch` was applied after `desktop.patch`
and the complete frozen PR #169/#174 dependencies. It mounts the separate customer
privacy form, and a read-only projection of existing conversation child-run
receipts in the Console. `server/harness/routing-receipts.ts` and the on-demand
view are authored independently; neither is accepted by the earlier CP gates.
The reader checks project, thread, tenant and command identity, ignores tool
content, includes writing-helper attempts and pages by immutable turn identity.
The journey now requires the route, revisions and settlement to be visible after
reload, as well as present on disk. The receipt reader passes the repaired
harness cases; browser behavior remains unrun.

The complete original `harness.patch` is applied. Its Nectovia adapter section
was found missing during composition and applied as a separate diff; the earlier
claim that it was already present was incorrect. The 22-case harness suite ran
on both the partial and complete original compositions, each with nine failures
and thirteen passes. The suite does not instantiate the Nectovia adapter, so
both runs reproduced the same repair defects. Source hashes stayed unchanged.

`harness-repairs.patch` is now applied after those recorded reds. It retains
rules on direct model intents and derived history,
preserves the wrapper's enforcement capability, validates successful receipts,
records only model-failure receipts, and rejects tool content in the receipt
view. Its error mapping uses the existing harness contract. No tool effect,
budget, lease or run-state transition is redefined. Its green run passed all
22 cases at 09:58 UTC. Root type checking then found two test-fixture signatures;
their corrected rerun passed all 22 cases and root TypeScript at 10:14 UTC.
See `review-record.md` for the
original logs, unchanged-source manifests and remaining acceptance limits.
