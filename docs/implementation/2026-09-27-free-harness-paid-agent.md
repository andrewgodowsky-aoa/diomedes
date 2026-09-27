# Free harness, paid Agent (2026-09-27)

Feature: free-harness-paid-agent. Branch `feature/free-harness-paid-agent`, worktree
`F:/Diomedes/diomedes-wt/free-harness-paid-agent`, owner Andrew Godowsky. Base: origin/main
8daf0c1 plus `feature/home-link-spec-repair` f9553c9 (merged in, because this lane rewrites the
refusal that commit introduced). Merge f9553c9 first, or merge this branch in its place.

## Andrew's decisions (2026-09-27)

- **Individuals use the harness for free, for good.** This covers projects, the workspace, the task board (to-do and Kanban) and conversations on their own engines. There is no trial. A free Nectovia sign-in is still required.
- **The Nectovia Agent is what's paid.** That means the Agent, the bot, company-funded inference (our keys and our connections), our model integrations, and harness work that exists for the Agent. A project without paid access loses those parts and works like a regular harness; it is not refused wholesale.
- **Project instruction files are free.** A project's own instruction files reach the person's engine. Console rules and trigger rules stay paid. This narrows the 2026-09-25 "rule injection is paid" decision.
- **The free-version notice.** A person without a paid plan is told plainly that they're on the free version and the Agent is locked. The notice offers **Remind me later**, **Don't remind me again** and **Sign up for a plan**. Sign-up opens the pricing page, and that address is one setting so a Stripe checkout can replace it. The app says what's paid and what isn't.
- **Paid access is any active subscription**: a business plan, or an individual subscription the person owns. A person with no subscription of their own gets no Agent in Personal work or in an unlinked project, even as a business's Employee or Manager. A business never pays for someone's personal work.
- **An individual subscription is a real per-person purchase.** It is not a one-person business. It costs $250/month with 500 credits a month, like Starter. A business cannot buy it. (Starter already carries 500 credits in `MONTHLY_CREDIT_GRANTS`; nothing changes there.)

## Phase 1: the desktop app, buildable now (this branch)

### Paid access for one project
- `paidAccessFor(projectId)` is true when the business that owns the project includes `nectovia-agent`, or while that business's access has not been read yet (`unknown`, so the admission gate decides).
- Phase 2 adds the person's own individual subscription here.
- With accounts off (embedded tests), everything is paid, as the Agent gate already is.

### The conversation's effective route
- **Nectovia by default.** A thread on Nectovia by default (the person never chose it, `engineChoice !== 'person'`) in a project without paid access runs on the person's own AI. The stored thread is not rewritten. The substitution happens where the next request's route is resolved (`tierFor`, `threadRoute`, and the work-style and preflight views), so subscribing brings Nectovia back with no migration.
- **The person's own AI** is the setup's `defaultEngine`, but only when it is a *direct engine* that holds conversations (`isConversationRoute && !isModelApiRoute`, which today means Claude Code).
  - A model-API route on the person's own key (Bedrock, Vertex, Azure, OpenRouter) runs Nectovia's own loop. That is the Agent: the gate admits every model-API route, and Pillar 12 amendment 2026-09-25.1 says a customer-funded route never unlocks it. So it is not a free fallback.
  - With no direct engine chosen, the thread stays on Nectovia and is refused by the sentence below.
- **No tier where nothing pays.** A tier routes either to Nectovia's policy or to the owner's tier map, and the map only ever names model-API routes. So for a project without paid access, `tierFor` answers null and the thread keeps its own engine. Otherwise the default map would move a Claude Code thread onto Bedrock, and the gate would refuse it.
- **Nectovia chosen by the person.** A thread routed to Nectovia by hand in a project without paid access is refused, never moved.

### Refusal sentences (`shared/access.ts`)
- **No paid access anywhere:** `AGENT_FREE_VERSION_REASON`, "You're on the free version of Nectovia, so the Nectovia Agent isn't available here. Nothing was sent."
  - Where the host knows the person's AI setup (`nectoviaAccountFor`), `freeVersionRefusal(hint)` adds one hint. The hint never suggests installing or choosing an engine, and the only thing it suggests is a plan (Andrew, 2026-09-27: "does not suggest engines. if one doesn't have one installed, only suggest nectovia paid inference subscription"):
    - Nothing chosen: "Sign up for a plan to talk here."
    - A model key chosen: "A model key of your own also runs through the Nectovia Agent, so it needs a plan too. Sign up for a plan to talk here."
    - An engine that can't hold conversations, named because the person chose it: "ChatGPT can't hold a conversation yet, but it can still do Build and Fix work. Sign up for a plan to talk here." This case goes away for ChatGPT, OpenCode, Cursor and Devin once `feature/codex-conversation-driver` admits them as conversation routes.
  - The gate (`unpaidReason`) gives this sentence only when `agentPlan()` is `free`.
- **Paid access somewhere else:** a person with a plan through a business keeps `AGENT_PERSONAL_REASON` (switch workspace) or `AGENT_PROJECT_UNLINKED` (link the project). While their plan is still being read, they are never told they are on the free version.
- **Other paid-feature sentences** (business rules, phone access, included AI usage) now say "part of a paid plan", not "part of a Business plan", because the individual tier includes them.
- The account service's own `agent_not_included` sentence ("part of a Business plan") is unchanged here. Changing it deploys the Worker. It belongs to phase 2.
- **Paid access through a business, but this project isn't linked to it:** keeps `AGENT_PROJECT_UNLINKED`.

### The account view and the notice
- `AccountStateView.plan`:
  - `paid` is true when any active workspace includes the Agent, and in phase 2 when the person holds an individual subscription.
  - `unknown` is true while an active business's access is unread.
  - `plansUrl` is the sign-up address.
  - `notice` says whether to show the free-version notice.
- The notice choice is kept per person, in settings `planNotice[personId]`:
  - "Remind me later" hides it for 7 days.
  - "Don't remind me again" hides it until the person signs up and their plan lapses. A new sign-in doesn't bring it back.
- `POST /api/account/plan-notice {choice: 'later' | 'never'}` records the choice.

### What's paid, in the console
- The notice lists the paid parts once, in plain words. The locked places (Automations, Console rules, trigger rules, phone access) say they're part of a paid plan and offer sign-up, rather than telling a person to switch to a business.

### Instruction files
- `ownerRulesIncluded` no longer withholds a project's instruction files.
- Console rules and trigger rules still follow 'owner-rules'.

### Hot files
`server/app.ts` and `server/native-work.ts` are integrator-owned hot files (AGENTS.md). They are changed here under Andrew's explicit direction of 2026-09-27 to "rethink how this is done even if it means rewiring other portions". No other lane's claim covers the paths this branch touches (coordination status, 2026-09-27).

### Not in phase 1
- **Codex as a conversation driver: the largest gap against Andrew's ask ("codex is allowed too").** Codex already runs Build and Fix on a thread. A Codex *conversation* needs its own driver (CD-01 Decision 5), and the Codex route still doesn't stream and can't be stopped. It is a separate slice.

## Phase 2: the individual subscription (design only, needs Andrew's approval for the migration)

- **Migration 009.** 008 is ORG-01's and is unmerged, so 009 lands after it; the opt-in Postgres suites derive the applied count.
  - It adds `person_feature_grants` (FK to `persons`, no tenant) and a person-keyed credit period, and makes `agent_admissions.organization_id` nullable, with a subject kind.
  - Personal has no `tenantId`, so person funding is keyed on the person id.
- **Plan template.** An `individual` plan template ($250/month, 500 credits, the Business feature set) is issuable only to a person. `issueGrant` refuses it for an organization, and refuses a business plan for a person.
- **Contract.** `decideAgentAdmission`'s `personal_workspace` branch admits when the person's own entitlement includes the Agent.
- **Worker routes:** `GET /account/me/access` and `POST /account/me/agent-admissions`. The managed gateway accepts a person-subject admission.
- **Desktop.** The session keeps `personalAccess` next to the per-business map. The gate uses it when no business pays.
- **Operations app.** It needs a person search and a person-target grant form (a separate repo and commit).
- **Seed.** A second free demo person holds an individual grant.

## PILLAR IMPACT

Pillar 12 is amended as 2026-09-27.1: a free individual keeps a full harness on their own AI, and only the Agent and company-funded inference are paid. See `docs/DIOMEDES_CORE_PILLARS.md`.
