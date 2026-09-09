# Windows package notices handoff

**Roadmap basis:** initial mirror `.5`; final local reconciliation `.7` over cloud `.6`.  
**Application version:** `0.1.1`  
**Status:** notice collection is operational and regenerated from the current lockfile and installed production graph. No package or release output was changed.

## Run before desktop packaging

From `F:\Achilles\diomedes-wt\windows-release`:

```powershell
node scripts/collect-package-notices.mjs
```

The collector:

1. Requires `package.json` and the package-lock root version to match.
2. Resolves the production dependency closure from package-lock v3 and validates every required package name/version against the installed read-only `node_modules` tree.
3. Records each dependency's locked tarball URL, npm integrity value, declared license, and hashes for discovered top-level LICENSE, LICENCE, COPYING, and NOTICE files.
4. Downloads the two exact Codex tag files in memory from official GitHub raw URLs, verifies pinned SHA-256 values, and refuses to overwrite a different existing file.
5. Verifies the three local native-runtime hashes and sizes before generating notices.
6. Rewrites only `licenses/DEPENDENCIES.txt` and `licenses/THIRD_PARTY_NOTICES.md`. It does not write into `node_modules`, package the app, or modify the four existing font notices.

The command requires network access to official GitHub raw content and Windows `curl.exe`. No dependency installation, account, payment, provider agreement, or signing service is involved.

## Current generated inventory

- `102` installed package paths are reachable through locked production dependencies, installed optional dependencies, and required installed peers.
- `78` unique license/notice texts were collected and deduplicated by SHA-256.
- `0` reachable packages lack a discovered top-level license text.
- `package-lock.json` SHA-256: `5291fbfd4a9e68c2d7ebad705226b7cc9c2c1de4403bbb7e46f52e8acfbc0e1d`.
- The four font-specific license files were preserved byte-for-byte by this task; the collector only references them.
- The root Apache License 2.0 text is embedded exactly in `THIRD_PARTY_NOTICES.md` so it reaches the packaged `licenses` directory without changing `scripts/package-desktop.mjs`.

The inventory is conservative. It can include a reachable production dependency that Vite or esbuild removes during bundling. That is preferable to omitting a notice from the experimental artifact.

## Codex notices and provenance boundary

Official `rust-v0.153.4` files:

- `licenses/codex-LICENSE.txt`: [official LICENSE](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/LICENSE), 10,926 bytes, SHA-256 `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc`.
- `licenses/codex-NOTICE.txt`: [official NOTICE](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/NOTICE), 242 bytes, SHA-256 `9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915`.

The [official release workflow](https://github.com/openai/codex/blob/rust-v0.153.4/.github/workflows/rust-release-windows.yml) confirms that Windows Codex bundles the command runner and sandbox setup helpers with the main executable. The exact local files match the official assets' names and byte counts, and local `codex.exe` separately reports `codex-cli 0.153.4`. Complete-file hashes differ from the corresponding raw assets reported by the [official release API](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4):

| File                              | Local SHA-256                                                      | Official raw asset SHA-256                                         |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `codex.exe`                       | `a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6` | `444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b` |
| `codex-command-runner.exe`        | `08b56828cca57c83d14f03eb9ec62c73a2cd6648248cc731ae8fedd5fa3ae566` | `3eb267dc1f0d1d80efeacc26a211f26ed0f414466d32a2aa7304a8a0beec170c` |
| `codex-windows-sandbox-setup.exe` | `682cf7b351a871f3479b78fe3b7ea7348554de655bd98b0f322cef2d006a8d62` | `0c3eeb7cee8d2bc4c8644def3c818e8b06760979572dcedc919c38d0f38f64c4` |

Direct comparison resolves that raw-hash difference. The official raw assets were downloaded to the ignored `test-results/native-provenance` directory and matched the API's published sizes and SHA-256 digests. `Get-AuthenticodeSignature` reports all six files as `Valid`; every file uses signer certificate thumbprint `EC22378E8B5F90A38B5449A388915922A9803643` for `OpenAI OpCo, LLC`. The local and official copies use different Authenticode timestamp/signature instances.

For each local/official pair, SHA-256 matches for every PE section. A second digest over the whole file while omitting only the optional-header checksum, certificate-directory entry, and addressed certificate blob also matches. The certificate offset and length are identical, and there are no bytes between the last PE section and the certificate blob. The executable program/image content is therefore byte-identical to the official `rust-v0.153.4` assets; the complete-file differences are confined to the PE checksum and Authenticode certificate material. Exact commands, asset IDs, signature metadata, ranges, and hashes are recorded in [`evidence/windows-release/native-provenance.json`](../../evidence/windows-release/native-provenance.json).

This result resolves executable-content provenance. It does not establish whether the upstream root `LICENSE` and `NOTICE` include every notice required by Codex's Rust dependency graph. The generated notice file was intentionally left unchanged during this follow-up; its earlier raw-hash caution is conservative and is superseded by the evidence above only for executable identity.

## Electron and Chromium boundary

Installed Electron `44.2.0` remains outside the production npm notice graph because it is the packager/runtime dependency. The installed npm package includes Electron's MIT `LICENSE`. Its downloadable runtime has not been materialized under this checkout's `node_modules/electron/dist`.

The final package contains Electron's top-level `LICENSE` (1096 bytes) and
`LICENSES.chromium.html` (20472830 bytes) beside Diomedes.exe. Their hashes are in
`evidence/windows-release/package-files.json`; both survived all-file ZIP extraction
and installed-payload hash comparison. These large runtime notices remain external
to `THIRD_PARTY_NOTICES.md` and are included in both final downloads.

## Verification

- `node --check scripts/collect-package-notices.mjs`: passed.
- Collector completed twice against the current lockfile and installed junction without writing to `node_modules`.
- All `102` required production package paths matched locked names and versions.
- All package entries had a discovered top-level license text.
- Official Codex LICENSE and NOTICE downloads matched the pinned hashes.
- All three native-runtime files matched their existing local package pins.
- All three downloaded official executables matched their release-API digests and had valid Authenticode signatures from the same OpenAI signer certificate as the local copies.
- All local/official PE section hashes and normalized whole-file hashes matched; the only differences were the checksum and certificate material.
- Existing font license files remained outside the collector's write set.

This is a mechanically collected notice packet and evidence report. Electron and
Chromium notices are verified in the actual downloads. The precise remaining gap
is the complete Windows-x64 Rust dependency closure paired with license/notice
texts; see NATIVE_NOTICE_REVIEW.md. Upstream publishes no such bundle. This is
missing evidence, not an invented purchase, provider-agreement or human-approval rule.

## ROADMAP IMPACT

- Experimental package notice generation: **implemented locally and repeatable**.
- Production npm notice inventory: **collected from current lock/install state**.
- Codex root LICENSE/NOTICE: **captured from exact upstream tag**.
- Native Codex executable-content provenance: **verified against the official `rust-v0.153.4` assets, excluding distinct Authenticode signature instances**.
- Codex Rust dependency/vendor notices: **complete binary-specific inventory not established**.
- Electron/Chromium package-output notices: **verified in package, ZIP and installer**.
- Public upload/signing/live deployment: **not performed**; disposable installation is verified.

**BUILD STATUS:** available notices included in final package/ZIP/installer.  
**PUBLICATION STATUS:** unpublished; complete native dependency inventory remains an evidence gap.  
**DEPLOYMENT STATUS:** disposable install tested and uninstalled; no live deployment.
