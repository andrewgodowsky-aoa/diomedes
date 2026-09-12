# Diomedes Windows experimental 0.1.1 handoff

> **Current release (12 September 2026):** `v0.1.1-experimental.3` from commit `4fb8656`, record
> `evidence/release-candidates/diomedes-0.1.1-windows-experimental-20260912-4fb86560c1d7.json`,
> published at https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v0.1.1-experimental.3
> (installer sha256 `d9eccbd5101b675968a17f2adbb760b66db627e247da24f8c4d07aa66b0e369d`). Public assets
> are produced by `scripts/write-release-assets.mjs`; the release pipeline is described in
> `docs/implementation/2026-09-12-integration.md` §12 and signing in `docs/releases/CODE_SIGNING.md`.
> The text below is the September 9 handoff, kept as written.

The app is implemented, integrated, rebuilt and tested as a real Windows package.
The complete portable ZIP and per-user installer are staged locally. They are
unsigned and unpublished. Opus owns the future public download link; this task
owns the exact artifact manifest and capability claims.

## Exact candidate

- Release ID: `diomedes-0.1.1-windows-experimental-20260909-09e551958dfa`
- Branch: `codex/windows-release-20260909` in `F:/Achilles/diomedes-wt/windows-release`.
- Base commit: `11829e1962b448360d3fc7aaba7c38fda6833a84`; application changes are local/uncommitted.
- Build-input digest: `09e551958dfab590f12dc4678664a32c9244f88ef1982723d8fe97b35b292803`.
- Application build time: `2026-09-09T10:15:52.981Z`; Windows x64, version 0.1.1, Electron 44.2.0.
- Tested OS: Windows 11 Home 64-bit, build 26200. Other Windows versions are unverified here.
- Final directory: `F:/Achilles/deliverables/windows-release-20260909`.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| Diomedes-Experimental-0.1.1-win32-x64.zip | 276783564 | 50fbf6f4e36ba0315d409f849356bacd5385aead0bbe221b898c69c70cc189a9 |
| Diomedes-Experimental-0.1.1-unsigned-setup.exe | 266271601 | e487e62f50a6aabb7ecc0244d1c0ce997420a8c1a48eb0e87bb1770d1622f07f |
| Diomedes.exe (inside package) | 246201856 | 1aa5a72eb0fba99a1e5bb5541045f9b0ee63574a14f0f847264738481a4e3c54 |
| resources/app.asar (inside package) | 4826233 | 313a35c02ca99d9243441d3f79cecdbbba063380aec7682c0e07abe5840ae11f |

Both the application executable and installer report `NotSigned`. There is no
verified Diomedes publisher identity. The bundled native Codex executables have
their own valid OpenAI signatures; that does not sign the Diomedes app/installer.
The final payload has 76 files totaling 709153483 bytes. Ship the whole ZIP or
installer, never the bare Diomedes.exe or ASAR alone.

## Manifest contract for Opus

`release-manifest.json` and `capability-ledger.json` in the deliverable directory
are the public-safe metadata contract, mirrored here for source review. They have
no local paths, credentials or private logs. Artifact URLs are deliberately absent.
`release-evidence.json` under `evidence/windows-release` is internal-only and links
the full proof locations. Do not upload that evidence tree, source checkout,
provider traces, profiles or projects as download metadata.
The adjacent `Diomedes-Experimental-0.1.1-unsigned-setup.exe.json` is the installer's
internal build/ownership record and also must not be uploaded as public metadata.

Website claims can describe the verified synthetic Connections flow, bounded
declarative compiler with two unrelated fixture examples, official in-process MCP,
scoped guidance/correction/replay, exact approval/history behavior, and the tested
unsigned Windows candidate. The new source is not a published release merely
because a local ZIP exists.

Do not claim live Toast or ingredient inventory, production tenant isolation or
human authentication, a remotely accessible MCP server, arbitrary natural-language
connector generation, continuous monitoring while the host sleeps, autonomous
model learning, a general live-model connector loop, a second ready model route,
Windows signing, public CI success or a public download that has not been verified.

## Use and installation

For portable use, extract the entire ZIP into a new folder. Run its Diomedes.exe.
For installation, the unsigned setup installs per-user without elevation into a
distinct experimental product folder and creates a current-user shortcut. The
installer can be directed to a new disposable folder using `/S /D=absolute-path`
with `/D` last. It refuses an unrelated nonempty folder. It neither launches the
app nor replaces an existing differently identified installation.

The default Electron profile remains the normal Diomedes profile. For isolated
evaluation use the staged `Start-Experimental.ps1` with the explicit portable or
installed executable. It supplies fresh profile/data/projects and an empty
synthetic CODEX_HOME only to the child process. This is the tested fixture mode;
it does not copy or alter an existing account. Normal user sign-in is separate.

In the app, open/create a sample project, choose Connections, prepare the scoped
Toast proposal, supply the numeric threshold and service window, and review the
synthetic scope before activation. Refresh availability, inspect the correction
demo, send a signed fixture event and review the created manager Task. Rule changes
remain proposals until explicit adoption. Generated library/helpdesk candidates
are under the review section and must be approved before the MCP check.

Uninstall uses the exact experimental ownership marker and deletes only the
enumerated payload, shortcut and registration. Unknown files and profile data are
preserved. Same-version repair and a separate actual 0.1.0-to-0.1.1 profile upgrade
were tested. Do not infer support for every historic version or a production updater.
Do not disable Windows security to run an unsigned candidate.

## Verification and release notes

615 source tests and TypeScript passed. The built client, actual executable,
relocated source-unavailable package, installed app, forced crash before event
triage, installer repair/uninstall and ZIP-extracted profile upgrade passed. The
fresh real Sol synthetic report used one existing native account call through the
frozen egress/Need/Store path. Detailed commands, evidence, failures and performance
limits are in VERIFICATION.md; extra package denials are in PACKAGE_NEGATIVE_PROOF.md.

This version adds Connections to both existing desktop surfaces, exact reviewed
synthetic scope, deterministic service-window stock triage, signed durable inbox
recovery, scoped frozen context/final-output correction, versioned rule revision
and rollback, generic reviewed fixture adapters and official MCP projection.
It repairs the final-context tool-narrowing gap and per-step transcript replay,
and preserves existing Runtime, Trust, Usage navigation, approvals and History.

## Publication status and remaining evidence

No source commit/push, GitHub release, public artifact upload, site deployment,
signing purchase or replacement of the user's installation occurred. Public upload
requires the user's explicit authorization for the concrete candidate/operation.
Signing remains absent; this candidate can only be represented as unsigned experimental.

All 102 locked installed production npm packages have captured top-level notices;
78 unique texts, four font notices, root Apache license, exact Codex LICENSE/NOTICE,
Electron LICENSE and Chromium notices are included. Three native program payloads
were matched to official Codex 0.153.4 assets, including all PE sections and valid
same-signer Authenticode evidence. Their whole-file hash differences are signing
material/checksum differences, not unexplained program changes.

[blocked for claiming complete redistribution evidence] Upstream publishes no
binary-specific Rust dependency notice inventory for these three executables, and
one was not independently generated here. NATIVE_NOTICE_REVIEW.md records the
exact missing closure/license-text evidence and the concrete way to obtain it.
There is no invented requirement to purchase anything or seek an additional
provider agreement for this local build. Until the inventory is resolved, the
manifest keeps public eligibility false. All available official notices are shipped.

After explicit publication authorization and resolution of the notice evidence,
Opus should upload these exact immutable filenames, retrieve each actual download,
verify its SHA-256 and length, then set its URL in the manifest and run a fresh
download/extract or install check. Do not replace an asset under this release ID
with different bytes. Website publication and app/account-backend deployment remain
separate operations. No account backend is selected or deployed by this task.

## ROADMAP IMPACT

Cloud .6 product decisions are incorporated in the clean local .7 mirror.
ROADMAP_PATCH.json contains the exact unapplied update with the required live
revision. Cloud synchronization remains pending; another writer must not apply
it if the revision changed. Runtime/Trust originals and the prior M1 package remain
preserved. COMMIT_PROPOSAL.md lists the proposed source change; no commit was made.

The contract was sent to the existing `Diomedes production website` task
(`01a0841b-4b51-7be0-ad67-49379ac96617`) for read-only acknowledgment. Delivery was
accepted; its acknowledgment was still pending at final handoff. The message
expressly authorized no publication, website changes or competing roadmap update.
