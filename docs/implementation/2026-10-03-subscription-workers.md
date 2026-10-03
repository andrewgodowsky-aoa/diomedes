# Subscription workers under a Personal Nectovia lead (subscription-aware orchestration S3), 2026-10-03

| Field | Value |
| --- | --- |
| Feature | Subscription-aware orchestration, slice S3: a Personal Nectovia lead with one worker on the person's own coding tool |
| Tracking | DIO-175 (parent). Plan: `F:\Diomedes\deliverables\subscription-aware-orchestration-20261003\IMPLEMENTATION.md`, section S3 |
| Branch | `feature/subscription-aware-orchestration` |
| Worktree | `F:/Diomedes/diomedes-wt/subscription-aware-orchestration` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5) |
| Base | S2 at 81465bc, on `feature/agent-team-automatic-work` at 74d2a8c (DIO-177), which isn't on main yet |

Owner decisions, 2026-10-03: D3 (02:07 EDT) lets Claude Code, Codex and OpenCode be workers through
their programming interfaces only, never a consumer chat. D1, the Pillar 07 amendment that brings
back an opt-in preference for a subscription the person already pays for, is drafted and waiting
for Andrew's yes. **S3 stays off until D1 is approved**; the pillar text is unedited.

## What it does

When a person on the Individual plan turns it on, a Nectovia loop they start in their Personal
workspace can hand one bounded task to their own Codex, Claude Code or OpenCode. The lead runs on
Nectovia credits as before. The worker's turn runs on the person's own plan, through the tool's
programming interface, signed in through the provider's own flow. Nectovia holds and debits no
credit for it; the account service records a paid Agent admission for the worker under the lead's
job, append-only, with no managed hold.

## The preference

- Stored as `store.settings.subscriptionWorkers`, a server-only key like `home`. `validateSettings`
  never reads it; only `PUT /api/settings/subscription-workers` writes it, and
  `GET /api/settings/subscription-workers` reads it with the consent text and revision.
- Fields: version, `personId`, `scope: personal`, `enabled`, `engines` (the person's order, each
  named once), `reserve` (`none`, or keep a percentage of the tool's usage window), `whenUnavailable`
  (`pause` or `single-agent`), `consentRevision`, `updatedAt`.
- Keyed to the signed-in person: anyone else signed in on this computer reads it as off.
- A consent revision older than `SUBSCRIPTION_WORKERS_CONSENT_REVISION` reads as unavailable until
  the person confirms again. Turning it off always works.

## At a Nectovia start

The host decides; nothing in the request picks the worker.

1. **Who may take one.** Only the person's own start from the loop start route
   (`personStart`). A host start (Board work through `admitWork`, the Ready queue, a follow-up, the
   conversation driver) keeps the lead single-agent, so scheduled work never runs on a person's
   subscription (D12). A Retry of a worker the host chose then is read against the preference as it
   is now.
2. **Off** when the build or the port doesn't allow it, nobody is signed in, the preference is
   absent, off or another person's, or a business owns the project (D13).
3. **Unavailable** when the consent revision is stale or no tool is chosen.
4. **Consent names the tools.** The request must carry `workerConsent`: the consent revision and
   exactly the tools the host would try. A bare `consent: true` was given to a dialog that may not
   have named them, so it is refused with 409 `consentRequired` and the `workerConsent` to echo:
   "Your goal and the files the loop reads will be sent to Nectovia, and a task it hands off goes to
   Codex or Claude Code with the files it needs, signed in with your own account. Confirm before
   sending."
5. **Each tool in the person's order** is admitted the way a worker they name is
   (`admitRole(..., teamWorker, reserve)`); the first that admits takes the worker role. The team
   carries `origin: 'subscription-preference'`, one worker, one turn, the worker wall time.
6. **None admits:** `pause` refuses with 409 `subscription_worker_unavailable` before any paid
   admission; `single-agent` runs the lead alone and records why.
7. The run records the outcome as `LoopRunInput.subscriptionWorker` (state, tool, reason, reserve,
   consent revision), so a preference change mid-run changes nothing for it (N21).

## The reserve

`reserveRefusal` keeps the person's share of their tool's usage for their own work. The tightest
window decides. A missing, empty or stale reading (older than five minutes) can't meet a reserve.
It's checked at start, at the worker child's admission (the reserve pinned on the run) and in the
adapter's own admission before the turn. Codex now reports its windows at admission
(`account/rateLimits/read`); Claude Code and OpenCode report none, so a reserve keeps them out.

## The paid record

A worker under a Nectovia lead calls the Agent gate with surface `loop`, route kind
`external-engine` and the lead's root job. A refusal (a lapsed plan, an unknown state) fails the
worker before its turn (A29, N23). The account service records the admission append-only and holds
nothing.

## Deviations from the plan

- **Three tools, not Codex alone.** The plan's S3 named one Codex proposal worker; D3 widened it to
  Claude Code and OpenCode, tried in the person's order.
- **"Eligible", not "qualified".** No producer of the plan's qualification records (4.3) exists, so a
  tool is eligible when it's on the person's list and its own admission passes.
- **Receipt split as a team field.** `TeamLeadView.leadPayer` reads `nectovia-credits` for a
  Nectovia lead, beside S2's per-handoff worker payer. The plan's per-attempt gateway field needs a
  control-plane change.
- **The reserve is pinned per run**, read again on each admission's own usage reading.
- **Windows only** applies to Codex, through its driver. Claude Code and OpenCode run wherever their
  adapters run.
- **Consent is bound to the tools** (`workerConsent`), stricter than the plan's consent line.
- **N26 no longer applies:** after D3, a Claude Code worker is allowed.

## Launch gates

Both are needed: `DIOMEDES_EXTERNAL_WORKERS=1` attaches the engine port, and
`DIOMEDES_SUBSCRIPTION_WORKERS=1` (or `createApp({ subscriptionWorkers: true })`) allows the
preference. Without them the preference reads as unavailable and every start is as before.

## Files

| File | Change |
| --- | --- |
| `shared/subscription-workers.ts` | New. The preference record and its schemas, the consent text and revision, `reserveRefusal` |
| `server/subscription-workers.ts` | New. The host's choice, the settings routes' logic and the paid worker admission |
| `server/native-loop-routes.ts` | The choice at start, tool-bound consent, host starts kept single-agent, the Retry rule |
| `server/harness/capabilities/native-loop.ts` | The worker child's admission: reserve and paid record; reserve in the adapter; `leadRoute` on the team view |
| `server/harness/external-worker.ts` | The adapter's reserve check before the turn; usage on the admission |
| `server/external-worker-port.ts`, `server/integrations.ts` | Codex's usage windows at admission |
| `shared/team-delegation.ts` | `origin` on a team, `leadPayer` on the team view |
| `shared/native-loop.ts`, `shared/types.ts`, `server/store.ts` | The run's record and the settings key |
| `server/app.ts` | Wiring, the launch gate and the two settings routes |
| `tests/s3-subscription-workers.test.ts` | New |

## Tests

`tests/s3-subscription-workers.test.ts` covers the reserve rule, the preference record and its
routes, the paid record's gate call and the adapter's reserve check. It then mounts the real loop
routes over a scripted harness for every branch of the host's choice: off, on, tool-bound consent,
fallback in the person's order, single-agent and hold, the reserve, a business project, a stale
consent, a named team, a host start and Retry. Last, it runs the real app over the faux account
service.
- A signed-in Individual person, with a published route policy and an accepted Balanced profile,
  so the Personal tier resolves the way it does for a customer.
- A scripted managed gateway that returns its attempt record.
- A scripted engine port standing in for Codex.
- The lead plans, hands one task to Codex with its file and finishes. The account service records
  the worker's `external-engine` admission under the lead's job.
- A lapsed plan fails the worker before its turn.

Nothing reaches a provider or a real engine.

Gates, run in this worktree under the heavy slot on 2026-10-03, on the committed bytes:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | No errors |
| S3 and the files it touches most (S3, loop routes, Nectovia Board work, Nectovia loop refusals, H14 external worker, H14 team host) | 6 files, 89 passed (29 in the S3 file) |
| Full `npx vitest run` | 562 files: 9,534 passed, 1 failed, 5 skipped |
| `npx vite build` | Built |
| Playwright `ui`, `native-ui` and `field` | 36 passed |

The one failure is in `tests/automatic-work-host.test.ts`, which S3 doesn't touch. That file failed
in all three full runs on this box (5, 5 and 1 tests, a different set each time) and passed on its
own (39 passed, with `tests/run-store-reader-gate.test.ts`). The S2 commit, 81465bc, without S3, failed in
the same file under the same load (with `tests/connections-desktop.test.ts`: 561 files, 9,504
passed, 2 failed, 5 skipped). It's load-sensitive on a busy machine, not an S3 regression. Earlier,
before the consent and host-start change, the 26 files around S3 passed 385 tests.

Not covered: a live engine. Every engine turn here was scripted.

## Not in S3

- The UI: the Settings opt-in (copy through nectovia-voice, `single-agent` preselected), the worker
  row in the Agent conversation, the payer in the Team view, and the LoopStart consent naming the
  tools. Until the LoopStart echoes `workerConsent`, a start with S3 on asks for consent again.
- Telling an engine's own mid-turn refusal from an uncertain turn (A17), and keeping an answer that
  arrives after Stop (N33).
- A live engine turn. Every engine turn here was scripted.
- D1's approval, which switching S3 on waits for.
