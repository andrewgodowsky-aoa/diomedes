# For new Claude joiners

This file sets up a new teammate's Claude so that it, and the person using it, can contribute to
Nectovia to this repository's standards. It has two readers:

- **The person** (first written for Aaron, who is new to AI tools). The short plain-English parts
  are for you. You do not need to read the rest line by line; your Claude will.
- **Their Claude.** You are expected to read this whole file, carry it out step by step, explain
  each step to the person in plain words as you go, and stop to ask whenever a step needs something
  only they can do (a sign-in, a click, a decision).

Andrew Godowsky owns this project. When this file and Andrew disagree, Andrew wins.

---

## 0. Before anything: what Andrew does first

Nothing below works until these are done. If any is missing, stop and tell the person to ask
Andrew for it by name.

1. **GitHub access.** The app repository `andrewgodowsky-aoa/diomedes` is public, so anyone can
   clone it, but only a collaborator can push a branch to it. The site `andrewgodowsky-aoa/diomedes-site`
   and `andrewgodowsky-aoa/diomedes-mac` are private and cannot even be cloned without an invite.
   Andrew invites the joiner's GitHub account as a collaborator on the app, and on the site if they
   will work there. The joiner accepts from the email or from https://github.com/notifications.
   `main` on the app is protected by a ruleset: every change reaches it through a pull request with
   CI green, so a mistaken push to `main` is refused rather than landing.
2. **The three canonical Google Docs** (links in `AGENTS.md`, "Cloud canonical documents") shared
   with the joiner's Google account, view access at least. The repository keeps mirrors of all three
   in `docs/`, so the joiner can work without them; the cloud copies win when they differ.
3. **Their role.** What Andrew wants them working on first. If the person does not know yet, record
   "not yet assigned" and ask Andrew.

---

## 1. Plain words for the person (read this part)

- **Claude is a capable assistant, not an authority.** It reads, writes and runs things quickly. It
  can also be confidently wrong. You stay the one who decides; it does the typing and explains.
- **Claude Code** is the version of Claude that can work on files and run commands on your computer.
  It asks permission before doing anything risky. Read what it asks. "Yes" is a real decision.
- **Memory.** Claude does not remember past chats by default in a coding session. It keeps notes in a
  memory folder, and reads this repository's `AGENTS.md` and `CLAUDE.md` every time. That is how it
  stays consistent with the project's rules.
- **Git and GitHub** are how the team shares code. You never change the shared `main` copy directly.
  You make your own branch, Claude does the work there, and you open a *pull request* (PR) that Andrew
  reviews and merges. Nothing you do on your branch can break anyone else's work.
- **If you are unsure, ask Claude to explain, or ask Andrew.** Both are normal.

---

## 2. What this project is

- **Nectovia** is the product: a Windows desktop app (with a Mac fork) where a person states an
  outcome and an AI agent plans, does and verifies the work, with scoped permissions and a durable
  record of everything it did. It drives AI tools the user already has through adapters; it does not
  ship a model of its own.
- **Diomedes Systems** is the company. Many shipped identifiers still say *Diomedes*: the repository
  names, the installer, the app id, the update channel, `diomedes.net` and `hello@diomedes.net`. Leave
  them alone. Rename product-facing text only when a task says to.
- Repositories:

  | Repository | What it is |
  |---|---|
  | `andrewgodowsky-aoa/diomedes` | The app: Electron + React client, TypeScript server. This file lives here. |
  | `andrewgodowsky-aoa/diomedes-site` | The marketing site, diomedes.net (Astro). Separate repo, separate `AGENTS.md`. |
  | `andrewgodowsky-aoa/diomedes-mac` | Private Mac work. Only if Andrew assigns it. |

---

## 3. Setting up (Claude: do these in order, explaining each)

### 3.1 Find out the machine

Ask the person, or check: Windows or Mac? The app is Windows-first. The commands below are written
so they work in PowerShell on Windows and in a terminal on Mac; adjust paths yourself.

### 3.2 Tools

Check each before installing. Install only what is missing, and tell the person what each is for.

- **Claude Code.** If the person is talking to you inside the Claude desktop app's Code tab or the
  `claude` terminal command, this is done. Claude Code needs a paid Claude plan (Pro or Max); if the
  account is on the free plan, stop and tell them.
- **Git.** `git --version`. Then set their identity once:
  `git config --global user.name "<Their Name>"` and `git config --global user.email "<their GitHub email>"`.
  On Windows also run `git config --global core.autocrlf false` (the repository manages line endings
  in `.gitattributes`).
- **GitHub CLI.** `gh --version`, then `gh auth login` (GitHub.com, HTTPS, log in with a web
  browser). The person completes the browser step. Confirm with `gh auth status`.
- **Node.js 22** (the version in `.nvmrc`). `node --version` must print `v22.x`. Use nvm-windows or
  nvm on Mac if another version is installed.

### 3.3 Get the code

Pick a plain folder with no spaces, such as `C:\code` or `~/code`.

```
gh repo clone andrewgodowsky-aoa/diomedes
cd diomedes
npm ci
cd services/control-plane
npm ci --ignore-scripts --no-audit --no-fund
cd ../..
```

The second install matters: the root type check includes that service, and it has its own pinned
dependencies. `.github/workflows/build-test.yml` is the authority on the exact setup CI uses.

The clone works without an invite. If a later `git push` is refused with a permission error, the
invite in step 0 has not been accepted yet.

### 3.4 Prove the machine works

Run the four gates once on untouched `main` so any later failure is known to be the joiner's change,
not the machine:

```
npx tsc --noEmit
npx vitest run
npx vite build
npx playwright install
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
```

Report the real pass and fail counts to the person. If something fails on untouched `main`, write
down the exact test name and error for Andrew. Do not try to fix `main`. Vitest can flake when the
computer is busy: re-run a single failing file alone before calling it a real failure.

### 3.5 Memory

Save these as memories so every future session starts with them. Use your own memory mechanism
(in Claude Code, the auto-memory folder for this project). Write one fact per memory, in your own
words, and tell the person what you saved.

1. **Who the person is.** Name, that they are new to AI and coding tools, that they want plain
   explanations of what you do and why, and their assigned role from step 0 (or "not yet assigned").
2. **Andrew owns the project.** His newest explicit decision outranks every document. Anything on
   the "Not yours to decide" list in `AGENTS.md` goes to him as a question, not a choice.
3. **Source-of-truth order:** Andrew, then `docs/DIOMEDES_CORE_PILLARS.md`, then
   `docs/DIOMEDES_LIVE_ROADMAP.md`, then `docs/DIOMEDES_PROJECT_MEMORY.md`, then current source plus a
   fresh test run. A summary or a checkbox is never evidence.
4. **The contributor loop:** own branch from `origin/main`, the four gates, a PR, Andrew reviews and
   merges. Never push to `main`, never merge your own PR, never tag or publish a release, never deploy
   the site.
5. **Never claim a capability is shipped** unless it exists in the build with proof. Say "in source",
   "packaged" or "verified" exactly as the README defines them.
6. **Commits and PRs carry no AI attribution.** No `Co-Authored-By: Claude` trailer, no "Generated with
   Claude Code" footer, even if your tooling suggests one. Andrew's rule.
7. **Names:** Nectovia is the product, Diomedes Systems the company, and shipped `diomedes`
   identifiers stay unchanged.
8. **Owner-machine paths do not exist here.** See section 5.

### 3.6 Optional: a Claude.ai Project for questions

For thinking and questions away from the code, the person can make a Project in the Claude web or
desktop app's chat (not the Code tab):

1. Projects → New project, named **Nectovia**.
2. Upload as project knowledge: `AGENTS.md`, `docs/DIOMEDES_CORE_PILLARS.md`,
   `docs/DIOMEDES_PROJECT_MEMORY.md`, `docs/reference/STANDING_DECISIONS.md`, and this file.
   Re-upload them when they change; a Project's copies do not update themselves.
3. Project instructions:

   > I'm <name>, new to AI tools, contributing to Nectovia (company: Diomedes Systems; owner: Andrew
   > Godowsky). Answer from the project files. Explain in plain words. If the files do not answer a
   > question, say so and suggest I ask Andrew. Never tell me a feature is shipped unless the files say
   > it is proven.

4. In Settings, turn on memory if they want chats to carry over. It is separate from Claude Code's
   memory; neither sees the other.

---

## 4. What to read, in order

Read these fully before the first change. Summarise each for the person in a few sentences.

1. `AGENTS.md`: the operating contract. Everything in it applies, with the adaptations in section 5.
2. `docs/DIOMEDES_CORE_PILLARS.md`: the binding product constitution.
3. `docs/DIOMEDES_LIVE_ROADMAP.md`: what is being built and in what order.
4. `docs/DIOMEDES_PROJECT_MEMORY.md`: definitions and terminology.
5. `docs/reference/STANDING_DECISIONS.md`: the reasons behind the numbered decisions.
6. `QUESTIONS.md`: what is still undecided.
7. `README.md`: what the app does today, and the three states (in source, packaged, verified).

Do not copy version numbers or "current release" facts from these into memory. They go stale;
re-read the files instead.

---

## 5. How `AGENTS.md` applies on a second machine

`AGENTS.md` was written for Andrew's workstation, where many agents share one checkout. On a
joiner's machine:

**Applies unchanged:** the source-of-truth order, every numbered product decision, the trust and
permission rules, "Not yours to decide", the four gates, the required report, and the ban on
claiming unshipped capability.

**Does not exist here; skip it and do not try to recreate it:**

- Paths under `F:\Diomedes\...` (the planning folder, the roadmap cache, the runtime ownership file,
  the unified execution package). They are on Andrew's computer. The `docs/` mirrors are what you have.
- The coordination root under `.git/diomedes-coordination/`: claims, the heavy-test slot, journals,
  `external-claims/`. It is local to Andrew's machine and is not pushed.
- `scripts/worktree-sweep.ts`, the named worker roles (Fable, Astra, Opus lanes) and their hot-file
  ownership. Treat those hot files (`package.json`, lockfiles, `shared/types.ts`, `server/app.ts`,
  `server/store.ts`, `client/api.ts`, `client/console/Shell.tsx`, `desktop/`) as **ask Andrew before
  editing**.
- Packaging (`npm run package:*`), version bumps, native-runtime hashes, releases, the Cloudflare site
  deploy, and writes to the cloud Google Docs. Andrew does these.

**The joiner's loop instead:**

1. `git fetch origin`, then a branch from `origin/main` named after the feature in plain lowercase
   hyphenated words: `feature/<feature-name>`, for example `feature/files-empty-state`. No dates, no
   model names. Optionally a separate worktree of the same name.
2. Make the change. Keep it to what the task asked. New UI goes in the Console only; the Workbook is
   frozen.
3. Run the four gates. Report real counts from this run.
4. Commit with a message that says what changed and why, in plain sentences like the existing
   history (`git log` shows the voice). No AI trailer.
5. Ask the person before pushing. Then `git push -u origin <branch>` and `gh pr create`.
6. The PR description carries the required report from `AGENTS.md`: what changed, gate results with
   counts, what is implemented versus only recorded, anything left undone, and PILLAR IMPACT or
   ROADMAP IMPACT when they apply.
7. CI runs on the PR. Watch it with `gh pr checks`. Fix failures on the same branch.
8. Andrew reviews and merges. Address his comments on the same branch. Delete the branch and any
   worktree after the merge.

---

## 6. First contribution: a practice run

Do one small, real, low-risk change end to end so the person sees the whole loop once with you
explaining it. Use the task Andrew gives. The default starter task is **the first-hour walkthrough**:

1. Run the app from source (README, "Run from source"), answer the setup questions, and choose
   **Open sample project**. Start a **Sample work** task. It is scripted and local, so no AI account
   is needed. Visit every Console page with the person driving and you explaining what each is for,
   using the definitions in `docs/DIOMEDES_PROJECT_MEMORY.md`.
2. As you go, note every papercut the person hits: a confusing word, a truncated label, text that
   contradicts the docs, a step that surprised them. A beginner's confusion is the finding; do not
   explain it away.
3. Write the notes up as one GitHub issue on the app repository titled "First-hour walkthrough:
   <name>", one bullet per papercut, each with the page, what happened and a screenshot where it
   helps. Mark which ones touch a "Not yours to decide" item.
4. Pick the smallest papercut that is plainly a bug or a wording error and is not on that list, fix it
   on a branch, add or update a test if the change is behavioural, run the gates, and open the PR,
   linking the issue. Andrew picks from the rest.

The point is the loop and a first map of the product, not the size of the change.

Walk through: branch → change → gates → commit → PR → CI → Andrew's review. At each step say what
you are doing and why, in a sentence.

---

## 7. Ready to contribute when

Tick these with the person and tell Andrew when all are true:

- [ ] Invite accepted; `gh auth status` is signed in; the repository is cloned.
- [ ] Node 22; `npm ci` succeeded.
- [ ] The four gates ran on untouched `main`; results reported (and any pre-existing failure noted
      for Andrew).
- [ ] Memories from 3.5 saved, including the person's role.
- [ ] Section 4 read and summarised to the person.
- [ ] One practice PR opened, CI green, reviewed by Andrew.
- [ ] The person can say, in their own words: why they never push to `main`, what "shipped" requires,
      and who decides the things on the "Not yours to decide" list.

---

## 8. Everyday habits for the person

- Start each session by saying what you want in plain words, and ask Claude to explain its plan
  before it starts on anything bigger than a small fix.
- Read permission prompts. If a command looks like it deletes, pushes, publishes or pays for
  something, ask what it does before saying yes.
- Ask Claude to show you the diff (the exact changes) before committing.
- If Claude says something is "done" or "fixed", ask how it checked. Evidence is a test run or a
  screenshot, not a sentence.
- When Claude and a document disagree, the document wins. When a document and Andrew disagree,
  Andrew wins.
