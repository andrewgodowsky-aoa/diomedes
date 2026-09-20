# Account service admission and connection lifetime repair

Feature account-service-repair; base b52e9dd248e806831aec5f03f2702a9a9d221243.
Worktree F:/Diomedes/diomedes-wt/account-service-repair; branch feature/account-service-repair.
Canon: Pillars 2026-09-19.1, Roadmap and Project Memory 2026-09-19.2.

ACP-R1 allowed successful writes beyond read limits: workspace 101 and member 1001
subsequently made enumeration or owner management return 503. Revoked rows counted
toward the read limit, and ordinary revocation used that same bounded list.
The independent 30-case regression is retained byte-for-byte, SHA256
cb2c288bd7c09be78956eeaa002d71ccebe889b25a9e3e3e9c902924cf722b9e.
Six real-Neon cases also reproduced the capacity and concurrency defects before
the repair; historical red inputs and logs remain in their original locations.

Admission now permits at most 100 active workspaces per person and 1000 active
members per organization. Creation and invitation acceptance check active counts
under the existing subject/organization locks before committing. Reactivation
through an invitation consumes capacity; historical revoked rows remain stored
but do not count. Membership authorization and final-owner protection use point
or existence queries, so an existing over-limit organization can still recover.

The cloud GET /account/session has an intentional bounded continuation contract:
at most 25 organizations, plus nextCursor:string|null; optional after is one
validated organization ID. No other query parameter is admitted. The cursor
confers no authority. Pages use current membership and a fresh verified session,
not a cross-request snapshot. Removing the cursor row does not shift an offset;
a future revoked row is omitted without losing other active rows.
The same validated GET continuation is allowed during browser OPTIONS preflight,
with the existing origin and requested-header restrictions. A regression first
reproduced the unintended 422 response, then required preflight and page success.

The cloud AccountService.workspacePage method uses AccountTransaction.workspaceRows,
which returns at most 26 joined membership/organization projections in one query.
LEFT JOIN plus strict schema validation refuses inconsistent missing organizations.
This removes the former per-workspace network query. A real-clock workerd probe
at 100 workspaces found a 7.414-second page and 401 freshness refusal in the earlier
serial-query candidate. Neither the five-second proof lifetime nor verification
semantics was relaxed. Final evidence records the joined-page timing and query
counts, all 100 IDs traversed once, and current authorization on each page.

AccountTransaction.members now provides an active-only bounded admission window;
memberships provides an active-only keyset window. New member and
hasOtherActiveOwner methods serve recovery without a whole-organization scan in
application memory. StateTransaction implements the same contracts under the
existing Store lock. AccountService.listWorkspaces retains its complete legacy
{person,organizations} response using local traversal. The desktop wrapper,
identity-host transport and account-routes mount are unchanged, as are their
existing query rejection and capability/Trust checks. No shipped client was
found consuming the new cloud continuation field; a cloud caller must follow it.

The socket probe established COMMIT acknowledgement, first socket close,
client end, end() resolution, then a duplicate client error/close before the
HTTP response. Disabling Neon write buffering did not change this ordering.
Promise-only cleanup did not own that late EventEmitter error. Each transaction
now owns client error events for the client's lifetime. Observed errors while
connecting, executing, committing or closing fail the operation. An acknowledged
commit is never replayed or falsely rolled back. Only after explicit end()
resolution are late notifications treated as belonging to an already closed
client. The retained listener prevents an uncaught error; clients are not reused.

The actual workerd/Neon probe also terminates its own restricted-role backend
after an uncommitted insert. It must return 503 and persist none of those writes,
then pass subsequent ordinary requests without uncaught connection failures.
The expected generic 503 event is separate from an uncaught runtime error.

Validation, exact commands, counts, source hashes and the frozen delta are under
F:/Diomedes/deliverables/continuation-20260920/account-service-repair/.
Only the parent-authorized disposable branch br-spring-rice-aewy6iui,
database b01_validation_accounts was used. Credentials remained in process
memory and logs were redacted. No production data or schema was changed.

PILLAR IMPACT: repairs P05/P09 account recovery and resource ownership without
granting membership, Trust, entitlement or funding through provider claims.
ROADMAP IMPACT: no DONE status; full B01/H21 and hosted CPU qualification remain
open. This is source and isolated-runtime evidence, not hosted deployment proof.
BUILD/PUBLICATION: no dependency, migration, root/CI, legacy foundation or site
change; no commit, push, merge, deployment or paid upgrade by this worker.
