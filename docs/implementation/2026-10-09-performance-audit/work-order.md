# Functionality and performance repairs

Owner: Andrew. Integrator: Codex, session process 36232.
User authorized nine separate GPT-6.1 Sol workers at max reasoning, one repair
commit per worker, final integration into main after validation, and an
investigation and repair of slow app opening.

Base: `92bc57bd678865390f17291beb382642769e73e5` (`origin/main`).
Integration: `feature/performance-audit-integration` at
`F:/Diomedes/diomedes-wt/performance-audit-integration`.
Canonical mirrors: Core Pillars, Live Roadmap, Project Memory `2026-10-06.1`.

## Items

| ID | Feature | Branch and worktree name | Why |
| --- | --- | --- | --- |
| AUDIT-01 | Source generation validation | agentfs-source-generation | Do not bind older source bytes to a newer authorization generation. |
| AUDIT-02 | Native loader environment | agentfs-loader-guard | Caller options must not hide process-level native loader overrides. |
| AUDIT-03 | Aggregate delta capacity | agentfs-delta-capacity | Imports and proposals must obey the receiving host's total byte limit. |
| AUDIT-04 | Bounded outbox admission | memory-outbox-admission | Small outbox reads and acknowledgments must not load every ledger entry. |
| AUDIT-05 | Read-only ledger admission | memory-read-admission | Unchanged epoch reads must not require WAL write capacity. |
| AUDIT-06 | Positive schema evidence | turso-schema-proof | Two empty or incomplete catalogs cannot prove schema compatibility. |
| AUDIT-07 | Lazy advisor admission | lazy-agent-advice | Rule-based selections should not wait for unused advisor admission. |
| AUDIT-08 | Bounded conversation reads | bounded-conversation-history | A short history or recap should not materialize every past turn. |
| AUDIT-09 | Temporal history grouping | memory-temporal-index | Avoid repeatedly scanning the entire ledger for each selected record. |

Each branch uses the `feature/` prefix and lives in
`F:/Diomedes/diomedes-wt/<name>`. Each item has its own native Codex worker,
regressions and rationale note. Parent review reconciles source and test results.
No external model or further delegation is authorized for workers.

## Prerequisites and validation

The sanitized W00 contract commit `144d8927eaf84bb10ccbceb095f4ed4b028421c8`
and committed W01 candidate `d05a6b10d71199631ec254d5eec8e9ff9e737aad`
are staged in this isolated integration branch. TS00 qualification starts at
`7c40ce5ff7b52d8c93e245d13c7d08a44e44a56e`. Original worktrees remain untouched.
The original author already committed the AgentFS review snapshot as
`9ea1870dc57d48a3a88fa37765af49432850e068`. Its implementation and tests match
the audited files ignoring line endings. This existing commit is the repair
baseline; no uncommitted source files were copied or adopted. The integrator
recorded the owner-directed claim transfer on 2026-10-10 UTC, leaving both
original worktrees intact. The unrepaired review snapshot is not accepted as-is.
The optional adapter remains unwired and its SDK is not redistributed.

The pinned coordinator holds the edited paths and the shared heavy-test slot.
Targeted tests are serialized. Final gates are TypeScript, full unit tests,
Vite build, and the required three browser spec files. CI remains disabled
under `F:/Diomedes/CI-STOP.md`; local results do not claim hosted CI, a release,
installed-app qualification, provider calls, or database migration acceptance.

Startup measurements use owned synthetic data and processes. Do not read
credentials, alter the running installation, or relax admission/recovery gates.
