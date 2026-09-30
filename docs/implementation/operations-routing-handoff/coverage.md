# Operations routing coverage

Current local source: app `dae3a4b60feef2baec1ce15defcb3542c3c5a41c`
(tree `e810433d10d0f26480b9cc23d92ebd0ea31f0f46`), Operations
`fdd73a74b87bcbcf0ddec123cf78117efcf8fa8a`
(tree `e44e9737138a02b53ded7ab5ea5bf466df0a4560`).
Operations production source is unchanged from reviewed and browser-tested `e8366b4`;
the later commit repairs one test fixture and passes the full 24-case suite.
These include app main `1af37e0` and Operations main `d0d04da`.
The engine dependency `8ce83140` is already an ancestor; do not replay it.

This is source and local verification evidence. It does not establish real
PostgreSQL migration/privileges, funded provider readiness, packaging, deployment
or final merged acceptance. Paths below are relative to the app unless prefixed
`Operations:`. See [finish.md](finish.md) for the handoff and
[source-candidate.json](source-candidate.json) for exact committed file identities.
Historical failures and checks retain their original manifests in
[review-record.md](review-record.md); counts from separate runs are not added.

| Requested behavior | Implementation | Meaningful verification and remaining limit |
| --- | --- | --- |
| Global, organization and Individual policy; inherit/reset; independent revisions | `shared/routing-policy.ts`, control-plane `routing.ts`, `commercial.ts`, `commercial-postgres.ts`, `faux/store.ts` | Scoped fixtures cover two organizations and the same person's Individual, CAS, preview, rollback, inherit/reset and forged scope. The current 23-case scoped suite passes in the 83-test main-composition run. Real PostgreSQL persistence remains unverified. |
| Identity, membership, roles and Personal-only paid admission | Control-plane `commercial.ts`, `routing.ts`, `worker.ts`; desktop `accounts/routing-session.ts`, `agent-gate.ts`, `engines/service.ts` | Five intended new-main regressions were reproduced and repaired. Person access and explicit usage funding are both required for managed Personal work. Funding alone grants no access; one-member Business is excluded. Identity provisioning creates no grant or balance. The Personal browser journey verifies separate plan and usage agreement. |
| Customer privacy remains separate from staff routing and funding | `shared/routing-policy.ts`, `routing.ts`, `client/console/RoutingPreferences.tsx`, `client/AccountSettings.tsx` | Scoped tests cover consent, authorized scope ownership and staff refusal. Both browser journeys accept and persist Strict revision 1. NC-SETUP-2026-09-27.1 and NC-2026-09-28.1 remain distinct. |
| Approved connections and configurable model/protocol bindings | Control-plane `managed-bindings.ts`, `routing.ts`, `worker.ts`; `Operations: src/Routing.tsx` | Transport fixtures exercise AWS Responses/Chat/Converse/Messages, Azure Responses/Chat, Vertex GenerateContent/Messages and OpenRouter Chat, including tools and usage. The browser uses the actual Azure binding with synthetic loopback transport. No provider has funded live qualification evidence. |
| Endpoint, credential and downstream restrictions | `managed-bindings.ts`, `server/engines/openrouter.ts` | The recorded 31 binding cases cover host allowlists, redirects, credentials, scope, served-route attribution and tool withholding. The 16 direct OpenRouter cases include ZDR preservation and refusal before credentials/network when weakened. No secret values enter the renderer. |
| Strict, accepted exceptions and source rules precede ranking | `shared/routing-policy.ts`, `routing.ts`, `managed-inference.ts` | Recorded policy/scoped fixtures cover stale or mismatched evidence, geography, privacy, quality, zero quota, and before-send primary/backup exclusions. Real account privacy and quota qualification remain separate. |
| Conservative same-or-lower estimates and one job cap | `shared/routing-policy.ts`, `funding.ts`, `managed-inference.ts`, `server/spend-exposure.ts` | Policy cases compare cache/long-context rates and fees. Scoped cases preserve the original cap, retain uncertain primary costs and reserve backup attempts independently. Promotional offsets remain separate from debit. |
| Bounded, model-specific failover; no refusal or partial-response replay | `managed-inference.ts`, `managed-bindings.ts`, `managed-normalization.ts` | Capacity, cooldown, uncertain-hold, partial-output, refusal and incompatible native-state fixtures pass. A dispatch-write cancellation originally sent and settled; the repaired regression proves zero sends/backups, 499, retained uncertain hold, no settlement or cooldown. |
| Derived restrictions through tools, follow-ups, carried context and writing repair | `shared/harness.ts`, `server/harness/{native-agent,policy,model-api-adapter,model-session-run,nectovia-model-adapter}.ts` | The recorded 22-case harness green retains its original nine-failure evidence. Two real Nectovia ModelAdapter cases prove a permitted request succeeds and a forbidden connection stops before reservation/provider send. |
| Dynamic authenticated prices/capabilities and deliberate old-client refusal | `server/engines/nectovia.ts`, `engines/service.ts`, `accounts/routing-session.ts`, control-plane `routing.ts`, `managed-inference.ts` | Current 18 client cases pass, including non-Luna Personal host dispatch, snapshot expiry and receipt attribution. Missing/v1 protocol requests return 426 before reserve/send for versioned routes. The real browser route needs no hardcoded Luna rate entry. |
| Durable successful/failed receipts in Home, conversation and task details | `server/harness/{run-service,routing-receipts}.ts`, `server/app.ts`, `client/console/{DiomedesHome,ThreadView,ManagedRoutingReceipt}.tsx`, `client/workbench/RunInspector.tsx` | Harness fixtures cover restart, immutable pagination, identity, model-only trust and malformed receipts. The browser reproduced a missing Home mount after successful persistence. The repair reuses the existing receipt view; both Business and Personal details survive reload. Resetting Personal routing does not rewrite its old receipt. |
| Operations controls, staff bridge and credential isolation | `Operations: electron/service.mjs`, `src/{Routing,Customers,Admin,api}.tsx/ts` | Operations typecheck and build pass. Both browser journeys use the actual staff bridge. After formal test ownership transfer, the fixture owns its own unqualified route and compares rollback to captured initial tiers. Full Operations rerun: 24/24 passed, no skips; the original 22-pass/2-fail run is retained. Independent frontend/bridge source review passed. |
| Persistence, migration and runtime privileges | Immutable `009_individual_plans.sql`, additive `010-scoped-routing.sql`, `commercial-postgres.ts`, migration runner and permission SQL | Source tests enforce unchanged 009 and ordered migration history. The authored PostgreSQL suite covers pre-010 grants/admissions, identity-only backfill, repeat application, concurrency, restart and restricted roles. It has no approved disposable target and has not run. No migration was applied by this lane. |
| Complete staff-to-customer journey | `tests/operations-routing-journey.spec.ts`, handoff `fixture-server.ts` and `journey.config.ts` | Two browser tests pass against the real bridge, persisted faux policy, authenticated account, gateway, actual Azure binding and normalized runtime response. Business and Personal retain distinct policy/admission/funding. Both UIs and persisted receipts were inspected. This uses synthetic transport and disposable local data. |

## Recorded gates

- Old-base composed run, 10:32 UTC: 77 control-plane and 55 root tests passed,
  both typechecks passed; no skips. This predates the Individual main merge.
- Main-composition run, 11:46 UTC: 49 control-plane and 34 root tests passed,
  no skips. Both typechecks initially found two unrun PostgreSQL fixture
  assignments; explicit string validation repaired them. Both passed at 11:48.
- Response-contract repair, 12:23 UTC: 58/58 passed and control-plane TypeScript
  passed. It restores funding HTTP 402 and Business membership error contracts
  while updating registry fixtures to use an actually unregistered route.
- Final local browser run, 12:54-12:55 UTC: 2/2 passed, root TypeScript and both
  application builds passed. All 1,499 frozen source hashes were unchanged.
  The exact staged tree is the committed `dae3a4b` tree above.
- Operations fixture rerun, 13:21 UTC: 24/24 passed, no skips, four files. App
  executable source was unchanged; the only change among 1,499 frozen files was
  the reviewed Operations test. Its exact tree is now committed as `fdd73a7`.
- Coordinator reported the same 2/2 browser result and both builds on combined
  `6e9ebba`, including separately owned security fixes. That is a separate
  integration checkout and evidence stream, not a test run on this branch.

Current source is not marked DONE. The real database gate,
final combined review/gates and separately authorized live,
packaged and deployed acceptance remain explicit.
