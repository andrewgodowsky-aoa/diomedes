# Plain writing: every answer is written, checked and repaired to one standard

Date: 2026-09-25 · Lane `plain-writing` · Branch `feature/plain-writing` · Builds on
`feature/rule-delivery-coverage` (PR #143), which made the rule path reach every person-facing
model call.

## What a person gets

Andrew asked for plain writing as core behaviour: the owner forwards what Nectovia writes and
sends drafts under their own name, so it has to read like a careful person wrote it. Three parts do
that:

1. **A writing standard in every call's instructions.** `WRITING_STANDARD`
   (`shared/plain-writing.ts`, 1,197 bytes, about 299 tokens) goes first in the rule path's
   section (`assembleInstructions`, `server/harness/instruction-delivery.ts`), so it travels with
   every message on every route PR #143 covers. Each rule carries its reason. Its bytes come off
   the section budget first; the delivery record says `writing: { version, sha256, bytes, state }`.
2. **One deterministic checker** (`checkPlainWriting`, `shared/plain-writing.ts`). Its rule list
   is one data file the owner can extend: `shared/plain-writing-rules.json`. The owner's own
   phrases come from Settings (`plainWritingPhrases`, up to 200, 2 to 80 characters, stored
   lowercased). Nothing is sent anywhere to check.
3. **One repair pass, never a loop** (`repairWriting`, `server/plain-writing.ts`). Unambiguous
   cases are fixed in code. Only the sentences still flagged go, once, for a short rewrite, and a
   rewritten sentence is kept only if every number, name, date, quote, citation and file name is
   unchanged (`rewriteKeepsFacts`) and it breaks fewer rules. Otherwise the original sentence
   stays. The pass never throws: a failed rewrite leaves the code-fixed answer.

The record of what happened (`PlainWritingRecord`: hits, code fixes, rewrite asked, accepted,
kept with a reason, what remains) goes on the run's own record for that answer.

## Rules

| Rule | What it catches | Fixed in code |
| --- | --- | --- |
| `em-dash` | `—`, a spaced `–`, a spaced `--` | Yes. Digit to digit becomes an en dash; a pair around a short aside becomes commas (parentheses if the aside has commas); one dash becomes a new sentence before a clause, a colon after a short label, else a colon or comma |
| `filler-opener` | "Great question", "Certainly,", "I'd be happy to help" at the first prose sentence | Yes, when it is its own sentence or leads one with a comma. "Sure." as the whole reply is the answer and is left alone |
| `closing-offer` | "Let me know if", "Feel free to", "Hope this helps" in the last paragraph | Yes, when it is the final sentence of a longer answer |
| `contrast` | "It's not X, it's Y", "isn't X, it's Y", "not just X but Y" | No: rewrite |
| `stacked-hedge` | Two or more hedges in one sentence, at least one an adverb or phrase | No: rewrite |
| `stock-phrase` | 56 words and phrases (the site's banned list plus additions: delve, robust, seamless, leverage, ...) | No: rewrite |
| `owner-phrase` | Whatever the owner adds in Settings | No: rewrite |

Plain ", not" corrections ("Tuesday, not Wednesday") are left alone on purpose (`contrastNote` in
the rule file). Excluded stock words, each with its reason, are listed in `stockPhrasesExcluded`:
journey, landscape, navigate, ecosystem and let's all have plain literal uses in a small business.

**Where the checker does not look:** fenced and indented code, inline code, block quotes, table
rows, links, paths and file names ("Fall menu.md"), quoted text, and any span that repeats the
person's own words (the request, the documents they attached). Look-alike characters from other
scripts are not dashes: `ー` (Japanese), `―`, `־` (Hebrew maqaf), `−` (minus) and ranges like
`Mon–Fri`.

## Where it hooks in

| Output | Standard sent | Checked | Code fixes | Rewrite | Record |
| --- | --- | --- | --- | --- | --- |
| Thread answer, model-API routes (AWS, Azure, OpenRouter, Vertex) | Yes (message rules, after the stable prefix) | Yes | Yes | One call, same admitted route and model | Turn step output `writing`; the rewrite is its own child run `…-writing` |
| Thread answer, native sessions (Claude Code, OpenCode, Cursor, Devin via ACP) | Yes (`contextMessage.rules`) | Yes | Yes | No | Turn step output `writing` |
| Direct Ask (`/ask`) | Yes (instructions channel) | Yes | Yes | No | `Turn.writing` |
| Work proposal: summary and changed `.md`, `.markdown`, `.txt` files | Yes (Work's own rules section) | Yes | Yes | No | `Session.writing` (parts with hits) |
| Weekly brief (deterministic) | n/a | Test only | Template fixed | n/a | n/a |
| Code, commit messages, the person's own text | No change | No | No | No | n/a |

The repair runs inside the turn step handler, before the step output is committed, so replay,
conversation history and the record all see the same repaired text.

**Why the rewrite only runs on model-API routes.** There the rewrite is one extra request through
the adapter the turn was already admitted on, as a child run with a hard budget
(`units: 2, modelCalls: 1, toolCalls: 0, wallMs: 60000`). It reserves against the same
per-connection exposure ledger, so it stays inside the existing credit cap and needs no new
admission, key or provider. "Cheapest allowed route" therefore means the one route already admitted
for this answer. A native session has no side channel: a second turn would enter the session's own
history and its instruction digest. Direct Ask and Work have no admitted model-API adapter at that
point. All three get the code fixes, which in the measurement below clear 160 of 161 hits on their
own.

## Deterministic text fixed at its template

The checker covers deterministic outputs by test only, so their templates were fixed:

- **Weekly brief Sources line** (`server/weekly-brief.ts`): `- [S1] Weekly operations exports: POS
  weekly summary — Imports/pos-weekly-….csv (SHA-256: …)` now reads `- [S1] … (Imports/…csv,
  SHA-256: …)`. This is the line in
  `docs/verification/2026-09-25-capture-polish/after-4-6-weekly-brief.png`. A test renders the old
  line (flagged: `em-dash`) and the new brief (no hits).
- **The brief's expected-output label** (`shared/packs.ts`): `Weekly operations brief (Produce a
  recurring report): A Monday note…` in place of `… brief — Produce…`. `outputName` still reads
  labels saved in the old shape.
- **Automation status words** (`shared/automations.ts`, `server/automations.ts`): `Manual, not
  scheduled`, `Missed: computer was off`, `Skipped: paused`, `Blocked: the setup changed` and the
  rest. A test checks every value in `SCHEDULE_OUTCOME` and `AUTOMATION_LABEL_TEXT`.
- **Change review** (`server/change-review/render.ts`, `rules.ts`), the **discovery export**
  (`shared/discovery.ts`), the **configuration refusal and route line** (`server/configuration.ts`,
  `shared/configuration.ts`), the **support bundle status** (`server/support-bundle.ts`), the
  **update notice** (`server/update-reconcile.ts`: `Updated to 0.2.0: 1 setting moved…`), the
  **remembered-approval note** (`shared/remembered-approvals.ts`), the **business setup choice**
  (`shared/business-setup.ts`) and the **rule-authority refusal** (`shared/rule-authority.ts`).

Left as they are, on purpose: developer diagnostics nobody outside the team reads
(`server/harness/conformance.ts`, `server/evaluation/route-matrix.ts`,
`shared/adapter-contract.ts`, `shared/theme-pack/compatibility.ts`) and the lone `—` that stands
for an empty value in change review's before and after cells. The Console's own copy in `client/`
(136 lines with a dash, many of them comments) is UI text owned by other lanes and is not in this change.

## H16 not reused

The H16 stream evaluator (`server/stream-rules/`) was the other candidate. It does not fit:
its grammar bans anchors and `\b`, allows one quantifier and looks at 512-character windows; it
watches a running loop and never rewrites output; and its "correct" action re-asks for the whole
answer, which the brief forbids. Plain writing needs sentence boundaries, skip zones and the
person's own words, so it has its own checker. Nothing under `server/stream-rules/` or
`shared/stream-rules.ts` changed.

## Before and after: 30 sample-business requests

**How it was measured.** All 30 requests in the five sample businesses' `scenarios.md` files
(`resources/sample-businesses/*`, merged in #140), answered twice each through the Claude Code CLI
on Andrew's existing subscription (`claude -p`, model `claude-sonnet-5`, read-only tools, no user
settings, run in a fresh copy of each business's `workspace/`). The system prompt was the product's
own `answerInstructions(mode)` for the scenario's mode, with `WRITING_STANDARD` put first for the
"after" run. These are live model calls, not fixtures, but they go through the CLI rather than
Nectovia's own adapters, and the CLI adds its own system prompt. Each request ran once per arm, so
single answers vary (one weekly brief went from 6 hits to 31). The harness, all 60 answers and
every repair record are in `docs/verification/2026-09-25-plain-writing/`.

| | Outputs with a hit | Hits | By rule |
| --- | --- | --- | --- |
| Before (no standard) | 30 of 30 (100%) | 161 | em-dash 161 |
| Code fixes alone, on the before answers | 1 of 30 | 1 | |
| After (standard sent) | 20 of 30 (67%) | 122 | em-dash 121, stock-phrase 1 |
| After, repaired (code fixes, then one rewrite) | 0 of 30 | 0 | |

- The standard alone removed a quarter of the hits (161 to 122) and shortened answers by 12%
  (67,878 to 59,699 characters). The model keeps writing em dashes when told not to; the code fix
  is what removes them.
- Repair: 116 code fixes and one rewrite call (one sentence, a stock phrase, accepted with its
  facts unchanged). Every code fix was read by hand. The first version of the dash fixer got three
  wrong (two unrelated dashes taken as a pair, a comma splice before "no one else", a short label
  split into two sentences) and a second pass found two more comma splices (a contraction, a verb
  past the fifth word). All five are fixed and each is now a test.
- **Added tokens per call:** about 299 input tokens (1,197 bytes of standard). The answer calls
  cost the same in both arms ($4.28 for 30).
- **Repair cost per 100 outputs:** 3.3 rewrite calls. Sent the way the product sends them (the
  rewrite instructions plus the flagged sentences only), one call was 747 bytes in and 301 bytes
  out, about 190 and 75 tokens. Per 100 outputs that is about 620 input and 250 output tokens,
  roughly $0.006 at Sonnet list prices, and 3.3 extra requests against the connection's allowance.
  The CLI's own figure for the same call was $0.021, because the CLI adds a 30,000-token system
  prompt that the product does not.

## Tests

- `tests/plain-writing.test.ts`: each rule, each skip zone, other scripts' look-alike dashes,
  the code repairs (including the five sample-run cases), fact checks, the standard's size, and the
  repair pass: a rewrite that changes a number keeps the original, a draft email with three flagged
  phrases, one pass at most, a failed rewrite, a clean answer.
- `tests/plain-writing-routes.test.ts`: a model-API thread (exactly two requests; the rewrite
  sees only the flagged sentences), a clean answer (no second call), a Claude Code session with an
  owner phrase from Settings, a Work proposal (summary and Markdown fixed, `price.js` untouched),
  the weekly brief, the old Sources line, and the automation status words.

## Limits and open decisions

- Work loops and team runs get the standard (PR #143) but their outputs are not repaired here.
- Native sessions, Direct Ask and Work get code fixes only (see above).
- Contrast framing is caught only in its flourish forms; plain ", not" corrections stay.
- Nested instructions: when a synthetic budget is smaller than the frame alone, the section can
  overflow the budget (an H11 edge, reachable only at test-sized budgets; unchanged here).
