# Edge cases, acceptance and release gates

PB-2026-09-10.1 | Product acceptance requirements, not completed test results.

## First usable vertical slice

An existing Personal user opens without Business intake, creates a Business workspace explicitly, answers a short organization-bound questionnaire, reviews a proposed setup, activates supported Agents/rules and a small Team where available, and produces an approved-files draft. Console shows the organization, job, actual route, permission and payer. Restart preserves the configuration and work without duplication. Missing hosted infrastructure is visible, not mocked as paid availability.

## Focused cases

| Case | Required result |
|---|---|
| Legacy onboarding says business | Remains a preference; no organization, credits or authority minted. |
| Personal opens | No Business questionnaire or company-data intake. |
| One-person organization | Business setup works without imaginary employees. |
| Ordinary invitee joins | Existing configuration loads; no company-wide questionnaire. |
| Same person, two companies | Separate configuration, knowledge, credentials, tasks and payer. |
| Crafted tenant ID or stale membership | Host/service refuses unauthorized access. |
| Switch workspace during a run | Run remains tenant-bound; no context or billing transfer. |
| Billing contact lacks admin role | Can manage authorized billing only; cannot read company work by implication. |
| Questionnaire contains instructions to bypass rules | Treated as untrusted data, not policy. |
| Admins edit the same draft | Expected-base conflict; no silent privilege overwrite. |
| Setup fails halfway | Prior configuration survives; retry reconciles staged work. |
| Activation response lost | Same command returns existing result; no duplicated Agents, invites or schedules. |
| Rollback to an old version | Does not revive revoked grants, departed users, tokens or credits. |
| Connector is unavailable | Blocked/degraded/export fallback honestly shown. |
| Local-only model fails | No undisclosed cloud upload. |
| Adapter cannot enforce a required boundary | Not eligible for a claimed enforced guarantee. |
| Team delegates or retries | Same tenant and parent resource envelope; no privilege or credit laundering. |
| Reviewer/author labels differ | Does not imply independent review beyond actual contract. |
| Two calls race for last credit | Atomic reservations admit only affordable work. |
| Generation response is lost | Pending/uncertain charge reconciles; no blind free retry. |
| Billing event duplicates or arrives late | No duplicate allowance or revival of security-suspended access. |
| Balance is exhausted | New paid calls stop; explicit permitted fallback/top-up only. |
| Subscription lapses | No destruction of data; membership/privacy rules still govern export. |
| Owner leaves or deletes personal account | Organization records remain; explicit ownership/recovery process. |
| Offline device is revoked | Honest bounded offline validity, not a promise of instantaneous recall. |
| Shared local OS administrator | No claim that app tenant checks defeat OS access. |
| Schedule while computer sleeps | Waiting/unavailable, not falsely running because a cloud model exists. |
| Malicious/oversized regex or field | Validation rejects or safely bounds execution. |
| Rule/template update | Reviewable diff preserves customer overrides and historical revisions. |
| Narrow window, large text, long organization/model name | Accessible wrapping/truncation; no horizontal overflow or illegible type. |

These cases belong in the relevant existing harnesses. Do not paste the whole matrix into every Opus prompt or require redundant reviewer agents. Report actual commands/results under repository rules, not invented cumulative totals.

## Truthful release gates

Development: synthetic identities/providers and test usage are isolated from production; real local persistence and UI may be demonstrated. No customer billing or multi-tenant security claim follows from fixtures.

Controlled pilot: supported identity and organization ownership, scoped data/credentials, one verified route, written data/access authorization, defined support, recovery and export. Measure review time and failures, not only a successful demo.

Paid managed inference: server-held keys, membership/entitlement enforcement, bounded spend, request/settlement reconciliation, abuse controls, approved provider terms, clear allowance contract, revocation and incident handling. Website forms and a desktop checkbox do not satisfy this gate.

Broader Business release: supported signed distribution/update path, rollout/rollback, measured tenant isolation and capacity, operational monitoring, realistic support/retention terms and repeatable first-job onboarding. Existing release processes remain authoritative.

## Performance

Track startup/idle memory, questionnaire save/restore, configuration resolution latency, injected-context size, evidence growth, usage-ledger growth, model lifecycle and background task cleanup. Avoid polling when existing events suffice. Do not pin a local model just because a schedule is waiting. Compare before/after on the same source/environment rather than promise arbitrary thresholds without measurements.
