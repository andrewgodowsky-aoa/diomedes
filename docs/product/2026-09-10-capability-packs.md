# Capability packs: what a pack is allowed to change

**Status: approved architecture direction. No pack is implemented.**
Approved by Andrew, 2026-09-10. See `AGENTS.md` decisions 12 and 14.

A capability pack is how Diomedes becomes good at a kind of work without becoming a product for that
kind of work. The Software Engineering pack is the first one and the reason this document exists, but
the contract below is general: a Restaurant Operations pack or a Remodeling Administration pack would
be built the same way.

---

## 1. The decision

**A capability pack may affect the combination of tools, Agents, rules, context, workflows and
relevant UI affordances — not merely prompt text — while using the same Core Runtime, Trust and
Project contracts.**

That sentence is the whole architecture. Both halves are load-bearing:

- A pack that could only add prompt text would be too weak. "Be good at code review" in a system
  prompt is not a capability; a repo-aware tree, a diff view, a test command and a reviewer Agent are.
- A pack that could add its own runtime, its own permission model or its own file authority would be
  a second product. Packs compose existing primitives. They never introduce parallel ones.

**Do not inject or load a pack's toolset for users or projects that do not need it.** A Personal
Project tracking invoices must not pay for a symbol index, and its Console must not grow a Git status
column. Activation is the line, and the default side of that line is off.

---

## 2. What a pack may contribute

| Dimension | A pack may | A pack may never |
|---|---|---|
| **Tools** | Register tools scoped to the pack | Bypass work admission or the tool host's policy |
| **Agents** | Supply versioned Agent definitions and Teams | Create an Agent that carries its own authority |
| **Rules** | Add standing guidance and triggered corrections | Turn a rule into an enforcement surface that Trust does not back |
| **Context** | Contribute retrieval and context construction | Read outside the Project's guarded paths |
| **Workflows** | Supply durable workflows and commands | Own its own run, state or recovery machinery |
| **UI affordances** | Light up affordances on existing surfaces | Add a second application surface |
| **Permissions** | Declare what it needs | Grant itself anything |

The last row is the one to re-read. **Activating a pack is not an authorization event.** A pack
declares the capabilities it would use; Trust decides whether the person or organization has granted
them, exactly as it does for any other work. A pack that is activated but not authorized is a pack
whose tools refuse, visibly, for the ordinary reason.

This follows the existing Agent contract in `docs/DIOMEDES_PROJECT_MEMORY.md`: changing Agent, model
or Team never grants authority, and a handoff cannot launder permission. A pack is subject to the
same rule.

---

## 3. Where a pack sits

```
WORKSPACE / ORGANIZATION
  └─ PROJECT                        the durable container for an outcome
       ├─ CAPABILITY PACKS          activated per Project (and offerable per workspace)
       │    └─ contributes tools · Agents · rules · context · workflows · UI affordances
       ├─ THREADS + TASKS           unchanged
       ├─ FILES + ARTIFACTS         Core surface; a pack may deepen it
       ├─ PERMISSIONS               unchanged, and still the authority
       └─ EVIDENCE / HISTORY        unchanged, and still the record
```

Activation is a **Project-level** property, because the unit that is or is not a software project is
a Project. A workspace may make a pack available, recommend it, or require it; it is the Project that
turns it on.

A pack's contributions must be attributable. When a pack's Agent does work, attribution stays
truthful to the runtime-reported model and engine (`AGENTS.md` decision 8), and History records that
the work came from a pack-supplied Agent rather than silently presenting it as Core behaviour.

---

## 4. The Software Engineering pack

The first pack, and the reason for the split described in
[`2026-09-10-project-files-and-agent-overview.md`](2026-09-10-project-files-and-agent-overview.md) §1.

**Core keeps** the general file and artifact surface: the project folder and artifact model, ordinary
file preview, text and Markdown viewing, search, generated artifacts, history and version inspection,
references into Threads, and open-externally behaviour for common business files. Files are not
inherently a software feature.

**The pack supplies**, on the same surface: repository-aware tree · syntax highlighting · code
editing · project-wide code and text search · symbol, function and class navigation · line references
into Threads · Git status and history · unified or split diffs · changed-file review · diagnostics ·
test and build commands · worktrees and branches · repo-aware context construction ·
software-specific Agents and subagents · coding tools and workflows · automatic discovery of
repository instruction files · later, LSP and code intelligence where justified.

### 4.1 Repository instruction files

When a repository or project contains applicable instruction files — `AGENTS.md`, `CLAUDE.md`, and
relevant project documentation — the pack discovers them and feeds them through the correct context
and rule path. **Not by pasting them into a prompt**: an instruction file is standing guidance, and
Diomedes already distinguishes standing guidance, triggered correction and enforced policy. An
instruction file lands in that system, with its scope, source and version recorded, like any other
rule.

The person sees an unobtrusive indication:

> Project instructions loaded · AGENTS.md

Clicking it opens a readable rendered version. Two properties matter and are easy to get wrong:

1. **It is an indication, not a narration.** One line, on the surface where work happens. Diomedes
   says a thing once (`AGENTS.md` decision 4).
2. **Discovery is not obedience-in-secret.** A person can see exactly which files were loaded and
   read them as Diomedes read them. A rule the user cannot inspect is not standing guidance; it is a
   hidden behaviour change.

### 4.2 What this pack must not do

- Become a second surface. It deepens the Console's Files pane; it does not open an IDE window.
- Load for Projects that have not activated it.
- Expand the path guard. `server/paths.ts` still decides what may be opened, and `blocked` and
  `privateNames` are not a display preference (`AGENTS.md` decision 11).
- Turn Diomedes generally into a coding IDE. The pack is one Project's profile, not the product's.

---

## 4b. The Small Business pack (2026-09-23)

`diomedes.small-business` (`shared/capability-packs.ts`, content in
`shared/small-business-skills.ts`) contributes **skills**: twelve playbooks for recurring
restaurant, shop and service-business work, each one data (`PackSkill`): a plain name, a one-line
value, trigger phrases, the inputs it reads (each declared as one of the pack's `read-*` needs,
with exactly how to export, upload or connect it when missing), a read-and-draft Mode (Ask or
Plan), numbered steps, an output shape, where a visual helps, what it drafts, and a
not-professional-advice caution on every accounting, tax, legal and employment playbook.

- `validateManifest` refuses a skill that could act (`acts` is the literal `false`), runs in Build
  or Fix, reads an undeclared need, or renders past 8 KB; and a pack that declares any outward
  capability at all.
- A skill never sends, posts, pays or messages anyone. What would reach someone else is a draft
  headed "Draft for you to send".
- Launch: with the pack on, the project's Ctrl K palette lists the playbooks; `Use` opens an empty
  or new thread in the skill's Mode, fills the composer with a starter the person can edit, and
  names the playbook beside the box. Nothing is sent until the person sends it.
- Delivery: `/api/projects/:id/ask` takes `skill`, and `assembleSkillSection`
  (`server/harness/instruction-delivery.ts`) appends the playbook to the Mode's instructions,
  whole or refused, only while the pack is active. The message stays as typed; the turn records
  which playbook and pack version ran.
- Not yet: the Diomedes home conversation. Its runs pin one instruction digest per lineage, so a
  per-message playbook there needs a decision (for example, a new lineage per skill).

---

## 5. Open questions for Andrew

1. **Granularity.** Is Software Engineering one pack, or a base pack plus optional pieces (Git,
   diagnostics, LSP)? One pack is simpler; pieces let a person take diffs without a language server.
2. **Activation surface.** Project settings, a first-run question, or inferred-and-offered when a
   repository is detected? Inference must offer, never self-activate.
3. **Workspace policy.** May a Business workspace require or forbid a pack for its Projects?
4. **Dotfiles.** Does the pack's repository-aware tree show dotfiles, and is that the pack's decision
   or Core's? Carried over from the Files investigation, §2.3 Gap 2.

---

## 6. What is true today

This section was written before anything was built and is kept as the record of that starting
point. Since then the pack mechanism, the Software Engineering pack's instruction-file discovery
and the Files pane landed (`docs/implementation/2026-09-11-*.md`), and the Small Business
pack's playbooks landed on a feature branch (section 4b). Nothing beyond what those records prove
may be described as shipped anywhere, including the website.
