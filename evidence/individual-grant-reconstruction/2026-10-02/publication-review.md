# Publication mapping review

Runtime-confirmed model: `swe-2-max`, through Devin ACP.
Session: `tulip-calcium`.
Started: `2026-10-02T12:26:03.745Z`; completed: `2026-10-02T12:26:38.292Z`.
No reviewer tools or writes. This supplements the complete source review in
`review.md`; it does not replace it.

## Reviewer response (verbatim)

**APPROVE** — bound to `committedContentDigest 2ef651e9d678f7368646f38504d73137033c32fc87db23997b9ae711faf0c2c2` (base `f72c6ace`, reviewed `c8a6f945`).

**Why the binding is honest**

- The proof anchors at the right layer: `git show :path` reads the **index blob** — the exact bytes a commit records, unaffected by `core.autocrlf` smudging — while `readFileSync` reads the physical worktree file that was tested. Each file must satisfy `sha256(physical) == manifest.sha256` AND `staged ∈ {physical, physical-minus-CR}`. The accepted difference set is *exactly* {identity, CRLF→LF}; any other staged byte fails closed via throw.
- The output is internally consistent: 5 `identical` rows all show `testedSha256 == committedSha256` and `testedRawGitBlob == committedGitBlob`; 7 `CRLF to LF only` rows differ in both, matching the stated normalization of 7 TypeScript files.
- `committedContentDigest` is sha256 over the serialized per-file rows — a reproducible, content-addressed binding of the 12-file mapping. The note accurately discloses what each manifest measures rather than conflating them.

**Why no fresh functional gates are required**

- The transformed files are all `.ts`. CRLF→LF is semantics-preserving for the TS/JS toolchain; the byte-sensitive surface (all 16 SQL files, where embedded line endings could matter in data or dumps) is entirely `identical`. The residual edge case — a literal line break inside a template literal — is theoretically nonzero but negligible, and escape-sequence `\r\n` in source is unaffected by normalization.

**Residual limitations (non-blocking, disclosed for the record)**

- The proof iterates `manifest.files`; it does not enumerate the index, so it binds these 12 files but does not itself prove nothing else is staged — per the brief, that is covered by the separate staging verification (15 historical migrations byte-identical to main, 5 new files identical index↔physical).
- `reviewedContentDigest` is carried from `source.json`, not recomputed — the trust anchor is that manifest's provenance, which the prior review session attested. The digest binds files, not a commit SHA; a post-hoc index change would not invalidate it retroactively, so it should be re-run if staging is touched.
- The retained duplicate-webhook failure is baseline-consistent and disclosed — not a publication-integrity defect.

No material hole found.

## Parent reconciliation

The source freeze was checked again, and all staged source blobs must match
`publication.json` before commit and at the published commit. Only the twelve
listed source files and this evidence directory are staged. The historical
migration bytes match main exactly. The raw source digest is independently
recomputed by `freeze-source.mjs --check`.

The reviewer's phrase "baseline-consistent" is not proof of the initial webhook
failure's cause: all five baseline runs passed, and that failure remains unresolved.
See the precise record in `verification.json`.
