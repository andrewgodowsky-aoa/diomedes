# Auto advisor preparation

Work order: performance audit item 7 of 9, `lazy-agent-advice`.
Branch: `feature/lazy-agent-advice`.
Worktree: `F:/Diomedes/diomedes-wt/lazy-agent-advice`.
Owner: assigned Codex worker; integration remains with the parent.
Base: `92bc57bd678865390f17291beb382642769e73e5`.
Scope claim: parent-held `claim_mv1p8yt8_4fa44619`.
Canonical mirrors: Core Pillars, Live Roadmap and Project Memory `2026-10-06.1`.

The agent-pick route awaited `jevAdvice` before `pickAgent` applied its rules.
That prepared the thread context under the Store lock and asked the Account
Agent gate even when the message had a deterministic answer. A rule-only pick
could therefore wait on account admission without using the advisor.

The repair prepares advice inside the fallback callback. A deterministic pick
does not enter advisor admission or preflight. Ambiguous picks still read the
current thread context, select its advisor and pass the existing admission
check before preflight. Advisor refusal and failures still abstain, preserving
the existing safe default and shortlist checks. The repair changes no account,
Runtime, Trust, route, permission or billing authority.

## Verification

The regression uses the HTTP route in the real app with a real AccountAgentGate,
controlled account doubles, empty engine discovery and a fake advisor. Accounts
and managed advice are disabled. A held admission promise proves that a rule pick
answers before admission is entered, without a timing threshold. The tests also
cover a refusing gate, admission before ambiguous advice, and a denied ambiguous
pick's safe default.

Targeted command, with the parent-held shared test slot:

```text
node node_modules/vitest/vitest.mjs run tests/agent-pick-route.test.ts --maxWorkers 1 --minWorkers 1
```

- RED before the source repair: 12 passed, 2 failed, 0 skipped in 1 test file;
  exit 1. The held gate was entered before the rule response, and the refusing
  gate was called once for a deterministic Fixer pick.
- GREEN after the repair: 14 passed, 0 failed, 0 skipped in 1 test file; exit 0.
  The delayed and refusing rule picks made zero gate/admission/preflight calls.
  Ambiguous advice remained gated, and denied advice kept the safe default.
- The first `npx --no-install vitest` attempt failed before collection with
  `Fatal process out of memory: Zone`, exit 1 and no test results. The direct
  entry point above completed RED and GREEN; that startup failure is not a
  regression verdict.
- `git diff --check` passed.

Parent integration owns the full TypeScript, unit, build and browser gates.
Hosted CI, live account/provider calls, packaging, installation and customer
acceptance are not part of this worker's verification. CI STOP remains binding.
