# Worktree sweep safety review

PR #28 originally allowed a nested link or a failed detach to reach forced Git
removal. It also omitted ignored local files from the dirty check and treated
all process-liveness errors as proof that a claim owner had exited.

The repaired sweep preflights every directory without a depth cutoff, refuses
linked roots, propagates inspection and unlink errors, and checks that no links
remain. It preserves ignored files and directories, rechecks eligibility before
removal, and uses ordinary Git removal so Git can refuse new dirt or locks.
Only ESRCH proves an owner has exited. Unreadable ownership records stop the
operation. Unresolved Windows aliases in free-form external claims conservatively
protect all worktrees until the record is reconciled.

SWE-2 High independently reviewed the original and repaired complete sources via
the existing Devin subscription. The final review accepted the substantive
repairs and identified external-record aliases; the conservative alias guard and
its focused regression test address that follow-up. The architect checked the
returned code, corrected the generated test's type error and Windows loader path,
and added real disposable-repository removal tests.

Verification artifacts are retained at
F:/Diomedes/deliverables/bot-continuation-20260921/. The focused suite covers deep
and broken junctions, linked-root refusal, read/unlink failure, ignored local
data, real removal of a clean landed checkout without changing its link target,
and malformed ownership records. Replacing the repaired detach function with
the original made four regression tests fail; restoration made them pass.
The four-gate results and exact candidate patch are in gates/. Consult those
records and hosted CI for the final commit's integration evidence.

The separately recovered stock-receipt-review checkout restored 1,131 tracked
files from its preserved clean index. Its existing commit
3bcc4b96534b6fb7fa59a537672765b8131242e7 was already merged in origin/main.
Recovery changed no tracked source and preserved its branch and protective lock.

This utility change does not accept the core-agent contract, change a product
pillar, or publish a desktop release. Other active implementation lanes remain
under their owners. No sweep of live worktrees was run during this review.
