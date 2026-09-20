# Diomedes

Diomedes is a Windows desktop application for working on a project with an AI helper
without giving it the run of your computer. It keeps the project's documents, plans,
tasks, conversations, approvals and file history in one place. A helper can propose a
change; Diomedes shows the exact before and after and writes nothing until you say go
ahead. Every write is recorded and reversible.

Diomedes has no model of its own. It drives an AI tool you already installed and signed
in to, through an adapter. Your account, your allowance, your bill.

It runs on this computer, and there is no telemetry. An optional account sign-in exists
in source and needs configuration before it is available at all; personal use works
without it, without signing in and without network access
(`docs/implementation/2026-09-20-native-workspace-sign-in.md`). What a task sends leaves
through the AI tool you signed in to.

Diomedes Systems (LLC formation pending). This source tree is Diomedes 0.1.5;
`package.json` holds that number and `tests/engine-routes.test.ts` fails if this file
disagrees with it.

## Three states, and which one a sentence means

Every capability named below is in one of three states, and this file says which:

- **In source** — the code is in this tree and its tests pass here.
- **Packaged** — that code is inside a published build, so it is in the executable a
  person actually runs.
- **Verified on a clean machine** — that exact build was installed and used on a machine
  other than the one it was built on.

None of the three implies the next. A capability can be in source and not packaged, or
packaged and never used anywhere but here. Where this file does not say, assume only the
first.

## Install and use the published Windows build

Windows 11 x64. No Node, npm, Git or developer tool is needed for this path.

1. From https://github.com/andrewgodowsky-aoa/diomedes/releases, download
   `Diomedes-Experimental-<version>-unsigned-setup.exe` and `SHA256SUMS.txt`.
2. Check the file before running it. In PowerShell, in the download folder:
   `Get-FileHash .\Diomedes-Experimental-*-unsigned-setup.exe -Algorithm SHA256`, and
   compare the result with the matching line in `SHA256SUMS.txt`.
3. Run the installer and open **Diomedes** from the Start menu. It installs for the
   current user only: no administrator rights and no automatic launch.
   Uninstalling removes its own files, its two current-user registry keys and its
   shortcut; your projects and history stay where they are.

The installer is **unsigned**. A matching SHA-256 proves the bytes are the ones
published with that checksum; it does not prove who built them. Windows may warn about
an unknown publisher, and some antivirus products flag new unsigned programs on
reputation alone. Never turn off Windows protection to install it: if a file is
quarantined, check its SHA-256 against `SHA256SUMS.txt` and download it again instead of
making an exception. Code signing is tracked in `docs/releases/CODE_SIGNING.md`.

The application can check that same releases page for a newer stable Windows per-user
installer. There is no other remote service of its own.

A portable archive is published beside the installer. Extract the whole folder and run
`Diomedes.exe` from inside it; the bare executable is not the application.

## The AI routes Diomedes can drive

You install the tool and sign in to it yourself; Diomedes uses that installation and
that sign-in. Five adapters are **in source**, each accepting exactly one account route.
Holding a different account with the same tool is a different situation from being
signed out. The contract for saying so is in `shared/engines.ts` (`AccountRouteIssue`);
at this commit an adapter still reports an unsupported account as signed out, which is
one of the things this repair is for.

| Tool | Account route the adapter accepts | What a task through it can do | Reviewed version |
| --- | --- | --- | --- |
| Claude Code | Claude subscription, signed in to Claude Code | Text and reviewed proposals. Tools, MCP and slash commands are off. | 2.1.252 |
| OpenCode | OpenCode Go | Text and reviewed proposals. Tools, plugins and MCP are off. | 1.18.4 |
| oh-my-pi | OpenAI API key, in a separate oh-my-pi profile | Text and reviewed proposals. Tools, extensions and skills are off. | 18.0.6 |
| Cursor | Cursor account, signed in through the Cursor CLI | Text and reviewed proposals. Ask mode. A tool event stops the request. | 2026.08.11 |
| Devin | Devin account, signed in through its browser flow | Text and reviewed proposals. Ask mode. A tool event stops the request. | 3000.10.23 |

These are text routes. The tool answers with text and Diomedes's own writer turns that
text into a proposal you approve or reject. None of them is that tool's own coding
experience: its tools are disabled or denied, and a tool event stops the request instead
of running it. These are configuration controls, not an operating-system sandbox. The
table above repeats `shared/engine-routes.ts`, which is written for the settings screen
to render; at this commit nothing reads it yet.

The same rows, each with the three states above, are generated into
`docs/reference/capability-record.json` by `scripts/write-capability-record.ts`. That file
is the one place these facts are collected, and it is what another repository copies
instead of retyping this table.

**Found is not usable.** Checking this computer ends in one of these, and the difference
is the whole point of the list:

- **Not checked** — nothing has been looked for yet. Discovery runs only when you ask.
- **Not installed** — no installation of that tool was found.
- **Compatibility check needed** — an installation was found and its version is not the
  reviewed one above. The adapter refuses rather than guessing.
- **Sign in required** — found, reviewed version, and the tool reports no account.
- **Ready** — found, reviewed version, signed in, at least one model offered, and
  checked within the last five minutes.

Only **Ready** can send a request, and the same checks run again when one is dispatched.

**What is reused and what is not.** Diomedes reuses the installation you have and the
sign-in that tool already holds, in the place that tool keeps it. It does not carry over
your plugins, MCP servers, instruction files or custom configuration: each route runs in
its own directory with configuration Diomedes wrote. A launched tool receives a short
allowlist of environment variables (`server/engines/process.ts`), so provider keys,
proxy settings and other custom variables do not reach it. The per-route lists are in
`shared/engine-routes.ts`.

**Signing in** happens in the tool, never in Diomedes. Claude Code, OpenCode and Cursor
open their own sign-in in a console window; Devin opens its browser flow; oh-my-pi opens
the separate profile folder where you write an OpenAI API key yourself, which Diomedes
does not read.

**Billing** falls on the account each route is signed in to. Diomedes never substitutes
a provider or a model, and it cannot see what an account has left unless the provider
reports it. The OpenCode route is pinned to OpenCode Go; OpenCode documents an
account-side "Use balance" setting that can continue usage from Zen balance once Go
limits are reached, so that pin alone does not decide what you are charged. The
oh-my-pi route spends an OpenAI API key, which is API billing and not a ChatGPT
subscription.

**Guided installation** is offered for Claude Code, OpenCode and oh-my-pi: Diomedes
downloads one pinned official release into its own folder, checks its SHA-256 before
anything runs it, and installs for the current user only, with no elevation and no PATH
change. It never overwrites, downgrades or removes an installation you already have.
Cursor and Devin are installed by their own installers.

Discovery itself looks for a program on PATH and in a few known folders, runs
`--version` on it one at a time, and probes two loopback addresses. It never starts a
service, never sends a model turn and never reads a credential file. Probe output is
capped, never evaluated and never logged raw.

## Proposals, approval and recovery

A helper's answer becomes a proposal. Each decision binds the displayed proposal, the
exact output bytes and the selected source revisions, and the host saves an immutable
decision receipt before writing. A lost response or an identical retry returns that same
decision; a restart reconciles prepared writes and marks an accepted decision with no
prepared write as not applied. Native proposals expire after an hour. An exact proposal
never grants permission for a whole task.

Task starts save a command identity before sending, so a lost response finds the
original session instead of starting a second one. A host restart keeps the receipt and
marks interrupted work stopped; it does not repeat a model call or apply a pending
proposal on its own.

The records behind those rules are the
[Work foundation record](docs/implementation/2026-09-08-work-admission.md), the
[approval continuation record](docs/implementation/2026-09-08-approval-receipts.md) and
[the runtime report](docs/harness/RUNTIME_VERIFICATION.md), which is also where the
native harness runtime's current verified state is kept rather than restated here.

## Two surfaces over one project

There is one model underneath and two ways to see it. Switch in the top-right menu or
in Settings > Interface. The Workbook is frozen: it takes no new screens and is being
ported into the Console page by page.

**The Workbook** shows one page at a time: Home, Ask, Plan, Work, Review, Tasks, Documents
and History, with a rail down the left. It has two detail levels, Guided and Standard.
Guided explains more and hides helpers Diomedes cannot actually run. Home is a single
column: "What do you want to do?" with four intents (Ask a question, Get something
done, Make a plan, Look over what changed), a line saying whether a helper is switched
on, recent threads, and "Changed today" grouped one row per task.

**The Console** shows everything at once: the project, its threads and the team roster on
the left; up to three panes in the middle, one per thread, each with its helper, its
permission mode and its messages; Board, Changes and Files on the right.

"Technical" is no longer a detail level. Settings written before 2026-09-06 that say
`detail: 'technical'` are read as "open the Console".

The three first-run questions pick the starting point: *I'm new to this* opens the
Guided Workbook, *I've used tools like this* the Standard Workbook, *I work with these tools every
day* the Console.

## Threads and permission

A thread is a named conversation that belongs to a project and, optionally, to a task.
The Workbook shows the threads of the page it is on; the Console shows all of them. Threads
can be renamed, and a thread started with a document attached belongs to that document.

Each thread has a permission mode:

- **Show me first** — every proposed change waits for your OK. This is the default, and
  the fallback whenever the mode is missing.
- **Go ahead for this task** — the first OK inside a task covers the rest of that task.

There is no "full access" mode. Nothing runs before the first OK, and a proposal is
only ever applied to the exact files and text shown in it.

## The team

A team is a leader and some members working on one project, each in its own thread,
talking to each other through Diomedes rather than through each other's tool settings.
The team service lives in `server/team/` and is Diomedes' own code; the tool names and
mailbox semantics follow iOfficeAI/AionCore v0.2.1 `crates/aionui-team` (Apache-2.0) and
are reimplemented here. No AionCore or AionUi process is installed, linked or launched.

How it works:

- Diomedes serves an MCP endpoint on loopback at `POST /mcp/team/:projectId`. Non-
  loopback connections are refused. Each member authenticates with its own bearer token
  and an `X-Slot-Id` header; the token is issued once, when the member is added.
- Thirteen tools are exposed: `team_members`, `team_send_message`, `team_read_messages`,
  `team_task_create`, `team_task_update`, `team_task_list`, `team_list_assistants`,
  `team_describe_assistant`, `team_spawn_agent`, `team_rename_agent`,
  `team_interrupt_agent`, `team_shutdown_agent`, `team_clear_agent_context`.
- The board is the Diomedes task list. There is no second, hidden list: a task a member
  creates is a task you can see on Tasks and on the Console's Board, attributed to the
  member that made it.
- The mailbox is Diomedes'. A message addressed to a member is delivered by Diomedes,
  counted as unread on the roster, and rendered into the wake text as
  `From <sender>: <content>`.
- **A member wakes on its mail.** When the owner or another member sends to an idle
  member, Diomedes starts that member's run itself. Automatic wakes are capped at five
  per member per ten minutes; going over that parks the member as waiting and records a
  History entry instead. The Console also has an explicit Start for a member with waiting
  mail, which works regardless of the cap.
- A run is a normal Diomedes Work run. It cannot write files. Anything it proposes
  arrives as a proposal that waits for your approval, and the member's role instructions
  tell it to describe changes as proposals and not to mark a task done while an approval
  is open.

What is *not* proven or not there:

- The team's tool inventory is the model's own report, not a protocol-level guarantee
  that the host exposes nothing else. There is no pre-execution veto: Diomedes rejects a
  foreign tool result when it is reported, which detects a violation after the fact. See
  `QUESTIONS.md`.
- A member can be added on several engines, but starting one returns "This helper cannot
  run here yet" unless it is the earlier Codex route (`server/app.ts`). The five adapters
  above are not wired into a team run.
- `team_spawn_agent`, `team_describe_assistant` and `team_clear_agent_context` are
  registered and answer "not available in this version"; `team_list_assistants` returns
  an empty list. Diomedes never spawns a process for a helper — you add a member
  yourself, on the Console.
- The model's own report lands in the session log for that run, not as a turn in the
  thread. The thread turn says a message from the team was picked up.
- There is no steering a run in flight, no branching a thread, and no handing a thread
  from one helper to another.
- One run at a time per project. A second start returns "This project already has work
  in progress."

The recorded team evidence is `evidence/codex-team-real-binary-2026-09-06.md`, taken on
that date against that pinned binary.

## Which helper answered

Every answer records which helper produced it, taken from the runtime's own report and
never from the answer text. The caption under a helper's turn shows that value. When the
runtime reported nothing the caption says so — "name not reported" in the Workbook,
"model not reported" on the Console — rather than guessing. Sample work is recorded as
sample work. A model pinned in Settings travels in the thread configuration, never in the
text. Turns written before 2026-09-07 carry no record and show no caption.

This exists because a saved conversation once showed the helper calling itself
"GPT-5.2 Codex" while the runtime reported a different model; the name had come from the
model's own prose.

## Usage

A helper that reports usage gets a bar: a chip in the top bar for the helper that is on,
with the tightest window and a bar that takes the signal colour past 80 percent and the
fault colour at 100; every window as a labelled bar with its reset time under that helper
in Settings; the same bar in each Console pane header and on each roster member. Clicking
the chip opens Settings at the helpers section.

Nothing calls an undocumented endpoint and no number is guessed. A helper that reports
nothing gets one plain sentence instead, which is what the five adapter routes above do
today: their remaining allowance is not reported to Diomedes.

## First use

Answer the three setup questions, then create a project or choose **Open sample
project**, which writes three text documents into a new folder. No sample is created
during onboarding itself.

1. Open **Plan**, edit the document, save.
2. Choose **Make tasks from this plan**, review the proposed tasks, add them.
3. Start a task. **Sample work** is a scripted local demonstration, labelled as such
   throughout the interface. It calls no AI service, so it proves the application works
   and proves nothing about a provider.
4. Answer **Needs your OK**, then look at **Review**. Keep accepts the current file;
   Undo records and applies the previous contents.
5. Open **History** to inspect changes, save named versions, or restore. A restore is
   itself reversible, and newer content produces explicit conflict choices.

Changing how something is presented never grants a permission. Unsaved text is backed up
in this browser profile and recovered when you reopen the document.

## Run from source (development)

This section is for working on Diomedes, not for using it. Node 22.12 or later, on
Windows. From this directory:

```powershell
npm ci
npm run prepare-native
npm run dev
```

Open **http://127.0.0.1:5173**. The service listens only on **127.0.0.1:47631**. Ctrl+C
stops both processes. Nothing is added to startup, no tunnel is opened and no global
package is installed. `npm run prepare-native` belongs to the earlier Codex route: it
copies an already-installed matching Codex runtime into this application's data
directory and records its hashes. It does not change your installed Codex and does not
copy credentials.

For a single production listener, `npm run build` then `npm start`, and open
**http://127.0.0.1:47631**. Stop a development service before starting production on the
same port. `./Start-Diomedes.ps1` launches that listener in the background;
`./Stop-Diomedes.ps1` stops the recorded process and its children after checking the
process identity.

On this machine, Node needs the system certificate store for package downloads. If npm
reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, run with `NODE_USE_SYSTEM_CA=1`. Keep TLS
verification on. The build makes no external font requests.

### Build, test and package

```powershell
npm run check          # TypeScript across client, server, shared, scripts and tests
npm test               # vitest
npm run test:ui        # Playwright against installed Microsoft Edge
npm run package:desktop # alias of npm run build; postbuild packages the desktop app
npm run test:desktop   # smoke the packaged release/Diomedes-win32-x64/Diomedes.exe
```

`npm run build` type-checks, builds the client, and then packages the desktop
application through its `postbuild` step, always to the same
`release/Diomedes-win32-x64` path. When you finish a change, run the build and
`npm run test:desktop` so the release on disk is current and verified. Report the counts
from your own run; a historical total is not evidence about your commit.

Browser tests use the installed Microsoft Edge with isolated data directories and ports;
no browser is downloaded. These checks are separate because they spend real subscription
usage and are not part of `npm test`:

- `npm run verify:native-work` — a synthetic native Work integration check. It needs the
  native runtime and a signed-in account, creates only its own test project, verifies
  preview, approval, write, history and restore, and closes its own service.
- `node scripts/approval-desktop-smoke.mjs` — one real run through the packaged approval
  flow, using its own project and profile. Verifies a lost approval response, decision
  receipt, restart, replay and byte-exact restore.
- `npm run smoke:team-codex` — a real team session against a running Diomedes service.
  Set `DIOMEDES_API` to override the default `http://127.0.0.1:47631/api`.

`npm run probe:team` exercises the team MCP endpoint with a probe member and spends
nothing.

### Design authoring

Design authoring is off unless the service was started with `DIOMEDES_DESIGN_AUTHORING=1`
in its environment. It is read once, at launch (`server/customization-gate.ts`), and it
is deliberately not a setting: nothing inside the running application can turn it on, and
it grants authoring on the local scope only. The release's optional
`Start-Experimental.ps1` launcher sets it for an isolated evaluation profile with its own
data and projects folders.

## Where things are kept

- Desktop application state: `%APPDATA%\Diomedes\data`; new projects default to
  `Documents\Diomedes`.
- Browser prototype state: `.data/` in this directory. It is preserved and is *not*
  imported into the desktop application; the desktop starts with its own setup and
  project list.
- Overrides: `DIOMEDES_DATA_DIR`, `DIOMEDES_PROJECTS_DIR`, `DIOMEDES_PORT`,
  `DIOMEDES_CLIENT_PORT`.
- Unsaved document drafts: local storage for the loopback origin.

Projects are ordinary folders. Text and Markdown writes, task records and decisions are
persisted in an atomic per-project `state.json`; History keeps before/after content
objects and a durable pending-write journal separately. A restarted service reconciles
interrupted writes and marks active work stopped. Changes made by other applications are
detected when a file is read; intermediate external edits cannot be reconstructed.

Files must be valid UTF-8 text, no larger than 8 MB, and inside a registered project.
Credential paths, production LocalAI folders, path traversal and symbolic links or
junctions are rejected.

## What is not in it

- **A model of its own.** Diomedes ships adapters, not engines. Without an AI tool you
  installed and signed in to, only the labelled sample work runs.
- **Full native tool behaviour.** The five routes are text routes; their tools, plugins
  and MCP servers are off, and configuration controls are not an operating-system
  sandbox.
- **A signed installer.** The published installer is unsigned. A SHA-256 match checks
  bytes, not a publisher.
- **The team's limits** are listed under [The team](#the-team).
- **No local authentication on most of the API.** The team MCP routes check a bearer
  token and slot; the rest of the loopback API does not. Origin/Host checks and a
  required mutation header keep unrelated websites out, but any other process on this
  computer can reach it. This is a local prototype, not a remote or multi-user service.
- **Text only.** Word, Excel, PDF, images and binary diffs are not editable, and History
  keeps everything. There is no retention or archive policy yet, so nothing ages out and
  no setting claims otherwise.
- **No Git and no messages.** The application never commits, branches, pushes, or sends
  an email or message on your behalf.
- **Business plugins are a proposal, not code.** See
  `docs/research/2026-09-06-business-plugins/`.
- Keyboard and assistive-technology audits, Windows 150% scaling and text-spacing
  overrides are not verified.

## Where the record is

- `docs/implementation/` — one record per slice, with the evidence behind it. Start with
  the newest that names your area.
- `QUESTIONS.md` — what has been settled and what is still open.
- `docs/harness/RUNTIME_VERIFICATION.md` — what the runtime has actually been proven to
  do, as opposed to what exists in source.
- `evidence/` — dated verification records, including the release candidates and their
  installer proofs. A proof carries the machine it ran on; read that before reading it as
  a claim about anyone else's computer.
- `docs/releases/CODE_SIGNING.md` — the signing work that is still outstanding.
- `licenses/` — the bundled font licences. `reference/` — read-only copies of source
  documents used during the build.
