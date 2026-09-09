# Packaged negative-path proof

Verified September 9, 2026 against the frozen unpacked Windows 0.1.1 executable:

- Executable: `release/Diomedes-win32-x64/Diomedes.exe`
- Executable SHA-256: `1aa5a72eb0fba99a1e5bb5541045f9b0ee63574a14f0f847264738481a4e3c54`
- `resources/app.asar` SHA-256: `313a35c02ca99d9243441d3f79cecdbbba063380aec7682c0e07abe5840ae11f`
- Isolated run: `test-results/package-negative-final-20260909-0612`
- Machine-readable result: `evidence/windows-release/package-negative-final.json`
- Console log: `evidence/windows-release/package-negative-final.log`
- Driver: `scripts/package-negative-smoke.mjs`

The driver launched the packaged executable twice using new profile, data, project and
`CODEX_HOME` directories. Health reported version 0.1.1. Both loopback servers stopped,
their ports closed, and the data lock was released. Codex was disabled, no provider route
was called, and `CODEX_HOME` began empty. The native runtime initialized new local database
files there; it created no `auth.json` or `config.toml` and inherited no credentials.

## Verified denials

### Reordered signed event

The fixture connection accepted and processed a quantity-3 event, then accepted a valid
event signed through the desktop fixture closure with a source timestamp two minutes older.
The second inbox receipt became `ignored`. Replaying its exact bytes returned
`duplicate: true`. The inbox retained two identities, the manager Task count stayed one,
and the authoritative observation retained the newer timestamp and quantity 3. The older
event neither duplicated work nor rolled source state backward.

### Privilege-expanding rule request

`POST /connections/rules/revise` with an added `connections.write` capability was rejected
with HTTP 400. The packaged strict route schema reported the `capabilities` key as
unrecognized, so the attempted authority expansion did not reach revision adoption. This
proves this public request boundary; it does not claim that arbitrary direct Store mutation
is a supported input.

### Changed report base

The packaged `format-report` fixture reached its exact waiting Need with no existing report.
The driver then created `Harness report.md` directly in the isolated project before sending
the exact approval. Approval admission returned normally, but asynchronous execution failed
at the expected-base check with `This document changed since you opened it`. The Need's
execution state became `not-applied`, no report write appeared in History, and the outside
file remained byte-for-byte unchanged with SHA-256
`150b85ea103db695e94db2c0fcf1c00d50f619383ee54014cf85d1a5885f8225`.

### Expired approval

The desktop package has no supported isolated-process clock override, and this proof did not
change the Windows clock. The driver created a real waiting `format-report` Need, shut down
the owned process, changed only that Need's `createdAt` in the isolated state file, and
recomputed its action, base and proposal digests using the published v1 canonical formats.
The aged proposal expired one millisecond before restart. Package startup accepted the state
as internally valid; submitting the exact recomputed identity then returned HTTP 409 with
`approval_expired`. The Need remained open, its run remained waiting, it gained no approval
receipt, and no report existed.

This is a controlled valid-state expiry predicate check rather than elapsed one-hour wall
clock proof. The JSON evidence records the before/after timestamps, state hashes and
recomputed identities, with `machineClockChanged: false` and `sourceChanged: false`.

## Attempt retained

The first run, `test-results/package-negative-final-20260909-0609`, completed all four
behavior checks but the driver incorrectly expected `CODEX_HOME` to remain empty after the
native runtime initialized fresh local databases. Its failed proof and log are preserved as
`evidence/windows-release/package-negative-attempt1.json` and
`evidence/windows-release/package-negative-attempt1.log`. The passing driver instead proves
that the directory starts empty and contains no inherited auth or configuration file.
