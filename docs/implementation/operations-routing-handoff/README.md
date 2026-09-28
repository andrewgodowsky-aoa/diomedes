# Desktop routing handoff

Unapplied patch. App/service ownership has transferred to this feature under
`handoff_mukxudp0_eb0e8b54` and `claim_mukxvns8_c7d3cc5a`. The full committed
dependency must be composed before this delta is applied. This artifact is not
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
