# CD-02 acceptance rows C01–C12, C21–C23 — executable evidence

2026-10-01 · lane `cd02-interaction-admission` · base `a0d752e` (origin/main at branch time)

## Scope taken

Work order `reference/work-items/CD-02.md` ("Intent and disposition without action
surprises") asks for deterministic acceptance coverage of rows C01–C12 and C21–C23
over the frozen interaction-decision schema. The admission implementation itself is
already merged (`server/interaction-admission.ts`, `server/interaction-service.ts`,
`server/interaction-turn.ts`); this slice adds the named rows as executable tests
through the production boundary and records what each row's evidence actually is.

**No production code was changed.** The diff is one new test file plus this record.

## What was added

`tests/interaction-admission.crows.test.ts` — 18 tests, all driving the real seam:
`createApp` over real HTTP, real `Store`, real session driver and admission, with
only the provider scripted (`PersistentTextAdapter` whose answers are keyed to the
row's own input string). Nothing in the test mutates internals to pass.

Evidence oracles are durable records, not in-memory flags:

- `workFor(sourceMessageId)` counts task/session records whose receipts carry the
  command ids `conversationCommandIds` derives from that message — the "no visible
  task created" check.
- `phaseNames(result)` reads the phases saved on the message's run — `decision`,
  `action-selected`, `task-input`, `task-receipt`, `work-input`, `work-refused`.
- `dispatches` counts provider turns — the idempotency check.

## Row-by-row result

| Row | Input | Evidence |
|-----|-------|----------|
| C01 | greeting | `answered`; 0 tasks, 0 sessions; only `decision` phase |
| C02 | thanks | `answered`; same inert evidence |
| C03 | brainstorming | `answered`; inert |
| C04 | capability question | `answered`; inert |
| C05 | compare two approved notes | `read`; real documents written to the project folder, selected by real sha; inert otherwise |
| C06 | "don't change anything" | `answered` under Ask; hostile act proposal under Ask degrades to the answer, never `proposed`/`started` |
| C07 | plan-only | `answered` under Plan; hostile act under Plan likewise refused |
| C08 | maybe-later | `answered`; inert |
| C09 | build schedule | `proposed`, zero work until `select`; then `started`, exactly 1 task + 1 session, phases `action-selected`/`task-input`/`work-input` |
| C10 | receiving checklist | same proposed→started path |
| C11 | new validator | `not-started`/`build-not-reachable`; see Honest limits |
| C12 | access denied → "make another" | `answered`; inert |
| C21 | retry same commandId | replay returns identical `sourceMessageId` and proposal digest, zero additional dispatches; re-select returns committed `started`; still 1 task + 1 session |
| C22 | "use last month instead" | own `sourceMessageId` and derived ids; own task created (`task-input`/`task-receipt`); work refused `This project already has work in progress` (`work-refused` phase, `not-started`/`refused`); first message's records untouched |
| C23 | unrelated question during active job | `answered`; inert; job's 1 task + 1 session unchanged |

Adversarial coverage beyond the numbered rows (from the work order's attack list):

- `control` with `target_run_id: null` — refused by the frozen schema itself;
  reply degrades to `answered` (`decision` phase records the refused block).
- `control` naming a run — reaches admission, refused `control-not-reachable`.
- `act`/`send_external` — refused `send-not-reachable`.
- `act`/`write_internal` with `requested_project_id` naming an unknown project —
  refused `unknown-target`.

## Honest limits

- **C11 is partially met by construction.** The frozen seam refuses
  `build_capability` through conversation (`build-not-reachable`). The row's
  positive half — admitting a bounded development task with tests and separate
  activation — needs a different path the work order does not authorize creating
  here. The test asserts the truthful current behavior (honest refusal, nothing
  activated); the gap is recorded, not papered over.
- **C22's supersession record is not in this seam.** The test proves the
  correction is its own message with its own receipts and that the first
  message's records are never rewritten. Dependency invalidation between tasks
  is a task-domain record; it exists or it doesn't regardless of this file.
- Scripted-provider evidence, not live-model evidence. The deterministic seam
  (schema → narrow → admit → select → receipts) is the acceptance surface;
  whether a real model phrases blocks correctly is provider-tier evidence.
- `expectInert` asserts no `task-input`/`work-input` phases and no receipts for
  the message's derived command ids; it does not enumerate unrelated system
  records (e.g. document-observation History entries created by `readDocument`).

## Verification

- `npx vitest run tests/interaction-admission.crows.test.ts` — 18/18 pass
  (~9.5 s suite time).
- Interaction-family regression: `interaction-admission`, `interaction-contract`
  (+astra), `interaction-turn`, `interaction-driver`, `interaction-seam`
  (+review-20260921), `interaction-authority.*` (matrix/repair/schedules),
  `approval-admission` — 220/220 pass.
- `tsc --noEmit`, full `vitest run`, `vite build`, Playwright — pending the shared
  heavy-test slot (currently held by another active lane); no production file
  changed, so gate risk is confined to the new file's own compilation.

## Remaining for CD-02

- The four required gates under the slot before any merge consideration.
- Independent review (Astra) of this file against the C-row source text.
- C11's positive half and C22's task-domain supersession remain open items for
  whoever owns those paths — flagged, not claimed here.

## Frozen patch identity

- Base: `a0d752e94a6a83ba9cd3b7277361dd2986d56014` (origin/main, PR #192)
- `tests/interaction-admission.crows.test.ts` sha256 `6fc51249455bf22b0553d7e41361f7ed7dda82a9aeef077f0ab6c2c6cad01839`
- This record sha256 `bb2a9e562c40b714b499daeae64e6184f302bc5c2ce81ecdb9745bdd9cef7328` (hash taken before this section was appended). The final record hash is reported in the frozen evidence packet alongside this file — embedding it here would be self-referential.
- Production files changed: none.
- `npx tsc --noEmit` on this worktree: clean (2026-10-01, base `a0d752e` + this file).

## Final gate evidence (2026-10-01, slot_devingate_a1b2c3d4)

- npx tsc --noEmit: clean.
- npx vitest run: 531 files, 8760 passed, 5 skipped, 0 failed (278s) — includes the 18 C-row tests.
- npx vite build: built in 9.19s.
- npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts: 36 passed (1.3m).

Status: READY FOR INDEPENDENT REVIEW. No push/merge performed.
