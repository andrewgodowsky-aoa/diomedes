# Home history sharing (0.1.8 fix)

Status: implemented and gated on `feature/home-history-sharing`, from `bd684a6`, the 0.1.8 base.
Committed locally; not merged, pushed, packaged or released.

## Why

The 0.1.8 candidate (`43e0fa5`) passed every gate but its release review found the All projects
conversation on the Nectovia page cannot remember earlier messages. The owner's cloud-sharing rule
of 2026-09-23 keeps Home's documents and history gated while letting its typed messages through, and
the screen that would let a person grant history there was never built: Cloud sharing lives only in a
project's top bar. On provider routes each Home message is answered alone and nothing says so; on
Claude Code a follow-up is refused.

Andrew held 0.1.8 for this fix on 2026-09-23 ("Hold for a small fix"): a way to turn history on for
that conversation (off by default, per the rule), a visible line whenever it is off, and a true
wording for Workspaces' "we pay for them" line. Home is still never upgraded.

## What changes

### The control

All projects gets its own Cloud sharing, placed where the Console keeps a project's: in the strip's
right cluster, after Settings. `TopStrip.tsx` carries the button (Shell's strip carries a project's),
and it shows only while the All projects conversation is showing and exists, so it never opens
nothing. It opens `HomeHistorySharing.tsx`, a dialog titled "Cloud sharing" that offers only history,
one box per route: "Share earlier messages with AWS Bedrock". It offers the route the next message
takes and every route that receives earlier messages now, so any grant can be taken back there. The
boxes show what is saved; opening the dialog grants nothing.

It reads `GET /projects/<homeProjectId>/cloud-sharing` and saves with `PUT` and the version it read
as `expectedVersion`. If another window saved first, the dialog reads the record again and says so.
The endpoint, `changeCloudSharing`, `requireCloudSharing` and the rule that Home is never upgraded
are unchanged.

### Grant and revoke

The record has one history switch for every route, so a grant for one route could turn history on
for another route that is merely listed. At Home, then, `routes` means exactly the routes that
receive earlier messages (`client/console/home-history.ts`):

- A grant sends the routes that have history now, plus this one, with the switch on.
- A revoke sends them without this one. The last revoke sends no route and turns the switch off.
- `documents` and `shareReviewPackets` go back exactly as they were read. The page never sets them;
  at Home they stay `[]` and `false`.
- A route listed with the switch off can only come from a direct write, since Home has no
  documents screen. It is dropped when the switch turns on, so it never gains history nobody chose.
  This narrows the record and never widens it.

This was chosen over adding a per-route history field, which would change the server's record, and
over granting a route whatever it was listed with, which is the widening the rule forbids.

### The line

Near the composer, above it, `Diomedes.tsx` draws one line (`.dio-history`, from `DiomedesHome.tsx`)
with a "Share earlier messages" button that opens the dialog. It shows only when all of these hold:

- All projects is showing, and its sharing record has been read.
- The next message's route is a conversation route, so never Sample.
- There has been at least one answered exchange.
- That route does not receive earlier messages.

On a model route it reads "Earlier messages aren't shared with AWS Bedrock, so each answer stands
alone." On Claude Code it reads "Earlier messages aren't shared with Claude Code, so it can't answer a
follow-up."; there, a first message is answered and a follow-up is refused, so the line shows before
the follow-up is sent.

The route it names is the one the next message takes, by the host's rules in `tierFor` and
`threadRoute`. The thread's tier, or the Settings default tier, sends the message where the owner's
tier map or the owner-testing pin says. A pinned model keeps the recorded route. With no tier, it is
the recorded route.

The line is a status, not an alert, a notice or a turn. When Claude Code refuses a follow-up
(`cloud_sharing_denied`), the notice is the line's own sentence with the same button, and the line
steps aside so it is said once. The words go back in the box, as for any refusal. Saving a grant for
that route clears the notice. Nothing else about sending changes.

### Workspaces

`ALLOWANCE_TEXT` in `Allowance.tsx` rendered only when the allowance endpoint answered 404. The
served `ALLOWANCE_MEANING` said the same thing on every other path: "Managed model access includes
a set number of requests each period, and we pay for them." `Allowance.tsx`, rendered only from
`Workspaces.tsx` for a business, is the one place either appears.

- The duplicate is gone. Both paths render `ALLOWANCE_MEANING`, which now opens: "On a managed
  plan, a set number of requests each period is included, and we pay for them. A request is one
  thing you ask Nectovia to do…". It keeps the request-count unit, every negative, and no dollar
  figure.
- Where there is no allowance, the host's reason comes first: "This installation has no entitlement
  service. Managed access, included usage and billing are not available here, and no local record
  can grant them."
- That reason, `NO_ENTITLEMENT_REASON`, drops "Diomedes Agent" and now matches the control plane's
  own sentence. It is also the managed gateway's refusal text. Shipped identifiers stay as they
  were.

## Tests

New tests:

- `tests/home-history.test.ts` (18): what a grant and a revoke send, when the line shows and what it
  says, and which route it names.
- `tests/home-luna-routing.test.ts`, one test. After the page's grant, an AWS Bedrock follow-up
  carries the earlier turns. After the revoke it goes alone. A grant for Claude Code does not bring
  AWS Bedrock's back. Documents and review packets are untouched.
- `tests/home-conversation.test.ts`, one test. A Claude Code follow-up is answered after the grant.
  After the revoke it is refused with `cloud_sharing_denied` before anything is dispatched.
- `tests/included-usage.test.ts`, one test: the plan sentence opens "On a managed plan," and neither
  sentence names Diomedes.
- `tests/allowance-ui.spec.ts`, one test: the section's first line is the host's reason, and the plan
  sentence follows it. There is no `$` and no "Diomedes".
- `tests/home-history-sharing.spec.ts` (5), on the built Console with the real Store and both
  drivers. The line shows and its button opens the dialog. Granting hides the line, and the next
  message carries history. The strip's control revokes and the line returns. There is no line or
  control in a project scope, and no line on Sample. On Claude Code the line is there before
  sending, and the refusal carries the same button.

Each was seen failing first:

- Before any implementation, the unit and server files failed on the missing module, and the
  wording test failed on the old sentence.
- On the base UI, four browser tests and the allowance test failed.
- The Sample test passed there, because nothing drew a line. It failed once the line was built
  without its conversation-route check.
- Mutations fail the server tests on the behaviour itself:
  - history for any route while the switch is on (`host.ts`);
  - a Home bypass that lets history through (`cloud-sharing.ts`);
  - a revoke that only turns the switch off.
- Twelve more mutations of `home-history.ts` each fail their unit test.

Wording pins: no test pinned the removed sentences, so none was updated. The existing pins still
hold unchanged:

- `ALLOWANCE_MEANING`, in `included-usage`, `managed-usage` and `managed-usage-routes`;
- the Workspaces section, in `allowance-ui` ("not withdrawable money", "no entitlement service").

The gates ran on 2026-09-23 under the shared heavy slot, on this tree. The full browser suite used
ports 5294 and 47752.

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run` | 325 files, 5798 passed, 4 skipped |
| `npx vite build` | exit 0 |
| `npx playwright test` | 206 passed |
