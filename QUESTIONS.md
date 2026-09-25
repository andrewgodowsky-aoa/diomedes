# Questions

What is still undecided about Diomedes, and what the answers to the earlier questions
turned out to be. Anything settled here is settled in the code as well; if you overturn
one, the change is named beside it.

## Open

### O1. There is no pre-execution veto over the Codex tool host

Team runs enable `features.code_mode_host` for the team server only. With that on, the
model reported an inventory of the thirteen Diomedes team tools plus the host's own
internals (`exec`, `wait`, `request_user_input`, `clock`, the MCP resource readers,
`skills__list`, `skills__read`) and no shell or file tool, and it could not read a
project file or run a shell command. That is the model's own report, not a protocol
guarantee.

What is missing is a universal pre-execution interception point. `ClientRequest.json`
in the pinned 0.153.4 protocol has `mcpServerStatus/list` but no complete host
tool-inventory method; `ServerRequest.json` has `DynamicToolCallParams` for
`item/tool/call`, which covers client-executed dynamic tools only. Rejecting every
server request in `createRpcClient()` fences those; it does not fence a call the
app-server executes without asking the client. Diomedes rejects a foreign tool item on
`item/completed`, which detects a violation *after* it happened.

Three ways out, none taken yet:

1. Version-matched runtime or source evidence of the complete host inventory, or of a
   universal pre-execution allowlist, then implement and test a team-only boundary.
2. A separately constrained host or a client-executed tool bridge that checks the
   allowlist before forwarding. `--code-mode-host` is routing, not enforcement.
3. Accept the residual risk with the current fences, and say so plainly. This is where
   the project stands today: the enabled surface is documented, the gap is named, and
   nothing claims the boundary is proven.

Owner decision D8 in `../planning/2026-09-06-v6-two-views/00-two-views-brief.md`.

### O2. Discovered engines cannot be team members

`shared/types.ts` fixes `TeamMember['engine']` to `codex | claude-code | opencode |
oh-my-pi | sample | probe`, and `Route` to `sample | codex`. Discovery also finds
Cursor, Hermes and Ollama, and any future engine it learns about lands outside both
unions: it appears in the helper roster but cannot be picked for a team or given work.
Widening either union is a contract change, not a client guess. Nothing needs it yet.

### O3. Which engine gets the second adapter, and what it costs

Claude Code, OpenCode and oh-my-pi are found, reported and unrunnable. Each needs its
own adapter with its own isolation proof — the Codex one took a Windows write-denial
probe, an inherited-MCP disable-and-verify step and a pinned protocol schema.

`../planning/2026-09-06-v6-two-views/07-engine-discovery-brief.md` recommends Claude Code
next, driven through its CLI rather than the Agent SDK, as slices E2 and E3.

**The first half is decided.** Andrew, 2026-09-10: adapters are the next big piece, named
as "acp, -p for claude". So the second adapter target is Claude Code through its own
command interface, confirming the brief's CLI recommendation over the Agent SDK, and ACP
is a peer target rather than a later one.

**The second half is still open.** Nobody has said what the equivalent isolation proof
looks like for a CLI that was not built to be fenced, and that proof is what the Codex
adapter's cost actually was: a Windows write-denial probe, an inherited-MCP
disable-and-verify step and a pinned protocol schema. Until one lands, "team" means
"Codex talking to Codex", and D5 in the two-views brief — which engine leads by default —
has nothing to decide.

### O4. What a member should be able to do to a run in flight

There is no steering a run, no branching a thread, and no handing a thread from one
helper to another. A leader can interrupt or shut down a member, and that is all. Each
of these is a design question before it is an implementation one.

### O6. How long a start may wait before the data folder lock downgrades its evidence

`PROBE_TIMEOUT_MS` in `server/lock.ts` gives the start-time probe four seconds. The probe is
the lock's strongest signal: it is what separates a live owner from a reused pid. When it
does not answer in time the verdict falls back to the recorded port, which is the weaker
signal, and nothing tells the person that it did.

Four seconds is not always enough. On an idle machine the probe costs about 300 ms. On the
GitHub Windows runner, under the full suite, CI run 34552390176 failed three lock tests at
4074 ms, 4049 ms and 4043 ms, all at the timeout boundary, on a commit that changed only
markdown. Run 34551480601 passed with an identical `lock.ts`. Three consecutive timeouts
also rule out a cold start that a retry would warm. Of the shell-outs measured on current
Windows, PowerShell is the only one that answers at all: `wmic` is gone and `tasklist`
does not report a start time. Its own start dominates the cost, measured at about 250 ms of
roughly 300 ms, so a cheaper expression does not buy the budget back. Whether a lighter
host could was not tested.

Both fallback outcomes are wrong, in opposite directions. CI showed the conservative one: a
reused-pid lock that should read `held: false, start-time-mismatch` read `held: true,
port-active`, so Diomedes would refuse a data folder that is actually free. The dangerous
one is the same failure when the live owner has not yet bound its port: `port-idle` says
the folder is free and two processes can own it.

Three ways out, none taken:

1. Raise the budget. The probe runs only when a lock file already exists, so the cost is a
   slower start in an already abnormal case, against a wrong answer about ownership. This is
   the recommendation, at about fifteen seconds. The true ceiling is unknown: what is known
   is that four seconds failed three times running.
2. Keep four seconds and accept that the lock degrades to the port under load, saying so
   where the verdict is recorded.
3. Change what the fallback means, so an unanswered probe refuses rather than guesses.

Meanwhile the tests ask the capability question rather than the latency one: they give the
real probe a longer leash, so a loaded runner no longer reads as a platform that cannot
report a start time. The production default is untouched, and no test now exercises the
four-second budget end to end. Whichever option is chosen, that separation stands.

**Narrowed 2026-09-11.** The fifteen-second leash was not enough either: CI run 34664792501
timed out the same test at 15200 ms. So the budget was never the variable. Every `run:` step
on the GitHub Windows runner executes under PowerShell 7, which leaves Windows PowerShell 5.1
cold until the suite spawns it, and a cold 5.1 compiles itself on the way up for longer than
any budget a lock should wait. `server/lock.ts` now asks `pwsh.exe` first and falls back to
`powershell.exe` inside the same budget, remembering which one answered; run 34665085056 on
282baf3 passed with the four-second default unchanged. What remains open is the original
question in a smaller form: on a machine with no `pwsh`, whether four seconds of 5.1 is the
right budget, and whether an unanswered probe should refuse rather than guess (option 3).
Options 1 and 2 are no longer recommended, because the measured cause was a cold host, not
a slow one.

### O7. What version the first fully recorded candidate carries, and what its installer is called

Raised 2026-09-12. `diomedes-0.1.1-windows-experimental-20260912-da84689e08d7` is the first
candidate whose package, installer and record exist together on one machine
(`docs/implementation/2026-09-12-release-candidate.md`). It is version 0.1.1, like both
earlier identities, because bumping the version is not a build task. Two installers named
`Diomedes-Experimental-0.1.1-unsigned-setup.exe` now exist in history with different
digests, and the stable update channel tells releases apart by version. Separately, the
installer's product id, ownership marker and Start Menu folder are still named `20260909`
in `scripts/build-windows-installer.mjs`; renaming them breaks upgrade continuity with the
earlier installer, so they were left as they are. Andrew decides whether this candidate
becomes 0.1.2 or stays an unpublished experimental 0.1.1, and when the product identity is
renamed, once, on purpose.

### O8. ACP provider and version compatibility checks

The rule is settled and lives in the roadmap (2026-09-13.1, "Runtime seam"): Diomedes
contract first; ACP is the preferred external transport. What is not settled is what the
pinned providers actually do. Each item below is answered by a probe against the installed
binary, recorded the way `server/engines/cursor.ts` records its initialize exchange, never by
a vendor page alone.

1. Does the installed Devin CLI verify the way Cursor's did (version pinned, sign-in state
   readable, `devin acp` initialize negotiated, models listed), so it can be the second
   independent ACP conformance route in H05?
2. Does the pinned OpenCode 1.18.4 expose an ACP subcommand, and if so with what
   capabilities against its native session route (H04)?
3. Does ACP v1 `session/new` carry MCP servers in the shape the loopback `diomedes_team`
   host needs, for Cursor and for Devin (H14)?
4. Can Cursor's `Mcp(*:*)` native deny rule carve out the loopback team server while
   still denying every other MCP server (H05, H14)?
5. For each ACP route with client-served filesystem and terminal: can the mediated
   operations be bypassed by uncontained native tooling? Until answered no with evidence,
   the route's facts stay `engine-reported` or `not-measured` (H05, H12).

### O9. The History page can stay on the Console when two settings writes cross

Raised 2026-09-15. `openInBook` in `client/App.tsx` sends the guarded whole-settings write
(`PUT` with `If-Match`, `surface: 'workbook'`) at the same moment as `navigate`'s unguarded
`lastPage` patch. When the server handles the patch first, it refuses the guarded write with
409 ("Settings changed while this screen was saving. The saved settings were reloaded.") and
the surface stays `console`, so the History page never opens. Holding the guarded write for
150 ms makes the History check in `tests/ai-engines-ui.spec.ts` fail with both the 7adf603
spec and the spec before it; holding the patch instead makes both pass. Unforced, the check
failed 4 of 25 runs with the 7adf603 spec and 0 of 15 with the earlier one, which is not a
significant difference. A person can hit this, so retrying the test would hide a product bug.
Still open: which change in `App.tsx` makes the two writes safe to cross (for example,
`openInBook` waiting for the `lastPage` patch, or `navigate` skipping the patch while a guarded
write is in flight), carried under its own work order rather than as a test change.

### O11. Automations Milestone A: the defaults Run once was built on

Raised 2026-09-24 by `docs/implementation/2026-09-24-automations-a.md` §4. Andrew's D1–D4 are
settled (R9); these are the lane's own conservative choices, each in force until answered.

1. An occurrence file from another version: refuse it for that organization only (409
   `automation_record_unreadable`) and leave it untouched, or stop the app as `configuration.ts`
   does? Default: refuse for that organization only.
2. Should the 4 MB source cap of the per-run path also bound the configured sources? Default: yes.
3. The saved draft's History entry now reads `actor: 'diomedes'` with the procedure's application
   origin and the writer's generic "Diomedes changed 1 file"; the richer "drafted … for your review"
   sentence is not kept. Keep that? Default: yes.
4. A setup that asks for a reviewer first (`person-after-reviewer`) runs no reviewer in this build,
   and the detail says so. Build the reviewer step, or keep saying so? Default: keep saying so.
5. List the brief only once its organization has a configuration revision or an occurrence?
   Default: yes; before that the list is empty.
6. Label precedence: Running, Needs approval and Needs investigation first, then Setup incomplete,
   Waiting for data, Manual; a cleanly stopped run and a busy-project refusal rest as Manual.
   Default: as stated.
7. Budget 9 units and 9 tool calls, 0 model calls, so a crash-replayed save is affordable.
   Default: as stated.
8. Reads take the store lock, so an `admitting` occurrence is never seen half-way. Default: yes.
9. Automations sits first in the Console's and the home's Nectovia group, and the home's "Not ready
   yet" group is gone. Default: as stated.

### O12. Automations Milestone B: schedule defaults, including one that differs from the specification

Raised 2026-09-24 by `docs/implementation/2026-09-24-automations-b.md` §3.

1. **A local time that does not exist** (clocks go forward): run at the moment the clocks jump, and
   say so on the occurrence, or skip it and record the omission, as the specification's §6 proposed?
   Default taken: **run at the jump**. This differs from the specification; skipping is a one-line
   change.
2. A repeated local time (clocks go back) runs once, at its first occurrence. Default: as stated
   (matches the specification).
3. Missed runs: record every one; only the most recent may catch up, within 2 hours of its time
   (choices never, 1, 2 or 4 hours); a backlog never runs. Default: as stated.
4. "On time" means within 2 minutes of the slot; later is a catch-up and says so. Default: as
   stated.
5. The scheduler passes every 30 seconds, and the heartbeat reads unknown after 5 minutes.
   Default: as stated.
6. Turning a schedule on is a separate, recorded act by an owner or admin, never a side effect of
   saving, a setup answer, pack activation, configuration change, restart or rollback. Default: yes.
7. Who may pause: owners and admins only, or any member (pausing only stops future runs)? Default:
   owners and admins.
8. Resume is a fresh grant by whoever resumes, checked now; slots during the pause never run.
   Default: yes.
9. Editing a schedule that is on keeps it on under the original enable grant from the next slot.
   Default: yes.
10. A changed setup blocks the schedule (`configuration_changed`) until it is turned on again,
    rather than following the newly active setup. Default: block.
11. The person who turned a schedule on must be the one signed in on this computer, and a removed or
    demoted enabler blocks it. Default: yes.
12. A procedure with any model call or no finite budget never starts on a schedule. Default: yes.
13. A due slot while the output project is busy is skipped and recorded, never queued. Default: yes.
14. Paused slots are recorded as "Skipped — paused" and raise no attention. Default: yes.
15. Run once stays available while the schedule is paused. Default: yes.
16. Missed-run attention stays until someone has seen it; other items clear on the next clean run
    or when the schedule is turned on again. Default: as stated.
17. Only daily and weekly calendar schedules, one time a day; no intervals and no cron text.
    Default: as stated.
18. The occurrence file moves to version 2, and a Milestone A build refuses it rather than
    misreading it. Default: yes.

### O13. Ready queue: consent, limits and whose tasks it starts

Raised 2026-09-24 by `docs/implementation/2026-09-24-h07-ready-scheduling.md` and its review
(`2026-09-24-review-batch1-a.md`).

1. Automatic start is off for every project until the person turns it on. Default: off.
2. Limits of 1 run per project and 2 across projects, with manual runs counted, as constants: should
   they become settings? Default: constants.
3. May a person give a standing, per-project, per-engine consent so the queue can send a
   never-confirmed Ready task to a service route? Default: no. A service-route task starts on its
   own only as an exact re-send of a request the person already confirmed (same documents and
   thread); anything else is held for the person's Start.
4. A stopped, failed or finished task is not restarted unless the person reopens it. Default: as
   stated.
5. A refused claim holds the task for the person's own Start until it re-enters Ready. Default: yes.
6. An automatic start sends only the task's own default document, or none. Default: as stated.
7. The queue starts any Ready task, including those whose owner is "you", as the Board's Start does.
   Default: keep; revisit if owners come to mean "who does it".
8. A project whose Board policy is *Confirm each start* may still turn automatic start on; the
   switch is itself the opt-in. Default: keep, and say nothing more on the Board.

### O14. Remembered approvals: the offer, the pattern and what always asks

Raised 2026-09-24 by `docs/implementation/2026-09-24-remembered-approvals.md` and its review
(`2026-09-24-review-batch1-a.md`). D5 itself is Andrew's (2026-09-24); these are its details.

1. The offer threshold is 3, a product constant with a host override, not a person's setting.
   Default: 3.
2. A decline of the same item restarts its count ("keeps giving" read as consecutive). Default: yes.
3. An offer is made once per item per project, ever; a declined offer and an accepted one whose
   grant was later revoked do not return, and route 1 is how the person asks again. Default: yes.
4. "Go ahead and remember in this project" remembers only an approval just given, within 15 minutes
   of the click. Default: 15 minutes.
5. The button reads **Go ahead and remember in this project**, pairing with the existing **Go
   ahead**. Default: as stated.
6. A restart does not end a remembered approval (unlike a task scope's host lease). Default: yes.
7. Always asks: money, destruction and access words anywhere in the procedure, tool or permission
   name (stems and run-together names included), credential and key files, and anything the
   classifier cannot read; only a recorded local write and a send to named recipients are
   rememberable. Default: as stated.
8. A saved grant that a stricter classifier later calls always-asks fails project load. Default:
   keep fail-closed; if the lists grow, consider marking such a grant inactive instead.
9. A new rememberable permission joins the allowlist only with its own review. Default: yes.

### O15. Remembered approvals for Codex proposals, and the ChatGPT account of a task scope

Raised 2026-09-24 by `docs/implementation/2026-09-24-d5-codex-proposals.md`.

1. A Codex proposal's pattern is its exact set of files, created or updated and never removed, on
   one ChatGPT account; Build and Fix are the same procedure, and a team member's run is never
   covered. Default: as stated.
2. The Codex connection being on is the live authority a Codex grant rests on; turning it off asks
   again. Default: yes.
3. A task scope decides before a remembered approval. Default: yes.
4. A task scope's account is the one Diomedes last saw Codex prepare a proposal under in that task
   (else the project) when the scope was confirmed; stale knowledge can only cause an extra ask.
   Default: as stated.
5. An account the runtime did not report counts as "not the same account", except that a scope
   confirmed with no account seen still covers a proposal whose account was also not reported.
   Default: as stated.

### O16. Durable controls: confirmation, uncertain effects and receipts

Raised 2026-09-24 by `docs/implementation/2026-09-24-h08-durable-controls.md`.

1. Resume and Retry ask once before they send; Stop and Fork act on the press. This is "whether a
   click runs an action or selects it", which is Andrew's. Should Resume and Retry keep asking?
   Default: yes.
2. May a person acknowledge an uncertain effect and retry anyway, and what must the acknowledgment
   record? Default: no override; the person checks History and starts new work.
3. Resume refuses a widened thread permission; Retry runs under the thread's current permission.
   Default: as stated.
4. A fork starts at *Show me first*, starts no run, and copies the origin thread's route, model,
   Agent choice and mode. Default: as stated.
5. A host steer is not Steer: where a route only holds a message, the Console offers Queue and says
   so. Default: yes.
6. Receipts are never evicted; a project at 2048 receipts refuses new controls. Default: yes.
7. The Console's plain Stop goes through the control route (same effect plus a receipt). Default:
   yes.
8. Possible provider charging is not an uncertain effect for Retry; Retry's confirmation names it.
   Default: yes.
9. The control fixture is test-mode only and is not a route contract. Default: yes.

### O17. Codex kept threads and native controls

Raised 2026-09-24 by `docs/implementation/2026-09-24-h02-codex-controls.md`.

1. May Diomedes keep a Codex Work run's thread (`ephemeral: false`), which writes its transcript,
   including the selected documents' text, into the person's own Codex history, whenever the
   installed Codex offers resume or fork? Default: yes, and only then. (H04's kept OpenCode session
   likewise keeps its session in the person's OpenCode history.)
2. A native Fork makes the Codex branch and the new task and starts no run; the fork task's first
   Start continues the branch. Default: yes.
3. Where Codex cannot continue a thread, Resume is offered as a labelled fresh start by Diomedes
   rather than withheld. Default: offered and labelled.
4. Steer is offered only while the run is working and its Codex answered `turn/steer`. Default: yes.
5. A Resume waits up to 45 seconds, under the store lock, to learn whether Codex continued the
   thread before it writes its receipt. Default: 45 seconds.

### O18. Should a queued steering message carry the same per-message consent as a turn?

Raised 2026-09-24 by `docs/implementation/2026-09-24-review-batch1-b.md` (H04). A message queued
into an OpenCode kept session re-checks cloud sharing when it is sent, and Settings and the account
route are re-read at admission, but it asks for no separate per-message `consent: true`. The
review proposes yes (the steer carries consent and re-runs the turn's cloud-sharing check). Default
in the code today: no separate consent.

### O19. Should OpenCode's kept session become a Console conversation route?

Raised 2026-09-24 by `docs/implementation/2026-09-24-h04-opencode-sessions.md`. CD-01 Decision 5
names Claude Code and the model-API routes as the only Console conversation drivers; admitting
OpenCode amends it. The kept session is built and its API exposes exactly the controls its contract
declares. Proposal: allow it, with the Console offering exactly `sessionControls(contract)`.
Default: not wired; no Console screen offers OpenCode session controls.

### O20. Agent profiles: fallback and precedence

Raised 2026-09-24 by `docs/implementation/2026-09-24-h09-agent-profiles.md`.

1. Fallback to the next profile is off by default and is restated on every save; omitting the flag
   turns it off. Default: off.
2. A thread's own model pin or WorkStyle outranks a project or task list, and the tier map is
   untouched (no profile gives Thorough a model). Default: as stated.
3. A thread's explicit profile pick uses the project's or task's fallback policy for the rest of
   the list. Default: yes.
4. Profiles are person-level; routing lists are per project and live with configuration, not
   project state. Default: as stated.
5. Retry and Resume re-resolve a profile and pin what they resolved then. Default: yes.
6. A profile pick counts as `manual` model selection and a routing-list pick as `automatic`.
   Default: as stated.

### O21. Instruction files: kind order and discovery limits

Raised 2026-09-24 by `docs/implementation/2026-09-24-h11-nested-rules-delivery.md`.

1. In one folder, AGENTS.md takes precedence over CLAUDE.md (the pack manifest's order). It changes
   ordering only, never authority. Default: AGENTS.md first.
2. Nested discovery stops at 6 folders deep, 2000 folders visited and 32 nested files, and a file
   past a bound is neither discovered nor recorded as skipped. Should bound hits be recorded, and are
   the bounds right? Default: the bounds above, unrecorded.
3. Filenames match exactly (`agents.md` is not found on a case-sensitive disk), discovery refreshes
   on activation and when the packs list is read rather than at every run start, and scope comes
   from a run's selected documents only. Default: as stated.

### O22. Mediated effects: idempotent recovery and reconciliation

Raised 2026-09-24 by `docs/implementation/2026-09-24-h12-mediated-effects.md`.

1. Any interrupted write is uncertain, idempotent ones included, so it waits for reconciliation
   instead of retrying on its own. May an interrupted idempotent write whose sink dedupes by key
   retry without a reconciliation step? Default: no.
2. Only a definite reconciler answer settles an effect; `write_file` answers applied only on an
   exact text match, never not-applied. Default: as stated.
3. Where and how does a person mark an uncertain effect applied or not applied, and what evidence
   must they give? Default: no route or Console surface yet; `reconcileEffect` is host API only.
4. Team tools keep `permission: null`; team membership is their gate. Default: yes.
5. The contained `write_file` tool is offered to no route (model-API turns stay read-only).
   Default: not offered.
6. Read tools skip the NFC and case-collision refusals; the private-name checks still fold case and
   compatibility forms. Default: as stated.

### O23. Where a person starts a Diomedes work loop

Raised 2026-09-24 by `docs/implementation/2026-09-24-h13-native-loop.md`. Andrew answered its
other three items (the finish, delegation and attribution) on 2026-09-24, and they are now R11.

Where does a person start a loop: the Diomedes page's escalation (CD-04), a thread action, or
elsewhere? The same question now covers an H14 lead with workers (O36). Default: no Console start
control; only `POST /api/projects/:id/loop/start`.

### O25. Should a declared project command run as a verification check, and under which grant?

Raised 2026-09-24 by `docs/implementation/2026-09-24-h17-verified-completion.md`. There is no
mediated, Trust-authorized command-execution path, so a declared `command` check is recorded and
reported as not run (*incomplete*), and a task that declares one can never read Verified. Default:
declared, never run.

### O26. Context selection: carried history, bounds and pinning

Raised 2026-09-24 by `docs/implementation/2026-09-24-h18-context-accounting.md`.

1. History carried from a retired lineage keeps giving way first and is not summarised (the existing
   rule for "Update this conversation"). Default: not summarised.
2. The history bounds stay 12 messages and 24,000 characters; H18 changes what fills them, not their
   size. Default: unchanged.
3. Only a lineage's opening message is pinned; should a person be able to pin a message? Default:
   no pin control.

### O27. Versioned records: newer files, backups and the automation host

Raised 2026-09-24 by `docs/implementation/2026-09-24-h21-migrations-perf.md`.

1. A newer settings or project file stops the local service and is left untouched. Default: stop.
2. Project state is stamped `schemaVersion: 1` from now on. Default: yes.
3. A migration's backup sits beside the file and is never deleted automatically. Default: yes.
4. Automation occurrence files migrate when opened, not on the next write. Default: yes.
5. An unreadable or newer `automation-host.json` is replaced today; should a version above 1 be
   refused instead, which changes scheduler start-up? Default: replaced, as today.

### O28. Pack lifecycle defaults and outward capability requests

Raised 2026-09-24 by `docs/implementation/2026-09-24-p01-p03-pack-lifecycle.md` and its review
(`2026-09-24-review-batch1-b.md`).

1. Software Engineering and Small Business count as installed by Diomedes, the `diomedes`
   namespace and publisher name are reserved, and they can be uninstalled only while no project has
   them on. Default: as stated.
2. Turning on a pack whose dependency is off asks rather than refusing or turning it on silently;
   turning off or uninstalling something in use refuses and names the user. Default: as stated.
3. Rollback steps back one version at a time and restores no permission. Default: yes.
4. Outward capability requests are refused by a denylist of name prefixes (`email-customers`,
   `upload-files` and `wire-money` pass it). Should an allowlist drawn from Trust's capability
   vocabulary replace it? Default: the denylist stays; a request is still never a grant.
5. A damaged pack with no recorded dependencies blocks uninstalling any other pack until it is
   repaired or removed. Default: yes.

### O29. Which H-number names which harness lane

Raised 2026-09-24 by the H07 and H13 records. `docs/harness/HARNESS_INTEGRATION_MAP.md` uses H07
for execution teleportation and titles H13 "Queues and budgets", while Linear DIO-12, DIO-18, the
unified package and roadmap §4 use H07 for Ready scheduling and H13 for the native loop. Default:
the records and this roadmap follow Linear; the map is not yet changed.

### O30. Files: restoring binary versions and opening a file externally

Raised 2026-09-24 by `docs/implementation/2026-09-24-p05-files-attachments.md`. Restoring a
picture, PDF or workbook from History is refused in words (its versions stay kept and viewable),
and the desktop shell gained no open-externally hand-off, so a PDF is described, not opened.
Default: both not built; each is a candidate follow-up.

### O32. Should a same-version byte change in a bound executable move its binding revision?

Raised 2026-09-24 by `docs/implementation/2026-09-24-audit-server-fixes.md` (DIO-86). The binding
now records the SHA of the bytes on disk and its revision key moves with them, but the semantic
`revision` counter does not: a same-path change is followed as the installation updating itself, so
a verification receipt survives a byte change without a version change. Default: keep that
contract.

### O33. Inventory: permissions, tenant labels and mounting

Raised 2026-09-24 by `docs/implementation/2026-09-24-inventory-auth.md` (DIO-95).

1. View and status need `inventory:view`; receive, use and transfer need `inventory:record`; adjust
   needs `inventory:adjust`; a count needs `inventory:count`; a correction adds `inventory:adjust`;
   `inventory:approve` is unused. Default: as stated.
2. Inventory scope ids admit no `:`, so the local tenant `org:<id>` maps to `org.<id>` and any other
   non-conforming tenant reads as unavailable. Widen the inventory id grammar, or adopt the mapping
   in the MI00 contract? Default: the mapping.
3. Inventory stays unmounted from the app until someone decides to ship an inventory surface.
   Default: unmounted.
4. The session token is mandatory for inventory even in the standalone development browser service,
   which therefore cannot serve it. Default: mandatory.

### O34. May a status line name the agent while ChatGPT writes?

Raised 2026-09-24 by `docs/implementation/2026-09-24-independent-reviews.md` (R36-4).
`server/native-work.ts` logs "Nectovia is writing the proposal." during a direct ChatGPT proposal
run, following `shared/agent-name.ts` ("lines about what the agent is doing name it, never the model
or route serving it"), while decision 8 says direct-agent work is never casually described as
Diomedes reasoning. The run's recorded origin is truthful either way. If decision 8 wins, the line
becomes `${routeDisplayName(run.engine)} is writing the proposal.` Default: unchanged.

### O35. Guidance maintenance: what signs a revision, and when Diomedes proposes one

Raised 2026-09-24 by `docs/implementation/2026-09-24-h10-guidance.md` (DIO-15, PR #111, in batch 6).

1. "Signed" means a SHA-256 digest chain, not an HMAC. There is no persisted local key to sign
   with, so the chain detects an edited, dropped or reordered revision but cannot stop someone who
   can write `state.json` from recomputing it. An HMAC needs a key-custody decision. Default: the
   digest chain.
2. A proposal needs 3 distinct occurrences of the same correction, for every kind, as a product
   constant. Default: 3.
3. A decline holds until a new piece of evidence arrives, and rolling back an applied proposal
   counts as declining its evidence. Default: as stated.
4. Rollback restores the text from before the named revision. Default: as stated.
5. A revision that would flag any run whose write the person kept reads *worse*, however many
   corrected runs it would also catch. Default: *worse* wins.
6. Sample runs are not evidence. Default: as stated.
7. Only an existing, loaded instruction file is revised, by appending one line. No file is created
   and no existing line is edited. Default: as stated.

### O36. Lead and workers: limits, failure and reuse

Raised 2026-09-24 by `docs/implementation/2026-09-24-h14-teams.md` (DIO-19, PR #112, in batch 6).
Andrew's 2026-09-24 decisions answer part of this (R11, R13). A worker is a Diomedes-dispatched
helper, so it will work in a sandbox and hand back a change set once the sandbox exists. Until
then it stays read-only as built. What is still open:

1. **Limits.** H14 was built with depth 1, at most 3 workers at once and at most 6 per lead run.
   Andrew's H13 limits are depth at most 2 and at most 4 delegates per run, in parallel. Do the H13
   limits govern H14's workers? If they do, 6 per run is above the limit. Default: the build's
   numbers stand until the delegate-sandbox slice reconciles them.
2. **Budget.** A worker gets its own budget: 4 turns, reported tokens not limited, 5 minutes. The
   ceilings are 8 turns, 400,000 tokens and 30 minutes. An advisor gets 3 turns and 2 minutes, and
   2 questions per lead. R11 says a delegate's budget is carved from its parent's remaining budget,
   and these budgets are not carved from the lead's yet. Review D's patch B names the same gap for
   H13. Default: as built.
3. A worker that fails or dies stops its lead, and the person retries through H08. A worker stopped
   by its own budget does not stop its lead. Should a lead ever carry on with a partial outcome?
   Default: it stops.
4. The default Agents are `diomedes.general` for a worker and `diomedes.architect` for an advisor,
   and an advisor must have a `review` ceiling. Default: as stated.
5. A retry reuses a finished worker's answer when the role, task and scope match exactly, without
   re-reading the files. Default: as stated.

### O37. Pack contributions on demand: refusal, reading and model choice

Raised 2026-09-24 by `docs/implementation/2026-09-24-p04-on-demand-contributions.md` (DIO-30,
PR #114, in batch 6).

1. A built-in pack whose content changed without a version change is refused at load, not
   silently re-indexed. Default: refused. Changing a playbook therefore needs a version bump.
2. A person opening a playbook to read it is recorded as a load, with the reason `opened`.
   Default: recorded.
3. In Ask and Plan on model-API routes, the model may choose a playbook from the index. Andrew may
   prefer that only the person chooses. That is a one-line change, and the index route remains.
   Default: the model may choose.

### O38. Should project threads on Claude Code run on the native session?

Raised 2026-09-24 by `docs/implementation/2026-09-24-h03-claude-live-controls.md` (DIO-8, PR #92,
on main through batch 5, PR #107). H03's controls (queued steering, Stop with escalation, restart
reconciliation) ship only on the Diomedes page. Project threads on Claude Code (Ask, Plan,
Automatic) still use the single-turn direct path. Moving them would change how a thread's route is
chosen (`planThreadSend`). Default: not moved.

### O39. Kept Cursor and Devin conversations: a Console route, and when their folder is removed

Raised 2026-09-24 by `docs/implementation/2026-09-24-h05-cursor-acp-sessions.md` (PR #90, on main
through batch 5, PR #107).

1. Should the kept Cursor and Devin conversations become Console conversation routes? That would
   amend CD-01 Decision 5, as O19 would for OpenCode. Default: an API route only.
2. When should a kept conversation's private engine folder be removed? The resume needs it, and
   deletion is designed, never a blunt switch (decision 10). Default: never removed automatically.

Also recorded as defaults: only `fetch` and `think` asks and plan approvals reach a person, and
anything that would write, execute or switch mode stays declined. A declined question lets the
turn continue. An expired or cancelled one stops it.

### O40. Should a Codex Resume wait for Codex while it holds the service lock?

Raised 2026-09-24 by review C (`docs/implementation/2026-09-24-review-c.md`, RC-H02-1, PR #109, in
batch 6). H02's default 5 has a Resume wait up to 45 seconds for its run to open a Codex thread.
The wait happens under `store.locked`, which serialises the whole service. So a slow Codex start
also holds up Stop and every read in every project. Fork has no overall bound. Review C proposes
releasing the lock around the engine call. The interim option is to drop the wait and have the
receipt say what Diomedes started. Also open: whether Queue with `waitsFor` cancellation should be
exempt from H08's 2048-receipt limit, as Stop now is. Default: unchanged; the proposed patch is
recorded, not applied.

### O41. May a new run start while a supervision escalation is open?

Raised 2026-09-24 by review D (`docs/implementation/2026-09-24-review-d.md`, patch A, PR #110, in
batch 6). `WorkService.start` refuses a start only while a run is live. A person's Start on a task
waiting on a supervision escalation therefore succeeds and detaches the question, and that run's
drift is only noted. R12 item 6 (one escalation per task and issue) does not decide this. Proposed
default: refuse the start (409 `supervision_escalation_open`) until the person answers. Today the
start is admitted.

### O42. Review E's decisions to revisit

Raised 2026-09-24 by review E (`docs/implementation/2026-09-24-review-e.md`, PR #113, in batch 6).

1. **D5 task-scope account.** A task scope confirmed with no proposal waiting still binds the
   account of an earlier approved proposal (the open half of D5-1). Should it bind only a waiting
   proposal's account, and otherwise record "no account seen"? That would change O15's default.
2. **D5 always-ask list.** Only SVG, HTML and XML count as able to run code when opened. Should
   scripts, CI workflows, `package.json` and instruction files (`AGENTS.md`, `CLAUDE.md`) always
   ask as well?
3. **Automations B default 16.** Its section 3 says attention items clear when the schedule is
   turned on again. The code clears only `blocked` items, which is the safer behaviour. One of the
   two needs correcting.
4. **P06 version comments.** A version comment rides with a task's revision by path, even when
   someone else wrote the version. Should it ride only with versions the task's own changes
   produced?

Default: each stays as built.

## Resolved

### R14. Task priority: order, due dates, labels and who edits (raised by OS-DISC-01 section 5)

**Settled 2026-09-25 by Andrew (OS01 prompt rev 2, `docs/product/PROMPT_OS01-task-priority-2026-09-25.md`;
ADR rev 5 D7).** The discovery report asked how priority should order work. Answers:

- **Fairness.** Priority applies inside each project's fair turn in the ready queue. Least-recently-served
  project order, consent holds and limits are unchanged, and there is no cross-project override.
  Every other actionable work list sorts by the one comparator:
  `priority → due (dated first) → readyAt → scoped id`. Plan steps, History, conversation turns and
  messages keep their own order.
- **Due date.** A plain calendar date, `YYYY-MM-DD`, stored as entered and compared as a string.
  There is no organization timezone on main. OS01 computes no overdue or today; a later lane that
  shows them picks the zone.
- **Undated tasks** sort after dated ones at the same priority.
- **Labels** are 1 Do first, 2 Today, 3 This week, 4 When you can, 5 Backlog. They are words only
  and never auto-decay. Packs and organizations may override them later.
- **Planning revision.** Only priority and due edits bump it, so a state move never makes a
  person's priority edit fail.
- **Attribution.** `priorityMoves.by` records `'you'` for the Console control and for a
  conversational edit the person asked for (its receipt names the turn). It records `'diomedes'`
  for team tools or anything Diomedes initiates.
- **The control.** Choosing a level saves at once, with "Saving…" and then the result or a
  conflict message, and no confirmation step. The due date is edited in the same control.
- **Permission.** None until OS04 adds `task:prioritize`; the local Console user may edit.

Not built yet. OS01 is package node 23c/24c, Linear DIO-110.

### R13. How a helper Diomedes dispatches works (team mode)

**Settled 2026-09-24 by Andrew (`docs/reference/DECISIONS_2026-09-24.md`, "Team mode, in
general").** These rules cover every helper or sub-agent Diomedes dispatches, not only H13
delegates. His direction was to take the options that give broad function and safety without
hampering agents while they work, especially in team mode.

- **Sandbox by default.** Delegated work runs in an isolated working copy under H12 containment
  and hands back a recorded change set. Direct writes to the project belong to the parent or a
  person, never to the helper.
- **No authority widening.** A helper's authority is the intersection of its parent's grant and
  its declared scope (decision 7). A helper's action is attributed to its own engine and model
  (decision 8).
- **Do not hamper.** The sandbox replaces "read-only" as the safety mechanism. Letting a helper do
  the work somewhere safe is preferred over refusing the work.

Not built yet. H13 delegates and H14 workers are read-only in source today. The sandbox is H13's
next slice, in progress on `feature/h13-delegate-sandboxes` and not landed. H14's limits and budgets
are still O36.

### R12. Supervision: thresholds, corrections, scope and escalation (raised as O24)

**Settled 2026-09-24 by Andrew (`docs/reference/DECISIONS_2026-09-24.md`, H15).** Items 1 to 4 and
6 to 8 accept H15's defaults. Item 5 answers the question the lane left open.

1. **Thresholds.** Identical calls in a row: 3 / 4 / 6 (note / correct / pause). The same
   observation for different inputs: 4 / 5 / 8. Budget: noted at 80 percent used, critical at 90
   percent or more used with a projected overrun. A project may tighten these but never loosen them.
   No project setting for tightening exists yet.
2. **Correction bounds.** Scope 1, no-progress 2, budget 1, instruction 1 and verification 1, all
   capped at `CORRECTION_LIMITS.maxAttempts` (3).
3. **Scope** is folder-level, as proposed.
4. **Out-of-scope writes.** An unapproved recorded write outside scope, or into a forbidden path,
   pauses the run at once. Reads and proposals are only noted.
5. **Queued corrections.** On a route that cannot steer, a queued correction may start the next run
   without a person. It shares the origin run's correction bound. It runs through ordinary
   admission, with a permission never wider than the origin run's. It is labelled as a supervision
   correction in the thread and in History. A pause or a Stop cancels it. Once the bound is spent,
   the next drift escalates to a person as a Need. This is how H15 was built.
6. **Escalations** are raised once per task and issue. Review D narrowed "continue" to
   acknowledge the issue only for the run it resumed (PR #110). Whether a new run may start while
   an escalation is open is still O41.
7. **Supervision is always on**, in every project. No setting turns it off or widens it.
8. **Instruction drift** reads only backticked paths after an explicit prohibition. Review D fixed
   the reading of a prohibition that carries an exception.

### R11. The Diomedes work loop: finish, delegation and attribution (raised as O23 items 1–3)

**Settled 2026-09-24 by Andrew (`docs/reference/DECISIONS_2026-09-24.md`, H13).**

1. **Accepted.** A finish that is not Verified leaves the task in Review (`waiting ·
   changes-ready`), also when no checks are declared. The agent is not stopped. It finishes, and a
   person or a verifier moves the task to done.
2. **Changed: delegates will work in sandboxes, not read-only.**
   - Every delegate runs in its own sandbox: an isolated working copy of its scope in the parent
     run's area. Every write and spawn goes through H12's containment funnel, rooted at that copy.
   - Its changes come back to the parent as a recorded change set, with P06's readable diff and
     per-change keep. The parent may apply changes inside its own grant, through the one recorded
     write path and attributed truthfully. Anything else waits for a person as ordinary review.
   - A delegate's grant is the intersection of the parent's grant and the handoff's declared scope.
   - Limits: depth at most 2, at most 4 delegates per run, and delegates may run in parallel.
   - A delegate's budget is carved from the parent's remaining budget, never added on top of it.
     Stop still cancels the whole tree.
   - Delegate routes come from the project's H09 Agent profiles. The person, or the profile's
     default, fixes which routes are allowed at start. The model picks among them and writes each
     sub-task, but never chooses who pays.
   - Until the sandbox exists, delegates stay read-only, one level deep, at most 2 per run, as
     built. The sandbox and the change-set return are H13's next slice, in progress on
     `feature/h13-delegate-sandboxes` and not landed.
   - Carving the budget needs what review D's patch B names: charging a delegate's spend to the
     parent's job cap. That is not built.
3. **Accepted.** The loop's own steps are attributed to Diomedes as native supervisor. Model steps
   are attributed to the runtime-reported model, and a fixture route names no model.

Item 4, where a person starts a loop, is still open as O23.

### R10. Readable diffs of recorded versions are Core (raised as O31)

**Settled 2026-09-24 by Andrew (`docs/reference/DECISIONS_2026-09-24.md`, P06).** Three things P06
built are Core, as the lane built them: readable diffs of recorded versions, keep per change, and
review comments. The rule behind this is decisions 12 and 13. A restaurant's spreadsheet export
and a contract draft need a readable diff as much as source code does. The Software Engineering
pack still owns the IDE-grade layer on the same surface: Git, syntax highlighting, unified and
split code views, and LSP. For recorded versions only, this replaces the 2026-09-10 product note,
which put "unified and split diffs" in the pack. Decision 13 in `AGENTS.md` and
`docs/reference/STANDING_DECISIONS.md` now says so. P06 is implemented in source and was reviewed
by review E. It is not released.

### R9. How Run once executes, what it may save, what a missing source does, and where Automations lives

**Settled 2026-09-24 by Andrew (Automations Milestone A work order, D1–D4), now in the code on
main.** Run once is a deterministic `weekly-brief` harness capability run by RunService with no
model call (D1). Saving the draft keeps today's authority — `approval: false`,
`write-project-file`, the pinned destination only, saved for review (D2). A missing configured
source stops the run before writing, shown as Waiting for data (D3). Automations sits in the
Console's Nectovia group, and the home row opens the output project on it or says why (D4).
`server/harness/capabilities/weekly-brief.ts`, `server/automations.ts`,
`client/console/AutomationsPage.tsx`; record `docs/implementation/2026-09-24-automations-a.md`.
The lane's own defaults are O11.

### R8. Which web search an Ask or Plan turn on a model-API route may use (raised as O10)

**Settled 2026-09-23 by Andrew: web search stays on the subscription engines.** Claude Code and
Codex search the web natively under the customer's managed subscription, and that is where search
lives. Nectovia buys no search API: no paid search provider, no search key, and no per-call search
charge on AWS Bedrock, Azure OpenAI or OpenRouter (nor on Google Vertex AI when its route lands).
A model-API turn keeps project-file reads, approved connector reads and the guarded `fetch_page`
for a known address (`server/harness/capabilities/read-scope-tools.ts`), and the model is still
told search is unavailable there. Work that needs a search belongs on a subscription engine, and
the tier map (`shared/tier-map.ts`) is where the owner decides which tier runs where.

This answers the first half of O10 (which provider and key, paid by whom, under what limit): none.
A search call therefore never needs a ledger line of its own and never rides on a model route's
spend hold.

Still open, carried from O10: whether an approved connector's MCP server is launched through a
shell on Windows. The host client spawns the owner's `command` directly, so a `.cmd` launcher such
as `npx` needs its full path or a `node` command line in `read-connectors.json`.

### R7. History retention was configured and not enforced (raised as O5)

**Settled 2026-09-10 by Andrew: preserve the evidence, remove the controls.**
`Settings.history.keepDays` (30) and `maxBytesPerProject` (2 GB) were stored, validated
and read by nothing. The choice was to implement pruning or stop offering the settings,
and pruning was the wrong half to reach for first: History is evidence, and Pillars 06
and 09 both name evidence and audit as enforced concepts, so what may be aged out is a
policy question before it is an implementation one.

Both keys are gone from `Settings`, from the defaults and from the settings validator.
`migrateSettings` deletes a stored block, because settings load with no merge against the
defaults and a retired key would otherwise be read back and rewritten forever. History
now keeps everything, and the README and the website say so rather than describing a
control that does not work.

This is not a ruling that data can never be deleted. Diomedes relies on durable
attribution, receipts, authorization history, verification and evidence as part of its
trust model, so what it will not do is expose a blunt setting that destroys that record
before the archival, deletion, organization-policy and legal data-lifecycle model exists.
Designing those semantics deliberately is future work, not a closed door.

Still open, when someone wants it: what a real retention and archive policy allows. It
has to answer whether ageing out may remove the record of an authorized effect, and if
not, what an archive keeps instead.

### R1. Could Codex call the Diomedes team tools at all?

**Yes, with two changes.** This was the blocker of 2026-09-06: a real team run reached
readiness and returned "code-mode host is disabled", and the analysis at the time
concluded that enabling the host could not be justified without an enforceable tool
boundary.

It was settled empirically instead, and the runs are recorded in
`evidence/codex-team-real-binary-2026-09-06.md`:

- **Run 1** — `features.code_mode_host = true` for the team run only, everything else
  unchanged. Every team tool call returned `MCP tool call requires approval, but
  approval policy is never`. The tools were reachable but uncallable.
- **Run 2** — plus `default_tools_approval_mode: 'approve'` on the `diomedes_team`
  server entry. `team_members`, `team_task_list` and `team_task_create` all returned
  real results.
- **Run 3** — a member woken by the owner's message read its mail, created and updated a
  board task, and reported to the leader.

`features.code_mode` stays `false`. The host flag is set for the team process and team
thread config only; a non-team run still sees both flags false. What this does *not*
settle is O1 above, which is the proof gap the original analysis named.

### R2. Where does a helper's work show up?

The board is the Diomedes task list — a task a member creates is a task on Tasks and on
the Desk's Board, attributed to the member. The model's own report goes into that run's
session log, not into the thread as a turn; the thread turn says a team message was
picked up. Team tool calls are logged as technical lines in the session log.

### R3. How a member wakes

- The recipient thread's permission comes from `Conversation.permission` on the member's
  `threadId`; a missing conversation or missing field means `show-first`.
- The wake text is `From <sender name>: <content>`, oldest first, joined by blank lines.
  The sender is `Owner` for the owner, the member's name otherwise, the raw slot id if
  the sender row is gone. The same renderer serves the automatic wake and the explicit
  one.
- Every unread message addressed to the slot counts toward `unread` and the wake text,
  including `shutdown_request` and `idle_notification`.
- Only `team_send_message` and the owner's `POST /team/messages` wake a member. A
  leader's interrupt or shutdown does not.
- Automatic wakes are capped at five per slot per ten minutes. Going over writes one
  History entry (`kind: 'team-wake'`, actor `diomedes`) and parks the member as waiting.
  Normal wakes write no History entry.
- A starter failure never fails the send: the automatic wake swallows it and parks the
  member as waiting. The explicit wake route lets the error through.
- The explicit wake route works on a `stopped` member — the owner asked for it — as long
  as there is unread mail and a starter. Automatic wake skips stopped members.
- The starter is wired in `server/app.ts`. It calls `startCodexWork(..., held = true)`,
  so it does not re-enter `store.locked` from inside a locked route. The store lock is a
  queue and re-entering it deadlocks; anything else wiring a starter has to respect that.

### R4. What the helper roster shows

- The Settings rail entry is **Helpers on this computer** in the Book; the Desk keeps
  **Engines**. Both render the same block. The old Desk-only "Connections" entry is gone.
- Guided detail hides engines whose adapter is not ready, in the Book only. Standard and
  the Desk show everything.
- An engine counts as usable when the integration reports it available *and* its
  Settings switch is on. Sample work is ungated. This is what keeps "Start with Codex"
  from appearing while Codex is switched off.
- Task Start buttons and the thread helper picker offer only the `Route` union — sample
  and Codex. The roster still lists every engine that was found.
- The add-a-helper picker offers every engine the integration reports; unavailable ones
  are disabled and carry the server's status in parentheses, e.g. "Claude Code
  (Installed)".

### R5. How discovery decides what it found

- Discovery runs only when asked: opening the helpers section, or pressing **Check
  connections**. Never at application start, and one probe at a time.
- On Windows, `where` lists an extension-less shim before its `.cmd` twin, so candidates
  are ranked `.exe`, then `.cmd`/`.bat`, then bare. A `.cmd` or `.bat` is run through
  `cmd.exe` with a fixed argument list, and a path carrying shell metacharacters is
  refused outright.
- PATH first, then `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, `~/.local/bin` and
  `~/.bun/bin`, each tried as `.exe`, `.cmd`, then bare. A failed or slow PATH lookup
  falls through to the folders instead of failing the engine.
- A non-zero exit from `--version` is fine if the output parses; the version string is
  the evidence. A timeout is always "version could not be read" — no partial output is
  trusted. Version text is stdout and stderr combined, sliced to 4 KB before matching, so
  a version past the cap is unreadable rather than guessed.
- Ollama counts as found when either the binary resolves or `/api/tags` answers 200; the
  location falls back to the tags URL when no binary resolved.
- `?refresh=1` bypasses both the discovery cache and the 30-second Codex/LocalAI cache.
  A plain call reuses discovery indefinitely.
- Loopback probe bodies are never read. The response body is cancelled and released —
  the headers already answered. (This overturns an earlier decision to read and discard
  a capped body.)
- Cursor is reported as installed without being run: its launcher starts an interpreter.

### R6. What "Technical" became

There is no Technical detail level. There are two surfaces, the Book and the Desk, and
two detail levels inside the Book. Settings written before 2026-09-06 with
`detail: 'technical'` are read as "open the Desk"; the `Detail` type still carries the
value so old state loads.

# Appendix: picks recorded by the 2026-09-06 evening builds (sizing, landing)

# Interface scale as root zoom — open questions (muse/sizing, 2026-09-07)

Unsettled points from the sizing task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. What `100vh`/`100dvh`/`100vw` do under `html { zoom: var(--dm-ui-scale) }`

- Observed empirically with headless Chromium (standalone probe page, viewport
  1280x800, scales 0.9 / 1.0 / 1.3; the full app suite could not run — see 8):
  viewport units resolve against the *unzoomed* viewport and then get zoomed
  with the layout. With `.app { height: 100dvh }`, the app box measured
  720 / 800 / 1040 device px at scales 0.9 / 1.0 / 1.3, so at 1.3 the document
  was 1040px tall in an 800px viewport — a page-level vertical scrollbar.
  With `.app { height: calc(100dvh / var(--dm-ui-scale)) }` the app box stayed
  exactly 800 at all three scales (document scrollHeight == innerHeight, no
  page scrollbar), while the top bar measured 41.39 / 46 / 59.8px — i.e. boxes
  grow with the scale (59.8/46 = 1.3). Computed `font-size` does not change
  under zoom, which is why the smoke test now measures box heights.
- Pick: keep `html { zoom: var(--dm-ui-scale) }` and divide exactly the rules
  that size against the viewport: `.app` height, `.dialog` max-width/max-height
  (plus its 600px responsive max-width), `.error-bar`/`.feedback` max-width
  (plus their responsive max-width). Native `<dialog>` modals still covered
  the viewport in the probe at all three scales in both variants. The top bar
  stays at the top (flex column, `flex: none`).

## 2. When nothing is saved and the person is both Guided and on the Desk

- Options: (a) Desk wins (0.95); (b) Guided wins (1.1).
- Pick: (a). `App.tsx` computes `interfaceScale ?? (surface === 'desk' ? 0.95
  : detail === 'guided' ? 1.1 : 1)`. Rationale: on the Desk the binding
  constraint is fitting threads/helpers/changes on one screen; a Guided person
  on the Desk still gets the reading/code text multipliers untouched. The
  `Settings.tsx` slider uses the same formula for its displayed value.

## 3. Settings slider option labels for the new effective values

- Options: (a) add 0.95/1.1 options; (b) keep only 1/1.12/1.24 so an effective
  1.1/0.95 shows blank until touched.
- Pick: (a). Interface size now offers Smaller (0.95, marked default on Desk),
  Default (1), Guided (1.1, marked default when Guided), Larger (1.12),
  Largest (1.24). Reading/Code keep Default/Larger/Largest. Once the person
  picks anything, the saved number wins everywhere (even picking Default (1)
  on Guided pins 1 instead of the 1.1 default).

## 4. 13px Desk labels vs the never-below-14 floor

- Options: (a) raise `.desk-side-header h2` / `.desk-side-sub` 13px to 14px;
  (b) leave at 13px without the multiplier.
- Pick: (b). They are Desk-only eyebrow labels, not covered by the Book layout
  check, and raising them would change the Desk's visual character beyond the
  brief. Everything that was 15px ui-scale is now a flat 14px.

## 5. Responsive sizes that mirrored a changed desktop value

- Options: (a) leave every media-query fixed size alone; (b) move the ones
  that are clearly the same part (top-bar 52->46 incl. brand-button/top-right
  heights, project-tabs 44->40, project-tab 42->38, rail/rail-link 44->40,
  task header 44->40, task-card 130->120, dialog/error-bar viewport calcs).
- Pick: (b). Page-header mobile padding, setup margins and other
  context-specific values were left alone. The 21px responsive headings
  (page-header h1, dialog-heading h2) became 19px and the 24px responsive
  setup h1 became 22px, following their desktop 22->20 / 28->24 moves.

## 6. Reading-face rules that moved with prose

- Options: (a) only the table rows (prose 16/1.6, prose.small 15);
  (b) also the rules that are the same reading rhythm.
- Pick: (b). `.turn.you` 17->16, composer textarea 17->16 (68px box, tighter
  padding), `.notice .prose` and `.capability` 15.5->15. Markdown document
  headings (24/28/17 read-scale), desk turn text (16) and the home
  section-title (19) were left alone as document/desk-specific.

## 7. Desktop smoke evidence key

- The `sizes()` helper now records `getBoundingClientRect().height` for body,
  `.task-title`, `.task-card .button`, `.caption`, and the 1.24 ratio assertion
  is unchanged. The old exact assertions (`body 16`, `task-title 18`) became
  computed-font checks for the new defaults (`body 15`, `task-title 17`).
  The `fontSizes: { before, after }` evidence field was left named as-is to
  stay inside the allowed edit area; its values are now box heights, not font
  sizes.

## 8. Verification status (blocker, not a code question)

- `tsc --noEmit` is clean (exit 0). The UI suite could not run in this
  worktree: vite fails to transform `client/main.tsx` with
  `Cannot find package '@babel/core' imported from
  .../node_modules/@vitejs/plugin-react/dist/index.js`. Installed
  `@vitejs/plugin-react` is 5.2.0, which requires `@babel/core ^7.29.0`, but
  `node_modules/@babel` does not exist in the shared tree (junction target
  `F:/Achilles/diomedes/node_modules`); installed Playwright browsers are
  1228 (matching @playwright/test 1.55) while node_modules now holds
  playwright 1.63.0 (which wants headless_shell-1243). Both pre-date this
  change — the failure happens before any app code loads (no Continue button
  renders) — and `npm install` is forbidden in this worktree, so the full
  Home/Tasks/Settings/Desk scrollbar sweep, modal coverage check and the two
  new assertions have not been executed here. The zoom/viewport behaviour in
  (1) was verified with a standalone Chromium probe instead.

# Verified helper (muse/verified-model, 2026-09-07)

The Astra finding: a saved conversation showed the helper answering "GPT-5.2 Codex"
when asked its name. The runtime is Codex CLI 0.153.4 over app-server with a ChatGPT
account, default `gpt-6-astra`, and no GPT-5.2 among its models. The claim came from the
helper's prose. The app kept only `askCodex()`'s `.text`, so nothing recorded which
engine actually answered.

## Which schema field the runtime engine came from

The `thread/start` response's `model` field on the started thread — the value the
existing adapter already read (`started.model`) and the protocol fakes mirror
(`model: 'native-model'`, `model: 'fake-model'`). When `turn/completed` carries
`turn.model` it overrides, since that is the turn that produced the text. `version`
comes from `initialize` (the `userAgent` check against `CODEX_PROTOCOL_VERSION`).
The pinned schema dir (`evidence/codex-app-server-0.153.4/`) holds only
`ListMcpServerStatusResponse.json` plus the README, so there is no pinned
`ThreadStart`/`TurnCompleted` schema to cite beyond the live binary's behaviour;
`verified` is true only for these runtime fields, never for anything parsed from text.

## Picks

- Every run passes an explicit selection: `askCodex({ model })` rides in the
  `thread/start` config (never in prompt text, so the answer cannot rename its own
  engine), defaulted from `settings.services.codexModel` when present, else the
  runtime default. The setting is a name, not a switch, so `validateSettings`
  accepts a ≤120-character string for that one key.
- Every turn stores `helper: { engine, model, version, verified }`; every session
  engine carries `version`/`verified` beside its existing fields. Sample work is
  deterministic, so its helper is `{ engine: 'sample', model: null, verified: true }`.
- A Plan History sentence names the verified helper when present —
  `Diomedes, with Codex gpt-6-astra, wrote <plan>` — and falls back to
  `Diomedes wrote <plan>` when the runtime reported nothing.
- Captions show the verified value only: `Codex, gpt-6-astra` when verified. The
  Book never uses the word "model" (a UI test bans it), so an unreported Book
  helper reads `Codex, name not reported`; the Desk header from a live session
  reads `Codex, model not reported`. Turns written before this change have no
  `helper` and show no caption rather than a guessed one.
- Work turns are created unverified and marked verified by the native worker once
  the runtime reports; the session engine is set in the same locked step.

# Projects landing — open questions (muse/landing, 2026-09-07)

Unsettled points from the landing task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. One-column width: reuse Home rules or add a landing class?

- Options: (a) give the wrapper `book-layout home` so the existing Home column
  rules apply; (b) add a `landing` class with duplicated caps.
- Pick: (a). The wrapper is `book-layout home`, so the 760px cap (880px at
  ≥1550px) and the hidden margin come from the existing Home rules. The appended
  Landing CSS only styles the ask box row.

## 2. Where does the landing ask state and send handler live?

- Options: (a) `useState` hooks at the top of `App` plus a small `sendLandingAsk`
  handler in the component body, kept out of the scale effect; (b) everything
  inline in the JSX.
- Pick: (a). `landingText` / `landingProjectId` sit with the other `useState`
  hooks, and `sendLandingAsk(text, project)` sits just above `const current`,
  with a comment noting it belongs to the projects-page block below. Hooks cannot
  live inside the JSX ternary, and the scale effect is untouched.

## 3. What orders the picker and the rows?

- Options: (a) picker by last opened (`lastOpenedAt || createdAt`, newest first),
  rows by `needsYou` first then last opened; (b) picker and rows both follow
  `settings.openProjects` order.
- Pick: (a), per the task. The select defaults to the newest by that key via
  `landingProjectId ?? sorted[0]?.id`; rows use the needs-first comparator and
  keep the existing row markup, status text and marks.

## 4. How is "none is the sample" detected?

- Options: (a) a flag on `Project`; (b) a name match, since the server creates
  the sample as "Harbor Street restaurants" and `shared/types.ts` is frozen.
- Pick: (b). The caption button hides when any project name includes
  "harbor street" (case-insensitive). If the sample is ever renamed or flagged,
  this one line changes.

## 5. Landing placeholder variants?

- Options: (a) one fixed placeholder; (b) vary by `settings.onboarding.work`.
- Pick: (b), exactly as specified: business "Ask about a supplier, plan a
  schedule, or say what to do"; school "Ask about a reading, plan the week, or
  say what to do"; software "Ask about the code, plan a change, or say what to
  do"; personal "Ask a question, plan something, or say what to do"; mix and
  undefined fall back to "Ask, plan, or say what to do". The textarea keeps a
  constant `aria-label` so tests do not depend on the variant.

## 6. Closing caption in the empty state?

- Options: (a) caption only when projects exist; (b) caption in both states.
- Pick: (b). Both states end with "Projects are ordinary folders on this
  computer." The "Try the sample project." text-button is appended on the same
  line only when projects exist and none matches the sample.

## 7. Carried draft: key format and who clears it?

- Options: (a) a new `askDraftKey(projectId)` helper returning
  `diomedes.ask-draft.${projectId}`, read once by the composer initializer which
  removes it; (b) reuse the document-draft keys.
- Pick: (a) in `components.tsx`. `Workspace` initialises `prompt` from
  `localStorage.getItem(askDraftKey(projectId)) ?? ''` inside try/catch and
  removes the key right after reading. `mode` initialises to `ask` with an
  explicit check for a carried draft (it runs before the prompt initializer
  consumes the key), so a carried draft always lands in Ask.

## 8. `HelperLine` props and matching Home behaviour?

- Options: (a) `(integrations, settings, saveSettings)` with the exact Home
  markup, classes and three sentences; (b) a slimmer landing-only line.
- Pick: (a) in `components.tsx`. Same `caption helper-line` / `text-button`
  classes, same "is on" / "signed in but turned off" / "Sample work, on this
  computer" sentences, first ready non-sample engine in roster order. Both Home
  (via `Workspace`) and the landing page render this component, so the Home test
  looking for `.helper-line` containing "Sample work" stays green.

## 9. Empty-state test without a fresh data dir?

- Options: (a) spin up a fresh data dir; (b) skip with a reason, since this spec
  has no fresh-dir helper and projects cannot be deleted via the API.
- Pick: (b). The new UI test covers the sample-present path end to end (ask box
  visible, select defaults to last opened, Send carries "Which suppliers are
  late?" into the Workspace Ask box with the rail Ask entry active) and states
  in a comment why the no-projects cards are not asserted in this run.

# Usage bar — open questions (muse/usage, 2026-09-07)

Unsettled points from slice U1, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. The pinned evidence has no rate-limit schema

- The spec says to read `evidence/codex-app-server-0.153.4/` for the exact
  field names (`GetAccountRateLimitsResponse`, `RateLimitSnapshot`,
  `RateLimitWindow`, `ThreadTokenUsageUpdatedNotification`,
  `TokenUsageBreakdown`). That folder holds only `README.md` and
  `ListMcpServerStatusResponse.json` — none of those five types appear
  anywhere in the tree.
- Options: (a) block U1 on a fresh schema dump from the pinned binary;
  (b) map defensively from the spec's field names (`primary`/`secondary`
  with `usedPercent`, `windowDurationMins`, `resetsAt`; `planType`;
  `credits`; `last`/`total` breakdowns with `inputTokens`,
  `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`,
  `totalTokens`; `modelContextWindow`), accepting both a bare snapshot and
  a `{ rateLimits }`-wrapped one, and mapping unknown shapes to empty
  windows rather than guessed numbers.
- Pick: (b). The mappers live in `server/usage.ts`
  (`windowsFromRateLimits`, `meterFromTokenUsage`) with unit tests over
  spec-shaped fakes. If the real `account/rateLimits/read` shape differs,
  only those two functions change.

## 2. What "tightest window" means

- Options: (a) highest percent used; (b) soonest reset.
- Pick: (a). The chip, the Desk pane bar and the roster chips all show the
  window with the highest `usedPercent`. The spec's chip example names one
  window, so either reading fits it; highest-used is the one closest to
  empty, which is what the bar warns about.

## 3. Window labels and reset times from raw fields

- Options: (a) label from `windowDurationMins` (300 → "5 hours",
  10080 → "week", with generic minute/hour/day fallbacks) and `resetsAt`
  normalised from unix seconds or ISO strings to ISO; (b) show raw values.
- Pick: (a), in `server/usage.ts`. An explicit `label` string from the
  engine wins when present. Unknown durations fall back to
  "Primary window" / "Secondary window", never a guessed quota.

## 4. A failed allowance read must not fail the status check

- Options: (a) let `account/rateLimits/read` errors flow into
  `codexStatus()` like any other check; (b) fence the read in its own
  try/catch so the last snapshot stands and the check outcome is unchanged.
- Pick: (b). The allowance is advisory. This also keeps the existing
  integration tests green: their fake native client rejects the unknown
  method, which is swallowed exactly like a real read failure.

## 5. How the filler reaches the usage service

- Options: (a) `createApp` builds the service and passes it into a fresh
  `createIntegrations`; (b) a shared `usageService` singleton in
  `server/usage.ts` is the default `usage` dependency, replaceable through
  `createIntegrations` overrides like `fetch` and `discovery`.
- Pick: (b). `server/app.ts` stays within its allowance (route plus SSE
  broadcast) because it imports the same singleton; tests inject fakes
  through overrides.

## 6. Test-mode fake: seeded snapshot plus `GET /api/usage?fake=1`

- Options: (a) `?fake=1` only; (b) preseed the shared service when
  `DIOMEDES_TEST_MODE=1` *and* offer `?fake=1` to reseed deterministically.
- Pick: (b). The client fetches plain `/api/usage`, so preseeding at
  `server/usage.ts` import time is what makes the chip and Settings bars
  appear with no client test hooks. `?fake=1` reseeds and returns the fixed
  Codex snapshot (62 and 91 percent); outside test mode it is 404.
  Test-mode seeding lives in `server/usage.ts`, not `server/app.ts`, to
  keep the app edit to route plus broadcast.

## 7. The chip shows last-reported windows for an unreachable engine

- Options: (a) require the engine to be `available` as well as switched on;
  (b) show whenever the switch is on and windows were reported.
- Pick: (b). The spec hides the chip "when no engine is on or no window is
  reported" — availability is not in that sentence, and the helpers list
  already carries the live status. In the UI suite Codex is switched on but
  its binary is absent, so (a) would make the chip untestable there.

## 8. Workspace carries a `usage` prop after all

- The spec allows Workspace to stay untouched unless the chip needs a
  prop passed through. The chip lives in `App.tsx`, but `App.tsx` is told
  to pass `usage` to Workspace, Desk and Settings alike.
- Pick: pass it everywhere, and put it to real use in Workspace: the
  composer route line shows the selected service's tightest bar and percent
  (nothing renders for sample work, which reports no allowance). Copy was
  checked against the banned-words list.

## 9. Clicking the chip opens Settings at the helpers section

- Options: (a) just open Settings wherever it was; (b) raise a signal that
  moves Settings to "Helpers on this computer" (Book) or "Engines" (Desk).
- Pick: (b) via an `openHelpersSignal` counter prop. No existing Settings
  behaviour changed.

## 10. Cost stays null on turn notifications

- The turn notification carries no cost field in the spec; per-thread cost
  comes from `account/usage/read`, which U1 does not call.
- Pick: `meterFromTokenUsage` records `costUsd: null` unless the payload
  states a cost outright. The Settings meter line omits the price when it
  is null.

# Modes (muse/modes)

Unsettled points from slice 1, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. The `work` alias

- Options: (a) reject `work` outright; (b) accept `work` as an alias for `build`.
- Pick: (b). `modeOf()` maps `work` to `build` on `POST /ask`, `POST /threads`
  and `PUT /threads/:threadId`, and `migrateConversation` maps stored
  `turn.mode === 'work'` to `'build'`. The alias goes after one release.

## 2. Thread mode default

- Options: (a) leave new threads without a mode; (b) default to `ask`.
- Pick: (b). `POST /threads` defaults to `ask`; migration fills a missing
  `Conversation.mode` from the last turn's mode, else `ask`. Every `/ask`
  sets the thread's mode to the mode actually used.

## 3. Per-mode harness values

- The spec fixes effort, output, writes, consent and `maxAttempts`; no
  alternative was considered. Ask is low/text/none/sending-setting, Plan is
  medium/plan/plan/sending-setting, Build is medium/proposal/proposal/always,
  Fix is Build plus `maxAttempts` 3.

## 4. Instruction wording

- Options: (a) copy Codex-facing sentences from existing prompts; (b) write
  short plain-English instructions under 900 characters.
- Pick: (b). Ask answers only from supplied documents, names the document
  each fact came from and proposes no changes. Plan carries today's
  "practical Markdown plan, numbered actionable steps" prefix so the
  person's text is sent unchanged. Build limits proposals to the selected
  documents, at most eight files, each explained. Fix adds: something
  specific is failing, change as little as possible, improve nothing else,
  say what changed and why it fixes the failure. The STRICT JSON contract
  stays in `native-work.ts` untouched.

## 5. `askCodex` defaults

- Options: (a) require instructions/effort on every call; (b) keep today's
  values as defaults.
- Pick: (b). `instructions` replaces `baseInstructions` only on non-team
  runs when non-empty; team runs keep their team text. `effort` defaults
  to `low` on `turn/start`, including team runs.

## 6. Native work mode

- Options: (a) separate Build/Fix services; (b) one service with a mode.
- Pick: (b). `start()` accepts `mode: 'build' | 'fix'` defaulting to
  `build`; `prepare()` looks up `MODES[mode]` for instructions and effort.

## 7. Fix binding shape

- Options: (a) free-form failing text; (b) bound document and/or text.
- Pick: (b). `failing: { document?, text? }` needs at least one field;
  `document` must be one of the request's sources, `text` at most 4000
  characters, else 400 "Say what is failing: pick the document or paste
  what went wrong." The run instruction is the person's text plus a
  `Failing:` block naming the document and/or quoting the pasted text as
  untrusted material; the failing text never enters `baseInstructions`.

## 8. Attempt counting

- Options: (a) server-side retry loop; (b) count and stop, the person is
  the check.
- Pick: (b). Attempt is the thread's prior helper Fix turns plus one; over
  3 answers 409 "Three tries have not fixed this. Start a new thread, or
  make a plan first." Both turns carry `attempt: { n, of }`. Nothing
  re-runs automatically. A named-check registry comes with Fix v1.

## 9. Sample Fix text

- Options: (a) reuse the sample work sentence; (b) label the fix.
- Pick: (b). Sample Build keeps "Started clearly labelled sample work. No
  AI service is involved." Sample Fix returns "Started a clearly labelled
  sample fix. No AI service is involved."

## 10. Composer placeholders and captions

- The four Book captions are the spec sentences verbatim. Placeholders:
  Book Ask "Ask a question about this project...", Plan "What should the
  plan cover?...", Build "What should be done?...", Fix "What should be
  fixed?..."; Desk Ask "Ask or think out loud...", Plan "What should the
  plan cover?", Build "What should be done?", Fix "What should be fixed?"
- Pick: these exact strings; all avoid the banned-words list and use
  sentence case.

## 11. Fix row sources

- Options: (a) pick from every project document; (b) pick from the
  request's sources.
- Pick: (b). The Book select lists the attached document plus "Not a
  document"; the Desk lists the thread's prior turn sources plus "Not a
  document" and sends the chosen document as its source. Send stays
  disabled until a document or pasted text is present, with "Pick the
  document or paste what went wrong to send."

## 12. Chip text and placement

- Options: (a) mode only; (b) mode plus try count for Fix.
- Pick: (b). `ModeChip({ mode, attempt })` renders "Ask"/"Plan"/"Build"/
  "Fix" and "Fix, try 2 of 3" when an attempt is present. Shown on every
  turn in the Book thread and Desk pane, on the Desk pane header next to
  the helper name, and on the Book's thread rows (recent and page lists).

## 13. Work page and Home intent

- The Book's Work page keeps its name and hosts Build and Fix results.
  Home "Get something done" sets mode `build` and opens the Work page.
  The empty Ask thread says "switch the box below to Build." No new words
  were added to the top bar.

## 14. Two efforts met in the merge, and which one wins

- The modes slice and the engine-choice work each added `effort` to the
  Codex adapter, meaning different things: a mode's turn effort (Ask low,
  the rest medium, sent as `turn/start` effort) and the reasoning level a
  person picks for a thread from the model's own ladder (sent as
  `model_reasoning_effort` in the thread config). Both call sites read the
  same `input.effort`, so leaving two fields would have let the two
  channels disagree, and a mode's medium would have silently overruled a
  deliberate Astra "ultra" on every run.
- Options: (a) keep both fields and let each write its own channel;
  (b) one resolved value, the mode supplying the default and the person's
  explicit choice outranking it.
- Pick: (b). The adapter takes one `effort` string, so both channels
  always carry the same value. Callers resolve it as
  `thread choice ?? mode default` in `server/app.ts` (Ask and Plan) and
  `server/native-work.ts` (Build and Fix). The type is a string rather
  than the mode's `'low' | 'medium'`, because a ladder can reach past
  'high' and Astra reaches 'ultra'. A team run still keeps the low effort
  it was proven with.
- Not settled: whether a mode should be able to cap a choice (a person on
  "ultra" still gets "ultra" for a Fix). Owner's call.

## 15. The two surfaces are the Workbook and the Console

- The Book and the Desk were renamed on the owner's decision. Notebook was
  considered and set aside so the word stays free for the scratch surface
  that is not a project; Notes was the runner-up.
- Stored values change with them, so `Settings.surface` is now
  `'workbook' | 'console'`. Old settings are read forever: `migrateSettings`
  maps `book`, `desk` and the long-retired `technical` onto the new pair,
  and the settings route accepts the old spellings from an older client
  while only ever writing the new one. Without that, anyone already running
  Diomedes would open on a surface they did not choose.
- The rename went all the way through - component, file, CSS classes and
  copy - rather than stopping at the visible strings, so the code does not
  say Desk while the product says Console.
- This log keeps its older entries as they were written. They describe what
  was decided at the time, under the names in use then.
