# Packaged desktop release review: launch navigation

Candidate: `cc04e425442249856879621db546ef2ae474f845`.
Final package built at `2026-09-21T18:54:33.193Z`, with committed source digest
`a5f53684ef95c28ee0319b8dd740d2a4d629086c9e9cb2c3d7f3189f15960d43`.

## Verdict

Publication is blocked by a stale navigation assumption in the standalone
desktop smoke. The source gates remain passed; no packaged desktop, installer
or installed-runtime acceptance follows from them. No production change is
proposed by this finding.

## Executed reproducer

The existing committed `scripts/desktop-smoke.mjs` ran unchanged against these
packaged bytes, through `node scripts/desktop-smoke.mjs`, with a child-only
isolated Codex home and the script's own fresh profile/data/project directories.
It failed before its first screenshot at line 70, the original
`expect(page.locator('.task-card')).toHaveCount(found.length)` assertion.
The error logger emits only the first line, so a second unchanged execution
used `DEBUG=pw:api` and a read-only observer which captured the page when the
original script closed its own window. The observer changed no navigation,
responses, fixture setup or assertion. Both runs exited 1. The script's raw
SHA-256 stayed `4fea48f41a4ac17f8c5df17eed4c4f6ae8b8181b223b0233a9a376e126020b67`.

Evidence under `F:/Diomedes/deliverables/core-agent-continuation-20260921/`:

- `release-v017-desktop-smoke.log` and `release-v017-proof-results.json`.
- `release-v017-desktop-diagnostic.log` and `-result.json`.
- `release-v017-desktop-diagnostic/close-1-page-0.txt`, `.html` and `.png`.
- `release-v017-final-build-info-rejected-smoke.json`, preserving the exact
  genuine final package record before the worktree's prior record was restored.

Both own heavy slots were released. The desktop process closed. The failed
driver wrote no new passing proof, and installer work never started.

## Cause and bounded repair

The captured packaged screen is the Diomedes All projects conversation, with
the sample project present in the Open projects navigation. It shows zero of
four tasks done in that project's summary, but no task cards on the conversation
page. The saved fixture settings contain the sample project in `openProjects`,
`surface: workbook`, `lastPage: tasks` and completed onboarding.

`client/App.tsx` lines 233 onward explicitly make a fresh window open on Diomedes.
Only an existing window's session storage restores its selected project on
reload. Setting `openProjects` and `lastPage` does not select a project in a
window that has never opened one. The standalone smoke assumes that it does.
The working browser fixture `tests/fixtures/landing.ts` already enters the last
open project by its accessible navigation button and verifies its active state.

Update only the standalone smoke to perform that real user navigation after
its initial setup/reload and again after its separate restart. The later
restart assertion has the same static assumption; it was not reached in either
failed execution. Preserve all existing task-count, font-scale, lost-response,
receipt, renderer-isolation, shutdown, lock and restart assertions. Keep the
application's accepted launch behavior. No session-storage injection, timeout
increase, fake response or reduced assertion is authorized. A separate author
must make the driver change, followed by independent execution and review.
