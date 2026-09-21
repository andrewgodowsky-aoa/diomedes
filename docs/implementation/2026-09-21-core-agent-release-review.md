# Release preparation review

Date: 2026-09-21. Base: `e05833b4d91bb4e63731d41564378f2254ca00dc`,
merged PR 29 plus its documentation checkpoint. Isolated worktree:
`F:/Diomedes/diomedes-wt/core-agent-release`, branch `feature/core-agent-release`.

## Accepted preparation scope

A separate author changed only two text passages in
`scripts/write-release-assets.mjs`. Independent diff inspection confirms the
capability-derived route list now identifies installed-tool routes, and FIRST
RUN qualifies existing sign-in wording to that route class. It removes the
blanket claim that the application holds no credential and points readers to
Settings and the setup instructions supplied with their release. Discovery
consent and the pointer to live-proof limits are preserved. There is no version
branch, model-name insertion, dependency change, new storage claim or change
to proof, hash, refusal or record-derived logic.

Independent execution in the fresh release worktree passed both existing pure
release-copy test files: 13 release-assets cases and two final-client README
cases, 15 passed and zero failed. `tsc --noEmit` also returned exit 0 after
the fresh installs. This accepts the small common-copy correction and recorded
preparation only. It is not a new version's full release acceptance.

## Fresh local preparation

The worktree started clean with neither dependency path present. Locked root
`npm ci --no-audit --no-fund` installed 288 packages; the nested control-plane
`npm ci --ignore-scripts --no-audit --no-fund` installed 108. Both exited 0.
All four root/nested package and lock files stayed unchanged. Both new
dependency directories are ordinary directories. Existing worktrees and their
junctions were preserved.

The root install warned that the esbuild 0.28.2 postinstall was blocked by the
existing allowScripts policy. No policy or dependency was changed. Focused
Vitest and TypeScript execute successfully; a fresh production build remains
part of the later versioned release gates.

`prepare-native` copied the three pinned binaries from
`F:/Diomedes/deliverables/nr03-final-package-20260909/resources/native-runtime`
and verified the expected `codex-cli 0.153.4` version and hashes. The generated
`evidence/native-runtime-manifest.json` changes only preparation time and the
destination worktree paths. Binary source paths, versions and hashes match
the prior committed manifest. No installed tool, credential or global setup
was changed. Preparation held exclusive slot `slot_mubfta61_6675e44f`; the
subsequent typecheck used its own exclusive slot. Both slots were released.

Raw records under
`F:/Diomedes/deliverables/core-agent-continuation-20260921/`:

- `release-preparation-results.json` and the root, service and native-runtime logs.
- `release-copy-focused.log` for the independent 15-case run.
- `release-preparation-typecheck-result.json` and its log.
- `release-readme-copy-work-order.txt`, output and session export for separate authorship.

## Not yet a release

Package version remains 0.1.6. No new candidate, package, installer, installed
runtime proof, published release or website deployment has been produced.
The version and generated-notice paths are still held by active AWS-owner
claim `claim_mub06qvl_0d898805`. The pending request transfers only
`package.json`, `package-lock.json` and `licenses`; its two runtime paths stay
reserved. Andrew's earlier transfer covered `model-session-run.ts` only.
The ownership boundary in the continuation brief prevents editing the other
claim while the new request is unanswered.

After that transfer, versioning and generated records need separate authorship
and independent inspection, followed by full gates on the exact new source
commit, packaging and installer/runtime proofs, publication and the site update.
The PR's passing 4,682 unit and 176 browser cases are merged-source evidence;
they are not relabeled as a fresh release's results. Live Luna execution,
credentials and spend authority remain with Andrew and the AWS owner.
