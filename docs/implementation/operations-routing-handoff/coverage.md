# Operations routing coverage

This is a source-to-requirement record, not feature acceptance. Paths below are
relative to the app repository unless prefixed `Operations:`. Historical checks
apply only to their recorded source manifests. `review-record.md` retains their
original failures, repairs, counts, logs and review limitations.

Current composition: app `2b231c80cfd2dd9c6a7534e2ecf9e772f6db9c19`, including
provisional engine dependency `8ce831400fb4329ea06aec5cf85609638eb938e8` and
merged policy main `2e6c7850eb28491ea662fe2f36b68d5ac41ddbea`, plus the owned
working changes. Operations checkpoint: `f97e0b5b6944247426097b50a8cf48ad8cfa289d`.

The composed focused run at 10:32 UTC passed 77 control-plane tests, 55 root
tests and both TypeScript checks with no skips, SDK errors or source drift.
Evidence: `test-results/operations-routing-integration-green-20260928-103253/`;
the source manifest SHA256 is
`4BA6BD0162AD3BC34E6B83F49987A2ACF493F091B737E53B8FD0571F271F0E43`.
This run predates composition with main `1af37e0` / PR #176. That main introduces
Individual migration 009 and overlapping account code; its integration remains
pending. Operations main `d0d04da058e7e9fdaeb89f6b28da2ad933f678de` / PR #6
also adds Individual administration and overlaps three routing paths; it is not
imported into the Operations checkpoint. The browser and Operations window is
held before acquisition.

| Requested behavior | Implementation | Meaningful verification and current limit |
| --- | --- | --- |
| Global, organization and Individual policy; inherit/reset; independent revisions | `shared/routing-policy.ts`, control-plane `routing.ts`, `commercial.ts`, `commercial-postgres.ts`, `faux/store.ts` | The 18 passing scoped tests exercise two organizations plus the same person's funded Individual, inheritance/reset, CAS and rollback. Real PostgreSQL persistence remains unverified. |
| Identity, membership, roles and paid admission | Control-plane `routing.ts`, `commercial.ts`, `worker.ts`; desktop `accounts/routing-session.ts` and `agent-gate.ts` | Scoped tests cover forbidden publication, member consent, forged scope and revoked agreement. Client tests cover late results after account switches. The separate Personal-only paid-plan candidate still needs composition. |
| Customer consent remains separate from staff routing and funding disclosure | `shared/routing-policy.ts`, `routing.ts`, `client/console/RoutingPreferences.tsx`, `client/AccountSettings.tsx` | Scoped customer-profile and staff-refusal cases pass. The composed Operations suite and browser consent journey remain unrun. NC-SETUP-2026-09-27.1 is distinct from NC-2026-09-28.1. |
| Approved connections and configurable model/protocol bindings | Control-plane `managed-bindings.ts`, `routing.ts`, `worker.ts`; `Operations: src/Routing.tsx` | Real transport fixtures exercise AWS Responses/Chat/Converse/Messages, Azure Responses/Chat, Vertex GenerateContent/Messages and OpenRouter Chat. All four providers still lack live qualification and funded-call evidence. |
| Endpoint, credential and downstream restrictions | `managed-bindings.ts`, `server/engines/openrouter.ts` | The 31 binding cases pass through allowlisted-host, redirect, credential, scope, endpoint-attribution and tool-withholding checks. All 16 direct OpenRouter cases pass, including explicit ZDR preservation and refusal before credentials/network when weakened. |
| Strict, accepted exceptions and source rules precede ranking | `shared/routing-policy.ts`, control-plane `routing.ts` and `managed-inference.ts` | The 28 policy tests and scoped fixtures pass evidence-expiry/mismatch, geography, privacy, quality, zero-quota and before-send exclusions on the composed candidate. Live provider qualification remains separate. |
| Conservative same-or-lower estimate; one job cap | `shared/routing-policy.ts`, `funding.ts`, `managed-inference.ts`, `server/spend-exposure.ts` | Passing policy cases include cache/long-context rates and fees. Passing scoped cases preserve the original cap, keep uncertain primary cost and reserve backups independently. |
| Bounded, model-specific failover without refusal or partial-response replay | `managed-inference.ts`, `managed-bindings.ts`, `managed-normalization.ts` | Scoped cases pass capacity, cooldown, uncertain-hold, partial-output and refusal checks; bindings pass native-state isolation. Dispatch-write cancellation was reproduced (one unintended send and settlement), repaired and verified: zero sends/backups, 499, committed uncertain hold, no settlement or cooldown. |
| Derived restrictions through tools, follow-ups, carried context and writing repair | `shared/harness.ts`, `server/harness/{native-agent,policy,model-api-adapter,model-session-run,nectovia-model-adapter}.ts` | All 22 repaired harness cases pass, retaining their nine-failure original record. Two additional cases instantiate the real Nectovia ModelAdapter through the account gateway: an eligible restriction succeeds, and a disallowed connection stops before provider send/reservation. |
| Dynamic authenticated prices/capabilities and old-client handling | `server/engines/nectovia.ts`, `server/engines/service.ts`, `server/accounts/routing-session.ts`, control-plane `routing.ts` and `managed-inference.ts` | All 17 client cases pass, including non-Luna responses, snapshot expiry and receipt attribution. Missing and v1 protocol cases both return 426 before reserve/send on a versioned route. |
| Durable successful/failed receipts in ordinary conversation and task details | `server/harness/{run-service,routing-receipts}.ts`, `server/app.ts`, `client/console/{ThreadView,ManagedRoutingReceipt}.tsx`, `client/workbench/RunInspector.tsx` | Repaired harness passes restart, identity checks, immutable pagination, model-only receipt trust and malformed receipt cases. The browser must still demonstrate the receipt after reload. |
| Staff bridge and credential isolation | `Operations: electron/service.mjs`, `src/Routing.tsx`, `src/Customers.tsx`, `src/api.ts` | Operations type checking passed on the checkpoint. Existing staff-key/bridge tests and the new real-bridge routing fixture need the composed app run. No renderer token or provider secret is added. |
| Persistence, migration and runtime privileges | Candidate `009-scoped-routing.sql`, `commercial-postgres.ts`, migration runner, runtime/funding permissions | The real PostgreSQL suite is authored and refuses production/existing schemas. Read-only Neon inventory found only the production branch; no local PostgreSQL or approved isolated target is available. Main now owns Individual migration 009, so routing migration numbering and account identity must be reconciled without rewriting applied history. Real migration, privileges and concurrency remain unverified. |
| Complete staff-to-customer journey | `tests/operations-routing-journey.spec.ts`, `fixture-server.ts`, `journey.config.ts` | Authored journey starts the real Operations bridge, publishes routes, accepts customer privacy, uses the actual Azure binding and desktop SDK, then reloads the stored receipt. Build, browser run and screenshot inspection are pending. |

The 132-test result above is one current composed run, not a sum of historical
suite totals. Six follow-up cases now pass within it. Broader repository gates,
Operations checks, the browser journey and real PostgreSQL acceptance remain
pending. The only source change after that run is the unrun journey's composer
locator correction. Its two-repository browser freeze has SHA256
`CF61DB513184D4F35D9BFBB527989756B84DFBEDC094C991CD9D9BA36F2F7E8B`.
This record does not mark the feature DONE, merged, packaged, deployed or
live-tested. The work order contains the provisional migration/behavioral
rollback plan and provider readiness matrix.
