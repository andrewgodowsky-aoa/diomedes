# Avoid unchanged project writes during app opening

Feature: faster-app-opening. Prompt: startup follow-up to AUDIT-01 through 09.
Owner: Andrew. Implementation: parent Codex integrator.
Branch: feature/faster-app-opening.
Worktree: F:/Diomedes/diomedes-wt/faster-app-opening.
Base: 92bc57bd678865390f17291beb382642769e73e5.

## Why

Desktop window creation awaits createApp, which awaits Store.init. Store.init
previously rewrote and fsynced every loaded project's entire saved state on every
launch, even when all migrations and restart reconciliation left it unchanged.
Large History records and many projects therefore add unnecessary startup I/O.

The reader now captures a SHA-256 of each parsed disk record before migration,
including its schema marker. After ordinary recovery, migrations, interrupted
work reconciliation and count refresh, only a changed persisted representation
goes through the existing Store.persist writer. A digest is kept instead of a
second copy of every project's History. Missing/older markers, repaired counts,
changed states and recovery still require persistence; unreadable/newer schemas
still refuse normally. No lazy project loading or authorization changes are made.

## Verification

- RED: `vitest run tests/store-startup.test.ts --maxWorkers=1 --minWorkers=1`:
  0 passed, 2 failed, 0 skipped. Unchanged projects were rewritten three times
  and once in the two cases.
- GREEN: `node node_modules/vitest/vitest.mjs run tests/store-startup.test.ts
  tests/store-registry-guard.test.ts tests/migrations.test.ts
  tests/project-conversation.test.ts --maxWorkers=1 --minWorkers=1`:
  89 passed, 0 failed, 0 skipped, four files. This includes legacy migration,
  prepared-write recovery and newer-schema refusal coverage.
- One wrapper launch failed before Vitest started with "The system cannot
  execute the specified program". The direct Node retry ran the passing gate;
  the wrapper failure is a host command-start failure, not a passed test run.

## Measurement

Command: `node --import tsx scripts/startup-profile.ts [store-source-path]`.
Both runs use owned synthetic directories, 20 projects, 10,000 History entries
and 500 tasks, Node v22.23.2. Seven measured opens follow a migration warm-up.
The script removes only its own fixture directory and prints source identity.

| Store source | Median milliseconds | Durable project writes per open |
| --- | ---: | ---: |
| Baseline | 375.775 | 20 |
| Repaired | 105.145 | 0 |

Baseline source SHA-256:
`ebf06c600850c9dc759124c8be9b557fb5d06805be0e8eba7ffbe8e294956032`.
Repaired source SHA-256:
`087574ec6b0698cbb9b9da5f3f006543f8e40ebeba6730acc27465a2613bb6a3`.

Baseline milliseconds: 226.297, 230.729, 241.515, 1628.708, 375.775, 415.889,
1850.117. Repaired: 90.283, 92.703, 99.757, 114.728, 123.109, 135.643, 105.145.
Host scheduling and storage noise are visible in the baseline. The operation
count reduction is deterministic; the timing is a local synthetic observation.

This is the filesystem-cache-warm Store.init phase. It excludes Electron,
account restoration, renderer download/parse and first paint. Whole installed
app and cache-cold startup are unrun. Source review also found sequential account
restoration/cache warming before window creation; changing its first-view or
authorization semantics requires separate behavioral proof. The running
installation and the user's profile were not opened or modified.
