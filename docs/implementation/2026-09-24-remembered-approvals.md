# Remembered approvals — learns your approvals, and offers to stop asking

Date: 2026-09-24
Lane: `remembered-approvals` (branch `feature/remembered-approvals`)
Decision implemented: work order `docs/implementation/2026-09-24-automations-milestone-a-work-order.md`,
section 3, **D5** (Andrew, 2026-09-24): learning only *offers*; authority is remembered only when the
person clicks; one acceptance per item per project is enough.

## What is implemented

Both routes to a remembered approval, the learned offer and its remembered answer, the always-asks
classifier, truthful attribution for every action a grant covers, one list that revokes, and the
evidence for each of those in History. Implemented for **harness step approvals** — every approval
that reaches a person through `server/harness/*` (the fixture procedure and the Codex report today;
any later procedure step, such as an automation's delivery step, uses the same path). See *Not
implemented* for what is left.

### The grant model, generalised (not a second one)

- `server/trust/remembered-approvals.ts` holds the **exact-pattern grant**, grant protocol version
  **3**, engine-agnostic. It is owned by `ScopeGrants` (`store.scopeGrants.remembered`), shares the
  version 2 task scope's rules — explicit issuance recorded in History, revocation by a generation
  that never moves back, strict load validation that fails closed and never rewrites, and per-effect
  evidence bound to the exact grant digest — and joins the same funnels:
  - `ScopeGrants.assertCurrent` dispatches a remembered authorization to its own write-time check, so
    every Store write path (`writeRecorded`, journal recovery) re-checks a remembered grant exactly
    where it re-checks a task scope. No new check sites were added to the Store.
  - `validateScopeGrants` validates the remembered ledger; `validateScopedAuthorization` validates
    remembered evidence. Both are already called at load, reload and journal recovery.
  - `Need.authorization` and `HistoryEntry.authorization` are `ScopedAuthorization |
    RememberedAuthorization` (discriminated by `kind`). A remembered authorization is never an exact
    approval receipt and can never carry a reviewer (`reviewId?: never`).
- **What a grant covers** (`ApprovalPattern`, `shared/remembered-approvals.ts`): the same procedure
  (capability), the same tool, the same action (step kind, permission, effect), the same destination
  (files for a local write; `to:`/`cc:`/`bcc:`/`url:` recipients for a send), the same connection
  (engine and account route), in the same project. Coverage is digest equality over the whole
  canonical pattern, so a grant can never widen. It also re-checks, at the moment of coverage, that
  the principal a decision would be made under is the one the grant rested on, at the same identity
  generation, still holding the permission.
- **It asks again**, and says why on the Need (`authorizationBoundary`, shown as "Approval needed:
  …"), for: a new destination or recipient; a different or wider action; a changed connection; a
  revoked grant; a changed or unavailable authority (rotation, a different principal, a lost
  permission, a Codex authority that no longer resolves).
- **Always asks** (`classifyApproval`): conservative. Any money word (pay, charge, refund, transfer,
  purchase, invoice, billing, …), any destruction word (delete, remove, purge, wipe, overwrite, reset,
  …) or a deletion in the input, and any access word (credential, secret, token, key, member, invite,
  role, permission, grant, share, account, …) anywhere in the procedure, tool or permission name
  makes an action always ask. Beyond that, only a short allowlist is rememberable at all: a recorded,
  reviewable local write (`write-project-file`, idempotent, local, named files) and a send to named
  recipients (`send-email`, `send-message`, `send-report`, `deliver-report`, external). Anything else,
  or an input whose destination cannot be read, is `unrecognised` and always asks. An always-asks item
  is never counted toward an offer, never offered, refused by route 1 (`409 always_asks`), never
  covered, and a saved grant for one fails load validation.

### Route 1 — Go ahead and remember in this project

- The Console shows **Go ahead and remember in this project** beside **Go ahead** on an exact harness
  approval the classifier allows (`client/console/Need.tsx`, `ThreadView.tsx`).
- Clicking it gives the ordinary exact approval first (the unchanged protocol-1 command, which stays
  the evidence), then `POST /api/projects/:id/permissions/remembered {needId}` remembers that
  approval's pattern (`HarnessBridge.remember`). Only a go-ahead the local client gave on that Need,
  within 15 minutes, can be remembered; replaying the request returns the same grant.

### Route 2 — the learned offer

- Each exact decision on a rememberable harness approval updates a per-project **tally** keyed by the
  pattern digest (`RememberedApprovals.noteDecision`, called from `HarnessBridge.resolve`). A go-ahead
  counts; a decline starts the count again.
- At the threshold (**3**, `REMEMBER_OFFER_THRESHOLD`) Diomedes makes **one offer** for that pattern:
  "You've approved “Write Harness report.md (Format a fixture report)” 3 times in this project. Stop
  asking?" It is shown once, inline in the Needs area of the thread that owns the approval that
  reached the threshold, with **Stop asking** and **Keep asking**.
- **Stop asking** creates the grant (`…/offers/:id/accept`). **Keep asking** records the declined
  answer (`…/offers/:id/decline`) and the offer never returns for that pattern. An offer, once made
  in any state, is never made again. The person can still ask at any later prompt with route 1.
- Repeated approvals alone never create a grant: the tally and the offer are the only things they
  can change.

### Attribution

A step a grant covers keeps its exact Need, now decided `go-ahead` with `decidedFrom:
'remembered-approval'` and a `RememberedAuthorization`, and says so everywhere it is shown:

- History: a `remembered-authorized` entry, actor `diomedes`: "Ran under a remembered approval — you,
  since 24 September 2026. Write Harness report.md (Format a fixture report)." The write entry reads
  "Nectovia changed 1 file. Ran under a remembered approval — you, since 24 September 2026." (never
  "allowed for this task").
- The run record: the harness approval's `decidedBy` is `remembered-approval:<grantId>`, not
  `local-client`.
- The Session log, the Need's approval record (`ApprovalStatus`) and the Run inspector show the same
  sentence. Nothing presents it as a fresh click.

### One place to list and revoke

The task-permissions dialog (**Review changes** / **Work in this project** in a thread's head, the
place task scopes and capability packs are already shown) gains **Remembered approvals**: each grant
with the exact action, who remembered it, when and by which route, and **Revoke**. Revoked grants stay
listed as revoked.

### Evidence, revocation, restart, configuration

- Grant creation (`remembered-approval-granted`, actor `you`), a declined offer
  (`remembered-approval-declined`), each coverage (`remembered-authorized`) and revocation
  (`remembered-approval-revoked`, actor `you`) are History entries. Revocation keeps the grant record
  and every entry; nothing is pruned (decision 10).
- Revocation stops coverage at once: the next identical step asks. A step covered before the
  revocation but not yet run re-checks the grant before its decision reaches the run; if revoked, it
  writes nothing, its execution is `not-applied`, and the run is cancelled.
- A remembered approval survives a restart (it is the person's durable choice, unlike the task
  scope's host lease); a revoked one stays revoked.
- Configuration never creates or revives one: pack activation, a settings change, an organization
  configuration activation and rollback, the host threshold, a restart or a model change do not touch
  the ledger. Journal recovery carries a later revocation and a later declined answer onto the
  prepared state image it persists (`carryRememberedDecisions`, beside the existing task-scope carry
  in `Store.recover`), with the History entry that records it.

### On-disk format and the Codex task scope

- `ProjectState.rememberedApprovals` is `{ formatVersion: 1, grants, tallies, offers }`. Grants are
  protocol version 3. An unknown format version, grant version or field is refused at load and the
  saved file is left exactly as written (tested).
- Existing Codex task-scope grants (protocol version 2, `state.scopeGrants`) **carry forward
  losslessly and are not rewritten**. Rewriting them would change `scopeGrantDigest`, which every
  recorded `ScopedAuthorization.grantDigest` and reviewer decision binds, and would invalidate that
  evidence. So the migration is an identity: a project written before this feature loads with no
  ledger, and after a remembered approval is added the version 2 records are byte-identical and keep
  their digest (tested in `tests/remembered-approvals.test.ts`, "existing Codex grants carry forward
  losslessly"). Codex behaviour is unchanged: all existing scope-grant tests pass unmodified.

## Proposed defaults (Andrew's to confirm)

Each is the most conservative option that still delivers D5; none widens authority.

1. **Threshold 3, a product constant.** "A product setting to tune with evidence" is read as a
   product constant (`REMEMBER_OFFER_THRESHOLD`) with a host-set override
   (`ScopeGrants.remembered.threshold`), not a person's setting or request field. Changing it can make
   an offer appear sooner at the next exact approval; it can never create a grant.
2. **A decline of the same item restarts its count.** "Keeps giving the same exact approval" is read
   as consecutive.
3. **An offer is made once per item per project, ever.** A declined offer never returns; an accepted
   one whose grant is later revoked does not return either. Route 1 is how the person asks again.
4. **Route 1 remembers only an approval just given** (within 15 minutes of the click).
5. **The button says "Go ahead and remember in this project"**: D5's "Approve" is the Console's
   existing exact verb, **Go ahead**, so the pair reads as one verb family.
6. **A restart does not end a remembered approval** (unlike the task scope, whose host lease does);
   D5 lists restart only among things that must never create or revive one.
7. **The always-asks list** above, with the unrecognised default.

## Not implemented (follow-ups)

- **Codex direct text proposals** (the non-harness native Codex path, `server/native-work.ts`) are
  not counted, offered or covered. They keep their exact approval and the existing **Allow creates
  and updates for this task** scope. Extending remembered approvals there means binding a
  `RememberedAuthorization` into `NativeWorkService`'s scope-matching path; it is a separate slice.
- **The automation's Rules and access section** (D5: "shows what is remembered for it") does not
  exist yet (Automations Milestone A/B). The per-grant `pattern.procedure` is what it will filter on.
- **Team membership.** The local prototype knows one person ("you"). A member's grant, and "loses
  membership", are checked through the harness principal and its identity generation; a multi-person
  acceptor model waits for real member identity.
- **The Console's route-1 button** classifies from the step intent without the procedure name (the
  Need does not carry it). The server re-checks with the procedure; if it refuses, the exact
  approval already given stands and the refusal is shown.
- The threshold is not surfaced in Settings (see default 1).

## Tests

- `tests/remembered-approvals.test.ts` (36 tests, real host, Store and routes over a temporary
  directory): classifier categories; the offer at exactly the threshold and only once; accepting
  creates the grant and the next step is covered with truthful attribution in History, the write, the
  run record and the Session; decline memory; a decline restarts the count; route 1 and its
  idempotence; local-client-only and just-given-only; revocation stops coverage immediately and is
  evidenced; a step covered then revoked before it runs writes nothing; restart persistence and a
  revoked grant staying revoked; each out-of-pattern trigger (destination, action, connection,
  rotation, different principal, lost permission, unavailable authority, other project) including a
  changed connection through the real host; always-asks never offered, remembered or covered, and a
  forged always-asks grant refused at load; pack activation, settings, threshold and restart create
  nothing; journal recovery cannot revive a revocation or reopen a declined offer; a real
  configuration activation and rollback leave the ledger as it was; Codex grants carried forward
  byte-identical; unknown versions and fields refused without rewriting; tampered evidence refused.
- `tests/remembered-approvals-ui.spec.ts` (Playwright, added to `playwright.config.ts`): route 1 in
  the Console, the covered step's record, the list and Revoke in the permissions dialog, the re-ask
  after revocation; the offer asked once at the threshold and Keep asking remembered; Stop asking and
  the covered step.

## Proposed canonical-doc patch

**Project Memory** (`docs/DIOMEDES_PROJECT_MEMORY.md`, section "Files, packs, permission and
evidence"), append after the paragraph beginning "Permission scope and escalation reviewer are
independent.", the definition proposed in D5:

> **Remembered approval.** Diomedes learns which approvals a person keeps giving, and learning only
> offers. A person may approve and remember an item in a project, or accept a learned offer to stop
> asking; one acceptance per item per project is enough. The result is a scoped, revocable, attributed
> grant for that exact pattern. It never widens, never survives revocation or loss of authority, and
> is never created by repeated approvals, learning or configuration without the person's click.
> Payments, destructive actions and permission or credential changes always ask.

and, to record what "exact pattern" means in the build:

> The pattern is the same procedure, tool and action, the same destination or recipients and the same
> connection, in the same project. The offer comes after 3 identical exact approvals, once per item
> per project; a declined offer does not return. An action taken under a remembered approval says so,
> naming whose and since when.

**Live Roadmap** (`docs/DIOMEDES_LIVE_ROADMAP.md`), clause B ("Preserve scoped grants, exact
consequential approvals, …"): append "Remembered approvals (D5) are implemented for harness step
approvals: both routes, the learned offer and its remembered answer, the always-asks classifier,
truthful attribution and one revocation place; Codex direct text proposals and the automation's Rules
and access view are follow-ups."

**Core Pillars**: no change. This applies decision 7 and the existing permission pillar; it adds no
new meaning.

**Website** (separate repository): "Learns your approvals" is accurate only as "notices the approvals
you keep giving and offers to stop asking". Nothing in this record claims the website copy.

## PILLAR IMPACT

- **Scoped authority, not approval spam (decision 7)**: advanced. Repetitive exact approvals can now
  end after one explicit click per item per project, and the grant is an exact, recorded, revocable
  pattern. Risk addressed: learning never grants — tested that repeated approvals, configuration,
  rollback, pack activation, restart and the threshold create nothing.
- **Truthful attribution (decision 8)**: every covered action says whose approval it ran under and
  since when; the run record's `decidedBy` names the grant.
- **History is evidence (decision 10)**: creation, decline, coverage and revocation are History
  entries; revocation prunes nothing.
- **A capability pack composes; it never parallels (decision 14)**: one grant model, one set of
  funnels; activating a pack is tested not to create or revive a grant.
- No conflict found with a pillar.

## ROADMAP IMPACT

- D5's general form (both routes, the learned offer, decline memory, one revocation place) moves from
  "recorded" to **implemented for harness step approvals**, with the evidence above. Not implemented:
  Codex direct text proposals; the automation Rules and access view.
- No roadmap status is claimed for Automations Milestone B/C delivery steps; they can use this path
  when built.

## BUILD STATUS

See the lane's final report for the gate counts from the final run (tsc, vitest, vite build,
Playwright). Nothing here is published, packaged or released; the branch is pushed for the integrator.
