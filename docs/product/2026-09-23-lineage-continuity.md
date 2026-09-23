# Lineage continuity: open conversations survive an instruction change

**Decision record.** Version 2026-09-23.1 (implemented on the branch). Andrew's decisions of 2026-09-23 07:21 EDT:
- a lineage keeps the instruction text it started with, behind a code-owned digest list;
- a revoked digest forces a reset;
- every reset shows a visible note in the thread.

Release 0.1.8 is held until this is on main.

**Status: implemented and tested in `feature/lineage-continuity` (worktree
`F:/Diomedes/diomedes-wt/lineage-continuity`, base `6ee757c`, with `origin/main` at `8424710` merged in).
Not merged to main and not released.**

## The defect

A conversation lineage records the instruction text it started with. When a release changes the
composed text, the next message in an open thread fails the scope check (`SESSION_MISMATCH`). The host
then retires the lineage (`scope-change`) and starts a new generation. That generation carries none of
the earlier turns:
- on the model-API routes, `history()` reads only its own run's steps;
- Claude Code starts a fresh native session.

Nothing in the client reads the retirement, so the person is never told. PR #38 (8597bb1) appended the
visual instructions to Ask and Plan after v0.1.7. Updating from 0.1.7 would therefore silently drop the
context of every open Ask and Plan thread.

## Findings

Line numbers are those of the commit that carries this record.

### What a lineage records, on each driver

Both drivers record the same text: the bare composed text
`instructionsFor(mode, MODES[mode].instructions)` (`server/app.ts:3437`), as `run.input.instructions`.
- Claude Code: `scope()` at `server/harness/claude-session-run.ts:136-143`. It is recorded when the run
  starts (`:619-628`) and compared whole on every later message (`:659-660`).
- Model API: `scope()` at `server/harness/model-session-run.ts:184-192`.

A digest therefore identifies one mode's text in one build, whichever driver recorded it.

**Model API.** Each message runs in its own child run. That run gives the adapter
`${instructions}\n\n${TOOL_NOTE}`, plus `readToolsNote(scope)` on Ask and Plan when there is a read
scope (`model-session-run.ts:765-766`).
- The adapter digests that text into its profile (`profileHash`, `server/harness/model-api-adapter.ts:118`).
- `boundProfile` (`:134-136`) binds the profile to one child run, never across messages.

So the tool notes never retire a lineage, and changing them needs no digest.

**Claude Code.** The native checkpoint's `instructionDigest` is SHA-256 of the same bare text
(`server/engines/claude-session.ts:16`, `:110`).
- It is checked when a session is restored (`:147`) and on every turn (`:229`).
- `readScopeNote(scope)` is appended only to the `--system-prompt-file` bytes (`server/engines/claude.ts:713-714`,
  `:721-724`). This happens at every process start, including `--resume`, and the note is never digested.

So the recorded text alone reproduces the digested start text, and a Claude Code lineage can continue
under it.

**Except under a different read scope.** A checkpoint also keeps the read scope its session was opened
with (`scopeDigest`, `claude-session.ts:124`).
- A 0.1.7 checkpoint has none, which reads as text-only (`:148`, `:230`).
- Today every Ask and Plan turn carries a read scope when the project folder exists (`readScopeFor` in
  `server/app.ts`).
- The session is opened inside the turn step (`claude-session-run.ts:768-806`), an external model step.
  A refusal there parks the run `reconcile_required` (`server/harness/run-service.ts:174-176`), and that
  message fails.

So a 0.1.7 Claude Code Ask or Plan lineage cannot continue once its turn carries a read scope, which
is whenever the project folder exists. It now retires, with the note, before anything is sent. Without a
read scope it continues under its v0.1.7 text. Automatic's text has not changed since v0.1.7, so its
Claude Code lineages continue.

**v0.1.6.** Native sessions existed only through `/api/projects/:id/claude-sessions`: one run per command,
with no thread lineages. No client or desktop code at v0.1.6, v0.1.7 or now calls that route. Nothing
v0.1.6 persisted can be continued by a thread message, so its texts are not listed.

The Claude Code CLI pin is 2.1.252 at v0.1.6, v0.1.7 and now.

### The known texts

| SHA-256 (first 12) | Text | Recorded by |
|---|---|---|
| `f7db240c8969` | Ask, v0.1.7 | Both drivers |
| `c1e0bbd32438` | Plan, v0.1.7 | Both drivers |
| `ab8ce0359b49` | Automatic, v0.1.7 and 0.1.8 (unchanged) | Both drivers |
| `78350c2f27c9` | Ask, 0.1.8 (adds the visual instructions) | Both drivers |
| `a84d062e38dc` | Plan, 0.1.8 (adds the visual instructions) | Both drivers |

Each text was produced by that build's own composer:
- v0.1.7 from `git archive v0.1.7 server shared`;
- 0.1.8 from this branch.

The texts are kept verbatim in `tests/fixtures/instruction-texts.json`. The revoked list is empty. Build
and Fix have no lineage and are not listed.

## Design

1. **`server/instruction-digests.ts`** holds three things:
   - `KNOWN_INSTRUCTION_DIGESTS`: the five digests, each labelled with its mode and builds;
   - `REVOKED_INSTRUCTION_DIGESTS`: empty;
   - `instructionDigest()`.

   A text change adds its digest and fixture and keeps the old ones. A security-relevant change revokes a
   digest rather than deleting it.
2. **`server/lineage-continuity.ts`** holds four functions:
   - `recordedInstructions()` judges a run's recorded text as known, revoked, unknown or absent;
   - `boundInstructions()` picks the text a message is sent with;
   - `retirementNote()` and `lineageNoteTurn()` write the note.
3. **`resolve`** (`server/app.ts:3437-3679`):
   - Today's text is composed first (`:3437`). The text a message is sent with is bound only after the
     lineage is chosen (`:3679`).
   - A read-back binds the text its answering run recorded (`:3462`).
   - The read scope is decided before the lineage (`:3565`), because a Claude Code session keeps the one
     it was opened with.
   - The current lineage's recorded text is read once (`:3612`).
   - On Claude Code, a lineage takes its recorded text only when its saved scope digest matches this
     turn's (`:3617`). `status()` now reports that digest (`server/harness/claude-session-run.ts:237`).
   - A revoked text retires the lineage. So does a recorded text that differs from today's when this
     message cannot be sent with it: an unknown text, or a known one on a Claude Code session whose read
     scope changed. Both retire before anything is sent, as the scope check would have retired them
     (`:3632`).
   - Otherwise a known text is sent as recorded. The message stays on the same run and generation, and
     on the model-API routes it carries the same history.
   - Every retirement records its cause. The lineage change and its note are persisted together (`:3664`).
4. **The note** is a `role: 'diomedes'` turn.
   - It carries the application's origin (`applicationOrigin()`), the mode, and the route the
     conversation continues on. `selectedEngine` falls back to the last answer's route, so it still reads
     the same route with the note in place.
   - Its id is SHA-256 of the retired run and the command. A retry or a restart finds it and never writes
     a second.
   - It sits before the message that met the change.
   - Wording: "Nectovia started this conversation fresh because *reason*. Your earlier messages are still
     here, but it won't remember them." The reasons are:

     | Cause | Reason |
     |---|---|
     | Instructions changed or revoked | its instructions changed |
     | Tier | this conversation moved to the *Tier* tier |
     | Tier, when none applies now | this conversation moved to another tier |
     | Route | this conversation moved to *route name* |
     | Model | this conversation now uses a different model |
     | Account or other settings | the settings it runs with changed |
     | Run ended | the earlier conversation stopped and could not be picked up again |
     | Budget | the earlier conversation reached its length limit |
5. **Metering.** The job estimate prices the text the next message will be sent with
   (`nextModelInstructions`, `server/app.ts:3397`, used at `:4803`).
6. **Client.** No change. The note is a thread turn and shows wherever turns show:
   - the Nectovia page renders every turn (`client/console/Diomedes.tsx:254-272`) and re-reads the thread
     after each answer (`client/console/DiomedesHome.tsx:227-239`);
   - a project thread joins the note to the exchange before it (`client/console/ThreadView.tsx:231-238`).

   It never reaches a model:
   - model-API history is built from the run's own steps;
   - the sharing upgrade pairs only a person's turn with the answer right after it
     (`server/cloud-sharing.ts:121-125`).

## Tests

Each test below was run against the unfixed code and failed there for the reason given.

| Test | Proves | Unfixed result |
|---|---|---|
| `tests/lineage-continuity-aws.test.ts`, Ask | A v0.1.7 Ask lineage continues after the update: same run and generation, not retired, sent under its v0.1.7 text with its history. | A new run: the lineage retired. |
| same, Plan | The same for Plan. | A new run. |
| same, revoked | A revoked digest retires the lineage with exactly one note. The next message continues the new generation. | No note. |
| same, unknown | An altered recorded text retires as before, under today's text, with one note placed before the message that met it. | No note. |
| same, tier | Efficient to Thorough writes one note naming Thorough. A retry writes no second. | No note. |
| same, estimate | The job estimate prices the recorded text. | Equal estimates (841,091 micro-USD both). |
| `tests/lineage-continuity-claude.test.ts`, Automatic | Automatic continues across an update, and the resumed session is opened with the recorded text byte for byte. | A new run. |
| same, v0.1.7 Ask | A v0.1.7 Ask lineage under a read scope retires before anything is sent, with one note, on a fresh session. | No note. |
| same, refusal | A refused turn ends that message only. The next message is answered on a new generation, with one note. | No note. |
| `tests/instruction-digests.test.ts` (8) | The golden list: every fixture reproduces its digest, and today's texts are known. | Changing one character of the Ask text fails it (`ask: expected false to be true`). |
| `tests/interaction-seam.test.ts` R-10 | A budget retirement writes one note, and a retry and a restart write no second. | No note. |
| `tests/home-luna.spec.ts`, tier change | On the Nectovia page, Default to Efficient shows the note once, between the two exchanges. | 0 notes. |

The model-API tests run the real app over HTTP; only the Responses transport is scripted. The Claude Code
tests use the fixture adapter, whose checkpoints have no scope digest, like 0.1.7's.

## Open items

1. **The refusal premise.** The brief's accepted consequence cannot arise.
   - In that scenario, a continued 0.1.7 Claude Code lineage meets a read-tool refusal on a selected turn.
   - But a 0.1.7 Ask or Plan lineage retires whenever its turn has read tools, and a lineage that
     continues has none to refuse.

   Separately, no Claude Code lineage continues after any failed turn:
   - the failed turn parks its run `reconcile_required`;
   - the next message retires it (`terminated`) and starts a new generation, now with the note.

   The thread is not wedged, but "the next message must still continue it" cannot hold. The refusal test
   states exactly that.
2. **Claude Code, same text, different read scope.** One example is the read choice moving between
   selected documents and the whole project.
   - The session refuses to resume inside the turn, so that one message fails. The next retires the
     lineage with the note.
   - This is unchanged. Retiring up front whenever the scope differs would be a one-line change, and it
     is Andrew's call.
3. **Not verified against the real CLI.** Whether the Claude Code CLI accepts a changed
   `--system-prompt-file` on `--resume` is unverified. The tests use the fixture adapter.
4. **A Claude Code version change (inferred from the code).** The version is checked when the session
   opens, inside the turn (`claude-session.ts:97-98`). A future `CLAUDE_VERSION` bump would fail the first
   message on each open Claude Code lineage, then retire it with the note. This is unchanged.
5. **Untested wording.** The route, model and settings reasons are covered by code only. Leaving a tier
   for Default reads "moved to another tier".
6. **The estimate's history.** The job estimate still counts the whole thread as history, even when the
   next message would start a new generation. This was already so and is unchanged here.
7. **Two more reads per message.** `resolve` now reads the current lineage's run once more, and on
   Claude Code its status once more, under the store lock. That is fine for 0.1.8, but it will show in a
   profile.
