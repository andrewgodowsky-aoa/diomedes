# Automations need a paid plan, 2026-09-28

- **Feature:** automations-paid-only
- **Branch:** `feature/automations-paid-only`, from main `0f20384`
- **Worktree:** `F:/Diomedes/diomedes-wt/automations-paid-only`
- **Owner:** Opus lane, coordination claims `claim_mukt8tdt_a59f30bb` and `claim_muktisx7_64fe18fd`
- **Source:** finding F01 of the independent review of #171, which was rejected at `05ef1b0`
  after the merge. The evidence is on `review/free-harness-paid-agent` (`evidence/free-harness-paid-agent-review/F01.md`, red commit `d94d722`).

## The rule

Andrew, 2026-09-28: "automations are paid plans only, whether its business+ OR individual tier
plans."

`shared/access.ts` already listed Automations among the paid abilities, but nothing on the server
asked for a plan. A free person could create a business, set up and activate its configuration,
link an output project and then:

- turn a schedule on (HTTP 200, `enabled`);
- press Run once (HTTP 200, `admitted`).

Only the Console's Personal branch showed the paid notice. A free business never reached that
branch.

## What changed

The change is server-only, in `server/automations.ts`, with one helper in `server/workspaces.ts`.
It touches no `app.ts`, `session.ts` or client file.

- **`AutomationService.planRefusal(organizationId)`** is the one check. It passes when the
  business's plan includes the Nectovia Agent. Otherwise it returns
  `{ code: 'plan_not_included', reason: AUTOMATIONS_NOT_INCLUDED_REASON }`, or `plan_unknown` with
  the account service's own sentence when that service has not answered yet.
- **Admission** runs the check for a Run once press and a scheduled slot alike, right after a
  slot's recorded-authority gate. A refusal is recorded as a refused occurrence in the server's own
  words, as every other refusal there is, and nothing starts. The workspace's "prepare the brief"
  button goes through the same `admit()`.
- **The schedule grant** runs the check before turning a schedule on or resuming it, and refuses
  with 403. Saving, pausing and turning a schedule off are unchanged, because they start nothing.
- **The view** says why before anyone presses anything. `run.allowed` is false with the
  sentence, and `schedule.enableBlocked` carries it. The Console already renders both next to Run
  once and "Turn on schedule", so no client change was needed.
- **An ended plan blocks a schedule that is still on, at once.** The row reads "Needs
  investigation" with the sentence, and the summary stops counting it as "Starts on its own".
  When its slot comes due, the slot is recorded as refused and raises a `blocked` attention item,
  titled "Blocked: needs a paid plan" (`SCHEDULE_OUTCOME`, `SCHEDULE_BLOCKING_CODES`).
- **The sentence** is `AUTOMATIONS_NOT_INCLUDED_REASON` in `shared/access.ts`: "Automations are
  part of a paid plan. Their setup and history are kept, but nothing runs until this business has
  one."
- **`WorkspaceService.planOf(organizationId)`** returns the business's plan without asking about
  the person signed in, so a scheduled slot can use it. It returns null when no account service
  is connected.

## Decisions, and how to reverse each

1. **Paid means the plan includes the Nectovia Agent.** Every plan template includes it
   (`PLAN_TEMPLATES`), which is also how the Agent gate reads a paid plan.
   - A separate `automations` grant feature would need a control-plane change, and every existing
     grant would have to be issued again.
   - If one is added later, change the single test in `planRefusal`.
2. **A plan not yet read starts nothing.** This follows the entitlement's own sentence: "Nothing
   that needs a plan can start until it does."
   - A scheduled slot in that state is recorded as refused.
   - That is the same outcome a failed sign-in resume already produces at startup
     (`schedule_owner_not_signed_in`), when the account service is unreachable.
   - After a normal start the plan is read before the scheduler's first pass: `init()` awaits the
     resume, which reads each business's access.
3. **A host with no account service asks for no plan.**
   - Every desktop and development run wires one: `desktop/main.mjs` ("sign-in is required") and
     `server/index.ts`. Only tests and tools that build the app without `accounts` have none.
   - That keeps the 30-odd Automation suites and browser specs that run on local development
     businesses unchanged.
   - This deliberately departs from owner rules and the phone relay, which are strict even there.
   - To reverse it, make `planOf` return `this.entitlementFor(organizationId)` unconditionally.
4. **An Individual plan reaches Automations through the business it covers.** This was updated
   after the Individual plan (#176) merged.
   - Automations are set up per business workspace, and Personal has none.
   - The Individual plan covers a business with one active member. That business's access view
     then reads the Individual plan, Agent included, so the same check admits it.
   - Harbor Hardware shows this in the tests, running them under its owner's Individual plan.
5. **The generic Work path cannot start the weekly brief.** Its procedure begins with
   `weeklyBriefInputSchema.parse(run.input)`, and only an Automation admission pins that input.
   Anything else fails before a step runs.

## Not changed

These belong to other lanes or decisions:

- **F02, downgrade.** Andrew: the Nectovia Agent should stop at once after a confirmed downgrade,
  settle the person's files, and help them onto the regular harness.
  - It lives in `server/accounts/session.ts`, which the accounts-security lane holds.
  - Here the host must still re-read the account (the test calls `POST /api/account/refresh`)
    before a schedule stops.
  - A run already started keeps going, as it does when a person pauses.
- **F03, notices.** Andrew: every notice offers "Don't remind me again" and "Remind me later".
- **The Automations page** shows the plan sentence where a run or schedule is refused, but offers
  no "See plans" link in a business. Personal has one.

## Tests

`tests/automations-paid-plan.test.ts` runs against the businesses in the faux seed, using the real
control-plane handler in-process:

- Harbor Hardware (no grant): refused.
- A business a free person creates: refused.
- Juniper Street Bakery (Business): admitted. This is the control that shows the check does not
  over-block.
- Juniper's schedule after its grant is revoked: blocked at once, and its slot is refused.
- Harbor Hardware under its owner's Individual plan: admitted. That plan covers a one-person
  business.

## Results, 2026-09-28, under the heavy slot

- **Red, before the fix:** 3 of the 4 new tests failed.
  - Harbor Hardware and the free person's business were admitted.
  - The schedule whose plan was revoked still read "scheduled".
  - Juniper Street Bakery, the control, passed.
- **Green:** `tests/automations-paid-plan.test.ts`, 4 of 4.
- **The affected suites,** 30 files at 4 workers: 427 passed and 2 failed.
  - The files are every test that imports `server/automations.ts`, `server/workspaces.ts`,
    `shared/access.ts` or `shared/automations.ts`, plus the weekly brief, business output,
    customer accounts, acceptance matrix and capture suites.
  - Both failures were a Windows `EPERM` when a harness run file was renamed ("The harness run
    stopped: Error: EPERM ... rename"). In `automation-routes` the stopped run made the legacy
    brief route answer `brief_failed`, and in `automation-weekly-brief` the run itself failed.
  - Both files then passed alone, 20 of 20.
- **`tsc --noEmit -p .`:** clean.
- **Full root vitest,** 4 workers: 492 of 492 files passed, with 8,245 tests passed, 4 skipped and none failed.

## Proposed CHANGES.md entry

`docs/harness/CHANGES.md` is claimed by the #169 lane. Add this at composition:

```
## Automations need a paid plan, 2026-09-28

- A business without a paid plan could run the weekly brief and turn its schedule on: nothing on
  the server asked for a plan, and only Personal showed the paid notice (finding F01 of the #171
  review). Run once and a scheduled slot are now refused and recorded in the server's words, and
  turning a schedule on or resuming it is refused with 403. The page says why before anyone
  presses anything, and a schedule still on when a plan ends reads Needs investigation at once.
  A business's plan counts when it includes the Nectovia Agent, as every plan does, and a
  one-person business its owner's Individual plan covers runs them too. A host with no account
  service, which only tests build, asks for no plan.
- Not changed: F02 (stopping the Agent and moving the default route at once on a confirmed
  downgrade) and F03 (every notice offers Don't remind me again and Remind me later) belong to
  the accounts-security lane's `session.ts` work.

`tests/automations-paid-plan.test.ts` covers Harbor Hardware, a free person's new business,
Juniper Street Bakery and a revoked plan, with the real control-plane handler in-process.
```
