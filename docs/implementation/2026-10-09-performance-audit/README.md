# Nectovia functionality and performance repairs

Andrew authorized nine separate GPT-6.1 Sol workers at maximum reasoning, each
responsible for one finding and its own commit, followed by integration into
main after local verification. The parent investigated the boundaries, reviewed
each patch, coordinated serial testing and separately improved storage startup.
All workers used native Codex; no alternate provider or further delegation ran.

## Nine repairs

Each linked note records the failure, why the change is needed, the worker's
RED/GREEN evidence and its verification limits. Counts from these overlapping
runs must not be summed into a full-suite total.

| Item | Repair commit | Why | Evidence |
| --- | --- | --- | --- |
| 01 | `b42c85e31823e906f99aef9aaa7f20a6e436d730` | Bind pinned file bytes to the validated source generation; reject access-rights drift during subset capture. | [Source generation](01-source-generation.md) |
| 02 | `23daef98a9a25014776911e40999cacefdade571` | Check process and caller loader overrides independently so an undefined caller option cannot hide a native-loader override. | [Loader guard](02-loader-guard.md) |
| 03 | `55227d5e0a93e77bb62471eb74c9dfbb1fa49d1f` | Enforce the receiving host's aggregate delta limit using actual file bytes during import and collection. | [Delta capacity](03-delta-capacity.md) |
| 04 | `a623c77cc283a1f4169aa2ff66e9a4cb2692b977` | Admit small outbox reads and acknowledgments without materializing every ledger entry. | [Bounded outbox](04-bounded-outbox.md) |
| 05 | `f31ddc120f88ab26beaebb295de99bde537cccc9` | Allow unchanged-epoch reads without WAL write capacity, while persisting new floors and rechecking revocation. | [Read admission](05-read-admission.md) |
| 06 | `d7b1033143b796a96159e307bca427a3e88179db` | Require positive, complete schema evidence before equality can establish compatibility. | [Schema proof](06-schema-proof.md) |
| 07 | `70973c1b00f0739d7b2d4d63d54aa04947560f20` | Skip unused advisor preparation and account admission for deterministic Auto choices. | [Lazy advice](07-lazy-advice.md) |
| 08 | `cc126a71acf49d1fa2b1005c00ad7f1180dd7300` | Read only the recent answered turns needed by conversation history and lane recaps. | [Bounded history](08-bounded-history.md) |
| 09 | `120a1efffd0992d979d1d141dd20036fe77d73cf` | Group each record's complete revision history once instead of repeatedly scanning the whole ledger. | [Temporal history](09-temporal-history.md) |

## App opening

The parent's additional commit is
`aad028d8d969252f4773b1b760bc8885e5117ceb`. `Store.init` compares the loaded
representation with its final recovered and migrated representation, persisting
only changed projects. Recovery, migrations and interrupted-work handling still
run through their existing paths.

On a synthetic profile with 20 projects, 10,000 history entries and 500 tasks,
seven warm filesystem-cache samples showed median `Store.init` time decreasing
from 375.8 ms to 105.1 ms. Project rewrites fell from 20 per launch to zero.
These are storage initialization measurements, not total desktop launch times.
The complete sample series, test evidence and remaining startup boundaries are
in [the startup note](startup.md). `scripts/startup-profile.ts` reproduces the
owned-profile measurement without opening the installed application's data.

## Integration and acceptance boundaries

The integration started from remote main
`92bc57bd678865390f17291beb382642769e73e5`. The repairs include the existing
sanitized W00 contracts, W01 local ledger, TS00 qualification fixtures and the
author's committed TS05 AgentFS review snapshot as prerequisites; their exact
commits and ownership transfer are recorded in [the work order](work-order.md).
Original worktrees and unrelated changes remain intact.

The optional AgentFS adapter remains unwired, its SDK is not bundled, and the
ordinary copy sandbox remains the default. This audit does not qualify Turso as
the local memory engine, introduce a second file writer or change Runtime,
Trust, account admission or permission authority. No product definition or
roadmap prompt is marked complete by these repairs.

The parent runs TypeScript, the complete unit suite, Vite build and the required
`ui`, `native-ui` and `field` Playwright specs on the combined candidate before
the final fast-forward into main. Final counts come from that run's reports in
the integration worktree's `test-results/`, not the historical prerequisite
evidence. GitHub Actions remains disabled under `F:/Diomedes/CI-STOP.md`.
Local gates and a main merge do not establish installed-app, packaged-platform,
real-provider, hosted CI, live migration or customer acceptance.
