# Remembered approvals for Codex direct text proposals, and the ChatGPT account of a Codex task scope

Date: 2026-09-24
Lane: `d5-codex-proposals` (branch `feature/remembered-approvals-codex`), based on
`origin/review/h07-automations-a-remembered-approvals` (the merged D5 feature plus the batch1-a
review's fixes), merged with `origin/main`.
Decision implemented: work order `docs/implementation/2026-09-24-automations-milestone-a-work-order.md`
§3 **D5** (Andrew, 2026-09-24). Closes the two follow-ups recorded in
`docs/implementation/2026-09-24-remembered-approvals.md` ("Codex direct text proposals … are not
counted, offered or covered") and `docs/implementation/2026-09-24-review-batch1-a.md` (D5-3, "the
version 2 Codex task scope pins the literal `codex:chatgpt` and has the same blind spot").

## What is implemented

### 1. Codex direct text proposals join the D5 model

A proposal from the native Work path (`server/native-work.ts`, a person's own Codex run with no team
slot) is now counted, offered and covered exactly like a harness step. Nothing parallel was added:
the same `RememberedApprovals` ledger, the same version 3 grant, the same routes, list, History
entries, write funnel, load validation and recovery carry.

- **What the pattern is** (`patternForProposal`, `server/trust/remembered-approvals.ts`): pattern kind
  `codex-proposal`, the same project, the fixed procedure `codex-proposal` and tool `text.apply`, the
  action `write-project-file` / idempotent, the destination = the exact set of files the proposal
  writes (created or updated), and the connection = engine `codex` + the ChatGPT account route the
  runtime reported the proposal was prepared under. Coverage is digest equality over the whole
  pattern, so another file, a wider file set, or another account is a different pattern. The text of
  a proposal is not in the pattern, exactly as a harness step's content is not.
- **Where the account comes from.** `askCodex` now tells its caller the account route it prepared the
  turn under (`onAccountRoute`, called just before `turn/start`, the hash `requireChatGpt` already
  computes from nonsecret account metadata). Native Work keeps it on the Need as `connection`
  (`shared/types.ts`), outside every approval digest. A route the runtime did not report is never
  guessed at: the Need has no `connection`, is not counted, not offered, not rememberable and never
  covered.
- **Always asks** (`classifyProposal`, `shared/remembered-approvals.ts`, shared by host and Console):
  a removal (`destroys-data`), a credential/key/member file (`changes-access`, the batch1-a file
  checks), an SVG/HTML/XML file ("always needs your exact review: … can run code when it is
  opened", the same rule the task scope keeps), an unsupported text kind, an unreported account and
  a team-slot run. A proposal from a Reviewer-ceiling Agent is never covered either (the existing
  ceiling check runs before any scope or remembered approval). A saved `codex-proposal` grant whose
  shape differs in any field from the fixed one fails load validation.
- **Live authority re-checked at match time.** The authority a Codex grant rests on is the local
  client with the Codex connection on (`settings.services.codex`). Turning it off makes the next
  identical proposal ask: "The authority your remembered approval rested on is not available now, so
  this needs your OK." The account is re-checked through the pattern digest, and the Store's write
  funnel re-checks that the grant is still live and that every write is to a named file with no
  removal (batch1-a D5-2).
- **Order with the task scope.** `applyMatchingScope` asks the version 2 task scope first, unchanged;
  only when no scope matches does a remembered approval get the chance to cover the proposal.
- **Route 1.** The Console shows **Go ahead and remember in this project** on a Codex proposal the
  classifier allows (`ThreadView.tsx`, one condition). `POST …/permissions/remembered {needId}` now
  dispatches a non-harness Need to `NativeWorkService.remember`; the same rules hold (local client
  only, only an approval just given, idempotent replay, always-asks refused with `409 always_asks`).
- **Route 2.** `NativeWorkService.resolve` counts each exact go-ahead and a decline restarts the
  count, through the same `noteDecision`. At the threshold the offer "You've approved “Write Fall
  menu.md (Codex text proposal)” 3 times in this project. Stop asking?" appears once, in the thread
  that owns the proposal.
- **Attribution.** A covered proposal keeps its exact Need, decided `go-ahead` with
  `decidedFrom: 'remembered-approval'` and a `RememberedAuthorization` (never a receipt, never a
  reviewer). History gets `remembered-authorized` (actor Diomedes: "Ran under a remembered approval
  — you, since 24 September 2026. Write Fall menu.md (Codex text proposal).") and the write entry
  reads "… changed 1 file. Ran under a remembered approval — you, since …". The Session log and the
  Console's approval record say the same.
- **Re-ask reasons** on the Need (shown as "Approval needed: …"): "Your remembered approval covers
  “Write Fall menu.md (Codex text proposal)”, but this writes files it does not cover, so it needs
  your OK."; "… but this was prepared under a different ChatGPT account, so it needs your OK."; "You
  revoked the remembered approval for this, so it needs your OK."
- **Evidence validation.** `validateRememberedAuthorization` now accepts a Codex proposal's evidence
  only on a non-harness Need of a `codex` session with no slot, whose `connection` is the grant's
  engine and account, and whose write entry is exactly the approved action digest. A harness grant
  can never be evidence on a direct proposal, or the reverse.

### 2. The ChatGPT account of a version 2 Codex task scope

- A scope record now carries `confirmedAccountRoute` **beside** `grant` (`ScopeGrantRecord`), so
  `scopeGrantDigest` — which every `ScopedAuthorization.grantDigest` and reviewer decision binds —
  is unchanged, and no existing record is rewritten. Its value is the account the task's latest Codex
  proposal was prepared under when the person confirmed the scope, else the project's latest, else
  the literal `codex:chatgpt` meaning "no account seen yet". It is read from runtime facts only,
  never from the request.
- At use time (`ScopeGrants.check`, i.e. matching, minting and the write funnel) the account the
  proposal was actually prepared under (`need.connection`) must equal it. Otherwise the proposal asks
  again, with one of:
  - "This proposal was prepared under a different ChatGPT account from the one Codex was using when
    you confirmed this task scope, so it needs your OK."
  - "This task scope was confirmed before Diomedes recorded which ChatGPT account it was for, so this
    proposal needs your OK. Confirm the scope again to let it continue." (a record with no field)
  - "Diomedes had not seen which ChatGPT account Codex uses when you confirmed this task scope, so
    this proposal needs your OK. Confirm the scope again to let it continue under this account."
  - "Diomedes could not read which ChatGPT account prepared this proposal, so it needs your OK."
- Confirming the scope again on the waiting proposal binds the account in use and applies it, as
  before. Load validation accepts the field only as `codex:chatgpt` or `openai:chatgpt:<64 hex>`.

### 3. Playwright fixture race (integrator note)

`tests/remembered-approvals-ui.spec.ts`, "the learned offer is asked once at the threshold, and Keep
asking is remembered", started the next run through the API as soon as the offer appeared. The offer
is created when the Console's Go ahead is recorded, before that approved run finishes, so under load
the start met `409 This project already has work in progress.` The fixture now keeps the third Need
and waits for its Session to settle through the project state API (`finished`) before starting
again. No assertion changed.

## Proposed defaults (Andrew's to confirm)

Each is the most conservative option that still delivers D5; none widens authority.

1. **A Codex proposal's pattern is its exact file set**, created or updated, never removed, on one
   ChatGPT account. Build and Fix are the same procedure (the mode is not in the pattern); a team
   member's run is never covered.
2. **The Codex connection being on is the live authority** a Codex grant rests on; turning it off
   asks again. (The local prototype has one person, so the principal is the local client, as for
   harness steps.)
3. **A task scope decides before a remembered approval**, so existing scope behaviour is unchanged.
4. **The task scope's account is the one Diomedes last saw Codex prepare a proposal under** in that
   task (else the project) when the scope was confirmed. Stale knowledge can only cause an extra
   ask, never a wrong cover. A scope confirmed before any proposal was seen asks once on the first
   proposal; confirming it again on that proposal binds the account.
5. **A route the runtime did not report means "not the same account"**, except that a scope
   confirmed with no account seen still covers a proposal whose account was also not reported. The
   production Codex adapter always reports one, so this only affects injected test generators and
   keeps every existing scope test unmodified.

## Not implemented (follow-ups)

- **Other direct routes** (Claude Code, OpenCode, model-API routes through native Work) are not
  remembered: the task scope itself is Codex-only, and those routes have no runtime-reported account
  fact in this path yet.
- **The automation's Rules and access section** (D5) still does not exist.
- **The account for a scope confirmed from the dialog before any proposal** is not read from the
  runtime directly (that would spawn the Codex process under the Store lock); see default 4.

## Tests

- `tests/remembered-approvals-codex.test.ts` (new, 14 tests, real host, Store and routes over a
  temporary directory with a scripted Codex runtime that reports its account the way `askCodex`
  does): the account kept outside the digest and never guessed; route 1 journey (remember → the next
  identical proposal runs under it with attribution in History, the write, the Session → another file
  and a wider file set re-ask with the reason → revoke is evidence and re-asks → the revoked grant
  refuses a write at the Store funnel while its earlier evidence stays valid); another account, an
  unreported account and the Codex connection turned off each ask; local-client-only and
  just-given-only; route 2 offer at the threshold once, Stop asking covers, decline memory and a
  decline restarting the count; removal, credential file and HTML always ask and are never counted;
  widened saved Codex grants refused at load; evidence moved to another account refused; the task
  scope decides first and its records keep their bytes and digest; the task scope binds the account
  of the waiting proposal and another account asks; a scope with no recorded account always asks
  (both with and without a reported account); a scope confirmed before any account was seen asks
  then binds; an unknown account shape refused at load.
- `tests/remembered-approvals-ui.spec.ts`: new Console journey "a Codex proposal: remember, run under
  it, ask for another file, revoke, ask again", plus the race fix above.
- No pre-existing test was modified other than that fixture wait; every existing Codex, scope-grant
  and remembered-approval test passes unmodified.

## Proposed canonical-doc patch

For the integrator; not applied here.

**Project Memory** (`docs/DIOMEDES_PROJECT_MEMORY.md`), the "Remembered approval" build note proposed
by `2026-09-24-remembered-approvals.md` and extended by batch1-a: replace "A Codex step's connection
is the ChatGPT account its run used." with:

> A Codex step's or Codex proposal's connection is the ChatGPT account its run was prepared under.
> For a Codex proposal the pattern is the exact set of files it writes (created or updated, never
> removed) in the project.

and, in the task-scope definition ("Work in this project"), append:

> A Codex task scope applies only to proposals prepared under the ChatGPT account Codex was using
> when the person confirmed it; another account asks again.

**Live Roadmap** (`docs/DIOMEDES_LIVE_ROADMAP.md`), clause B, the D5 sentence proposed by
`2026-09-24-remembered-approvals.md`: replace "Codex direct text proposals and the automation's Rules
and access view are follow-ups." with "Codex direct text proposals are covered too; the automation's
Rules and access view is a follow-up."

**Core Pillars**: no change. **QUESTIONS.md**: none new.

**Website**: unchanged from the D5 record ("notices the approvals you keep giving and offers to stop
asking"); nothing here claims website copy.

## PILLAR IMPACT

- **Scoped authority, not approval spam (decision 7)**: advanced for the most common approval in
  the product today, a Codex write; tightened for the task scope, which no longer survives a ChatGPT
  account switch. Learning still only offers; nothing creates, widens or revives a grant without a
  click (tested).
- **Truthful attribution (decision 8)**: a covered Codex write says whose approval it ran under and
  since when in History, the write, the Session and the Console.
- **History is evidence (decision 10)**: grant, decline, coverage and revocation are History
  entries; nothing is pruned; recorded version 2 authorizations keep their digests.
- No conflict found with a pillar.

## ROADMAP IMPACT

- D5 moves from "implemented for harness step approvals" to **implemented for harness step
  approvals and Codex direct text proposals**, with the evidence above.
- batch1-a's queued Trust task "Detect a ChatGPT account switch in the Codex task scope" is done.

## BUILD STATUS

See the final report for the counts from this lane's own final run (Linux sprint container; CI runs
Windows and macOS). Nothing here is published, packaged or released; the branch is pushed for the
integrator.
