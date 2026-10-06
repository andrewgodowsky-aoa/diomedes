# W01 local storage candidate

Source-only implementation in `server/memory/local-store.ts` and
`server/memory/schema.ts`. Base: `063035ed9feee446352dbf445208577d021c71d4`.
Pillars, Roadmap and Project Memory mirrors read as `2026-10-06.1`.
The parent owns the service, shared contracts, migration-family registration,
work order and acceptance. No production profile is opened by module import.

## Storage behavior

- Explicit absolute path, lazy built-in `node:sqlite` import, no added package.
- Short synchronous `BEGIN IMMEDIATE` transactions. The transaction handle
  expires on callback exit; thenable callback results refuse and roll back.
- Every ledger primary/reference path includes tenant, workspace and scope.
  Revisions, source links, dependencies, aliases, conflict claims, commands and
  events are immutable. Source identity includes nullable revision and locator;
  a repeated identity cannot change its metadata.
- Entry identity, scope, epochs, temporal fields, exact dependency/conflict
  references and contiguous revisions/sequences are validated by the adapter.
  The service owns authenticated host admission and temporal interpretation.
- Revision, command receipt and outbox event commit together. Epoch advancement
  and per-consumer acknowledgements are componentwise/sequence monotonic.
- Snapshots materialize complete scoped history through a watermark or refuse
  capacity. Reads do not retain a database cursor outside their transaction.
- A readable versioned JSON backup includes scoped revisions, receipts, events
  and acknowledgements. Restore accepts an empty target only and requires an
  independent authority floor for every restored scope. It preserves the maxima
  and additional current floors for scopes absent from the backup. Retained old
  evidence is not current source authorization.

## Resource and schema boundaries

Defaults: database 64 MiB, WAL 80 MiB, logical transaction 4 MiB, backup
32 MiB, snapshot 10,000 entries, outbox page 1,000 events. Configuration has
finite upper bounds. Capacity refuses new work; nothing prunes History,
revisions, receipts, source links or pending outbox events.

`max_page_count` bounds database pages. Before a write, the adapter checkpoints
and reserves WAL room for a worst-case full-database set of frames. Cache
spilling is disabled. A pinned reader or insufficient reserve refuses a write.
`journal_size_limit` controls residual size and is not treated as an active WAL
ceiling. Restore is one atomic transaction: its logical input plus authority
floors must fit both the backup and transaction byte ceilings. Oversized
restores refuse capacity and require explicitly configured compatible limits;
they never split into partially restored history.

The schema has a dedicated application ID, version 1 and immutable migration
name/digest. On each explicit open, a short-lived in-memory reference is built
from the authored schema and closed. Actual ordered SQLite table, index and
trigger definitions must match that reference, including constraints. The
stored digest alone is not treated as proof of the actual schema. Only an empty
version-zero database can initialize. Existing
unversioned foreign data and unknown/newer versions refuse. There is no invented
legacy migration or downgrade path; existing Store/RunStore files are untouched.

The adapter requires SQLite 3.51.3 or newer because that release fixes the WAL
reset race. W00's Windows host and Electron capability probes are historical
evidence only. [SQLite WAL documentation](https://www.sqlite.org/wal.html#walreset)
and [pragma documentation](https://www.sqlite.org/pragma.html) informed these
source choices. Packaged Windows/macOS and persistent behavior remain unqualified.

## Verification state

Tests, typecheck, build, database opens, migrations, restart/crash experiments,
backup execution and packaging: **DID_NOT_RUN**, as explicitly directed by the
user. No paid calls, installs, commits, pushes, merges or deployment were made.
Static reading is not independent acceptance or runtime proof. In particular,
initial schema creation, rollback, WAL bounds, foreign keys and restore still
need the authored tests and later platform qualification before acceptance.
