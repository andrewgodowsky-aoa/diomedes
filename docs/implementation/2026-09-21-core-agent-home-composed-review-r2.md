# Home composition review, final local acceptance

Verdict: accepted for PR 29, exact candidate
`9060128ad4f42895c045a7a56770ce021a2ada8a`.

The reviewer independently inspected and executed the separate authors' work.
The accepted contract, drivers, server and client reviews retain their original
scope and disclosures. This report adds the full composed execution; it does not
claim publication, installed proof or a live provider result.

## HCF-1 correction

The first composed full run at `89f0d16` failed one existing native turn-identity
fixture before its identity assertions: Home defaulted to AWS, while that fixture
scripted only Claude Code. Immutable review `dbbaa56` recorded the failure before
any correction. The original client author added only an explicit existing thread
route PUT and its comment in `tests/conversation-turn-id.test.ts`, committed at
`9060128`. Every original command, identity assertion, response and cleanup hook
is preserved, as are the real app, Store and native session driver.

Independent focused execution passed both tests. The same two tests also passed
inside the final full suite. No product default, guard or permission was changed
to accommodate the fixture. The original failed run and its complete logs remain
available; they are not replaced by the final green result.

## Exact composed gates

The integration worktree was clean at the candidate above. The pinned coordinator
granted exclusive slot `slot_mubesliv_a244a003` to role `astra`, PID 43452, start
`2026-09-21T04:32:24.4162630Z`, worktree `core-agent-bot`. Checks ran sequentially:

| Check | Independent result |
|---|---|
| TypeScript, `tsc --noEmit` | exit 0 |
| Production Vite build | exit 0; existing large-chunk advisory retained |
| Original page, Home Luna and frozen HLR files, one worker, zero retries | 50 passed |
| Full Playwright, one worker, zero retries | 176 passed, zero failed, zero skipped, zero flaky |
| Full Vitest, one worker | 252 files passed; 4,682 passed, zero failed, four skipped; 4,686 total |

Vitest took 494.70 seconds. The complete run ended at
`2026-09-21T15:50:43.1535485Z`. The 40 tracked screenshot outputs were restored by
exact filename to the gated commit. The final tree is clean and the slot released.
No typecheck or preview ran alongside another local heavy check.

Frozen-oracle checks preserve the original AWS authority file, admission matrix,
independent admission seam, 3,034-byte R4 payload, all seven R2 payloads, and the
original R5/R6/admission/composed-baseline reports. The final full suite includes
those original files. The HLR browser file remains unchanged from its separately
reviewed artifact.

## Evidence and limits

Evidence root: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`.
The `home-composed-final-r2-*` logs, result JSON and uniquely named page/browser
artifact directories bind the candidate, identity and slot. Machine reports:

- Unit JSON SHA-256:
  `9533cbdf93b2d3cb74dc35e668c7a9722911f434e6160f07498fa9039e371554`.
- Browser JSON SHA-256:
  `ab8e52a7e9e56d61125b71f0e1fbce918d8fc802c464f55bdd654155184cbb76`.

The original client R13 closure, admission successor and AWS composition were
independently accepted before Home implementation. The Home acceptance reports
preserve all failed initial schedules and disclosed mutation survivors, including
the two inserted driver yields and overlapping client guards. A suite pass does
not turn a survivor into a killed mutation or a modeled boundary into proof of
every browser scheduling order.

All provider traffic is scripted or fake. Live Luna, its spend cap and credentials
remain with Andrew and the AWS owner. Streaming preview, a populated results
ledger, crash-atomic admission and a founder packaged AWS journey are unclaimed.
PR readiness and merge still require current hosted checks and a drift check.
Release versioning, a fresh candidate build, installer/runtime proofs, publication
and the website update follow only after the accepted PR merges.
