# WorkOS agent identity and enterprise MCP access

WA-2026-10-03.1 | Research and proposed integration contract | 2026-10-03

Inspected app main: `efcc554b71cd1be6100bda0d2dd1ae9cd7dc82c2`, tree
`282bc97962f1e606fb4d78b8224d586d095442a6`.
Pillars, Roadmap and Project Memory: **2026-09-27.2** each.
Trigger: the owner-supplied October 2 WorkOS email, `1a0fe67ab58946be`.
Public documentation checked October 3; the email itself was not retrieved.

This is a documentation amendment to existing identity, Runtime, Trust and
Connections work. It approves no production integration, provider configuration,
new authentication store or new execution path. The
[implementation prompts](../product/PROMPT_workos-agent-authority-2026-10-03.md)
carry these constraints into that work.

## Recommendation

Retain WorkOS AuthKit as hosted identity. Plan to use Agent Auth for first-party
Nectovia agents, and WorkOS Connect's EMA support for enterprise MCP connections.
Adopt their credential and federation machinery behind the current account and
Trust interfaces. Nectovia remains the authority for tenant/resource ownership,
capabilities, grants, approvals, paid access, budgets and effects. Neither a
valid token nor a connected server admits work on its own.

| WorkOS primitive | Adopt | Nectovia must wrap | Reject |
| --- | --- | --- | --- |
| Agent blueprints | Reusable, narrow first-party credential ceilings | Versioned mapping to Nectovia Agent definitions, allowed organizations and invocation modes | Treating a blueprint as a pack, workflow, Team membership or grant |
| Delegated identity | Agent identity with an explicit human principal | Current human membership, task scope and non-expanding delegation | Borrowed human credentials, administrator impersonation or agent self-approval |
| Autonomous identity | An agent acting for one Business organization | An administrator-approved standing mandate, resource limits and accountable sponsor | Falling back to autonomous mode after human delegation expires |
| Short-lived tokens and refresh | Provider signing, expiry and rotation | Backend-only mint/refresh broker, admitted scope ceiling and live checks | Giving a model a WorkOS API key or accepting a token at every endpoint |
| Session revocation | Provider session state and descendant invalidation | Durable local generations, worker cancellation and unresolved-effect reconciliation | Calling offline JWT verification immediate revocation |
| EMA / Cross App Access | Enterprise-admin authorization of a client/server relationship | Existing connection binding and per-operation Runtime/Trust checks | Equating removed consent screens with approved business actions |
| Connect M2M | A later credential option for bounded backend services | Explicit service identity, tenant, route and operation allowlists | Giving service credentials human, staff or autonomous-agent rights |
| Resource feature flags | Rollout selection for verified workspace/plan/environment/region facts | Server-derived identifiers and deny-only availability | A flag activating a pack, plan, grant, approval or authority |

## What the current documentation establishes

Agent Auth is for first-party agents and requires environment enablement. Its
blueprint, mint and validation operations use a server API key. Delegated
permissions intersect the human's permissions with the blueprint; autonomous
permissions use its ceiling. An instance is organization-bound, and tokens
distinguish the agent from its human principal. Refresh rotates a single-use
token; chains are bounded by root lifetime. `agent_delegated` creates another
session of the same instance, not a different worker. Optional `intent` is
caller-provided context and is not persisted by WorkOS. These are provider facts,
not Nectovia approval semantics. [Agent Auth](https://workos.com/docs/authkit/agent-blueprints)

The blueprint API exposes mint and live-validation operations. Validation checks
the blueprint and backing session, including the backing user session for a
delegated agent. Blueprint invocation defaults are broad: empty role/organization
lists do not mean deny, and the allowed instance types default to both. Do not
copy those defaults into Nectovia's deployment policy.
[Blueprint API](https://workos.com/docs/reference/agents/blueprint)

WorkOS calls its EMA path **Cross App Access (XAA)** in the MCP guide. It is
environment-gated early access and unavailable with Standalone MCP Auth. AuthKit
handles the resource authorization server's ID-JAG exchange. An agent platform
implementing the client side must separately qualify that integration; enabling
the receiving side does not supply a Nectovia outbound client.
[MCP / Cross App Access](https://workos.com/docs/authkit/mcp#cross-app-access)

The MCP EMA extension is Stable; that status does not make WorkOS early access
generally enabled or make its underlying ID-JAG draft an RFC. The profile uses
SSO to the enterprise IdP, an RFC 8693 exchange for an ID-JAG, and an RFC 7523
grant at the resource authorization server. Both sides need the established SSO
trust relationship. IdP policy governs token issuance, not subsequent MCP
traffic. [EMA specification](https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx)

Connect access tokens differ from AuthKit session and Agent Auth tokens. They
carry client `scope`, not a `permissions` claim. A user token's `sid` identifies
consent; an M2M token has no `sid` and its `sub` is the application client ID.
User role permissions need their own resolution. Do not feed these fields into
a human-session parser. [Connect token claims](https://workos.com/docs/authkit/connect/token-claims)

Custom feature targets are exact, case-sensitive identifiers evaluated by the
Node runtime client, not the session's `feature_flags` claim. WorkOS does not
verify that an application resource ID exists. The current custom-target guide
says management is through the Dashboard, while the targeting API accepts only
organization/user targets. Verify actual runtime compatibility before adopting
this for the Worker. [Custom targets](https://workos.com/docs/feature-flags/custom-targets)

## Current architecture and the integration gaps

A bounded case-insensitive search of `docs`, `server`, `shared`, `services` and
`planning` at the inspected main found no references to Agent Auth,
`agent_blueprint`, `sub_profile`, MCP authorization, enterprise-managed access or
ID-JAG. The active unified execution package also had no such integration
references. This is a scoped absence finding, not proof about every branch or
private WorkOS configuration. B02's existing user AuthKit path is not approval
for an early-access Agent Auth/EMA implementation.

| Existing seam | Evidence and required reuse |
| --- | --- |
| Hosted identity | `services/control-plane/src/identity-workos.ts`, re-exported by `server/business/identity-workos.ts`: verifies signed human tokens, exact configured client/audience, live user/session, and rejects `act`. Extend through typed adapters; retain this human-only boundary. |
| Account and organization ownership | `services/control-plane/src/domain.ts` and `account-service.ts`: verified issuer/subject maps to a Person; organization membership and session records are Nectovia-owned. `createOrganization` creates Nectovia IDs, not a proven WorkOS organization mapping. |
| Personal and Business scope | `server/accounts/session.ts`, `routing-session.ts` and `agent-gate.ts`: resolve owner, person/organization, paid admission, route and root job. Agent identity cannot replace any check. |
| Runtime | `server/harness/run-service.ts`, `host.ts` and `shared/harness.ts`: one run lifecycle, mandatory policy, leases, steps, approval binding and recovery. Federation supplies authenticated facts to this path. |
| Trust | `server/harness/trust-port.ts`, `server/trust/authority.ts`, `types.ts` and `revocation.ts`: current authority, genuine results and generations. Saved references never carry reusable authority. The generic epoch registry is currently in memory. |
| Personal Trust composition | `server/trust/local-backend.ts` and `docs/implementation/2026-10-01-agent-team-automatic-work.md`: app-scoped OS/account/project lifecycle. Production Business membership composition is explicitly still a missing dependency. A WorkOS JWT does not supply it. |
| Teams | `server/team/service.ts`, `mcp.ts` and `server/harness/capabilities/team-loop.ts`: agent slots, bounded delegation, shared root budget and stop ownership. A slot's bearer is not a WorkOS identity. |
| External/subscription workers | `server/external-worker-port.ts`, `server/subscription-workers.ts` and the October 3 implementation records: provider-owned sign-in, gated worker paths and restrictions. Agent Auth neither authenticates these provider accounts nor enables their disabled gates. |
| Capability packs | `server/capability-packs.ts`, `shared/capability-packs.ts` and `docs/product/2026-09-10-capability-packs.md`: pinned declarations and activation; activation grants no authority. |
| Connections / MCP | `server/connections/service.ts` and `mcp-projection.ts`: immutable run/connection binding, manifest/resource/operation checks and fresh authority. The projection is host-local and read-only. `server/harness/capabilities/mcp-read-client.ts` uses approved stdio read tools; neither is a production HTTP EMA integration. |
| Approvals / receipts | `server/approval-admission.ts`, `server/harness/approval.ts` and Store's recorded writer: exact action identity and existing receipts. Add attribution to those records, never another approval ledger. |

Do not assert production Business isolation from these seams' existence. Before
agent integration, qualify the WorkOS-to-Nectovia organization mapping, Business
Trust composition, durable revocation and per-effect enforcement on the actual
supported host. Pillars 02, 06, 07, 08, 09 and 12 already require this separation;
this proposal changes none of their meanings or completion status.

## Identity model

Preserve Person, Organization, Membership, AccountScope, Agent definition/revision,
Team slot, device, execution principal and provider connection as separate
objects. Add authenticated provider facts to the existing resolver contract;
do not invent agent Persons or a second membership system. The following is a
proposed adapter shape, not an implemented type.

An agent binding names the verified provider issuer/environment, blueprint and
instance, backing agent session, Nectovia Agent definition/revision, one account
scope, current tenant/project/resource binding, root job, mode, delegation/mandate
reference and current generations. Store identifiers and approved scope only.
Keep access and refresh tokens in the existing protected credential boundary.

| Caller | Principal for authority | Human attribution | Admission basis |
| --- | --- | --- | --- |
| Human session | Existing verified human session | The Person derived from verified issuer/subject | Existing membership, grants and account admission |
| Delegated first-party agent | Verified agent instance/session plus Nectovia execution binding | `act.sub` maps to the delegating Person; preserve its backing session separately | That human's current membership intersected with blueprint, original task scope and Trust |
| Autonomous first-party agent | Verified agent instance/session under one Business organization | Sponsor/admin is recorded as mandate author, never represented as the acting human | Active organization mandate, paid Business access, resource scope and Trust |
| Connect MCP user/client | Registered external client plus verified user/organization facts | Human subject and client are distinct; no invented first-party agent instance | Client scopes plus independently resolved membership/permissions and local connection grant |
| Connect M2M service | Explicitly registered service client | No acting human; record service owner and organization | Approved service operation allowlist and current tenant policy |

For delegated work, retain both the agent and the delegating human. A human token
does not become an agent token by adding a body field. No delegated agent can
use `act.sub` as a login session or gain the local owner's assurance. For an
autonomous agent, absence of `act` is necessary but insufficient: the backend
must know the registered invocation mode and mandate. An unknown or contradictory
token family/mode is denied. A missing `sub_profile` alone never classifies every
Connect/M2M token as human.

Support autonomous Business work only under an explicit standing mandate that
names purpose, allowed projects/resources/effects, sponsor, time/turn/spend
limits, approver policy and stop conditions. Employee departure may revoke their
delegated work; an independent Business mandate needs its own review/reassignment
policy. Never convert one to the other to keep a job running.

Personal/Individual currently has no Business `organizationId`. This phase must
not create a hidden WorkOS organization to make Agent Auth fit, promote Personal
work into Business, or route it through any organization the human belongs to.
Keep its existing identity/admission path until an explicit personal mapping is
designed and approved. The same restriction applies to null/ambiguous project
ownership; do not repair ambiguity by guessing a tenant.

## Token minting and verification boundaries

The existing protected account backend hosts the mint/refresh/validation adapter;
the renderer, model, pack and worker cannot call WorkOS administration directly.
Keep the WorkOS API key and delegated human token out of agent context. Prefer
brokered calls so Team/external workers receive task references and filtered
results rather than raw provider credentials. A qualified first-party remote
worker may receive only its narrow agent access token for the approved Nectovia
gateway; refresh custody stays in the backend.

Minting requires all of the following, before disclosing or starting work:

1. Resolve the caller through current account/Trust authority. Obtain verified
   human facts for delegation or a live mandate for autonomous use.
2. Resolve a single existing account/organization/project owner and the approved
   WorkOS mapping. Validate the blueprint's allowed environment, revision,
   organization, role and invocation mode. Use separate delegated/autonomous
   blueprints with explicit mode configuration and narrow ceilings.
3. Admit the root job through the existing account, Runtime and Trust paths.
   Pin resources, capabilities, data route, payer, limits and approval policy.
   An approval-required operation may be planned but cannot be dispatched yet.
4. Mint through the documented server operation; atomically bind the returned
   instance/session to the admitted unit. Recheck generations after the remote
   response. A racing stop or account change invalidates the mint and schedules
   provider revocation; an unbound token is never handed out.

For a delegated mint, the authenticated user's selected WorkOS organization must
match that mapping. The current Nectovia account bearer or a Personal token with
no selected organization must not be silently repurposed for this exchange.
Establish the provider-supported organization session through the existing login
flow; refuse a mismatch before calling the mint endpoint.

Use a proposed initial access TTL of **300 seconds**, a refresh window of
**3,600 seconds**, and a hard session maximum of **3,600 seconds**, further
bounded by the mandate/job. These are Nectovia trial defaults, not WorkOS minimums
or a reason to repeat human approval every hour. A longer unattended window
needs separately recorded policy. Serialize refresh per provider session and
store the rotated secret atomically; an ambiguous refresh must never retry a
spent token as though rotation had not happened.

The mint API does not document a per-request permission-subset field. Narrow
WorkOS ceilings through approved blueprint configuration; enforce finer task,
project, resource and operation limits in Nectovia. Never send invented `scope`
or `permissions` mint parameters. Refresh/chaining can pick up changed provider
rights, so the original admitted scope remains a ceiling until an explicit new
admission; renewal alone cannot expand a saved job.
Minting a fresh session also cannot reset the root job or mandate's elapsed-time,
turn or spending limits.

At ingress, dispatch, result acceptance and before later writes:

- Use an endpoint-specific token-family allowlist and verified cryptographic
  claims. Reject ID tokens, ID-JAGs, malformed/mixed actors, unsupported algorithms,
  wrong issuer/environment/audience, expired/future-invalid tokens and unknown
  blueprints. Select trusted metadata/keys from configuration, not token URLs.
- For Agent Auth require `typ: at+jwt`, `sub_profile: ai_agent`, `sub`, `sid`,
  `agent_blueprint_id`, `org_id`, `jti`, lifetimes and the expected delegated
  `act` shape or autonomous binding. Verify the signature and expected audience
  without relaxing the existing human verifier. Agent Auth currently documents
  the environment client ID as audience: accept it only at the named agent
  gateway, with the local route/operation binding as a further restriction.
- Call the documented agent validation operation at authority/effect boundaries
  to prove the provider session live. Compare its instance, session, organization
  and acting user to verified claims and the backend binding. A static JWT or
  webhook cache alone is insufficient. Provider errors/unavailability deny or
  suspend dispatch; they never select a cached-authority fallback.
- Resolve current Nectovia membership/mandate, blueprint ceiling, Trust grants,
  project/resource ownership and generations. Derive positive rights by
  intersection; apply all matching prohibitions. Unknown permission slugs add
  nothing. Provider roles/permissions never directly instantiate `Authority`.
- Check capability/pack/connection pin, route/data policy, account entitlement,
  root budget and exact approval/standing-grant coverage through their existing
  services. Recheck after asynchronous validation and at the actual handler.

For agent-executed operations, effective permission is the intersection of the
provider ceiling, current human permissions or mandate, admitted unit scope,
Trust grant, reviewed capability implementation and bound connector/resource
scope. Separately require live identity, correct tenant, paid access when needed,
budget admission and policy/approval coverage. A positive answer from one check
cannot compensate for a failed or unavailable answer from another.

## Organization and service isolation

Bind provider organization IDs by verified issuer/environment and WorkOS ID to
one Nectovia organization/tenant. Validate that mapping against the existing
organization record and current generations. Never match organization names,
email domains, body-supplied `org_id`, URL slugs or feature targets to grant access.
Provisioning the mapping must be an authorized, idempotent extension of existing
account onboarding, not another signup flow. Missing/duplicate mappings deny.

Every job, receipt, token custody reference, connection, cache and worker message
uses that account/tenant key plus project/resource where relevant. Bind the
resource owner before using its contents. Scope key rotation/revocation so a
change in Business A cannot revive or invalidate unrelated Business B or Personal
work. A workspace switch never retargets an already admitted run.

Use Agent Auth for first-party agent attribution and Connect M2M only for
ordinary registered service callers, where justified. M2M is organization-bound
and offers online introspection; qualify its exact token/audience behavior before
use. [M2M applications](https://workos.com/docs/authkit/connect/m2m)

An M2M service can transport a separately admitted work item but cannot become
its human approver. Do not make one shared service credential an all-tenant
gateway credential. Use an explicit client-to-organization/operation binding,
fresh Trust checks and service-specific endpoint admission. WorkOS's M2M audience
is environment-wide, so it must not implicitly authorize all Nectovia APIs.
Provider inference/connector credentials, local device keys and staff-only
Operations credentials keep their existing roles. None is a substitute for
another, and no customer agent/service token is accepted as an Operations key.

## MCP EMA integration through Connections

Treat inbound and outbound MCP as separate qualified compositions of the same
Connections and Runtime services:

1. **Nectovia consuming downstream MCP.** Resolve the approved connection,
   destination, organization, client and resource. Discover only trusted metadata;
   enforce HTTPS/destination/redirect and credential-boundary rules at the actual
   transport. Request the ID-JAG from the configured enterprise IdP for the
   downstream authorization-server issuer, then redeem it there for a
   resource-specific access token. Keep assertions and secrets in broker custody.
   Qualify client-side WorkOS support explicitly; existing stdio readers remain
   stdio readers until this transport is admitted.
2. **A client consuming a future Nectovia HTTP MCP endpoint.** WorkOS handles the
   assertion exchange. Verify only the resulting Connect access token with the
   exact resource audience, expected client and tenant mapping. Resolve client
   scopes and human permissions independently. Bind to an admitted connection/run
   and expose/call tools through the existing projection/service. Do not publish
   the current host-local projection or Team MCP as a blanket remote endpoint.

The ID-JAG audience names the authorization server; the issued access token's
audience names the MCP resource. Never use the assertion as an MCP bearer, pass a
Nectovia user/agent token to an arbitrary downstream server, or reuse one server's
access token at another. Configure and verify concrete Resource Indicators;
reject the environment-client-ID fallback at a resource-specific HTTP endpoint.
Authentication still precedes resource authorization.
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

An authenticated connection can be discoverable without being executable. Pin
the reviewed manifest/version/digest, exact server/resource, allowed operations,
data policy and connection generation. Filter discovery using current authority
and repeat it at invocation; catalog entries, remote tool annotations and newly
advertised tools are not permission grants. A credential's broad vendor scope
must not become broad tool exposure.

Every read still needs resource authority and permitted disclosure. Every effect
uses the same Runtime pre-effect policy and approval path as a non-MCP effect.
IdP-admin consent approves the client/server relationship, not sending email,
issuing refunds, writing files, provisioning other clients or spending credits.
Reuse an existing task/project/standing grant when it covers the exact operation;
otherwise create the existing Need. Neither EMA nor a separate consent screen
should duplicate or erase that approval. Tool/session continuation cannot bypass
rechecks after revocation or a changed target/base/destination.

If the IdP, client or server lacks qualified EMA support, leave the connection
unavailable or use an already approved ordinary OAuth path. Do not silently
switch identity, tenant, scopes or unattended authority to recover connectivity.
WorkOS's convenience is useful only where Nectovia's broker actually controls
dispatch. Direct external-engine tools remain observed where Nectovia cannot
mediate them; withhold governed credentials/tools rather than claiming control.
For a governed run, refuse an engine route if its own automatically available
EMA tools cannot be disabled or constrained at invocation. An independent
connection in that engine's account is not Nectovia-enforced capability access.

## Teams, packs and approvals

A Nectovia Agent definition maps to a blueprint revision; a Team slot maps to an
admitted execution unit, not automatically to an instance. WorkOS reuses an
instance across matching blueprint/organization/human contexts, so bind separate
root jobs and sessions instead of assuming one instance means one job or slot.
Children get their own bounded binding and root-budget allocation, never copied
tokens/grants. Disable WorkOS session chaining initially; later same-instance
chaining must not be used to authorize another Agent, pack or Team slot.

Maintain current `team-member` invariants: no `approval.decide`, `write.apply`
or `egress.send`. A remote identity adapter cannot bypass the protected host path
by labeling its caller `local-owner`. First-party agents proposing effects use
the existing authorized host dispatcher and writer. If a future worker needs a
different principal kind, change the shared Trust contract under review; do not
relax Team invariants or mint a second permission model.

Pack manifests may request capabilities and nominate a blueprint mapping;
trusted host configuration owns approval and registration. Installation,
activation, learning, model output and a WorkOS feature flag cannot create or
broaden a blueprint, grant or mandate. Pin pack/Agent/blueprint revisions together;
changed versions require re-admission when their authority contract changes.

Keep proposer, reviewer, approver, executing actor and verifier distinct.
`intent`, `auth_time`, OAuth consent, authentication assurance and Full approval
of task continuation are not exact effect approval. Preserve the current
action/target/base/source/actor/destination/expiry binding and scoped-grant rules.
Automatic review remains advisory or deny-only within its existing approved
policy; provider permissions never let an agent approve its own request.

## Revocation and recovery

WorkOS session revocation invalidates tokens for that session; its session API
is idempotent and distinguishes revoked from expired. Nectovia must observe
that state at the effect boundary. [Agent sessions](https://workos.com/docs/reference/agents/session)

On an authorized stop, revocation, membership removal, scope narrowing, ownership
change or security event: close local admission and advance the relevant durable
generation before awaiting provider cleanup. Invalidate credentials/refresh
custody, approvals that depend on that authority and connection caches; cancel
the affected jobs and descendants through the existing Runtime/Team lifecycle.
Revoke provider sessions/authorizations as appropriate and record cleanup retries.
Do not report provider revocation successful before confirmation. Autonomous
mandates and ordinary service clients have their own revocation roots.

Use issuer/environment/organization/instance/session-qualified revocation keys.
One WorkOS instance can back multiple independent jobs; revoke the affected root
session and dependent bindings, not the whole shared instance/blueprint when
stopping one job. A broader organization or instance revocation must be an
explicitly authorized broader operation.

Use agent live validation and, for Connect tokens, qualified online introspection
to check provider state. [Connect introspection](https://workos.com/docs/reference/workos-connect/introspection)
Authenticated, replay-resistant WorkOS events accelerate invalidation; they do
not replace those checks. Deduplicate event IDs, reconcile missing/out-of-order
events, and never infer a fresh grant from a late creation/update event. Provider
role/blueprint changes can lag in existing JWTs: fresh local membership and the
current blueprint/mandate ceiling must narrow access immediately at Nectovia's
next boundary, even before token refresh.

The in-memory Trust epoch checkpoint is not durable revocation across restarts.
Extend the existing account/Store persistence and recovery contract for agent,
mandate and connection generations; do not add a parallel auth database. A saved
run or retained approval must re-resolve after restart. Reinstatement creates new
references/admission, never decreases generations or revives old credentials.

Revalidation gates new dispatch and late-result acceptance; it cannot undo an
already submitted external effect. Check again immediately before transport,
record the dispatch fence and reconcile unknown outcomes without automatic
resend. Attempt cancellation where supported and report submitted/confirmed/
uncertain effects separately. Provider and local revocation are independently
evidenced; no global instantaneous-stop claim is justified by JWT verification,
a webhook or cancellation acknowledgement alone.

## Audit attribution and flags

Extend existing admission, Need, approval, effect, History and verification
receipts with references to: issuer/environment, token family and correlation
`jti`, blueprint/revision, agent instance/session, acting human or mandate,
registered client, organization/project/resource, root job/child/Team slot,
capability and pack digest, Trust generation, connection/resource/audience,
governing rules/grants, decision/expiry, actual engine/model/provider and payer.
The approving Person and executing agent remain separate even on a delegated
job. For autonomous work the acting human is null; the mandate author is retained
as provenance, not forged actor identity.

Record mint/refresh/validation/revocation decisions and their public reason codes
through the existing evidence path. Do not log tokens, API keys, refresh secrets,
ID tokens/assertions, private payloads or free-text intent. Use a bounded job
reference for intent, and store purpose/scope in Nectovia receipts; WorkOS does
not persist it. Token identity cannot attest which model ran or whether an effect
succeeded. WorkOS lifecycle events or a later Audit Logs export can supplement
the receipt trail, never replace its authority or verification evidence.

For resource flags derive canonical workspace/plan/environment/region identifiers
from verified server-owned facts. IDs must be tenant/environment qualified where
not globally unique and contain no personal secrets. A request cannot choose a
plan/region to turn a flag on. Custom-target evaluation can enable availability
only after ordinary entitlement and Trust checks; flag absence, staleness or
unsupported runtime keeps the new integration unavailable. Keep a local
deny-only stop control separate from cached rollout values. Turning a flag off
closes future admission and governed dispatch; turning it on never revives
revoked grants, sessions or jobs. Do not port the Node runtime client into the
Worker or add a flag service without a qualified existing integration path.

## Migration and release conditions

1. Inventory human-only `sub`/`sid`/`personId`, logout and session-refresh
   assumptions. Preserve the existing AuthKit login/PKCE/secure storage flow and
   legacy human verifier. Add explicit caller-family dispatch behind the same
   identity interface; reject agent/Connect/M2M credentials at human login,
   invitations, membership administration, approval and Operations endpoints.
2. Add explicit issuer/environment-to-organization mapping and typed
   agent/service facts through existing account/Trust composition. Agent-aware
   admission must support no acting Person for autonomous/service callers;
   never fill the existing required `personId` with the sponsor or agent ID.
   Qualify Business Trust and durable revocation before minting.
3. Reuse protected credential custody, current authorization/grant resolution,
   run stores, audit receipts and connection generation. Migrate historical
   records additively, preserving actors; unknown old attribution remains unknown.
   Recovery never reinterprets old human sessions as autonomous agents.
4. First qualification is a disabled sandbox adapter with signed fixtures and
   explicit token-family refusal tests, then a bounded first-party delegated
   Business case. Autonomous Business work, outbound EMA, inbound HTTP MCP and
   service M2M each need their own scoped evidence before enablement.
5. Recheck live docs/SDK/runtime support, WorkOS environment access, actual IdP/
   client/server support and repository approval. A sandbox pass proves no
   production/installed/provider behavior. Rollback closes admissions, advances
   generations and revokes affected credentials while preserving receipts;
   never fall back to borrowed human tokens.

The inspected repository contains no approved Agent Auth/EMA integration path.
Proceed now with documentation and contract reconciliation only. No feature
gate, customer capability, completed prompt or cloud canonical status changes
because of this research. See the companion prompts for prerequisites and the
required adverse cases before any later implementation.
