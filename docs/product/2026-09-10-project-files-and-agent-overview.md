# The Project as a durable container: one Files surface, and an overview that reads like a person wrote it

**Status: approved direction. Nothing described here is implemented.**
Approved by Andrew, 2026-09-10. Nothing in this document may be reported, released or advertised as
shipped until it exists and has proof. See `AGENTS.md` decisions 12, 13 and 14.

This document answers several of Andrew's 2026-09-10 instructions together, because they are one
question: what a Project is, what it holds, and how a person sees the work happening inside it.

- **§1** is the approved direction: one Files surface in two tiers, Core and capability pack.
- **§2** is the Console architecture for it, grounded in what the code already does.
- **§3** is the investigation of Cursor's September 2026 Projects and Agents experience.
- **§4** is the Project/Console/Agent hierarchy and the human status projection.
- **§5** is what this changes, what is open, and what it must never change.

The capability-pack contract itself lives in a focused companion:
[`2026-09-10-capability-packs.md`](2026-09-10-capability-packs.md).

---

## 1. Approved direction: one Files surface, two tiers

**A restaurant manager should never need to understand a source tree to use Diomedes. A software
developer should be able to work inside Diomedes without switching to another editor merely to
inspect what the agent is doing.** Both sentences have to stay true at once.

The way they stay true is a split, settled by Andrew on 2026-09-10: **files are not inherently a
software feature**, so the file and artifact surface belongs in Core; the IDE-grade version of that
same surface is supplied by the **Software Engineering Capability Pack** and appears only when a
person activates it.

**There is one Files surface.** The pack does not add a second one. It changes what the existing
surface can do.

### 1.1 Core Files and Artifacts — always available

General-purpose, because SOPs, reports, exports, documents, spreadsheets, invoices and images are
ordinary business objects and have nothing to do with programming.

| | Capability | Notes |
|---|---|---|
| a | Collapsible, resizable Files pane bound to the current Project | Off by default; remembered per person |
| b | The project folder and artifact model | Reuses `Project`, `DocumentInfo`, `DocumentContent` |
| c | Ordinary file preview | Common business file types |
| d | Text and Markdown viewing, rendered/raw toggle | `readTextOrNull` already does the reading |
| e | File search | Belongs in the existing Ctrl+K palette |
| f | Generated artifacts | Whatever the work produced |
| g | History and version inspection | History already holds both sides |
| h | Attachments and references into Threads | The feature that earns the pane |
| i | Changed-file indicators | `DocumentInfo.hasChangesWaiting` and `.recorded` |
| j | Preview, and open externally where preview is wrong | Binary and unsupported files show metadata |

Diomedes does not become a universal editor.

### 1.2 Software Engineering Capability Pack — on activation

When a person activates the software-development capability or profile, the same Files surface
becomes an IDE-grade project environment:

repository-aware tree · syntax highlighting · code editing · project-wide code and text search ·
symbol, function and class navigation · line references into Threads · Git status and history ·
unified or split diffs · changed-file review · diagnostics · test and build commands · worktrees and
branches · repo-aware context construction · software-specific Agents and subagents · coding tools
and workflows · automatic discovery of repository instruction files · later, LSP and code
intelligence where justified.

**Do not inject or load the software-development toolset for users or projects that do not need it.**
A Personal Project tracking invoices must not pay for a symbol index, and its Console must not grow
a Git status column.

### 1.3 Repository instruction files are first-class in the pack

When a repository or project contains applicable instruction files — `AGENTS.md`, `CLAUDE.md`, and
relevant project documentation — Diomedes discovers them, feeds them through the correct context and
rule path rather than pasting them into a prompt, and shows the person an unobtrusive indication:

> Project instructions loaded · AGENTS.md

Clicking it opens a readable rendered version. This is the acceptance test for the whole Files
surface, and it is deliberately self-referential: **the documents this repository itself produces
should be good to read inside it.** If `AGENTS.md` is not pleasant to read in the pane, the pane is
not done.

---

## 2. Console architecture

### 2.1 The rule that shapes everything else

**This is not a second application surface.** It is a pane inside the one Console, alongside the
Thread, the Board and the rest. It reuses the existing Project, `DocumentInfo`, `DocumentContent` and
History primitives; it does not create competing storage or a second file authority.

Every file byte a person sees in this pane arrives through `server/paths.ts` and `server/store.ts`.
The pane never gets a path of its own to read.

### 2.2 What the code already gives us for free

| Need | Existing primitive | Where |
|---|---|---|
| File listing | `listDocuments(id)` → `DocumentInfo[]` | `server/store.ts:689` |
| Per-file kind | `DocumentInfo.kind: 'plan' \| 'markdown' \| 'text' \| 'unsupported'` | `shared/types.ts:98` |
| Changed-file indicator | `DocumentInfo.hasChangesWaiting` | `shared/types.ts` |
| "Diomedes has touched this" | `DocumentInfo.recorded` | `shared/types.ts` |
| File contents | `readDocument` → `DocumentContent` | `server/app.ts:956` |
| Outside-change conflict | `DocumentContent.outsideChange` | `shared/types.ts:106` |
| Binary / oversize refusal | `readTextOrNull` (8 MB cap, NUL check, UTF-8 check) | `server/paths.ts` |
| Which extensions are text | `textKind` | `server/paths.ts` |
| Path safety | `projectFile` → `relativeName` + `safeAbsolute` | `server/paths.ts` |
| Diff material | `HistoryEntry.files[].before` / `.after` | `shared/types.ts` |
| Fuzzy-find surface | `Palette.tsx` / `paletteEntries.ts` | `client/console/` |

Item (i) is therefore already done on the server. Items (b), (c), (e), (f), (g) and (j) need no new
server capability at all. That is the payoff for reusing the primitives instead of inventing a file
service.

### 2.3 The four real gaps

**Gap 1 — the listing is flat, and re-walks on every call.**
`listDocuments` returns a flat `DocumentInfo[]` whose `path` is a `/`-joined relative path, and
`walkDocuments` re-walks the whole folder each time. `statePayload` deliberately strips `documents`
from the SSE fan-out because the listing "can hold 10,000 rows" (`server/app.ts:126`).

A tree is derivable client-side from the flat paths, so **no tree endpoint is needed.** What is
needed is not paying for a full walk on every board event. Options, cheapest first:

1. Build the tree in the client from one listing and refetch only on document-affecting events.
2. Give the cache an explicit generation number so the client can skip an unchanged listing.
3. Watch the folder. This is the expensive option and should not be reached for first.

Start at (1). It changes no server code and is enough for a pane a person opens deliberately.

**Gap 2 — dotfiles and skipped folders are invisible.**
`walkDocuments` skips every entry whose name starts with `.` and every name in `SKIPPED_FOLDERS`
(`node_modules`, `dist`, `build`, `target`, `out`, `__pycache__`). For an ordinary Project that is
right. For a developer inspecting what the agent did, `.github/workflows` and `.gitignore` are
exactly the files in question.

This is a **product decision, not a bug**, and it is Andrew's: does an opted-in Files pane show
dotfiles? Recommended answer: yes, behind the same opt-in that shows the pane, with
`SKIPPED_FOLDERS` still excluded and `server/paths.ts`'s `blocked` and `privateNames` guards
unchanged and unnegotiable. `.git`, `.ssh`, `.aws` and the credential names stay refused by the trust
funnel regardless of any setting, because that guard is not a display preference.

**Gap 3 — there is no project-wide text search.**
This is the one capability with no existing primitive. It needs a new endpoint that walks the same
guarded listing and returns matches with file, line number and a bounded excerpt. Constraints it
inherits rather than invents: the 8 MB per-file cap, the binary refusal, the `projectFile` guard per
candidate, and a bound on total results so one query cannot walk a person's machine to a stop.

**Gap 4 — nothing renders a diff today.**
History carries `before` and `after` for recorded files, so the data exists. What does not exist is a
diff component. Unified diff first; before/after side-by-side is a second view over the same
computation and should not be a second code path.

### 2.4 Build order

**Core first, pack second.** Core has to be good on its own, because most Projects will never
activate the pack.

*Core Files and Artifacts*

1. **Pane shell + tree + read-only viewing.** Client-only over `listDocuments` and `readDocument`.
   Proves the pane earns its space before anything new is written on the server.
2. **Changed-file indicators + Markdown rendered/raw toggle + preview and open-externally.** All
   client-side.
3. **References into the Thread.** The feature that makes the pane worth opening: select a file or a
   passage, send the reference into the current Thread as context.
4. **History and version inspection** over existing History records.
5. **File search** in the Ctrl+K palette.

*Software Engineering Capability Pack*

6. **Pack activation plumbing.** The pack must be able to contribute tools, Agents, rules, context
   and UI affordances without a second surface. See
   [`2026-09-10-capability-packs.md`](2026-09-10-capability-packs.md).
7. **Repository awareness**: repo-aware tree, Git status and history, changed-file review, and
   discovery of `AGENTS.md` and `CLAUDE.md` with the "Project instructions loaded" indication.
8. **Reading like code**: syntax highlighting, unified and split diffs, project-wide code and text
   search. Search is the one genuinely new server capability (§2.3, Gap 3).
9. **Navigating like code**: symbol, function and class navigation; diagnostics; later LSP where
   justified.
10. **Acting like a developer**: test and build commands, worktrees and branches, coding workflows.
11. **Editing**, only through the existing mutation, History and permission architecture, and only
    once the rest is proven.

Editing is last on purpose. A Files pane that can read is a viewer; a Files pane that can write is a
new mutation path, and Diomedes already has exactly one of those, with receipts.

---

## 3. Cursor's September 2026 Projects and Agents experience

Observed 2026-09-10 from primary sources. Statements below are attributed: **observed** means it is
on the cited page; **inferred** means it is my reading. Cursor's own docs describe less of their UI
than the marketing does, and where a status label would settle a question, **no primary source names
one** — so this document does not invent any.

### 3.1 What was observed

**Cursor Projects** (beta, announced 2026-09-10 — the same day as this decision;
`cursor.com/blog/projects`, `cursor.com/changelog/projects`):

- A Project takes on "larger bodies of work, such as a feature, a migration, or a full app," and
  "maintains context over months of work."
- A **coordinator agent** "doesn't write code itself; it plans the work, delegates it to agents that
  implement it, and brings the finished work back to you to check." The stated reason is that the
  coordinator is then "never blocked and is always responsive to direction."
- A Project "runs on its own computer in the cloud, so closing your laptop doesn't stop it," and
  "the coordinator spins up a local agent" when something must run locally.
- Projects hold **shared context files** that sync across cloud and local machines and accumulate:
  "If one agent figures out how to test a service, for example, every future agent can use those
  instructions."
- **Subscriptions**: the coordinator can watch Slack channels, run on a schedule, or track pull
  requests, "fixing CI and acting when they open or merge."
- Projects start "from the left hand nav."

**Agents Window** (GA 2026-04-02; `cursor.com/docs/agent/agents-window`):

- Multi-workspace: "work with agents across all your projects from one place."
- Worktrees "run agents in isolated Git checkouts so each task has its own files and changes."
- A "new diffs view" to "review and commit changes, and manage PRs without leaving Cursor."
- File access without leaving the window: `Cmd+P` to search files, `Cmd+Shift+F` to search all files.
- A right-side inspection panel carrying a file browser, a sandbox terminal, a browser and a review
  pane (third-party description, `learncursor.dev`; not stated in Cursor's own docs).

### 3.2 Where each Cursor idea belongs

Andrew's allocation, 2026-09-10, and the rule for reading §3.3 below:

- **Cursor's file, code and repository interaction ideas belong primarily in the Software Engineering
  Capability Pack.** Diffs, worktrees, repo search, PR handoff, the code-shaped half of the Agents
  Window. They are good ideas about *software*, and they should arrive with the pack that admits it.
- **Cursor's higher-level clarity belongs in Core**: Project → active work → Needs you → Ready for
  review → completed work. That pattern is about how a person understands work in progress, and it is
  as true of a restaurant Project as a repository.
- **Neither justifies a second task or state engine.** Those states are derived from the
  authoritative Diomedes task, run, Need, review and evidence records (§4.2).
- **Neither turns Diomedes generally into a coding IDE.**

### 3.3 Worth adopting

1. **The agent-management layer stays high-level; files are somewhere you drop into.** This is
   Cursor's strongest idea and it is exactly compatible with serving both ordinary and technical
   users. The default view is work; files are one keystroke away and never in the way. It is the
   whole argument for the pane being collapsible and off by default.
2. **A Project outliving a single chat.** Cursor's framing — work "that will outlive a single chat" —
   names the thing Diomedes's Project abstraction is already for but does not yet fully deliver in the
   interface. The Diomedes Agent should operate across the work inside a Project, not be conceptually
   trapped inside one Thread.
3. **Context that accumulates in the Project.** Research, artifacts and learned working preferences
   belong to the Project and outlive the Thread that produced them. Diomedes has the storage for this;
   what it lacks is the framing that makes it obviously the Project's rather than the Thread's.
4. **Subscriptions as ordinary Project work.** A Project that watches something and acts when it
   changes is general-purpose: a restaurant Project watching a supplier mailbox is the same mechanism
   as a repository Project watching CI. Worth adopting as a concept; the implementation is out of this
   document's scope.
5. **Worktree isolation made visible.** Diomedes already coordinates worktrees (`AGENTS.md`); Cursor
   surfaces them as a first-class property of a run. Ours are an agent convention the user never sees.

### 3.4 Not appropriate for Diomedes

1. **Coding-specific vocabulary as primary structure.** PRs, branches, CI and repositories are one
   Project's contents, not the Project model. A restaurant Project has approvals and exported reports
   where a code Project has PRs; the container must not be named after the code case.
2. **"Thousands of subagents" as a headline.** Diomedes's claim is durable outcome ownership with
   evidence, not fan-out scale. Pillar 10 forbids inventing value metrics, and a subagent count is a
   cost figure wearing a capability's clothes.
3. **Cloud-first execution.** Cursor's Project runs on its own cloud computer by default. Diomedes
   Personal is a genuinely capable local and BYO harness, and private processing is the default
   (Pillar 09). Remote execution is an option here, never the premise.
4. **A separate window for agents.** Cursor's Agents Window is a second surface with its own editor
   toggle. `AGENTS.md` decision 1 forbids exactly that. Our equivalent is a pane, in the one Console.
5. **The coordinator that never writes.** A hard rule that the coordinator only delegates is a
   scaling choice. Diomedes's supervisory model already distinguishes the Diomedes Agent from direct
   execution, and the attribution contract (decision 8) is stricter than Cursor's. Do not adopt the
   rule; the honest distinction we already have is better.

### 3.5 Where Diomedes is already ahead

- **Evidence and attribution.** Receipts, authorization history, verification and truthful
  actor attribution have no counterpart in what Cursor documents. Cursor's review flow ends at
  "review and commit"; ours records who was authorized to do what, and what was actually done.
- **Permission as architecture.** Scoped authority, escalation review separated from access scope,
  and the rule that configuration cannot revive spent or revoked authority. Cursor's model is a
  sandbox plus a human at the diff.
- **General-purpose by construction.** Cursor's Project is a software Project. Ours is not, and does
  not have to be retrofitted to stop being one.
- **One surface.** Cursor now has an editor window and an Agents window and asks the user to hold both
  in their head. We decided against that (decision 1) and should not drift into it.

---

## 4. The hierarchy, and the status projection

### 4.1 Hierarchy

```
WORKSPACE / ORGANIZATION     identity, membership, entitlement, policy
  └─ PROJECT                 the durable container for an outcome and its working context
       ├─ THREADS + TASKS    the conversation and the units of work
       ├─ DIOMEDES AGENT / TEAM   who does the work
       ├─ FILES + ARTIFACTS  what the work reads and produces
       ├─ CAPABILITIES / RULES / CONTEXT   what it may use and what it knows
       ├─ PERMISSIONS        what it is allowed to do
       └─ EVIDENCE / HISTORY what actually happened
```

The load-bearing claim: **a Project is the durable container for an outcome and its working context,
and the Diomedes Agent operates across the work inside that Project rather than being trapped inside
one Thread.** Everything else in this section follows from that sentence.

For a software Project, Files may be source and repositories. For a restaurant Project, the same slot
holds documents, exported reports, spreadsheets, connector-backed information, procedures, approvals,
generated artifacts, tasks and operating evidence. **Same contract, different contents** — this is
Pillar 02 and `AGENTS.md` decision 12, and it is the line that keeps this work from turning Diomedes
into an IDE.

### 4.2 Human statuses, derived and not stored

The global and project overview should make active work immediately understandable:

> **Working** · **Needs you** · **Ready for review** · **Finished recently**

**These are a projection, not a new lifecycle.** Diomedes already does exactly this:
`taskBoardState` in `client/console/paletteEntries.ts:73` is a pure function from the authoritative
`Task` to a display state, storing nothing. The project-level statuses are the same idea one level up.

Every input already exists:

| Human status | Derived from | Authority |
|---|---|---|
| **Working** | `Task.state === 'working'`; `ProjectSummary.counts.running`; `status.working` | task/run records |
| **Needs you** | `Task.reason === 'needs-ok'`; open `Need` (`state === 'open'`); `counts.waitingForYou`; `status.needsYou` | Need + task records |
| **Ready for review** | `Task.reason === 'changes-ready'`; `counts.changesWaiting`; `DocumentInfo.hasChangesWaiting` | change records |
| **Finished recently** | `Task.state === 'done'` with a recency window over `moves[].at`; `counts.historyToday` | task moves + History |

Three rules for whoever builds this:

1. **No new persisted state.** If a status cannot be derived from task, run, Need, review or evidence
   records, the answer is to fix the underlying record, not to store a display state beside it.
2. **One projection function, shared.** The overview, the Project header and the rail must not each
   compute "needs you" slightly differently. `taskBoardState` is the precedent to follow.
3. **"Recently" is a parameter, not a truth.** `Finished recently` needs an explicit window. It is a
   display parameter; it must never become a retention rule, and it must never cause anything to be
   pruned (decision 10).

`Task.reason` already carries a third value, `'went-wrong'`, which none of the four statuses covers.
It should surface as **Needs you** rather than being silently dropped — a task that went wrong is
precisely a thing that needs a person. Flagged for Andrew if a fifth status is preferred instead.

---

## 5. What this changes, and what it must not

**Changes**

- A Project is stated as the durable container for an outcome and its working context, with the
  Diomedes Agent working across it rather than inside one Thread.
- One Files surface, in two tiers: a general-purpose Core file and artifact surface, and an IDE-grade
  tier supplied by the Software Engineering Capability Pack on activation.
- The capability-pack contract: a pack composes tools, Agents, rules, context, workflows and UI
  affordances over the same Core contracts, and activation is not authorization
  ([`2026-09-10-capability-packs.md`](2026-09-10-capability-packs.md)).
- Repository instruction files become first-class, discovered standing guidance with an inspectable
  indication.
- Project and global overviews should present derived human statuses.

**Open for Andrew**

- Whether an opted-in repository-aware tree shows dotfiles (§2.3, Gap 2).
- Pack granularity, activation surface and workspace policy
  ([`2026-09-10-capability-packs.md`](2026-09-10-capability-packs.md) §5).
- Whether `'went-wrong'` surfaces as **Needs you** or earns a fifth status (§4.2).

**Must not change**

- Diomedes does not become a coding IDE, and Projects stay general-purpose (decision 12).
- No second application surface, and a pack does not add one (decisions 1, 14).
- No competing file authority: every byte still arrives through `server/paths.ts` (decision 13).
- The path guard's `blocked` and `privateNames` sets are not display preferences and are not
  negotiable by a setting or a pack (decision 11).
- A pack's toolset is not loaded for Projects that do not need it, and activating one grants no
  authority (decision 14).
- No parallel lifecycle or state machine for the UI (§4.2).
- Nothing here is shipped, and nothing here may be described as shipped (decision 13).

---

## Sources

Fetched 2026-09-10:

- [Cursor Projects (blog)](https://cursor.com/blog/projects)
- [Cursor Projects (changelog)](https://cursor.com/changelog/projects)
- [Agents Window (Cursor docs)](https://cursor.com/docs/agent/agents-window)
- [Cursor changelog](https://cursor.com/changelog)
- [Reviewing agent work (Cursor docs)](https://cursor.com/docs/agent/review)
- [Agents Window walkthrough (third party, lower confidence)](https://www.learncursor.dev/learn/cursor-agents/agents-window)
