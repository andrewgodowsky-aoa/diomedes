**Rejected.**

CD-05.R-4, package CD-1, lane CD-05b, at `6d2fc8be3a702be5c53a48f7fb50aa1b2c52eebd` on `feature/core-agent-client-review`. The checkout was clean before any read. CD05-R-06 and CD05-R-11 close against their R-3 closing conditions, but the new asynchronous Discard introduces CD05-R-12: its completion can reload an old project into a different current scope and abort that scope's delivery. This is a source-established P2 defect with a pasteable, unexecuted browser reproducer below. Independent type-check passes; the single permitted Vitest attempt failed before collection with EPERM. Passing test and mutation counts below belong to the integrator. This verdict covers only this client repair, not CD-01 admission, the AWS route, or a composed or installed build.

**Rulings**

- **CD05-R-06: closed within the client claim contract.** The remaining R-3 condition was reconciliation of completion and discard by command. `clear` now compares the command under the per-thread lock and drops only the matching window reference. Discard acquires that lock before looking again. The shared-identity, contention, reload and deliberate-new-message cases remain alongside the new replacement cases. The unrelated publication defect below does not recreate the original loss or reuse of a replacement command.
- **CD05-R-11: closed.** The page retains the displayed command with its words. Both controls pass that command, a stale resend reads its named outcome without posting the replacement, and successful delivery reads the remaining claim instead of clearing the strip blindly. The settled-claim cleanup is queued under the same lock and compares its captured command. The frozen reproducers, held-lock discard, late cleanup, and recovery of the newer message after reload meet the stated closure, supported by source and the integrator's execution record. Independent browser execution was not authorized.

**CD05-R-12 | P2 | A queued Discard can publish into a later visit**

Claim and location: `client/console/DiomedesHome.tsx:285`, specifically the success and failure callbacks at lines 291-294, do not capture or check the current visit generation. The success callback calls `load(scopeId)` using the scope captured when Discard was pressed. `load` at lines 133-145 aborts the current delivery, advances `turn.current`, and clears the displayed state before reading that captured scope. Thus its own later `owns()` check accepts this obsolete operation as the newest operation. The error callback can likewise publish an old project's notice into the current project. The scope-change invalidation at lines 334-339 cannot fence either callback.

Inputs and state:

1. Project A has a valid uncertain message, displayed in the recovery strip.
2. Another window holds A's conversation lock, as a send on A normally would.
3. The first window presses Discard. It queues behind that lock.
4. The person switches to project B and waits until B's conversation is displayed.
5. The other window releases A's lock. Discard settles and its callback runs.

Observed source result: the callback unconditionally starts a GET for A's state and takes a new publication generation. The selector and rail still name B, while A's transcript, binding and Mode replace B's. If B has a delivery running, `load(A)` also aborts its controller. This result is traced from the candidate source, not observed in an executed browser run here. The reproducer establishes the queue and asserts that no obsolete A read is initiated after B becomes current.

Consequence: the person is shown one project's records under another project's scope, and unrelated active work in the page can be interrupted. A subsequent recovery control or proposal action uses the reloaded A binding despite B remaining selected. This is a new instance of the publication invariant addressed by R-07, introduced by awaiting Discard; the transport's lock and command comparison do not protect page publication.

Smallest fix: capture the visit generation before queuing Discard and check it in both callbacks before calling `load` or setting a notice. Preserve the command-specific discard itself even if the person leaves; only its page publication must be fenced. A scope-id-only comparison is insufficient for A to B to A or a newer delivery in the same scope. No transport or server rewrite is required.

Closure: paste and run this case against the candidate before the fix, then against the repair. Also cover a rejected queued discard, A to B to A, and a newer delivery whose controller must not be aborted by the old completion. Keep the R-11 command and reload cases green. The new case uses only existing spec helpers and a real browser Web Lock; it changes no production code. It has not been added to the test file or run in this review.

```ts
test('CD05-R-12: a queued Discard cannot reload a scope the person left', async ({
  page,
  context,
}) => {
  const b = await reviewProject(page, 'R12 B');
  const a = await reviewProject(page, 'R12 A');
  const text = 'Uncertain R12 A';
  const pattern = '**/api/projects/*/threads/*/messages';
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await say(page, text);
  await expect(strip(page)).toContainText(text);
  await page.unroute(pattern);
  const state = await api<ProjectState>(`/projects/${a.id}/state`);
  const thread = state.conversations.find((item) => item.name === 'Diomedes')!;
  const suffix = `${encodeURIComponent(a.id)}|${encodeURIComponent(thread.id)}`;
  const lock = `diomedes.conversation.send.${suffix}`;
  const claim = `diomedes.conversation.claim.${suffix}`;
  const other = await context.newPage();
  try {
    await open(other);
    await other.evaluate(async (name) => {
      const holder = window as typeof window & { releaseR12?: () => void };
      await new Promise<void>((acquired, reject) => {
        void navigator.locks.request(name, async () => {
          await new Promise<void>((release) => {
            holder.releaseR12 = release;
            acquired();
          });
        }).catch(reject);
      });
    }, lock);
    await strip(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect.poll(() => other.evaluate(async (name) => {
      const snapshot = await navigator.locks.query();
      return snapshot.pending?.some((entry) => entry.name === name) ?? false;
    }, lock)).toBe(true);

    await page.getByRole('combobox', { name: 'In' }).selectOption(b.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R12 B');
    await painted(page);
    const obsoleteReads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' &&
          request.url().endsWith(`/projects/${a.id}/state`)) {
        obsoleteReads.push(request.url());
      }
    });

    await other.evaluate(() => {
      (window as typeof window & { releaseR12?: () => void }).releaseR12?.();
    });
    // A barrier behind Discard, followed by rendering turns for its continuation.
    await page.evaluate(async (name) => {
      await navigator.locks.request(name, async () => undefined);
    }, lock);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), claim))
      .toBeNull();
    await painted(page);

    // Candidate starts load(A) here even though the person is now in B.
    expect(obsoleteReads).toEqual([]);
    await expect(page.getByRole('combobox', { name: 'In' })).toHaveValue(b.id);
    await expect(answers(page).last()).toHaveText('You said: Warm R12 B');
  } finally {
    await other.evaluate(() => {
      (window as typeof window & { releaseR12?: () => void }).releaseR12?.();
    }).catch(() => undefined);
    await other.close();
  }
});
```

**Reproducer fidelity and before-repair ordering**

The R-3 TypeScript payload is 2,755 UTF-8 bytes, excluding fences and adjacent newlines. An ordinal comparison of raw `git show` output finds that exact payload after the banner in both `1388e6f:tests/diomedes-home.spec.ts` and `HEAD:tests/diomedes-home.spec.ts`. No whitespace normalization was applied to this Git-blob comparison. A first comparison of the working files differed only because the report uses LF while the checked-out test uses CRLF; it was not treated as proof of an edit. The later diff changes the `say` helper and adds closure cases, without changing the frozen block.

`git show 1388e6f` contains only the test paste. The range is, in order, `1388e6f` (paste), `703c6b4` (repair), `bb4cce6` (browser closure/helper), and `6d2fc8b` (two documents). Thus the paste-before-code rule is independently established. Both original failures on the unfixed build are recorded in that commit and the Round 10 ledger. Those historical executions were not independently rerun, and the supplied successful-run file is not their baseline log.

**Disclosed survivors and limits**

1. **Held-lock unit schedules: acceptable.** The helper directly holds the same `makeLocks()` manager installed on `navigator` and replaces the claim before releasing it. That deterministically exercises waiting and rechecking. It is a simulated lock manager, not the browser's native Web Locks implementation, and it is not a second module instance. The older second-module cases and browser cases provide complementary coverage. None exercises the new Discard publication continuation in R-12.
2. **Mutation evidence: acceptable within its stated coverage.** The integrator records U1-U5 killed, and B14-B16 killed by the named stale-control and delivery cases. These removals attack the intended command/lock guards. The file-restoration hash and clean-bundle rebuild are the integrator's evidence, not independent mutations or a hash verification performed here. Killing these mutants does not cover the missing visit fence.
3. **R-11 helper synchronization: acceptable as is.** Waiting for `.dio-pending` to disappear before typing establishes delivery completion. The old strip absence and old answer presence did not. The frozen test's inputs and assertions are unchanged, and the helper does not remove the replacement-claim schedule. No amendment to the frozen block is requested. The saved failed run reports 25 passed, one failed at the newer-strip wait, and three not run; those three are not passes. The reported four other successes are not additional independent runs here.
4. **Enter during delivery: not a defect for this contract.** `submit` checks the same pending constraint used by Send before clearing text. Enter during delivery leaves the draft intact; Working is visible and Send is unavailable. There is no advertised queue or automatic later submission. Waiting in `say` is consistent with that contract. This ruling does not certify broader accessibility or composer behavior.
5. **Frozen R-10 case: acceptable as retained history with the existing limitation.** Its per-window last-answer assertion remains order-sensitive. Its pass in this run does not resolve that. No new retirement or rewrite requirement is imposed in this repair; the R-3 advice to use shared-thread/both-turn assertions for durable coverage still applies. Its mechanical risk is not the rejection reason.
6. **No-command strip and unreadable storage: safe action targeting, limited recovery usability.** Both controls only reload until a command can be read; neither guesses a command nor removes a hidden claim. If storage is readable on that reload, the valid command and its words return and a subsequent control works. If reads still fail, `load` clears the strip and `retained` suppresses the error. The person may remain unable to send or recover until storage becomes readable and the conversation is loaded again. This is not full recovery support. It is accepted only within R-3's already disclosed unreadable/damaged-storage usability limit, not as proof that nobody can be stranded. The valid-storage R-12 schedule does not depend on this limitation.
7. **Damaged pending record without Discard: unchanged bounded exclusion.** Transport refuses the damaged record and the container offers no repair control. This remains a recovery gap; the command repair does not claim to solve it.
8. **No streaming preview, empty results ledger, no real provider or installed build: acceptable exclusions.** These remain unimplemented or unverified as disclosed. No corresponding product or release acceptance follows from this review.

**Other checks that held**

Once the first window has refreshed and actually displayed newer command B, Discard of B is an intentional action on B. If another window is sending B, Discard waits through that window's dispatch and cleanup. A confirmed send leaves no matching claim; an uncertain send leaves B and the explicit discard can remove B after the lock is released. A replacement C is protected by the comparison. Waiting is sufficient for the shared-claim mutation, although not for the page continuation in R-12. There is no claim here that client Discard cancels server work already admitted or erases a recorded turn.

When Web Locks are missing, the queued `pendingMessage` cleanup rejects before invoking `clear`; the attached catch absorbs the error, the settled claim is suppressed, and shared storage is not removed. Direct send/resend/discard also cannot enter their callbacks. Retaining a settled claim in an unsupported browser is conservative and does not authorize a fallback.

The new `sendMessage` settled-claim branch runs inside the same lock as dispatch and queued cleanup. If cleanup gets the lock first, the send sees no old claim. If the send gets it first, it clears or supersedes that settled command and saves a fresh identity before dispatch; a later cleanup of the old command cannot remove the new claim or its matching reference. Equal text after confirmation remains a deliberate new send. These conclusions assume cooperating callers use the lock and valid storage; arbitrary external storage mutation is not made atomic by Web Locks.

The diff contains two production files, two test files and two documents, with no server changes. R-05, R-08, R-09 and R-10 are not reopened by this diff. The earlier R-07 fixes remain, but the newly introduced path violates the same publication boundary and is recorded separately as R-12. No code from another worktree, the admission repair or AWS was used.

**Independent commands and real results**

All commands ran with working directory `F:/Diomedes/diomedes-wt/core-agent-client-review`.

| Command | Result |
| --- | --- |
| `git status --short` | Exit 0, empty before any read. Rechecked after writing: only this new review file is untracked. |
| `git diff --stat` | Exit 0, empty after writing; no tracked file changed. |
| `git show -s --format='%H %D' HEAD` | Exit 0; full candidate hash above, HEAD on the review branch, repair branch at the same commit. |
| `git log --oneline 21bc268..HEAD` | Exit 0; the four commits listed above. |
| `git diff 21bc268..HEAD` | Exit 0; six changed files, inspected with focused reads below. |
| `git show 1388e6f` | Exit 0; only the frozen test paste, before implementation. |
| `git diff 21bc268..HEAD -- tests/conversation-send.test.ts tests/diomedes-home.spec.ts` | Exit 0; unit additions, two call-site amendments, queued-cleanup wait, helper wait, frozen cases and browser closure. |
| `git diff 1388e6f..HEAD -- tests/diomedes-home.spec.ts` | Exit 0; frozen block untouched. |
| `git diff 21bc268..HEAD -- docs/implementation/2026-09-20-core-agent-contract.md docs/implementation/2026-09-20-core-agent-work-items.md` | Exit 0; Round 10 contract and evidence/status updates. |
| `git show 21bc268:docs/implementation/2026-09-21-core-agent-client-review-r3.md` | Exit 0; used for the original payload comparison. |
| `git show 1388e6f:tests/diomedes-home.spec.ts` | Exit 0; exact 2,755-byte payload found after the banner. |
| `git show HEAD:tests/diomedes-home.spec.ts` | Exit 0; same exact payload found after the banner. |
| `./node_modules/.bin/tsc --noEmit` | Exit 0, no diagnostics. The running process was polled to completion. |
| `./node_modules/.bin/vitest run tests/conversation-send.test.ts` | Exit 1 before collection: EPERM opening `node_modules/.vite-temp/vitest.config.ts.timestamp-1789986474017-7ab02a3807135.mjs`. Zero tests executed. One attempt only. |

Source and evidence were read with `Get-Content` (UTF-8 on focused reads), with `Select-Object` slices and a numbered `ForEach-Object` read for locations. Read-only PowerShell comparisons used `[IO.File]::ReadAllText` and `[regex]::Match` for the fenced block. For the definitive comparison, `System.Diagnostics.ProcessStartInfo` captured each `git show` stdout directly; `IndexOf(payload, banner, [StringComparison]::Ordinal)` preserved the blob's line endings and `[Text.Encoding]::UTF8.GetByteCount` reported 2,755. The initial working-file ordinal comparison was false, the line-ending diagnostic was true, and both raw Git-blob comparisons were true. No tests or source were edited to perform these checks.

**Integrator evidence, separate from the above**

Read `F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd05-r4-evidence.txt` and the disclosed `cd05-r4-evidence-run1-flake.txt` beside it. The successful file records `tsc --noEmit` exit 0; `vitest run tests/conversation-send.test.ts tests/conversation-turn-id.test.ts tests/project-conversation.test.ts tests/diomedes-view.test.ts` with 4 files and 90 tests passing, including 36 send tests; `vite build` exit 0; and the whole `tests/diomedes-home.spec.ts` in one serial run with 29 passed. Its note identifies source at `703c6b4` plus the test working tree later committed as `bb4cce6`, followed by the documents-only `6d2fc8b`. This is compatible with the inspected commit diff, but is not a fresh independent run at HEAD. U1-U5 and B14-B16 are all recorded killed. Neither the full Vitest suite nor full browser suite ran for this round. No historical totals are added to these counts.

**Scope, status and sources relied on**

Repository mirror versions: Core Pillars `2026-09-19.1`; Live Roadmap `2026-09-19.2`; Project Memory `2026-09-19.2`. PILLAR IMPACT: command-bound recovery advances P06/P09, while R-12 breaks truthful project association and can interrupt the current delivery. No pillar meaning changes. ROADMAP IMPACT: R-06 and R-11 close; R-12 opens and CD-05b remains unaccepted. No canonical document was edited.

Implemented: the candidate's command-bound controls, locked cleanup and added regression coverage. Proposed only: R-12's visit fence and the new reproducer above. BUILD STATUS: independent type-check passed, independent tests did not execute; no build or browser run here. PUBLICATION / DEPLOYMENT STATUS: no commit, push, package, release, deployment or live model call. Only this review file was written and remains uncommitted and unpushed.

Source-read appendix: `AGENTS.md`; the three canonical repository mirrors above; `docs/implementation/2026-09-21-core-agent-client-review-r3.md`; the two changed Round 10 documents; `client/conversation-send.ts`; `client/console/DiomedesHome.tsx`; `client/console/Diomedes.tsx`; `tests/conversation-send.test.ts`; and the relevant helpers, frozen cases and closures in `tests/diomedes-home.spec.ts`. External evidence is limited to the two explicitly supplied integrator files. No cloud document, other worktree's source, or separate repair branch was reviewed.
