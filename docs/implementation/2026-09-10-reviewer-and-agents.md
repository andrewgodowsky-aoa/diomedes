# Approve for me, honest Full access, and Agent as a runtime primitive

September 10, 2026. Candidate `integration/autonomy-workbench-20260910` in
`diomedes-wt/integration-autonomy`. This record states exactly what was built,
what is proven, and what is not. It supersedes nothing: Protocol 1 (exact
approval receipts, `docs/implementation/2026-09-08-approval-receipts.md`) and
Protocol 2 (task scope grants) are unchanged, and this work sits on top of them.

## 1. The governing invariant

`Approve for me` is **`Work in this project` plus a mandatory extra gate.**

The human grant is the only source of authority. The reviewer can only
*withhold* an authorization the person already issued. It cannot create one,
widen one, refresh one, or reach any operation the scope did not already allow.

The consequence is the security bound this whole design rests on:

> A fully compromised reviewer's maximum power equals today's Protocol 2
> behaviour, which the person confirmed. Its minimum power is nothing.

Everything below is an expression of that one sentence.

### Two axes that never merge

Permission scope and reviewer routing are separate fields on separate axes:

| | Field | Owned by | Means |
| --- | --- | --- | --- |
| Scope | `TaskScopeGrant.roots/operations/maxWrites/maxBytes/expiresAt` | the person | what may ever happen |
| Routing | `TaskScopeGrant.review: 'human' \| 'model-reviewer'` | the person | who must look first |

Configuring a reviewer is not a grant. A grant is not evidence a reviewer
looked. The validators refuse a record where one implies the other:
`(grant.review === 'model-reviewer') === !!grant.reviewer` and
`(grant.review === 'model-reviewer') === !!evidence.reviewId`.

## 2. Threat model, and where each threat is stopped

Every row names the code that stops it, not an intention.

| Threat | Stopped by |
| --- | --- |
| Malicious or confused proposing model | Nothing changes: it still produces a proposal, and a proposal has never been authority. |
| Malicious proposal text | The reviewer packet carries the proposal as *data* in a document channel, never in the instruction channel (`server/trust/codex-reviewer.ts`). |
| Proposing model instructs the reviewer | Same fencing, plus `REVIEWER_INSTRUCTIONS` states the packet is untrusted material. |
| Model text claims a human approved | `ApprovalReceipt` is minted only by the local-client route; the reviewer path can never write one. `decisionSource` is the literal `'model-reviewer'`. |
| Stale base or source | The reviewer decision is bound to `proposalDigest`, `actionDigest` and `baseDigest`; `assertCurrent` rechecks at the effect boundary. |
| Proposal mutated after review | `reviewGate(record, need, 'effect')` requires the named `reviewId` to resolve to an approve for **these** digests. A changed byte changes the digest and the gate fails. |
| Replay, or a lost HTTP response | The scope-grant command namespace (`findCommand`/`payloadDigest`) is unchanged, and the in-flight dedupe map keys on the change-set digests. |
| Process restart mid-review | The review runs outside the Store lock and mints nothing until it returns. A restart leaves the Need open. Never an auto-approve. |
| Reviewer timeout, crash, quota failure, unavailability | All resolve to `error` with a bounded reason. No authorization is minted; the Need becomes Needs you. |
| Contradictory reviewer response | `COHERENT` rejects an `approve` paired with a refusing reason as `contradictory-response`. |
| Policy-denied action | Deterministic Trust policy runs **first**; a denial is not reviewable and the reviewer is never called. |
| Expired or revoked scope | `usableApproval` requires an unexpired, generation-matched grant. Revocation bumps the generation, so a late reviewer answer cannot apply. |
| Same model as proposer and reviewer | Not prevented, and not claimed. See §4. |
| Reviewer tries to enlarge authority | The reviewer's only output is a typed decision. There is no field on it that can name a root, an operation, a budget or an expiry. |
| Recursive review loops | The reviewer route has no work-start capability; `REVIEWER_MAX_ATTEMPTS = 1` and `maxReviews` bound the spend. |

Private reasoning is never requested, recorded or displayed. The record keeps a
typed decision, a reason code, and a bounded note capped at
`REVIEWER_MAX_NOTE = 600` bytes.

## 3. What is recorded

`ReviewerDecision` (protocol version 3) is durable and written **before** any
approved byte lands, in the same `Store.locked` transaction as the sentence a
person reads. A reader can never see one without the other.

| Field | Why it exists |
| --- | --- |
| `decisionSource: 'model-reviewer'` | The one label. Never `human`, never a person's name. |
| `agent: {id, version, name, digest}` | Which worker identity reviewed. |
| `requestedModel` / `reportedModel` / `modelSource` | What was asked for, and what the runtime actually reported. Separate fields on purpose. |
| `proposerReportedModel` | The worker's model, so the two are comparable. |
| `independence` | `separate-invocation`, or `separate-invocation-and-model` when the models differ. |
| `policy` | The deterministic result the reviewer saw, and its version. |
| `decision`, `reasonCode`, `note` | The bounded decision evidence. |
| `proposalDigest`, `actionDigest`, `baseDigest` | The exact bytes decided about. |
| `attempt`, `timeoutMs`, timestamps, `expiresAt` | The spend and the window. |
| `eventId` | The linked History entry. |

A refusal is durable too. It is a **recommendation**, not a dead end: the Need
stays `open`, and the person can still approve it under Protocol 1. Their
receipt then coexists with the reviewer's record; neither overwrites the other.
This is the answer to "immutable receipts without an irreversible dead-end
created by a model declining."

## 4. What reviewer independence actually means here

Proven, and stated in the UI as `REVIEWER_INDEPENDENCE_STATEMENT`:

- a **separate invocation** with its own run identity;
- **review-only capability**: the reviewer route has no effect tool, no work
  start, no authority mutation;
- the reviewer's output is parsed as a **typed decision**, never reused as
  trusted structured text;
- the route is **explicitly configured by the person** at consent time.

Not proven, and deliberately not claimed: independent weights, an independent
vendor, or an independent account. The same account and the same model family
may serve both roles. The statement in the Console says so.

## 5. Full access

`Full access` is answered by `fullAccessEligibility(routeId, environment)` in
`shared/capabilities.ts`. It takes an `IsolatedEnvironment` **value**, not a
flag, and `server/trust/environments.ts` returns an empty list with its reason.

Eight prerequisites must all be met: an isolated environment, an attested
boundary, disposability, a host root boundary, pre-execution interception,
revocation that stops effects, an effect ledger, and route effect proof.
Six are unmet on every route in this installation because there is no
environment provider in this codebase at all.

The predicate is real logic, not a hardcoded refusal: a fully populated
hypothetical environment passes it in `tests/capabilities.test.ts`. It cannot be
switched on by a setting, a request field or a saved preference, because it
reads none of those.

The reason given to a person is one sentence, said once:

> This installation runs engines as the current user with no operating-system,
> process or virtual-machine boundary that Diomedes owns. A project folder or
> git worktree is edit isolation, not containment.

## 6. Agent as a runtime primitive

The control model is **Mode -> Agent -> Model -> Effort**. The four stay
distinct: a Model is interchangeable intelligence, an Agent is a durable
Diomedes-owned worker identity, a Mode is the person's current relationship to
the work, and a Team is a composition of Agents.

An `AgentDefinition` (`shared/agents.ts`) **references** the systems that
already exist rather than restating them:

| Field | Points at |
| --- | --- |
| `modes` | `server/modes.ts` MODES, which still owns mode instructions |
| `requires` | `shared/capabilities.ts` route capability facts |
| `tools` | the harness tool registry |
| `ruleScopes` | `server/rules.ts` scope names |
| `permissionCeiling` | `shared/permissions.ts` choices, as a **maximum**, never a grant |
| `models` | engine catalogue slugs, as a preference, never a lock |
| `handoff` | durable artifact identities, so Team orchestration never depends on a prompt string |

The only thing an Agent owns is its `role`: a bounded sentence carried by the
existing instruction channel alongside the mode's own instructions.

### Authority

`AgentResolution.policy` records three values and confers none:

```
agentCeiling  the Agent's own immutable cap
granted       what the person has granted for this task, read live
effective     narrowerPermission(agentCeiling, granted)
grantsAuthority: false          <- a literal in the type
```

Selecting an Agent can only ever *narrow*. `validateAgentResolutions` refuses a
saved snapshot whose `effective` is wider than the narrower of its two inputs,
whose `grantsAuthority` is not `false`, or whose selection provenance is
incoherent. That check runs at state load, at recovery and at journal replay,
and it fails closed: the project does not open rather than trusting a widened
record.

A handoff cannot launder permission, because a handoff carries an artifact
identity and an Agent id, and authority is read live from the grant at the
moment of the write.

### Auto

`AUTO_BY_MODE` is a deterministic mode mapping recorded as
`agentSelection: 'automatic'` with `requestedAgentId: 'auto'`. It is not a
router and does not read request text. A future router replaces the function
without changing the provenance contract.

### The reviewer is an Agent

The reviewer route is a `Code Reviewer` Agent execution. Its identity
(`agentId`, `agentVersion`, `agentName`, `agentDigest`, `agentRole`) is **pinned
into the grant at consent time**, so editing a project's Agent file afterwards
cannot rewrite who reviewed an existing change set. Only an Agent whose own
ceiling is `review` may hold the role; nominating a writer Agent is refused with
`reviewer_agent_unavailable`. The identity is resolved by the host from its own
registry and is never taken from a request.

### Compatibility is capability-driven, and stops there

`agentCompatibility` computes from `ROUTE_CAPABILITIES` facts. A writer Agent
needs a recorded writer and no credentials, and nothing more. Whether its
changes may then apply *automatically* is a Trust question, already answered by
the scope grant, which refuses every route that cannot intercept, prove and
revoke an effect. Repeating those conditions inside Agent would have built a
second policy layer that could disagree with the first.

## 7. Attribution

`OriginSnapshot.agent` answers who proposed this, independently of the model
that ran it. The host copies it from the resolved execution snapshot; generated
text can never set it. Historical records keep their original identity on
replay and forks and are never relabelled.

The Console's proposal dialog now reads
`<Agent> · <model> via <engine> proposes to <what>`: who proposed, on what, and
through which route.

## 8. The Console

Four choices, in one radiogroup, availability computed by
`describePermissionChoices` from capability facts and the host's own reviewer
wiring. A stored preference cannot make an option appear.

- **Review changes** — every change waits for you.
- **Work in this project** — recommended.
- **Approve for me** — states plainly that a separate model reviewer evaluates
  eligible changes, that some actions still require you, that reviewer failure
  falls back to Needs you, and that it does not increase filesystem or tool
  permission.
- **Full access** — unavailable, with the environment question answered inline
  on the row itself ("None. There is no isolated environment on this
  installation to give unrestricted authority to.") and a *What it would take*
  block listing the unmet prerequisites. None of this is in a tooltip.

The Agent picker sits beside the model picker in the chrome, using the same
control and typography. Its menu carries the honest sentence in the panel, not
a tooltip: **"Choosing a worker does not change what it may do."** An Agent the
selected engine cannot support stays visible and states its reason rather than
disappearing.

## 9. Verification

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 983 passed, 54 files |
| `npx playwright test` | 40 passed |
| `npx playwright test --config playwright.responsive.config.ts` | 9 passed |
| `npx vite build` | clean |
| `npm run package:desktop` | Diomedes-win32-x64 produced |
| `node scripts/reviewer-desktop-smoke.mjs` | PASS, 10 checks |

New deterministic coverage: `tests/capabilities.test.ts` (14),
`tests/reviewer.test.ts` (16), `tests/reviewer-authority.test.ts` (36),
`tests/agents.test.ts` (24), `tests/agent-authority.test.ts` (24),
`tests/reviewer-ui.spec.ts` (4 browser), `tests/agent-ui.spec.ts` (4 browser).

The packaged smoke runs the shipped `Diomedes.exe`, then starts a second host
from the **packaged compiled module** with a synthetic worker and a synthetic
reviewer. It proves the authority path on the bytes that ship — which decisions
may write, which may not, what is recorded, and what the person is told. It
proves nothing about a live model's judgement, and its manifest says so.

## 10. Defects this pass found and fixed

1. `ReviewerService.persist` ran outside `Store.locked`, so a concurrent revoke
   raced the reviewer record.
2. The reviewer's explanation was persisted in a separate write from the record,
   so a reader could see one without the other.
3. Review dedupe keyed on the grant, so confirming a second scope re-dispatched
   a review of identical bytes.
4. The Agent ceiling gate tested `policy.effective` — a start-time snapshot that
   goes stale when a scope is confirmed mid-run — instead of the immutable
   `policy.agentCeiling`.
5. Agent compatibility was refused **after** the session was pushed into state,
   leaving a phantom `working` session, a moved task and a spurious
   saved-version entry on a 409.
6. Adding `agentId` to the canonical Work payload changed the digest of every
   existing v1 receipt. It is now present only when a worker is named, so an old
   receipt keeps its exact bytes and still replays.
7. Agent `requires` restated scope-grant conditions, which refused honest text
   proposals on every non-Codex route.
8. The scope decision record and the reviewer record each said "you did not
   review this output" in the same open block.

## 11. What remains

- **Full access is unavailable.** There is no environment provider. The
  contract, the predicate and the tests exist so it cannot become enabled by
  accident, and so that building one has a defined target.
- **Reviewer independence is invocation-level.** Weights, vendor and account may
  be shared. Do not claim otherwise.
- **`REVIEWER_MAX_ATTEMPTS = 1`.** A transient failure is surfaced, not retried.
- **No general sandboxing, no external-effect exactly-once.** Unchanged from the
  Runtime record.
- **Auto is a mode mapping, not a router.**
- **Teams reference Agents by id** (`TeamMember.agentId`); orchestration by
  handoff artifact is a foundation here, not a working scheduler.
- **Project and user Agents are JSON files.** No registry, no marketplace, no
  studio, no self-editing.
