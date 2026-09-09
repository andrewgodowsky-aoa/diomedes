# Native Codex notice review

**Reviewed:** 2026-09-09  
**Upstream release:** `openai/codex` tag `rust-v0.153.4`  
**Scope:** published Windows Codex executables and their upstream redistribution-notice evidence. This is an evidence review, not legal advice.

## Finding

No official complete third-party license/notice bundle, SBOM, or release-specific statement of notice completeness was found for `rust-v0.153.4`.

The official material that does exist is unambiguous:

- The tag's [`LICENSE`](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/LICENSE) is Apache License 2.0. The copy already collected as `licenses/codex-LICENSE.txt` matches it byte-for-byte: 10,926 bytes, SHA-256 `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc`.
- The tag's [`NOTICE`](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/NOTICE) contains the OpenAI Codex copyright notice and the Ratatui-derived-code attribution. The collected `licenses/codex-NOTICE.txt` matches it byte-for-byte: 242 bytes, SHA-256 `9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915`.
- The tagged [`docs/license.md`](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/docs/license.md) points only to the repository's Apache-2.0 `LICENSE`; it does not identify another notice bundle.

These are the only official OpenAI license/notice documents found that can be added directly to the current package. They are already present. There is no additional upstream bundle waiting to be copied.

## Release and package evidence

At review time, the [official release API](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4) returned 160 assets. None had a name containing `license`, `notice`, `third`, `sbom`, or `source`. The assets include the standalone executables, canonical platform archives such as `codex-package-x86_64-pc-windows-msvc.tar.gz`, the platform npm tarball `codex-npm-win32-x64-0.153.4.tgz`, and `codex-package_SHA256SUMS`.

The exact-tag [canonical package builder documentation](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/scripts/codex_package/README.md) defines the Windows package as `codex-package.json`, the entrypoint and code-mode host, `rg.exe`, the command runner, and sandbox setup helper. Its [`layout.py`](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/scripts/codex_package/layout.py) constructs and validates those paths explicitly; it does not stage `LICENSE`, `NOTICE`, an SBOM, or a third-party inventory. The [Windows release workflow](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/.github/workflows/rust-release-windows.yml) invokes that builder after signing.

The exact-tag [npm package builder](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-cli/scripts/build_npm_package.py) stages the wrapper package from `bin/codex.js`, `README.md`, and `package.json`. For the Windows platform package it stages `README.md`, generated `package.json`, and the canonical `vendor` tree. The script has explicit logic to copy the root `LICENSE` for the TypeScript SDK, but no equivalent step for the Codex wrapper or platform package. The [release workflow](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/.github/workflows/rust-release.yml) calls this builder and publishes those generated tarballs to npm.

The npm registry metadata corroborates that layout:

| Published version | Reported files | Reported unpacked size | Declared license |
| --- | ---: | ---: | --- |
| [`@openai/codex@0.153.4`](https://registry.npmjs.org/@openai%2Fcodex/0.153.4) | 3 | 13,206 bytes | `Apache-2.0` |
| [`@openai/codex@0.153.4-win32-x64`](https://registry.npmjs.org/@openai%2Fcodex/0.153.4-win32-x64) | 8 | 395,725,468 bytes | `Apache-2.0` |

The already installed global npm copy on this machine is older (`0.145.0` and `0.145.0-win32-x64`), so it is corroborative rather than release-exact. Its wrapper and platform package contain no `LICENSE`, `LICENCE`, `NOTICE`, `COPYING`, or `THIRD*` file. The installed platform package contains only its package metadata, README, `codex-package.json`, and vendored executables/resources, matching the tagged staging design.

## What the upstream license check proves

The tag contains a [`cargo-deny` workflow](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/.github/workflows/cargo-deny.yml) and [`codex-rs/deny.toml`](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/deny.toml). The configuration checks dependency license metadata against an allowlist containing Apache, BSD, BSL, CC0, CDLA Permissive, ISC, MIT, MPL, OpenSSL, Unicode, Unlicense, and Zlib expressions.

That is useful policy evidence, but it is not a redistribution artifact. The workflow runs `cargo-deny`; it does not produce or publish license texts, a dependency-to-binary closure, an SBOM, or a notice document. The `rust-v0.153.4` release workflow does not invoke `cargo-deny` or a notice generator. No `cargo-about`, `cargo-license`, SBOM, or third-party-notice generator appears in the tagged release/package path.

The [exact-tag recursive source tree](https://api.github.com/repos/openai/codex/git/trees/rust-v0.153.4?recursive=1) contains the root `LICENSE` and `NOTICE`, several license copies beside bundled skill samples, and licenses under specific vendored/third-party source directories. Those files are not assembled into a release-scoped inventory by the published build.

## Exact remaining evidence gap

The missing evidence is narrowly defined:

1. There is no official statement that the root `LICENSE` and six-line `NOTICE` are an exhaustive third-party notice set for the three Windows executables.
2. There is no published `rust-v0.153.4`, Windows-x64, binary-specific dependency closure paired with the applicable license and notice texts.
3. The release packages' absence of such a bundle does not establish that no additional third-party text applies; it establishes only what OpenAI actually shipped.

There is no upstream evidence for a mandatory purchase, provider agreement, or human approval gate. Describing this as an unresolved "native provenance" issue would also be inaccurate: the separate PE comparison proves that the three local executable payloads match the official `rust-v0.153.4` assets.

## Concrete action

For the current experimental installer, keep the exact upstream `LICENSE` and `NOTICE` already collected. No additional official release file was found to add.

If a later publication criterion requires a complete third-party inventory, close it with one reproducible evidence step: derive the Windows-x64 dependency closure for `codex`, `codex-command-runner`, and `codex-windows-sandbox-setup` from the exact tagged `Cargo.lock`, collect the corresponding source license/notice texts, and record the tool version and hashes. That requires fetching the locked crate sources or obtaining a release-specific bundle from OpenAI, both outside this bounded review. `cargo-deny` output alone is not a substitute because it checks allowed license expressions without generating the texts or proving the final binary closure.

Until that evidence exists, the accurate status is: **official root LICENSE/NOTICE captured; executable provenance verified; complete native third-party notice inventory not published upstream and not independently generated here**.
