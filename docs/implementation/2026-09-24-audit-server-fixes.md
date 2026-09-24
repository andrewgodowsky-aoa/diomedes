# Audit server fixes: stale Discovery evidence, executable identity, UTF-8 byte limits

Date: 2026-09-24 · Lane: `audit-server-fixes` · Branch: `bugfix/audit-server-evidence-identity-utf8`
Base: `origin/main` at `559a1ab` · Linear: DIO-84, DIO-86, DIO-88 (source record AUDIT-20260920-01,
-03, -07)

Each issue was reproduced on current main with a regression check committed **before** its fix, so
the red run is pinned to a commit on this branch:

| Issue | Red commit (checks only) | Fix commit |
|---|---|---|
| DIO-88 | `ae7d22b` Add failing checks that byte limits count UTF-8 bytes, not UTF-16 units | `c421cd7` |
| DIO-86 | `258b3b3` Add failing checks that a same-length in-place change moves the executable identity | `b14c320` |
| DIO-84 | `45fcd8a` Add failing checks that an edited evidence file leaves Discovery usable | `8b10749` |

All three reproduced on current main; none is "unaffected".

---

## DIO-84 — Discovery stale evidence prevents inspection, correction and retirement

**Reproduction (current main, `45fcd8a` against unfixed source).** Real `createApp` HTTP routes and
the production evidence verifier in `server/app.ts`, on a disposable project: import a file through
Files, record an observed fact citing that import's History entry, then edit the file through the
ordinary `POST /api/projects/:id/documents/write`. The check
`listing, correcting and retiring after the evidence file is edited all answer 200 (DIO-84 report)`
in `tests/fd02-discovery-routes.test.ts` failed with:

```
- "correct": 200, "list": 200, "retire": 200
+ "correct": 409, "list": 409, "retire": 409
```

and the detailed checks failed at `GET /discovery` with
`{"error":"A stored observed fact no longer has valid source evidence.","code":"invalid_observed_evidence"}`.
A second path also reproduced: evidence cited from a `documents/create` entry, followed by a normal
`documents/write` within ten minutes, which `Store.writeRecorded` folds into the same History entry
(moving that entry's `after`).

**Root cause.** `DiscoveryService.owned()` (reached by every read and every mutation through
`active()`/`requireActive()`) re-ran the *new-observation* verifier over every stored observed fact,
superseded ones included. That verifier requires the file's current bytes to equal the recorded SHA,
so any later edit turned the whole record into a 409 — including the correction and the `value: null`
retirement that are the only ways to repair it.

**Fix.**
- `shared/discovery.ts`: `ObservedEvidenceCheck` (`verified` | `stale` with `currentSha` |
  `invalid`) and `StaleObservedEvidence` (`factId`, `projectId`, `path`, `recordedSha`,
  `currentSha` — `null` when the file is gone). The stale reading is computed when a record is
  served and is never written into it.
- `server/app.ts`: the production verifier became `checkObservedEvidence`. `verified` exactly as
  before. `stale` only for an approved file whose History entry still stands (by you, or approved or
  authorized, naming the path as a recorded write) and either (a) records `after === sha` while the
  file now differs, or (b) was folded into by a later quick edit, in which case the recorded bytes
  must still be present and hash-valid in the project's History object store (`Store.object`).
  Anything else — unknown project, unknown entry, wrong actor, path not recorded, bytes never
  recorded, a failed execution — is `invalid`.
- `server/discovery/service.ts`: new observations (`addFact`, `correctFact`) go through
  `requireVerifiedObservation`, which accepts `verified` only — `stale` is never fresh evidence
  (403 `unverified_observed_evidence`, unchanged). Stored facts: `stale` is collected, `invalid` still
  refuses the record with 409 `invalid_observed_evidence` (unchanged). The yes/no
  `verifyObservedEvidence` dependency is still accepted and maps to `verified`/`invalid`, so it can
  never produce `stale`.
- `server/discovery/routes.ts`: every response that carries a record now also carries
  `staleEvidence` (empty when nothing is stale).
- Console (`client/api.ts`, `client/console/DiscoveryPage.tsx`, `client/console/Discovery.tsx`,
  `client/console/discovery.css`): a fact whose evidence is stale shows its recorded provenance
  unchanged plus one label, "Stale: the file has changed since", inside the provenance cell (which
  already has `min-width: 0` and wrapping).
- History stays evidence (decision 10): the observed fact and its evidence record are never
  rewritten or deleted; corrections append (`replacesFactId`) as before.

**Tests.**
- `tests/fd02-discovery-routes.test.ts` (real routes, production verifier):
  - the report's three calls answer 200 after an ordinary edit;
  - listing returns the unchanged facts and `staleEvidence` with recorded vs. current SHA; correcting
    with the *old* evidence is refused 403 `unverified_observed_evidence`; correcting with fresh
    evidence from the edit's History entry succeeds and appends; the prior fact is byte-for-byte
    unchanged; retiring (`value: null`) succeeds; the same reading survives a restart;
  - the folded-edit path is stale, not invalid;
  - boundary: a stored record whose evidence cites a History entry that does not exist still answers
    409 `invalid_observed_evidence` (this passed on main and still passes).
- `tests/fd02-discovery.test.ts`: service-level — stale keeps `active()` readable and reported,
  stale never backs a new observation, retirement preserves the prior fact, invalid still refuses.
- `tests/fd02-discovery-ui.test.ts`: the label appears once, only on the stale fact, beside the
  recorded provenance text.

**Closable?** Yes, subject to the Linear "Before closing" items the integrator owns (reviewed PR and
merged commit; release containing it). Reproduced on the current build, regression check added,
API behaviour and failure paths (strict new evidence, invalid stored evidence) verified by test.

---

## DIO-86 — Executable identity cache misses changed bytes with preserved size and mtime

**Reproduction (current main, `258b3b3` against unfixed source).** `tests/candidate-binding.test.ts`
over real temporary files and the production `readIdentity` path; the version probe is the test's own
mock, so **no executable is launched**. Write bytes, discover, (bind), write different bytes of the
same length, restore the modification time with `utimes`, discover again. Both checks failed on main:
the candidate kept the first SHA (`expected '8cf8703b…' to be 'cd2cada9…'`) and the bound binding kept
the first SHA (`expected '032c8feb…' to be '20b8cfa2…'`).

**Root cause.** `EngineService.identify` reused a cached digest whenever path, size and `mtimeMs`
matched. Size and modification time do not prove bytes; a same-length replacement can put the
modification time back.

**Fix.** `server/engines/service.ts`: the cache is removed and the digest is read from the bytes on
every look. That is the robust option: ctime/inode would catch ordinary writes on POSIX, but not on
every filesystem or against a deliberate reset, and only a content read proves content. Cost is
bounded: the read is capped by the existing `DIGEST_LIMIT_BYTES` (350 MB, refused beyond), and the
same scan already launches each candidate for its version. Measured here: 170–260 ms to SHA-256 a
200 MB file. Admission's scan is scoped to the one route in use.

**Binding revision — read this.** With the fix, the new SHA reaches the candidate, the binding record
(`binding.sha256`) and the binding's revision key (`key`, which a verification receipt is checked
against), and re-binding binds the new bytes. The semantic `revision` counter deliberately does
**not** move: `followUpdate` treats a same-path change as the chosen installation updating itself,
and `candidate-binding.test.ts` "follows the bound copy when it updates itself in place" pins "An
update is not a new choice: the revision does not move", as does `connection-policy.test.ts`. The
regression therefore asserts the new SHA and the moved revision key, not a moved counter. Whether a
same-version, different-bytes change should also move the counter (and so retire the verification
receipt) is a product decision, not taken here. **Proposed default:** keep the current contract;
raise with Andrew if receipts should not survive a byte change without a version change.

**Tests.** `tests/candidate-binding.test.ts`:
- `records the digest of the bytes on disk, even when size and modification time are preserved` —
  **replaces** the former `records one digest per file and does not re-hash an unchanged one`, whose
  final assertion was the bug itself ("the recorded digest is reused" after different bytes). It
  still checks that an unchanged file reads back the same digest.
- `moves the bound identity to the new bytes when a same-length change keeps size and modification
  time (DIO-86)` — candidate, binding and stored key move to the new SHA; re-bind binds the new bytes.

**Closable?** Yes for the reported defect (stale SHA and binding identity), subject to the integrator's
PR/merge/release items. Note the binding-revision interpretation above when closing.

---

## DIO-88 — Evaluation response limit counts UTF-16 units instead of UTF-8 bytes

**Reproduction (current main, `ae7d22b` against unfixed source).** `tests/evaluation-contract.test.ts`:
a well-formed result with 30,000 CJK warning characters (under 65,536 UTF-16 units, over 65,536 UTF-8
bytes) was accepted (`Expected the contract to refuse this result.`), and a multi-byte body of
exactly cap + 1 bytes was accepted.

**Root cause.** `validateEvaluationResult` compared `canonical(body).length` — UTF-16 code units —
with `MAX_EVALUATION_RESPONSE_BYTES`.

**Fix.** `shared/evaluation.ts` measures `new TextEncoder().encode(canonical(body)).byteLength`.
Declared semantics are "may not exceed N bytes": exactly N is accepted, N + 1 refused.

**Same class of bug, searched in `shared/` and `server/`** (every `*_BYTES` constant compared with a
`.length`, directly or through a variable):

| Site | Verdict |
|---|---|
| `shared/evaluation.ts` `MAX_EVALUATION_RESPONSE_BYTES` | **Fixed** (the reported bug). |
| `shared/usage-contract.ts` `MAX_RAW_USAGE_BYTES` (raw usage evidence, "serialized") | **Fixed** — same mistake; TextEncoder because the client bundles this module via `shared/managed-usage.ts`. |
| `server/build-identity.ts` `MAX_BUILD_RECORD_BYTES` (record size on disk) | **Fixed** — same mistake; `Buffer.byteLength`. |
| `shared/artifacts.ts` `visualOf` vs `VISUAL_MAX_JSON_BYTES` | Not a bug: a cheap pre-check that can never refuse more than the byte check, and `readBlock` then measures UTF-8 bytes. |
| `server/change-review/service.ts` `PREFETCH_TOTAL_BYTES` (`bytes + text.length`) | **Left unchanged, follow-up.** It is an in-memory prefetch budget, not a serialized-size boundary, so it is not clearly the same mistake; changing it alters which entries a change review prefetches. |
| `server/harness/model-transcripts.ts`, `server/app-updates.ts`, `server/connection-secrets.ts` | Not bugs: `.length` of a `Buffer`/byte array. |
| All other `*_BYTES` uses (store, native-work, integrations, inventory, instruction delivery, packs, compiled fixtures, readiness, opencode, rehearsal) | Already measure `Buffer.byteLength`, `TextEncoder`, `stat.size` or byte counts. |

**Tests.**
- `tests/evaluation-contract.test.ts`: 30,000 CJK characters refused; an ASCII body of cap − 1 bytes
  accepted; exactly cap accepted and cap + 1 refused, for both ASCII and multi-byte padding.
- `tests/usage-contract.test.ts`: 6,000 CJK characters refused; exactly the ceiling kept, + 1 refused.
- `tests/build-identity.test.ts`: a valid record padded with 400,000 CJK characters (under the ceiling
  in units, about 1.2 MB) is `unreadable-record`.

**Closable?** Yes, subject to the integrator's PR/merge/release items. As the audit notes, the
evaluation library is not wired into a live provider path, so this was a contract defect, not a live
incident.

---

## PILLAR IMPACT

No pillar conflict. Advances truthfulness and durable evidence: Discovery keeps historical evidence
inspectable and repairable without rewriting it (decision 10), an engine binding names the bytes
actually on disk, and declared byte limits mean bytes. No authority is widened: new observed facts
still need evidence that verifies now (decision 7).

## ROADMAP IMPACT

No roadmap status changes. Three audited bugs fixed on a feature branch; not merged, not released.

## BUILD STATUS

See the final gate run recorded at the end of this file. Nothing released or packaged; no version
bump; native-runtime hashes untouched.

## Proposed canonical-doc patch

- `docs/DIOMEDES_PROJECT_MEMORY.md`, Discovery definitions: add — "**Stale evidence (Discovery).** An
  observed fact whose approved file has changed since it was observed. The fact and its evidence stay
  as recorded; the record reports the evidence as stale with the recorded and current SHA and stays
  readable, correctable (with fresh evidence) and retirable. Stale evidence never backs a new
  observed fact."
- `docs/DIOMEDES_LIVE_ROADMAP.md`: none beyond noting DIO-84/86/88 fixed on
  `bugfix/audit-server-evidence-identity-utf8` once merged.
- `QUESTIONS.md`: optionally record the open product question from DIO-86 — should a same-version
  change in an executable's bytes move the binding revision and retire its verification receipt?
  Current contract: no (in-place change is followed).

## Gate results (own run, this Linux container, 2026-09-24)

- `npx tsc --noEmit`: clean (at `8c04903`, after `git merge origin/main` — already up to date).
- Full vitest (`--maxWorkers=2`, under the shared lock) at `8c04903`: 345 files passed, 1 skipped;
  **6094 tests passed, 16 skipped, 0 failed** (main baseline 6082 / 16 / 0; the difference is the 12
  new checks here). An earlier full run at `8b10749` had one failure,
  `tests/evaluation-acceptance.test.ts` (J33 citing a moved line), fixed in `8c04903`.
- `npx vite build`: ok.
- Playwright (`PLAYWRIGHT_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
  under the heavy lock, after a fresh `vite build`) at `8b10749`: `tests/ui.spec.ts`,
  `tests/native-ui.spec.ts`, `tests/field.spec.ts` plus `tests/fd02-discovery.spec.ts` —
  **37 passed**, 0 failed. `8c04903` changes only a Markdown citation table.
- Windows- and macOS-only checks skip on Linux (the 16 skipped); none is counted as passing.
