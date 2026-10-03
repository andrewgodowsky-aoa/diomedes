# Limited Individual grants and automatic credits

Reconstructed on 2026-10-02 from main `f72c6ace14c89201425e33f90fb096bdbdda8f4d`.
Original accepted repair: PR #196, `1b4705bee5f3f5d71f0798b4baa5eafa2d61338f`.
Worktree: `F:/Diomedes/diomedes-wt/individual-grant-reconstruction`.
Branch: `feature/individual-grant-reconstruction`.
Work order: `DIO128-PR196-RECONSTRUCTION`; owner: Codex, PID 36076.
Pillars, live roadmap and project memory mirrors: `2026-09-27.2`.

## Eligibility and history

Automatic Individual credits require all four legacy features in one grant:
`nectovia-agent`, `maintained-profiles`, `owner-rules`, and `phone-relay`.
The complete legacy template and the current five-feature superset remain eligible.
Limited grants require an explicit end, cannot name a billing cycle, and create no
fresh automatic allowance. Separate limited grants never combine into a complete source.

Recorded calendar balances, explicit agreements, purchases, replacement idempotency,
original payer/period identity, and late settlement retain their accepted behavior.
There is no retrospective debit, reclaim, grant correction, or renewal-policy change.

## Reconstruction and migration

This reconstructs the accepted eight-file repair against current main without rebasing
its old history. Main was 37 commits ahead of the old branch's common base.
The three existing modified files had unchanged preimages. Migration 014 from the old
repair becomes `016_individual_complete_plan_credits.sql`, after main's actual
`013_purchased_usage_holds.sql`, `014_member_credit_limits.sql`, and
`015_credit_purchases.sql`. The runner and its current test lists enumerate 001..016.
No external migration override or assumed runner preimage remains.

Migration 016 changes only the complete-feature predicate in the 012 validator.
Owner, ACL, security-definer/search-path settings, source/account locks, identity,
state/date/amount validation, exact term bounds, and overlap checks are preserved.
The committed bytes of migrations 001..015 remain unchanged.

The restricted-role suite seeds historical funding on actual main 001..015, applies
only 016, verifies unchanged rows and function privileges, and replays exact name/hash
history. The historical suite verifies the 010 to 011/012 checkpoint and replay,
then advances to 016 before using current permissions and runtime queries, which now
require tables from 013..015. The general PostgreSQL suite includes 016 for fresh installs.

## Fresh evidence

Evidence is bound to the reconstructed source manifest, not the old PR's hashes or
October 1 gate counts. Source hashes, migration hashes, exact gate results, independent
review, and remaining limitations are recorded under
`evidence/individual-grant-reconstruction/2026-10-02/` when qualification completes.
Raw logs are retained at `F:/Diomedes/deliverables/individual-grant-reconstruction-20261002/`.

## Status and boundaries

This preserves the accepted funding distinction. No pricing, permissions, product
definitions, roadmap status, or DONE markers change. Qualification uses owned disposable
loopback PostgreSQL databases. Authentication and provider transport are fixtures.
Merge, deployment, live migrations, hosted CI, and customer/provider acceptance are
not authorized by this reconstruction. Rollout remains blocked. Future application
rollout requires an authorized operator to apply accepted 016 as the existing migration
owner first. Never rewrite applied migration hashes or restore the permissive predicate.
