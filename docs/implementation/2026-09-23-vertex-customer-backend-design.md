# Customer-managed Vertex inference: narrow backend design (2026-09-23)

Status: **design only. Nothing is built, deployed or provisioned.** This is a separate gate from
the owner-live proof (`docs/runbooks/vertex-owner-live.md`), and nothing here is needed for that
proof.

## The problem it solves

On the owner route, the desktop reads the owner's own ADC and bills the owner's project. A
customer build must never carry a company Google credential (`tests/managed-client-bundle.test.ts`
guards this). So company-funded calls need a server that:
- holds the credential;
- checks the customer's identity and funding before each call;
- streams the answer back.

## Reuse, don't duplicate

| Need | Existing authority, reused as is |
| --- | --- |
| Who the customer is | Control-plane WorkOS identity (`services/control-plane/src/identity-workos.ts`) and account service. No second identity system. |
| Whether they may spend | `FundingService` over PostgreSQL (`funding.ts`, `funding-postgres.ts`): reserve → markDispatched → settle / release / markUncertain, `recoverAfterRestart`. No second ledger. |
| Usage semantics | `nectovia-usage/1` (`shared/usage-contract.ts`), with the raw `usageMetadata` kept as `raw`. |
| The provider call | The same guarded request the desktop builds, from `server/engines/google-vertex.ts` and `model-api-core.ts`: exact URL, redirects refused, bounded bytes, `maxRetries 0`, one step, descriptor-only tools. The core goes into a small shared module, not a copy. |
| Tool execution and approvals | They stay on the desktop, in NativeAgent / RunService / Trust. The server runs one model step per request and never runs tools, so there is no second runtime. |

## Shape

```
desktop (customer)                        inference gateway (company)              Google
NativeAgent step ──(WorkOS session, jobId, attemptId, body digest)──▶ authenticate
                                           FundingService.reserve(parent job)
                                           FundingService.markDispatched
                                           guarded streamGenerateContent ───────▶ Vertex (company project)
          ◀──────────── SSE relay (bytes bounded) ────────────────────
                                           settle(usage, raw) / release / markUncertain
```

- **Credential: attached service identity, not a downloaded key.** The gateway runs as a Google
  service account attached to its runtime, for example Cloud Run with its own service account and
  `roles/aiplatform.user` on one company project. Tokens come from the metadata server.
  - If the gateway must stay on Cloudflare Workers beside the control plane, use Workload
    Identity Federation, where the Worker's OIDC token is exchanged for a short-lived Google
    token, instead of a stored JSON key.
  - `google-auth-library` needs Node, which is the reason to prefer Cloud Run for the call leg.
- **Payer:** the company project is recorded on every funded attempt, with the customer's
  organization and parent job. A customer can never name a project.
- **One model, one location:** `gemini-3.8-flash`, `global`, the gross card. The gateway refuses
  anything else, exactly as the desktop does.
- **Restart safety:**
  - `recoverAfterRestart` runs at gateway start, per organization with open attempts.
  - A dispatched attempt without usage becomes uncertain, never zero.
  - An unsent one is released.
- **Stop:** the desktop aborts the relay, and the gateway aborts upstream. The funded attempt
  settles from any reported usage, or is marked uncertain.

## Open decisions (owner)

1. Where the gateway runs: Cloud Run with an attached service account (recommended), or the
   Worker with Workload Identity Federation.
2. Which company project pays, its billing account, and a Google budget alert on it.
3. Whether customer debits use the gross card (recommended while the promotion is unconfirmed)
   or a separate retail price.
4. Quotas: per-organization concurrency and the tokens-per-minute share of the project quota.

## Not in scope here

- Deploying, provisioning service accounts or changing billing.
- Selling plans or credit grants: `MONTHLY_CREDIT_GRANTS` stays as it is and nothing is sellable.
