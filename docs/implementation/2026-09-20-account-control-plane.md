# B01 account control plane - bounded candidate

Base main: 80263205133c410d590549efd1c8f40cedf33b1c.
Feature: account-control-plane; branch feature/account-control-plane;
worktree F:/Diomedes/diomedes-wt/account-control-plane.
Canonical mirrors: Pillars 2026-09-19.1, Roadmap/Project Memory 2026-09-19.2.

The independent services/control-plane package supplies a real Fetch entry,
strict config/origin/body boundaries, the foundation's portable account rules,
WorkOS Web Crypto verifier, parameterized Neon Client repository, migrations,
test-only state adapter and explicit real-database tests. B00 contract files,
desktop Store/Trust/shared types, site and root dependency graph are unchanged.

The foundation input was tree 95364d402c24c0805acab641e6b13d84373149a8.
Its tested issuer/subject mapping, exact-subject invitations, owner-only member
administration, generation changes, last-owner protection and session refusal
are preserved. A separate parent-owned patch reexports the portable domain and
adapts existing Store transactions, retaining in-process membership snapshots
and the host Trust check. That integration requires its own exact review and
original foundation/independent regression run. Do not merge two active policy
implementations or infer acceptance of this extraction from the original tree.

The adapter uses interactive BEGIN/COMMIT/ROLLBACK on one Neon WebSocket Client,
not unrelated HTTP calls. Identity/provider HTTP runs before SQL. Transaction
locks prevent duplicate mappings, overlapping session attachment, invitation
replay and competing last-owner removal. A COMMIT transport failure is uncertain
and not retried. Tests over a deterministic adapter prove portable behavior,
not PostgreSQL locks or constraints.

Migrations include cloud account records, customer mappings, webhook inbox,
subscription/entitlement projections, funding reservation/settlement storage
and opaque connector references. These later tables grant no paid capability.
There is no payment client, provider-model call, scheduler or operational cloud
Task/Run/History store. Money types remain the B00/shared integer micro-USD
contract. Personal desktop and static marketing have no new runtime dependency.

PILLAR IMPACT: advances P04/P09/P12 through shared identity semantics and
separate tenant/account/Trust boundaries. Risk is treating unverified SQL or
runtime capacity as production readiness. The release gate explicitly retains
real-database, hosted CPU/quota, sign-in and customer-journey qualification.

ROADMAP IMPACT: no DONE or completion-ledger changes. This is a subset candidate;
full B01/H21 prerequisites and review/release gates remain open.

BUILD/PUBLICATION/DEPLOYMENT: see the frozen candidate manifest and command logs
under F:/Diomedes/deliverables/continuation-20260920/account-control-plane.
Those logs distinguish offline tests, compiled Worker, local workerd and real
database status. No commit/push/PR/merge, hosted database mutation, secret upload,
Cloudflare account change, public route or spending was performed by this worker.
