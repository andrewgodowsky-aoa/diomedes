# PR 196 reconstruction qualification

Base: `f72c6ace14c89201425e33f90fb096bdbdda8f4d`.
Original PR head: `1b4705bee5f3f5d71f0798b4baa5eafa2d61338f`.
Reconstructed from current main; no blind rebase or historical migration edits.

The original eight-file repair is preserved, with its migration renumbered to 016.
Four current-main runner/test integration files are also updated. `source.json`
lists all twelve reviewed files, their Git blobs and SHA-256 hashes, and all sixteen
migration hashes. Migrations 001 through 015 match the base exactly.

Source content digest:
`c8a6f945d5a0bbfb558019fe5ec84e8d0f8e2d6a2fbe777f83a1aad32f727f71`.
Evidence files are excluded from this digest to avoid self-reference.

`source.json` records physical tested/reviewed Windows bytes and raw Git object
hashes. `publication.json` maps them to actual committed Git blobs: seven TypeScript
files undergo Git's CRLF-to-LF normalization; the other five files, including SQL,
are identical. The mapping admits no other change and has a supplemental SWE 2.0
ACP approval in `publication-review.md`. Its committed-content digest is
`2ef651e9d678f7368646f38504d73137033c32fc87db23997b9ae711faf0c2c2`.

## Fresh local results

| Gate | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Root unit tests | 9046 | 0 | 5 |
| Control-plane unit tests | 995 | 0 | 78 |
| Playwright: ui, native-ui, field | 36 | 0 | 0 |
| Restricted-role/runtime PostgreSQL | 24 | 0 | 0 |
| Historical PostgreSQL upgrade/replay | 12 | 0 | 0 |
| General PostgreSQL, final fresh run | 13 | 0 | 0 |

Root and control-plane typechecks, Vite build and Worker dry-run build passed.
The restricted suite includes one manifest-gap check before connection and 23
database cases. The dedicated PostgreSQL results are separate from the default
unit gate's environment-dependent skips.

The actual runner applied 001..015 from the unchanged main checkout, then only
016 from the reconstructed checkout, then `applied: []` on exact replay.
Owned loopback PostgreSQL 18.6 instances used real restricted runtime and funding
logins; all were stopped. No hosted Neon, live provider, or production database
qualification is implied.

The independent SWE 2.0 Max review used Devin ACP (`swe-2-max`), approved the
frozen digest and found no blocking defects. See `review.md` and the parent
reconciliation. The reviewer did not execute tests.

## Retained failure

The initial general PostgreSQL run passed 12 and failed 1 on concurrent duplicate
webhook insertion (`23505 webhook_inbox_tenant_id_provider_event_id_key`).
No source change followed. The fresh candidate rerun and five unchanged-main
full-suite runs each passed all 13. The failure's cause remains unresolved and
was not reproduced on main. It remains recorded in `verification.json`;
the initial run is not counted as passing.

## Reproduction and boundaries

Run the following with the repository's required file claims and exclusive heavy
slot, using disposable local databases only:

- Root: `tsc --noEmit`, `vitest run --maxWorkers=4 --minWorkers=1`,
  `vite build`.
- Root browser: `playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`.
- Control plane: `tsc --noEmit`, `vitest run --maxWorkers=1 --minWorkers=1`,
  `wrangler deploy --dry-run --outdir dist`.
- Control-plane PostgreSQL: run
  `tests/individual-limited-grants-postgres.integration.test.ts`,
  `tests/individual-funding-postgres.integration.test.ts` and
  `tests/postgres.integration.test.ts` with their documented disposable-database
  environment variables. Run the actual migration runner against an isolated
  database at 015, then 016 and exact replay.

Full commands, logs, JSON results, ACP transport metadata and cleanup receipts:
`F:/Diomedes/deliverables/individual-grant-reconstruction-20261002/`.
`verification.json` records raw report paths, hashes, timestamps and counts.

No merge, deployment, live migration, hosted Actions run, or roadmap DONE update
was performed. This is a bounded local qualification and source review.
