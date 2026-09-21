# Diomedes is the agent: the page the app opens to

**CD-00 decision record.** Version 2026-09-20.1. Author: Fable 5.1 (integrator seat), from Andrew's
direction of 2026-09-20 and the CD-1 package (`Diomedes_Core_Agent_CD1_Complete.zip`, version
2026-09-20.3).

**Status: a product decision and a proposed design. Nothing here is built, tested or shipped.** No
site copy, release note, roadmap status or report may describe any of it as available until it
exists with proof.

Design artifact: <https://claude.ai/artifact/GWn2woUd39UoyEFme6EbgL> (five boards, private to
Andrew until shared). Work orders and lanes: `docs/implementation/2026-09-20-core-agent-work-items.md`.

---

## 1. What is decided, and by whom

### Owner decisions (Andrew, 2026-09-20)

1. **Diomedes itself is the conversational agent.** People talk to Diomedes. It is not a separate
   Bots tab, and a roster of configurable bots is not the central concept.
2. **The Diomedes page is the primary page the app opens to.** This answers the question the
   Console design pass left open the same day: "Diomedes still reopens the last project at launch
   ... Open question for Andrew, not decided here"
   (`docs/implementation/2026-09-20-console-design-language.md:74-77`).
3. **It must be clean for a business owner and take nothing away.** Every existing function stays
   reachable.
4. **The view stays uncluttered, and Everything is how the rest is reached.** A short pinned foot,
   and an Everything control a person hovers over to choose more functions.
5. **Automations keeps a real, dead button.** It has a fixed place to be wired to, so switching it
   on later needs no redesign.
6. **Model work is distributed as labelled** in the package: Fable for product thinking, Opus for
   the technical contract and integration, Astra for independent acceptance, SWE 2.0 for bounded
   implementation. Where the SWE 2.0 route is not available, Muse (or GLM as its fallback) takes
   that lane.

### Owner decisions (Andrew, 2026-09-21, "go with recommendations")

These were proposed defaults in sections 9 and 10. They are decisions now, and the contract may
not mark them as pending.

7. **The design direction is a go.** The five boards at the design canvas are the visual contract
   for the first slice.
8. **The landing conversation lives in a reserved workspace home Project.** An ordinary Project,
   hidden from the Projects list, navigation and Files, created when the first landing message is
   sent. It is a conversation container and never a work destination. Astra's six conditions
   (contract H1 to H6) bind it.
9. **Automatic is the default for a new conversation.** Answer only and Plan only remain explicit
   limits that always win.
10. **The "last opened project" fallback on the landing is removed.** A job with no named target
    gets a question, never a guess.
11. **Opening the app shows Diomedes for returning people too.** This follows from decision 2 and
    is recorded here because CD-01 round 2 drifted from it. The remembered project sits first on
    the spine, one click away. Recovery of a surface that was already in progress is unchanged.
12. **The Devin ACP external claim is superseded** by the landed commit `2237787`.
13. **The endgame is authorized.** When the work is done and the gates pass: merge this program's
    worktrees and the other finished worktrees by Claude sessions and by Codex into main, open a
    pull request, fix what it finds, push, deploy the site and publish the new build. This lowers
    no gate. Only work with an accepted verdict merges, and the release comes last.

### What this does not decide

Prices, included usage, the production lead model, hosting guarantees, the minimum window width,
customer-message permissions and any pillar's wording. Those stay Andrew's, and none is changed
here.

---

## 2. What a person experiences

They open Diomedes and see one place to talk, the scope they are talking about, and, only when
there is any, the work in progress and the decisions that need them. No bot to create, no model
to choose, no mode to pick first.

- **They say "Morning."** Diomedes answers. No task appears, nothing is scanned, no worker starts,
  no monitoring is implied. (C01)
- **They ask a fact.** "Did Friday's delivery match the order?" Diomedes reads the permitted
  records and answers with its sources, and says what it could not confirm. One short exchange,
  no project plan.
- **They ask for work.** "Compare the last four deliveries and make a checklist for the manager."
  One linked work item appears in the conversation with a real current stage. A missing record is
  shown as missing and becomes one focused question, not a silent gap.
- **They inspect.** Opening the work item turns the right-hand ledger into an inspector: target,
  sources, workers with their real model and engine, what the job was allowed to do, and what was
  checked. It opens because they looked, never because they said hello.
- **The result is an artifact,** not a paragraph to scroll for. It opens from the conversation and
  from the project's Files.

The voice is warm, direct and willing to disagree. No em dashes, no catchphrases, no narrating its
own helpfulness.

---

## 3. The design, and why it is this one

**One direction, not a menu of options.** Direction was already settled twice in the Console
design pass: the Console's three regions, "a little busier in terms of our mythic synthwave feel",
"easy access to everything", and the explicit finding that "a centred column with a box and a
list" is "the pattern every assistant product opens on." A chat-first home is exactly where that
failure would recur, so the page is built only from the Console's own devices.

| Region | What it carries | Existing device reused |
|---|---|---|
| Strip | The mark, the workspace, and news only when there is news (running, needs you) | `TopStrip.tsx`, the charged 1 px rule |
| Rail | "Talking about": the workspace and its projects on the spine, the point on the scope the composer will send to. A short foot: Projects, Files, Automations (not ready), Everything | `Rail.tsx` with `title`, the spine and guiding point, `Everything.tsx` |
| Work column | The conversation. A mono instrument line above it. The composer below, with In and Mode in its bar | `.col`, `.instr`, `.turn`, `.need`, `.composer`, `.bar`, `.send` |
| Ledger | Only what exists: Needs you, Working, Recent results. It becomes the job inspector when a person inspects | `Ledger.tsx` and its `.focus` block |

Conversation, work, evidence: CD-1's hierarchy maps one to one onto rail, work column and ledger,
so the page needs **no new layout primitive**.

**Uncluttered on purpose.** In the quiet state the ledger shows no "Nothing is waiting on you"
and no "No jobs running." The instrument line already reads `0 need you, 0 running`, and standing
decision 4 says not to narrate a state the screen already shows.

**Mode is present and never forced.** The composer's Mode reads Automatic by default, with Answer
only and Plan only beneath it. Those two are today's Ask and Plan, with today's limits. No new
autonomy preset is invented and no permission label changes meaning.

**Tokens are the app's, not the website's.** Field is the default scheme (`client/styles.css:6-86`).
Board 2b draws the same screen from the real Mythic Synthwave pack
(`shared/theme-pack/fixtures/mythic-synthwave.json`). Nothing is taken from diomedes.net
(standing decision 3).

### Where it plugs in (the architecture choice)

| Option | What it is | Verdict |
|---|---|---|
| **A. An app-level Console screen** | A new `client/console/Agent.tsx` beside `Home.tsx`, chosen in `client/App.tsx` where the app already decides between Home, Shell and Settings | **Recommended** |
| B. A seventh `ShellView` | A view inside `Shell.tsx`, reachable only with a project open | Rejected: the home is workspace-level; a project-scoped view cannot be the page the app opens to |
| C. Grow Home's ask box | Keep the Projects page and make its box conversational | Rejected: it keeps the "box plus list" shape, and Home's box does not send; it stashes a draft and opens a project (`App.tsx:496-508`) |

Option A touches the smallest hot surface. `Shell.tsx` needs no change for the page to exist. The
real gate is `client/App.tsx`: with no project selected it renders `<Home>`, and `loadInitial()`
restores the last project (`App.tsx:197-204`). Opening to Diomedes is a change there.

The Projects page is not removed. It is one click away in the foot and in Everything.

---

## 4. What Diomedes owns, and what it never owns

**Owns:** the conversation with the person; choosing whether to answer, look something up, plan,
do, propose building, control existing work, ask one question, or say it is blocked; handing
bounded work out; checking what comes back; saying truthfully what was done, what was checked and
what is still open.

**Never owns:** permission. The model proposes an interaction decision. Trust and Runtime decide
whether, where and how it may happen. A classification, a confidence score or a JSON object is
never executable authority.

**Knowing when not to build.** The preference order is the package's: answer from permitted
context; look up or calculate; reuse an approved tool or procedure; configure what exists; create
an artifact; only then propose new software. "Build next week's schedule" is a document. "Build a
scheduling tool for our managers" is software. Both are in the acceptance set.

---

## 5. Source facts (verified at `origin/main` `dadb72d`, 2026-09-20)

These came from read-only traces. CD-01 re-verifies each before freezing the contract.

1. **The conversational runtime already exists.** `ClaudeSessionRuns`
   (`server/harness/claude-session-run.ts`), capability `claude-native-session`, landed
   2026-09-19. It is durable, multi-turn, resumable, forkable and interruptible. It creates no
   Task, no Session and no Need: `recordResult` projects two Turns. The client supplies a
   `commandId`; the run id and the turn step derive from it; a succeeded turn replays instead of
   dispatching again.
2. **No Console client calls it.** `client/console/Shell.tsx:1005` still posts `/ask`, which has no
   source-message identity. Its ids are random per call, so a retried Ask dispatches twice.
3. **The session is mode-pinned.** Instructions are part of the run scope, and a scope change is
   refused with `SESSION_MISMATCH`. A Plan follow-up after an Ask start fails today.
4. **Idempotency holds inside each command family, not across them.** Nothing binds a
   conversation `commandId` to the `work.start` `commandId` an escalation would mint.
5. **Write authority has one source:** `ScopeGrants.matching` and `record`
   (`server/trust/scope-grants.ts`), reached through `admitWork`. `server/execution.ts` and the
   governance hooks in `server/harness/lifecycle.ts` have no production callers.
6. **One active run per project is the whole scheduler.** There are no parent and child tasks.
   `Task` has no parent field.
7. **The runtime is Claude-only and per-project.** It needs a `threadId` inside a project. The new
   home is workspace-level.
8. **Every node CD-1 leans on is `open`** in the unified package. H13, H14, H17, H18 to H20 and
   SDKR have no code at all. H09 and H12 exist only as unmerged candidates. Automations and JEV
   are outside the package graph.
9. **The earlier Bots program was never active.** It lives only on two unmerged branches,
   `docs/bots-capabilities-20260920` and `-r2`, and is absent from `RUN_ORDER` and from all three
   canonical documents.
10. **Canonical versions:** Pillars 2026-09-19.1, Roadmap 2026-09-19.2, Project Memory 2026-09-19.2.

---

## 6. The strongest material gaps

1. **Escalation.** Turning a conversation turn into admitted work without deadlocking
   `store.locked`, without colliding with the single-active-run guard, and with one identity from
   message to job. This is the heart of CD-01.
2. **Mode inside one conversation.** Automatic, Answer only and Plan only must coexist in one
   relationship while `SESSION_MISMATCH` keeps its meaning.
3. **A workspace-level conversation** in a product whose threads belong to projects.
4. **Bounded workers do not exist yet.** CD-04 depends on H13, H14 and H17. Building it now would
   mean inventing the second runtime this program forbids. It is **unclaimed** until those land.
5. **No authorized projection before egress.** The conversational path sends consented documents
   under a Settings toggle. CD-03 cannot claim multi-person source isolation on that basis.
6. **Non-Claude routes** have no durable conversation. What a ChatGPT-only person gets must be
   stated honestly rather than papered over.

---

## 7. The first complete experience

Small and whole, on what exists:

1. The app opens to Diomedes (CD-05).
2. A greeting is answered with no work object (C01), through the existing native session.
3. A factual question is answered from consented sources, with the sources shown.
4. Answer only and Plan only hold. Plan changes nothing (C03 class).
5. A request for real work is admitted once through `admitWork`, carries the conversation's
   identity, and a retry admits nothing new (C21).
6. The linked work item, its Need and its result are read from existing task, Need and History
   records. The page keeps no state machine of its own.
7. Stop works and never waits on generation.

Delegation, learning, Automations, channels, voice and paid admission are later items and are
not claimed by this slice.

---

## 8. Conflicts named rather than hidden

- **"Not ... a chatbot"** (`docs/DIOMEDES_PROJECT_MEMORY.md:38`). Reconciled, not overridden. The
  page keeps work and evidence visible beside the conversation, and every other surface stays.
  CD-1 says the same: a chat-only product would be a mistake. Project Memory gains an
  interpretation under this decision, not a reversal.
- **A dead pin.** `client/console/Everything.tsx` deliberately offers no pin for a destination
  that cannot open, "because that would put a dead entry in somebody's sidebar." Andrew's decision
  5 makes Automations the one exception: a default pin, not a person-offered one. The component's
  rule stays for everything else.
- **Hover.** Everything opens on click today. Decision 4 asks for hover. CD-05 adds hover intent
  and keeps click and keyboard, so nothing becomes unreachable without a mouse.
- **Hot files.** `AGENTS.md` names Fable as integrator of `shared/types.ts`, `server/app.ts`,
  `client/api.ts`, `client/console/Shell.tsx` and the rest. CD-1 proposes Opus as technical lead.
  Both hold: Opus freezes the contract and returns patches; hot-file edits land through the
  integrator under a claim. No live claim covers those files today.

---

## 9. Proposed defaults (to be tested, not facts)

- One continuing conversation per workspace with day markers, rather than a list of chats. Scope
  is chosen on the spine; it selects context and does not start a new relationship.
- The work target is pinned at admission. Moving the scope point afterwards never redirects a
  running job (C13).
- Pinned foot: Projects, Files, Automations (not ready), Everything. Board, Team, History, AI
  services and Settings sit in Everything.
- A person who was last inside a project can return to it in one click. Opening to Diomedes
  replaces "reopen the last project" only as the launch default.

## 10. Unverified assumptions

- That a workspace-level conversation can ride an existing record without a new store. CD-01's
  first answer was "none in the first slice", which left the landing with no run to generate or
  record even a greeting; the independent review rejected that (CD-01.R, R-01). The proposed
  default is now a **reserved workspace home Project**: an ordinary Project holding the home
  thread, so the native session works unchanged. It is acceptable only under the reviewer's six
  conditions, the chief ones being that home is never a work destination, never an alias for the
  last-used project, and reads nothing from other projects until a proved context adapter exists.
  **Pending Andrew.** The alternatives are no conversation until a project is picked, which
  contradicts decision 2, and a new conversation record outside any project, which adds a durable
  shape and touches `shared/types.ts` and `server/store.ts`.
- That the Mythic Synthwave pack applies cleanly. The design pass recorded that the theme API
  refused the save in the preview without an entitlement, so board 2b is drawn from the fixture's
  tokens, not captured from the app.
- That SWE 2.0 is reachable. On this machine it is not: only Devin Desktop is installed, there is
  no `devin.exe` CLI for the ACP adapter to resolve, and ACP sign-in needs a browser flow. The
  SWE 2.0 lanes go to Muse.

---

## 11. Canonical amendments: proposed, not applied

The three canonical documents are Google Docs with repository mirrors. The Drive connector cannot
write a document body, so the cloud edits need Andrew. **Cloud synchronisation is pending.** The
exact text is in the CD-1 package, `08_WEBSITE_AND_MIGRATION.md:119-131`:

- **Core Pillars:** an interpretation under Pillar 07, not a new pillar.
- **Live Roadmap:** a CD-1 entry beside Automations. It also closes the roadmap's open decision
  "native supervisor specialization."
- **Project Memory:** a definition after "Agent, Mode, Team and Project," including how this sits
  with "not ... a chatbot."

The package registration (CD-00 to CD-12 as leaf items, following the Field Readiness pattern:
`sources/`, `coordination/external-book-*.json`, `shared/AMENDMENTS.md`, `RUN_ORDER`,
`SHA256SUMS`, validation) is a separate step in the work-items ledger. The two `docs/bots-*`
branches should be marked superseded so they are never merged as a second program.
