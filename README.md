# Diomedes

Diomedes is a Windows desktop application for working on a project with an AI helper
without giving it the run of your computer. It keeps the project's documents, plans,
tasks, conversations, approvals and file history in one place. A helper can propose a
change; Diomedes shows the exact before and after and writes nothing until you say go
ahead. Every write is recorded and reversible.

It runs entirely on this computer. There is no account, no server, no telemetry and no
remote service of its own. When you switch a helper on, that helper's own sign-in
(today, your existing ChatGPT sign-in for Codex) is what talks to the outside world.

Diomedes Systems LLC. Version 0.1.0, a working prototype.

## Work and approval recovery

Task Start in Workbook and Console now saves a command identity before sending it.
If a response is lost, the same request finds the original Work session instead of
starting another one. The receipt, session and admission History event are saved
together before the native helper is called. A host restart retains the receipt and
marks interrupted Work stopped; it does not silently repeat a model call or apply a
pending proposal.

Native proposals now expire after one hour. Each decision binds the displayed
proposal, exact output bytes and selected source revisions. The host saves an
immutable decision receipt before writing. A lost response or identical retry
returns that decision; restart reconciles prepared writes and explicitly marks an
accepted decision with no prepared write as not applied. Workbook and Console show
the expiry, recorded outcome and an expandable Decision record. Exact proposals
cannot grant permission for a whole task.

Work Start and approval decisions share command identity and conflict primitives.
Composer sends, team starts and authenticated actors remain later foundation work.
The older sample flow remains supported. See the
[Work foundation record](docs/implementation/2026-09-08-work-admission.md) and
[approval continuation record](docs/implementation/2026-09-08-approval-receipts.md)
for acceptance gates, limits and evidence.

## Native harness runtime

The native harness now has a per-project run store, a Session/Task/Need bridge,
read and cancellation routes, and durable events with a reconnect cursor. The
`format-report` capability reads shipped synthetic lines, formats a report and
waits for an exact approval before writing `Harness report.md` through the existing
document journal and History. Restart recovery preserves unanswered approvals and
reuses recorded writes without applying them twice.

The model adapter is scripted; a real provider adapter is the next implementation.
TypeScript and all 483 tests passed, including real host and child-process crash
recovery tests. This source change has not been packaged into the Windows executable.
See the [runtime report](docs/harness/RUNTIME_VERIFICATION.md) for API invocation,
verification evidence, migration notes and limitations.

## Two surfaces over one project

There is one model underneath and two ways to see it. Switch in the top-right menu or
in Settings > Interface.

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

Codex runs get the tool host turned on for the team server only: `features.code_mode_host`
is `true` for a team run and false everywhere else, `features.code_mode` stays false, and
the `diomedes_team` server entry carries `default_tools_approval_mode: 'approve'` so the
team's own tools do not each raise a per-call approval. Every other tool feature stays
off, the sandbox is read-only with no network, inherited MCP servers are disabled and
their disabled state is verified before a model turn is sent, and a thread refuses to
start if an inherited `diomedes_team` entry is present.

What has actually been proven, on the pinned Codex 0.153.4 binary and recorded in
`evidence/codex-team-real-binary-2026-09-06.md`: with that configuration the model can
call the team tools (roster, board, task creation), its own reported tool inventory
contains the thirteen team tools plus the host's internals and no shell or file tool,
and it could not read a project file or run a shell command. A member woken by the
owner's message read its mail, created and updated a board task, and reported back to
the leader.

What is *not* proven or not there:

- The tool inventory above is the model's own report, not a protocol-level guarantee
  that the host exposes nothing else. There is no pre-execution veto: Diomedes rejects a
  foreign tool result when it is reported, which detects a violation after the fact. See
  `QUESTIONS.md`.
- Only Codex members can run. Adding a member on any other engine is allowed, but
  starting it returns "This helper cannot run here yet."
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

## Helpers on this computer

Settings > **Helpers on this computer** (in the Workbook) or **Engines** (on the Console) lists
every engine Diomedes knows about, what it found, and what would be sent to it. Nothing
in that list is contacted until you switch it on.

Discovery runs **only when you ask** — when you open that Settings section or press
**Check connections**. It never runs at application start. It looks for a binary on
PATH and in a few known folders, runs `--version` on it, one probe at a time, and probes
two loopback addresses. It never starts a service, never sends a model turn and never
reads a credential file. Probe output is capped, never evaluated and never logged raw.
Before you have asked, the roster says "Not checked".

The roster, in order:

| Engine | What Diomedes does with it |
| --- | --- |
| Sample work | Deterministic local demonstration. No AI engine is called. |
| Codex (native ChatGPT) | The one working adapter. Ask, Plan, Build, Fix and team runs. |
| Claude Code, OpenCode, oh-my-pi | Found and reported. No adapter yet; Diomedes cannot run them. |
| Cursor | Reported as installed without being run (its launcher starts an interpreter). |
| Hermes | Loopback check on `http://127.0.0.1:8642/` only. |
| LocalAI supervisor | Observational `GET http://127.0.0.1:8080/localai/status` only. Availability and resident readiness are reported; nothing is started, loaded or generated. |
| Ollama | Binary and `http://127.0.0.1:11434/api/tags` check only. |
| AionCore | Not installed and not adopted. Listed so its absence is explicit. |

**Codex with native ChatGPT** is the only engine that does work. `npm run prepare-native`
copies an already-installed, matching Codex 0.153.4 runtime into this application's data
directory and records its hashes; it does not change the installed Codex application and
does not copy credentials. Your existing ChatGPT sign-in is required. The adapter proves
Windows write denial, disables inherited MCP entries and verifies that they are disabled,
selects no environments and no tools, and requires native account status. There is no
API-key fallback, no environment-tool access, no command execution and no provider
fallback.

Modes shape every send. Ask answers from the selected documents and changes nothing.
Plan writes a plan document for you to read before work begins. Build proposes changes
to the selected documents — at most eight files and 128 KB — which are applied only
after approval. Fix is a Build bound to one failing thing: pick the document or paste
what went wrong, and Diomedes changes as little as it can, up to three tries in a
thread. The mode belongs to the thread and is shown on every turn.

If another Codex version is on PATH, Diomedes says so and still uses its own proven copy.

## Which helper answered

Every answer records which helper produced it, taken from the runtime's own report and
never from the answer text. A Codex turn keeps the engine, the model name the app-server
reported for the thread (or for the turn, when `turn/completed` names one) and the
protocol version from `initialize`. The caption under a helper's turn shows that value,
"Codex, gpt-6-astra". When the runtime reported nothing the caption says so, "Codex, name
not reported" in the Workbook and "Codex, model not reported" on the Console, rather than
guessing. Sample work is recorded as sample work. A Codex selection pinned in Settings
(`services.codexModel`) travels in the thread configuration, never in the text. Turns
written before 2026-09-07 carry no record and show no caption.

This exists because a saved conversation once showed the helper calling itself
"GPT-5.2 Codex" while the runtime was `gpt-6-astra`; the name had come from the model's
own prose.

## Usage

Every helper that reports usage gets a bar. Codex reports its ChatGPT allowance windows
(`account/rateLimits/read` when its connection is checked, and the
`account/rateLimits/updated` notification during a turn) and each thread's counts
(`thread/tokenUsage/updated`). Nothing calls an undocumented endpoint and no number is
guessed; a helper that reports nothing gets one plain sentence instead.

Where it shows: a chip in the top bar for the helper that is on, with the tightest window
(the highest percent used) and a 72-pixel bar that takes the signal colour past 80
percent and the fault colour at 100; every window as a labelled bar with its reset time
under that helper in Settings; the same bar in each Console pane header and on each roster
member. Clicking the chip opens Settings at the helpers section.

The exact rate-limit payload of the pinned Codex 0.153.4 app-server is not captured in
`evidence/` yet, so the mapping accepts the documented field names defensively and turns
an unknown shape into "not reported" rather than a number. The first check against a
signed-in Codex is still to do.

## Run it

### Windows desktop

Open `release/Diomedes-win32-x64/Diomedes.exe`, and keep the whole release folder
together. It is a portable, unsigned Windows x64 build with its own window and bundled
runtime — no Node, npm or browser needed to run it. It starts its own service on a free
loopback port and closes that service when you exit. Use View > Zoom In/Out or Settings >
Appearance > Interface size to adjust readability.

There is no installer, no code signature and no update service. The **Diomedes**
desktop shortcut opens this same executable after every rebuild, so keep the release
folder where it is. Close Diomedes before building and reopen it afterwards; editing
source does not update a running application.

### Browser development

Node 22.12 or later. From this directory:

```powershell
npm ci
npm run prepare-native
npm run dev
```

Open **http://127.0.0.1:5173**. The service listens only on **127.0.0.1:47631**. Ctrl+C
stops both processes. Nothing is added to startup, no tunnel is opened and no global
package is installed.

For a single production listener, `npm run build` then `npm start`, and open
**http://127.0.0.1:47631**. Stop a development service before starting production on the
same port. `./Start-Diomedes.ps1` launches that listener in the background;
`./Stop-Diomedes.ps1` stops the recorded process and its children after checking the
process identity.

On this machine, Node needs the system certificate store for package downloads. If npm
reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, run with `NODE_USE_SYSTEM_CA=1`. Keep TLS
verification on. The build makes no external font requests.

## First use

Answer the three setup questions, then create a project or choose **Open sample
project**, which writes three text documents into a new folder. No sample is created
during onboarding itself.

1. Open **Plan**, edit the document, save.
2. Choose **Make tasks from this plan**, review the proposed tasks, add them.
3. Start a task. **Sample work** is a scripted local demonstration, labelled as such
   throughout the interface.
4. Answer **Needs your OK**, then look at **Review**. Keep accepts the current file;
   Undo records and applies the previous contents.
5. Open **History** to inspect changes, save named versions, or restore. A restore is
   itself reversible, and newer content produces explicit conflict choices.

Changing how something is presented never grants a permission. Unsaved text is backed up
in this browser profile and recovered when you reopen the document.

## Build, test and package

```powershell
npm run check          # TypeScript across client, server, shared, scripts and tests
npm test               # vitest: store, API, work, native proposals, discovery, team
npm run test:ui        # Playwright against installed Microsoft Edge
npm run package:desktop # alias of npm run build; postbuild packages the desktop app
npm run test:desktop   # smoke the packaged release/Diomedes-win32-x64/Diomedes.exe
```

`npm run build` type-checks, builds the client, and then packages the desktop
application through its `postbuild` step, always to the same
`release/Diomedes-win32-x64` path. When you finish a change, run the build and
`npm run test:desktop` so the release on disk is current and verified.

Browser tests use the installed Microsoft Edge with isolated data directories and ports;
no browser is downloaded. Two checks are separate because they spend real subscription
usage and are not part of `npm test`:

- `npm run verify:native-work` — a synthetic native Work integration check. It needs the
  native runtime and a ChatGPT sign-in, creates only its own test project, verifies
  preview, approval, write, history and restore, and closes its own service.
- `node scripts/approval-desktop-smoke.mjs` — one real Luna run through the packaged
  approval flow, using its own project and profile. Verifies a lost approval response,
  decision receipt, restart, replay and byte-exact restore.
- `npm run smoke:team-codex` — a real Codex team session against a running Diomedes
  service. Set `DIOMEDES_API` to override the default `http://127.0.0.1:47631/api`.

`npm run probe:team` exercises the team MCP endpoint with a probe member and spends
nothing.

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

- **Only one engine works.** Claude Code, OpenCode and oh-my-pi are found but have no
  adapter. Cursor, Hermes, Ollama and LocalAI are observed, never driven. AionCore is
  not installed or adopted.
- **The team's limits** are listed under [The team](#the-team): Codex-only members, three
  tools that answer "not available in this version", no spawning, no steering, no
  branching, no handoff, one run at a time per project, and no pre-execution veto over
  the Codex tool host.
- **No local authentication on most of the API.** The team MCP routes check a bearer
  token and slot; the rest of the loopback API does not. Origin/Host checks and a
  required mutation header keep unrelated websites out, but any other process on this
  computer can reach it. This is a local prototype, not a remote or multi-user service.
- **Text only.** Word, Excel, PDF, images and binary diffs are not editable, and History
  has no automatic pruning — the retention settings exist but nothing enforces them yet.
- **No Git and no messages.** The application never commits, branches, pushes, or sends
  an email or message on your behalf.
- **No installer, signature or updater**, and no remote access or account pairing.
- **Business plugins are a proposal, not code.** See
  `docs/research/2026-09-06-business-plugins/`.
- Keyboard and assistive-technology audits, Windows 150% scaling and text-spacing
  overrides are not verified. A landing-page rework and an interface-scale rework are in
  progress and are not in the packaged release.

## Where the record is

- [Main build integration, 2026-09-08](docs/implementation/2026-09-08-main-build.md)
  records the verified Work foundation and exact approval changes now in the main
  Windows executable and existing desktop shortcut.
- `QUESTIONS.md` — what has been settled and what is still open.
- `evidence/` — dated verification records. `BUILD-REPORT.md` and `DESKTOP-RELEASE.md`
  describe the 2026-09-05 state; `codex-team-real-binary-2026-09-06.md` is the team
  proof; `codex-app-server-0.153.4/` holds the pinned protocol facts the adapter relies on.
- `docs/research/2026-09-06-business-plugins/` — a researched proposal for business
  plugins. Nothing in it is implemented.
- `../planning/` — the dated design and planning packages, with `../planning/README.md`
  saying which are current.
- `licenses/` — the bundled font licences. `reference/` — read-only copies of source
  documents used during the build.
