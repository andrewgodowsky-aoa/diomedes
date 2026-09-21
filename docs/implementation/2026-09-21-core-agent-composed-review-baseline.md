# CD-1: independent review of the preserved composition

Date: 2026-09-21. Exact tested commit:
`2b3f933c25aee5032e188c30bfc0ef166cc9b83c`.

**The preserved AWS and admission oracles pass in composition.** This closes the
missing independent execution of those oracles at the handoff's gated commit.
It does not accept the whole PR or replace the final repository gates after
the client closure repair and the newly authorized Home routing change.

The reviewer did not author the AWS implementation, its admission repair or
the integration conflict resolution. The clean frozen checkout was
`F:/Diomedes/diomedes-wt/core-agent-composed-review`, branch
`feature/core-agent-composed-review`. Integration `2120ae6` differs from the
tested commit only in review, ledger and handoff documentation.

The executing identity was role `astra`, PID `43452`, start
`2026-09-21T04:32:24.4162630Z`. Slot `slot_mub6c5ri_22970ad4` was granted and
released. The runner, exact hash assertions, result JSON and log are retained
at `F:/Diomedes/deliverables/core-agent-continuation-20260921/` as
`run-composed-baseline.ps1`, `composed-2b3f933-oracles.json` and
`composed-2b3f933-oracles.log`.

| Unfiltered file, one serial Vitest invocation | Result |
| --- | --- |
| `tests/aws-conversation-authority.review-20260921.test.ts` | 11 passed |
| `tests/interaction-authority.matrix-20260921.test.ts` | 13 passed |
| `tests/interaction-seam.review-20260921.test.ts` | 13 passed |
| `tests/capability-record.test.ts` | 23 passed |
| `tests/capability-record-pack-index.test.ts` | 20 passed |
| Total, `--maxWorkers=1` | 5 files, 80 passed, 0 failed, exit 0 |

The three reviewer oracles remain byte-for-byte unchanged. Their SHA-256 values
are respectively:

```
fe06fda3c7e9064bde9e74961d7410b9c8e9d9f491a75980c0121cacee7d44bb
7c82917641561760d02d5805ca9fe4153d415492c36123607022f338e37dd9d6
9af1f563c3ba12c356cd7b997a29ca47f11a51dd5ceb13b642720e3473d7a8f3
```

Those archived LF bytes equal this commit's Git blobs. The checkout and index
were clean before the run. The SDK dependencies came from the existing
`vercel-model-bridge/node_modules` installation through a junction, and the
control-plane install was also linked. Neither install was changed.

The AWS file includes the original seven route cases plus the four previously
failing authority cases: Ask and Plan narrowing before new Work, durable
interruption before and after restart, and receipt-only selection replay after
source cancellation and narrowing. All pass through the real local app,
Store and Runtime with provider transport faked. This is no live AWS or billing
proof. The capability cases also confirm on this composition the main-branch
repair for the one full-suite failure retained at admission-only `7f1b9b3`.

The AWS owner's existing merge review was read at
`F:/Diomedes/deliverables/bedrock-integration-20260921/MERGE-REVIEW-9803121.md`.
It confirms that `9803121` preserves the owner's driver selection and admission
intent and that the two added route mounts do not overlap. The pre-existing
dependency-notices hash depends on lockfile line endings; that disclosed
non-blocker was not repaired or claimed tested here.

The outgoing integrator's full-suite, build and browser counts at `2b3f933`
remain that integrator's evidence. This review ran the five files above, not
another full gate campaign. Final acceptance must use the actual final PR
commit, include the independently accepted Home contract and implementation,
resolve CD05-R-13, and run the required typecheck, full unit suite, build and
browser suite under the heavy slot. PR #29 remains draft until those conditions
are satisfied. No merge, package, live call or deployment is authorized by
these passing tests alone.
