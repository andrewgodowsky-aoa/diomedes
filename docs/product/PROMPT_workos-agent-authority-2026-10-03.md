# WorkOS agent identity and EMA: implementation amendments

WA-2026-10-03.1 | Prepared implementation prompts | 2026-10-03

Base inspected: `efcc554b71cd1be6100bda0d2dd1ae9cd7dc82c2`.
Architecture: [WorkOS agent identity and enterprise MCP access](../architecture/workos-agent-authority.md).
Status: **documentation only; no Agent Auth/EMA integration path approved**.

These prompts amend B02 hosted identity, B03 verified tenancy, B08 credential
broker, B10 revocation, H01 adapter contracts, H12 mediated effects, H14 Teams,
H21 recovery/migrations and P01/P03 packs. They are not additional numbered
execution nodes and do not reset accepted work or make an OPEN node
DONE. The active unified package's `RUN_ORDER.md`, `RUN_ORDER.json` and
`coordination/completion-status.json` remain the dependency/completion authority.
Its October 1 snapshot names six DONE prompts; this research changes none.
PB-01's [identity prompt](personal-business/prompts/OPUS_PB01_IDENTITY.md) consumes
this amendment without widening its scope.

Use current source and live provider documentation, the repository operating
contract and coordination claims. Preserve existing user work and shared hot-file
owners. Do not start workers or reviews unless the owner authorizes delegation.
Do not install packages, configure WorkOS/IdP production, send support messages,
apply live migrations, enable early-access flags or dispatch paid calls here.

## Prompt 1: reconcile identity and prerequisites

Carry out a read-only contract review of the existing hosted identity/account
and Trust composition, using the companion architecture. Freeze the inspected
main and the exact candidate files. Report which requirements are already
implemented, which are source-only/unqualified and which are missing.

Read `services/control-plane/src/identity-workos.ts`, `domain.ts`,
`account-service.ts`, `server/accounts/session.ts`, `routing-session.ts`,
`agent-gate.ts`, `server/trust/types.ts`, `authority.ts`, `revocation.ts`,
`local-backend.ts` and `server/harness/trust-port.ts`. Preserve the current
user-only verifier. Identify every API that assumes `sub` is a user, `sid` is a
user session and admission always has a human `personId`.

Produce a concrete additive patch proposal, inside those existing contracts,
for verified human/delegated-agent/autonomous-agent/Connect-client/M2M-service
facts and endpoint allowlists. Keep authenticated identity separate from resolved
authority. Specify the WorkOS organization-to-Nectovia organization mapping,
Personal refusal boundary, Business membership composition, root job/mandate
binding, durable generations and additive receipt migration. Never invent a
Person for a service or use an administrator's identity as an autonomous actor.

Required output: exact existing/new fields, consumers and storage owners;
source-aware migration/rollback; tests required below; evidence needed for
environment enablement and token-family audience configuration. Preserve existing
principal invariants and unknown historical attribution. Do not write an auth
adapter merely because B02 selected WorkOS for human sign-in.

The next prompts are prepared implementation instructions. They become executable
only after an owner-approved integration work order names scope, accepted
contracts, actual WorkOS environment and allowed sandbox/live evidence. Current
approval is for this documentation update only.

## Prompt 2: first-party agent broker under existing authority

After Prompt 1's contracts and integration work order are accepted, implement
the smallest disabled adapter in the existing account backend and Trust port.
Reuse its signing-key validation/credential infrastructure; add no competing
membership store, grant resolver, scheduler, writer or approval ledger.

Implement only the authorized first-party delegated Business case first. Split
delegated/autonomous blueprint mode configuration; allow only registered narrow
ceilings. Require verified organization mapping, original task scope, current
membership, paid/root-budget admission and Trust before minting. Default trial
lifetimes are 300-second access, 3,600-second refresh and 3,600-second maximum,
bounded by the work order. Explicit unattended mandates can later change them.
Never add undocumented mint scope/subset fields or default to autonomous after
delegation fails. Leave session chaining and Personal organization emulation off.

Keep API keys, human tokens and rotated refresh secrets in protected backend
custody. Prefer brokered task references for workers. Bind the returned agent
session to the admitted root and recheck generations after mint/refresh. Use
typed `at+jwt`/`ai_agent` verification and online agent validation at admission,
dispatch, result acceptance and later write. Re-resolve local membership,
blueprint/mandate ceiling, scope, caps, policy, approval, payer and spend at each
boundary; token renewal cannot broaden the original admission.

Reject agent/Connect/M2M credentials at human login, invitation, membership,
approval and staff Operations endpoints. Keep current Team prohibitions on
`approval.decide`, `write.apply` and `egress.send`. Autonomous admission must have
a separate reviewed mandate and nullable acting human, not a forged `personId`.
Do not enable it as part of the delegated case.

## Prompt 3: qualify EMA through the existing MCP/Connections model

After the identity/Business Trust/broker prerequisites are accepted, extend one
approved transport composition through `server/connections/service.ts`, the
existing connection binding and Runtime. Read `mcp-projection.ts`,
`server/harness/capabilities/mcp-read-client.ts`, `server/engines/read-scope.ts`
and `server/team/mcp.ts`; host-local projections, approved stdio reads and Team
mail are distinct from enterprise HTTP access.

Qualify inbound and outbound paths separately. Inbound: WorkOS handles ID-JAG
redemption; validate the final Connect access token at the exact Nectovia MCP
resource, registered client and tenant. Resolve client scopes and current human
permissions independently because Connect supplies no `permissions` claim.
Outbound: qualify the client/IdP exchange for the downstream authorization server
and concrete resource, with credential custody in the host broker. Existing
server-side XAA enablement alone does not implement this client path.

Use trusted metadata and real transport destination/redirect restrictions.
Never pass human/agent tokens to downstream servers, accept ID-JAGs as MCP bearers,
or treat broad environment audiences as a resource-specific audience. Keep
manifest/tool/resource/connection-generation checks at discovery and invocation.
Expose no unknown tools. Feed effects into the existing exact approval or scoped
grant path; connection consent, IdP policy, tool annotations and task continuation
never authorize effects. Remote unmediated tools must remain observed/unsupported
for enforcement, with governed credentials withheld.

Do not make Standalone Connect the new identity system, automatically enroll
Personal accounts in an enterprise, or silently fall back to a different client,
tenant/scope or unattended mode. Unsupported EMA may use only an independently
approved existing OAuth path. No production HTTP listener or early-access
enablement follows from these instructions without its named work order.

## Prompt 4: revocation, attribution and resource-flag qualification

Using the existing Store/account/Runtime evidence boundaries, persist agent,
mandate and connection generations. A local stop closes admission before remote
cleanup. Revoke the appropriate provider sessions/authorizations, cancel affected
children only, preserve uncertain effects and record cleanup failures/retries.
Delayed events or restart must not revive old credentials, grants or approvals.
Use provider live validation/qualified Connect introspection at effect boundaries;
webhooks accelerate invalidation rather than replace it. Preserve unrelated roots,
other organizations and Personal work.

Extend the existing receipts with agent/session/blueprint, delegated human or
mandate, client/tenant, root/child, capability/pack/connection revisions,
generations, governing grant/approval and actual engine/model/provider/payer.
Never log secrets/assertions or arbitrary intent. The sponsor is provenance,
the executing agent is the actor, and the existing authorized Person is the
approver. Provider lifecycle events do not prove tool effects.

Qualify custom resource flags only if the existing runtime supports their Node
evaluation path. The user-session flag claim does not contain custom targets.
Derive identifiers from current server-owned workspace/plan/environment/region
facts; qualify them by tenant/environment, and leave management claims grounded
in the current documentation. Treat flags as availability/deny controls. They
cannot activate packs, grant paid access, expand scopes or revive stopped work.
Do not add a new runtime dependency or Worker flag service through this prompt.

## Required acceptance scenarios for later implementation

These are **28 required scenario groups, all NOT RUN in this documentation task**.
Each group needs adversarial cases and positive controls through the real public
host/transport boundary. Report actual test counts separately from group counts.

| ID | Required boundary proof |
| --- | --- |
| WA01 | Valid human login stays compatible; agent, Connect, M2M and unknown/mixed families cannot become human sessions. |
| WA02 | Wrong issuer/environment/audience/algorithm, forged signature, invalid time/key rotation and ID-token/ID-JAG substitution send nothing. |
| WA03 | A valid delegated agent is attributed to both agent and mapped human, with exact backing session and blueprint binding. |
| WA04 | An autonomous agent has no forged human; absent/expired mandate denies, and failed delegation cannot become autonomous. |
| WA05 | Empty/broad blueprint defaults, unsupported invocation modes and unregistered/changed blueprint revisions cannot widen work. |
| WA06 | A narrower task/Trust scope wins over broader token permissions; an unknown slug grants nothing. |
| WA07 | WorkOS/Nectovia organization mismatch, missing/duplicate mapping and body/header tenant forgery deny. |
| WA08 | Cross-Business, cross-project/resource and Personal-to-Business access deny; workspace switching cannot retarget an admitted run. |
| WA09 | Human-only invitations, membership edits, approval decisions and Operations endpoints reject agent/service credentials. |
| WA10 | Mint/refresh never exposes API keys, human tokens, refresh secrets or assertions to models, packs, workers, renderer or logs. |
| WA11 | Concurrent/ambiguous refresh, single-use token replay, expired root and changed account generations cannot restore authority. |
| WA12 | Refresh or blueprint/role expansion cannot widen original admission; current narrowing applies before the next effect. |
| WA13 | Same-instance chaining cannot impersonate another Agent/Team slot; child scope/grants and root budgets remain bounded. |
| WA14 | Pack activation/update/rollback, model guidance and feature targeting cannot mint or promote authority. |
| WA15 | Valid identity/connection on a free/lapsed/over-budget account cannot admit paid Agent work; manual free Teams retain their separate path. |
| WA16 | Existing Team principal restrictions and external/subscription-worker gates remain enforced. |
| WA17 | EMA discovery/consent authorizes no read outside scope and no effect without the existing policy/approval coverage. |
| WA18 | Changed target/base/source/actor/destination/expiry invalidates approval; unrelated covered routine work avoids duplicated consent. |
| WA19 | Connect `scope` without user permissions, consent `sid` interpreted as a user session, and M2M client `sub` interpreted as a Person all deny. |
| WA20 | ID-JAG wrong AS audience/resource/client/subject, replay and wrong tenant are refused by the qualified exchange; final resource token is checked again. |
| WA21 | Token passthrough, cross-server token reuse, metadata/redirect destination substitution and environment-audience fallback send no credential. |
| WA22 | New/unreviewed tools or changed manifest/resource/connection generations deny at discovery and at direct invocation. |
| WA23 | Token/provider session revoke, human logout, membership removal and mandate withdrawal block next dispatch/late result/later write. |
| WA24 | Restart, lost/out-of-order/duplicate events, cleanup failure and provider outage keep closed authority closed; no cached grant fallback. |
| WA25 | Revoking one root/org leaves independent roots/orgs/Personal work intact; reinstatement cannot revive old references. |
| WA26 | In-flight effects distinguish submitted/confirmed/uncertain, cancellation and late results; retries never duplicate an uncertain write. |
| WA27 | Receipts truthfully separate proposer/reviewer/approver/agent/human/sponsor/engine/payer, preserve history and contain no credential/intent leak. |
| WA28 | Custom-target casing/tenant collisions, caller-forged plan/region, stale flags, unsupported runtime and flag off/on never bypass admission or revive a job. |

For every implementation verdict freeze exact hashes, name the relevant checks,
and report passed/failed/skipped/unrun counts. Repository merge/publication gates,
actual WorkOS/IdP calls, installed desktop, provider cleanup, multi-device and
production tenant evidence remain separate. A synthetic test or protocol
announcement never makes the integration DONE or production-ready.
