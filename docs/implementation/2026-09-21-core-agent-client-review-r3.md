**Rejected.**

CD-05.R-3, package CD-1, lane CD-05b, at `da6ec3d49c99080d832f296c08e35354f4528ef9`, on `feature/core-agent-client-review`. The checkout was clean before any read. Five findings close; R-06 is narrowed because recovery controls still act on a replacement pending message instead of the message displayed. CD05-R-11 below is a P2 blocker with a concrete source trace and pasteable browser cases. It is not an executed browser observation: the permitted Vitest attempt failed before collection with EPERM, and browser execution was outside this work order. The integrator's passing runs support the repaired paths but do not exercise this replacement-claim case. This verdict covers only the client repair and its two stated server additions. It does not accept the separately rejected CD-01 admission boundary.

**Rulings against the R-2 closing conditions**

- **CD05-R-05: closed.** `client/console/DiomedesHome.tsx` separates transport confirmation from `show`. Once transport resolves, a failed transcript read sets the notice and `unread`, and delivery returns true. It cannot restore the confirmed text. `Diomedes.tsx` offers Read again through `load`, which reads and does not send. Delivery clears the previous card before transport, so a failed refresh cannot attach a new card to the old transcript. The original reproducer and the additional read-again case cover an empty composer, one message POST, one user turn and successful read recovery. Their execution support is the integrator's 25-case run, not an independent browser run here.
- **CD05-R-06: narrowed, not closed.** The shared claim and exclusive Web Lock repair the original independent-window reproducer. Reading the claim, choosing an identity, saving, dispatching and transport cleanup are serialized. Reload and uncertain retries reuse the claim; an aborted lock wait writes and sends nothing; a different in-flight body gets a plain refusal. However, R-2 also required completion/discard reconciliation by command. Discard has neither a command argument nor the lock, and the container forgets the displayed command before either recovery action. CD05-R-11 shows that this can discard a newer uncertain message and permit a fresh identity for its recovery. The original session-only defect is repaired, but the full closing condition is not.
- **CD05-R-07: closed within the client publication boundary.** Scope changes invalidate `turn` immediately, before the effect starts its read. Loads and deliveries each advance it; `show`, catches and finalizers check ownership. A late refusal returns true after ownership is lost, so it is not restored into the new scope's composer. Selection checks the captured turn and the last command before publishing success, failure recovery or busy state. The added cases cover a later message, A to B to A, aborted delivery and a late transcript read. A rendered busy Start refuses another click; any duplicate invocation before rendering still names the same command and proposal. That is not certification of concurrent server selection admission, which remains explicitly outside this review. Read again clears `unread` on entry; delivery clears it too. Any older read still completing is fenced by the newer turn. No additional client publication defect was established on these paths.
- **CD05-R-08: closed.** `show` derives the assistant turn identity from run and command, reads the transcript after the outcome, and offers a card only if that exact turn ends the displayed transcript. It never compares answer prose. Proposed and started reloads, a newer message, identical answer text from different commands, and an outcome delayed across another writer are covered by the original and added browser cases. `tests/conversation-turn-id.test.ts` compares the browser derivation with real app projection and checks that outcome GET still has null answer text. The two substitutions in `server/app.ts` are behavior-preserving: the same JSON array is hashed by the same existing hash function, and the same prefixes and first 32 hex characters form both turn IDs. Projection deduplication and message/select/outcome shapes do not change.
- **CD05-R-09: closed for the reported refusal path.** After an ordinary transport error, the container reads the claim for the attempted binding, displays its saved words, keeps the refusal notice and returns true only when those are the submitted words. A different refused draft returns to the composer. Send again uses the saved Mode and body through `resendPending`; a fresh definitive refusal still restores text. The original refusal-after-uncertainty case, the changed-Mode closure and the existing fresh-refusal case cover these conditions. Replacement of the displayed claim by another window is the distinct remaining defect in R-11.
- **CD05-R-10: closed.** The new POST calls `Store.provisionProjectConversation` with one Store-locked adopt-or-create and pin operation. The route avoids an outer lock because the provisioner takes it. The shared selector preserves the previous qualification, oldest-first and ID tie-break rules. The operation changes only the selected conversation's engine, preserves its other fields and the project's work route, and persists only when creation or pinning changed something. The reserved home identity gets 409. No GET was added and the existing state read does not invoke the provisioner. Ordinary thread creation and engine changes remain available; the new route does not make all ordinary threads Claude Code-only. The 12 real-app tests cover the server boundary; the browser closure covers another window's lost first reply, recovery on the same thread, reload, and repinning after a reroute. The original race case has the test-ordering limitation discussed below.

**New finding, most severe first**

**CD05-R-11 | P2 | Stale recovery controls act on another message's claim**

Claim and location: `client/console/DiomedesHome.tsx:81` stores `unconfirmed` as text only. Load at line 149 and delivery failure do not preserve the displayed command as the action target. `resend` at lines 252-262 reads whichever claim exists when clicked and passes that command to `resendPending`. `discard` at lines 267-269 supplies only the binding. `client/conversation-send.ts:282-284` then unconditionally removes that thread's shared claim and the current window's reference, outside the Web Lock. The transport's command-bound resend cannot protect a command the container never passes to it.

Inputs and state:

1. Window A sends message A. Both replies are lost after recording, leaving command A pending and its words in A's recovery strip.
2. Window B opens the same conversation and settles A with Send again. A has no storage-change subscription, so its strip still offers message A.
3. B sends message B and loses both replies. The shared claim now names command B, which the server may already hold. B shows B; A still shows A.
4. A presses a recovery control beside A's words.

Observed source result: Discard removes B's claim. A's reload of the binding finds nothing pending. B's next reload also drops its session reference because no shared claim backs it. Sending B again can now mint command C, although command B was already accepted. With Send again instead, A rereads B and POSTs B's command and body, then clears B on confirmation. The user clicked under A's words, but B was retried. Neither path needs damaged storage, a storage exception, simultaneous JavaScript instructions or a weakened server admission rule.

Consequence: giving up on an old message can silently destroy the only shared recovery identity for a newer uncertain message. Subsequent recovery can duplicate its generation and recorded turn. The resend variant acts on a different message from the one offered. This violates R-06's command-specific completion/discard condition and the stated promise that Send again sends only the command it was offered. It is not the disclosed non-goal of intentionally sending equal text after confirmation.

Smallest fix: retain the complete pending identity with the displayed recovery state. Bind both recovery controls to that captured project, thread and command. Pass that command to `resendPending`, rather than choosing a replacement on click. Make discard a command-conditional mutation under the same per-thread Web Lock; if the command has settled or changed, leave the replacement untouched and refresh the displayed record. Keep unrelated session references intact. Apply the same lock/identity discipline to shared-claim cleanup initiated by `pendingMessage`, which currently also calls the unconditional `clear` outside the lock. No server rewrite is needed.

Closure: run the two cases below unchanged on the unfixed candidate first, then the repair. Both must leave B's claim intact, and neither stale click may POST B. Add a held-lock discard case that proves a queued discard rechecks its captured command after the lock is granted, plus a failed-cleanup case that cannot delete a replacement claim. Recover B afterward with its original command, including after reload. These additions must coexist with the original R-06 reproducer and the deliberate-new-message case.

Paste at the end of `tests/diomedes-home.spec.ts`. These use its existing helpers and real fixture. They have not been run or inserted into that file in this review.

```ts
for (const action of ['Discard', 'Send again'] as const) {
  test(`CD05-R-11: stale ${action} cannot consume a newer pending message`, async ({
    page,
    context,
  }) => {
    const p = await reviewProject(page, `R11 ${action}`);
    const oldText = `Old R11 ${action}`;
    const newText = `New R11 ${action}`;
    const pattern = '**/api/projects/*/threads/*/messages';
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.abort('failed');
    });
    await say(page, oldText);
    await expect(strip(page)).toContainText(oldText);
    const other = await context.newPage();
    try {
      await open(other);
      await other.getByRole('combobox', { name: 'In' }).selectOption(p.id);
      await expect(strip(other)).toContainText(oldText);
      await strip(other).getByRole('button', { name: 'Send again', exact: true }).click();
      await expect(strip(other)).toHaveCount(0);
      await expect(answers(other).last()).toHaveText(`You said: ${oldText}`);

      await other.route(pattern, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fetch();
        await route.abort('failed');
      });
      await say(other, newText);
      await expect(strip(other)).toContainText(newText);
      const state = await api<ProjectState>(`/projects/${p.id}/state`);
      const thread = state.conversations.find((item) => item.name === 'Diomedes')!;
      const key = `diomedes.conversation.claim.${encodeURIComponent(p.id)}|${encodeURIComponent(thread.id)}`;
      const claim = await other.evaluate((k) => localStorage.getItem(k), key);
      expect(claim).not.toBeNull();
      expect(JSON.parse(claim!).input.text).toBe(newText);
      expect(await said(p.id, newText)).toBe(1);

      // A still offers the old message, although B now owns the pending claim.
      await expect(strip(page)).toContainText(oldText);
      await page.unroute(pattern);
      const posts: string[] = [];
      page.on('request', (request) => {
        if (messagePost(request)) posts.push(request.postDataJSON().commandId);
      });
      const refreshed = page.waitForResponse((response) =>
        response.request().method() === 'GET' &&
        response.url().endsWith(`/projects/${p.id}/state`));
      await strip(page).getByRole('button', { name: action, exact: true }).click();
      await refreshed;
      await painted(page);

      // Candidate: Discard deletes B; Send again POSTs B and then clears it.
      expect(posts).toEqual([]);
      expect(await other.evaluate((k) => localStorage.getItem(k), key)).toBe(claim);
    } finally {
      await other.close();
    }
  });
}
```

**Reproducer fidelity and the before-repair rule**

All seven TypeScript block payloads in the R-2 report match contiguous text in the candidate tests exactly, without whitespace normalization: helpers, R-05, R-06, R-07, R-08, R-09 and R-10. They are ASCII payloads of 768, 1014, 857, 1373, 981, 1133 and 1528 bytes respectively, excluding fences and their adjacent newline. The browser payloads occur under the specified banner; R-06 occurs under its unit-file banner. The R-2 report itself has no diff from `7890c27`. No reproducer assertion was changed.

The repository's Round 9 ledger records the unchanged reproducers failing on the unfixed build before implementation, including uuid-2 versus uuid-1 and the five specified browser assertions, while the earlier eight cases passed. This agrees with the integrator's account. The supplied R-3 evidence file contains repaired-build runs, not those baseline execution logs. Therefore unchanged paste fidelity is independently verified here; the historical execution order and baseline failures remain the integrator's recorded evidence, not independently rerun or established by commit ordering alone.

**Disclosed survivors and limits**

1. **Store lock mutant: acceptable as a disclosed test limitation.** The current read-to-push segment is synchronous, so concurrent HTTP requests alone do not prove the lock. The retained lock also orders persistence and recovery against other Store writers. Source inspection establishes its presence. The worker's artificial-await experiment is reported evidence, not an experiment performed here. The 12 passing cases must not be called a successful mutation test of serialization.
2. **Selection fence pair: acceptable.** Either check currently rejects the tested late result; removing both is the meaningful mutation. Keeping both states the visit and command requirements explicitly. Neither surviving single removal proves a live client defect.
3. **Sequential R-06 reproducer: acceptable with its stated scope.** It proves cross-window pending identity, not contention. The two held-fetch cases and the abort-wait case exercise contention through the unit lock fixture. They do not cover replacement under stale recovery controls, which is R-11.
4. **Added `await settle()` in the existing in-flight test: acceptable.** Its assertions are unchanged. The release callback is installed by fetch after asynchronous lock acquisition, so awaiting a turn before calling it is necessary fixture synchronization, not a relaxation of the invariant.
5. **R-10 per-window last-answer assertions: a latent flake in the original reproducer.** One shared transcript can legitimately end with the second window's answer before the first window reads. It is then wrong to require each window's last answer to be its own. Repeated green runs do not make that ordering guaranteed. Keep the frozen reproducer as the historical diagnostic; use one shared thread and both uniquely identified turns, or deliberately gate transcript snapshots, for durable regression assertions. The deterministic lost-reply closure and server tests support R-10 independently. This mechanical test limitation is not the rejection reason.
6. **Damaged pending storage: accepted only as an unchanged limitation of this bounded repair.** The container suppresses the read error while transport refuses dispatch, with no Discard offered. That is still a recovery usability gap, not a new regression or a claim that damaged storage is handled. It does not explain or excuse R-11, which uses valid records.
7. **`resendPending` never mints, proved only in unit tests: the transport-level coverage is acceptable; the end-to-end claim is not.** The function has no mint path and reads the named outcome if that claim no longer exists. But the container rereads a replacement claim before invoking it. The absence of a browser distinction between saved-command recovery and plain resending left R-11 uncovered.
8. **No streaming, empty results ledger, no real provider and no installed build: acceptable scope exclusions.** They remain unimplemented or unverified as disclosed. This review supplies no streaming, result-ledger, provider, installed-window, deployment or release acceptance.

The deliberate behavior for equal text after a confirmed message is also acceptable. Those are two new sends. An uncertain claim is shared; text is not a permanent deduplication key. Missing Web Locks fails before claim creation or dispatch, which is conservative. A failed transport cleanup does not itself retry a confirmed send; a leftover claim with the last confirmed command is suppressed by `pendingMessage`. That cleanup path still needs the command/lock discipline specified in R-11 before the overall cross-window reconciliation claim can close.

**Other checks that held and review limits**

The `client/App.tsx` amendment restores the saved project only if it still appears in the current listing, then restores `settings.lastPage[project]` only if it belongs to the existing `pages` set, otherwise home. It does not use open-project recency as a launch target. Clearing selection still removes the window's place key; a deleted project cannot be restored from it. This preserves the old page-restoration convention without adding authority or an outcome cache. The page preference is the existing shared per-project setting, not a new per-window page history. Independent browser proof of project/page restoration, deleted-project handling and installed-window lifecycle was not run; the supplied 25 cases do not specifically assert the restored page. No additional blocker was established from this amendment.

The view remains props-only; sends remain on the conversation route; selection still carries the command, proposal digest, explicit project and consent. The shared turn helper preserves the server's previous identity output, and the shared thread selector preserves the previous client selection rule. The provisioner is a write-only addition behind the existing local-service guards. Its `locked = false` route wrapper avoids a nested lock and does not bypass the Store lock inside the provisioner. None of these conclusions reaccepts admission after Mode narrowing, asynchronous Runtime failure or a child-command mismatch. Round 9 correctly records that the earlier CD-01 acceptance is superseded for that boundary. No source from the separate repair branch was read.

Repository mirrors read: Core Pillars `2026-09-19.1`, Live Roadmap `2026-09-19.2`, Project Memory `2026-09-19.2`. PILLAR IMPACT: the repairs improve recovery and truthful association under P06/P09, but R-11 still loses an uncertain message's identity through an unrelated stale action. No pillar meaning changes. ROADMAP IMPACT: R-05, R-07, R-08, R-09 and R-10 close in this review; R-06 remains narrowed and CD-05b remains unaccepted pending R-11. No canonical document was edited. Implemented repairs are described above; R-11's fix and regression cases are proposals only. BUILD STATUS: independent type-check passes; no independent test suite executed. PUBLICATION / DEPLOYMENT STATUS: no commit, push, build, package, release or deployment was performed. Only this review file is new and uncommitted.

**Independent commands and results**

All commands ran from `F:/Diomedes/diomedes-wt/core-agent-client-review`. Git blob reads used this checkout's HEAD; no source from another worktree was read. The dependency junction appears in the Vitest stack trace but was not altered. Source output was retained and inspected in focused sections when too large for one tool response.

| Command | Actual result |
| --- | --- |
| `git status --short` | Exit 0, empty as the first action; empty again before creating this report. Final check lists only this report. |
| `git show -s --format=fuller HEAD` | Exit 0, exact candidate `da6ec3d49c99080d832f296c08e35354f4528ef9`. |
| `git log -1 --format="%H %D"` | Exit 0; same HEAD, with `feature/core-agent-client-review` and `feature/core-agent-client-repair` at that commit. |
| `git log --oneline 7890c27..HEAD` | Exit 0, 13 entries including the two lane merges. |
| `git diff --stat 7890c27..HEAD` | Exit 0, 17 files, 2,016 insertions and 146 deletions. |
| `git diff 7890c27..HEAD` | Exit 0; full candidate diff, inspected by file with the focused reads below. |
| `git diff 7890c27..HEAD -- client/ server/ shared/` | Exit 0; implementation delta. |
| `git diff 7890c27..HEAD -- server/ shared/ client/conversation-turn.ts client/console/diomedes-view.ts client/console/diomedes.css` | Exit 0; focused server/shared/helper/style delta. |
| `git diff 7890c27..HEAD -- client/conversation-send.ts` | Exit 0; focused transport delta. |
| `git diff 7890c27..HEAD -- docs/` | Exit 0; contract and work-ledger changes. |
| `git diff 7890c27..HEAD -- docs/implementation/2026-09-21-core-agent-client-review-r2.md` | Exit 0, empty. |
| `git diff 18c20f2..HEAD --stat` | Exit 0; only the work ledger and browser fixture change after the integrator's earlier gates. |
| `git diff --no-index -- NUL docs/implementation/2026-09-21-core-agent-client-review-r3.md` | Exit 1 because this new report differs from NUL; successful final read, ASCII only and no em dashes. A line-ending warning did not modify the file. |
| `./node_modules/.bin/tsc --noEmit` | Exit 0, no diagnostics. |
| `./node_modules/.bin/vitest run tests/conversation-send.test.ts tests/conversation-turn-id.test.ts tests/project-conversation.test.ts tests/diomedes-view.test.ts` | Exit 1 before collection: EPERM opening `node_modules/.vite-temp/vitest.config.ts.timestamp-1789984444842-ba376863239df.mjs`. Zero tests executed. One attempt only. |

The following exact read commands all exited 0. They also delimit the source-read appendix; reliance on the large App, server and components files is limited to the navigation, provisioner, route, transport and projection sections discussed above.

```text
git show HEAD:AGENTS.md
git show HEAD:docs/DIOMEDES_CORE_PILLARS.md
git show HEAD:docs/DIOMEDES_LIVE_ROADMAP.md
git show HEAD:docs/DIOMEDES_PROJECT_MEMORY.md
git show HEAD:docs/implementation/2026-09-21-core-agent-client-review-r2.md
git show HEAD:client/App.tsx
git show HEAD:client/api.ts
git show HEAD:client/components.tsx
git show HEAD:client/conversation-send.ts
git show HEAD:client/console/Diomedes.tsx
git show HEAD:client/console/DiomedesHome.tsx
git show HEAD:client/console/diomedes-view.ts
git show HEAD:server/app.ts
git show HEAD:server/store.ts
git show HEAD:tests/conversation-send.test.ts
git show HEAD:tests/conversation-turn-id.test.ts
git show HEAD:tests/project-conversation.test.ts
git show HEAD:tests/diomedes-view.test.ts
git show HEAD:tests/diomedes-home.spec.ts
```

Additional source reliance through the diffs: `client/conversation-turn.ts`, `client/console/diomedes.css`, `shared/conversation-turn-id.ts`, `shared/diomedes-thread.ts`, and the contract/work-ledger documents named above. Exact code-block comparison ran in the tool orchestrator on the captured Git output; all seven comparisons were true. No shell interpreter, test runner or app was used for that comparison. The report was created with `apply_patch`; no implementation or test file was edited.

**Integrator evidence, separate from independent results**

The following exact commands read the authorized external logs through Git's no-index diff. Each exited 1 because the nonempty file differs from NUL; these were successful reads, not failing tests. The first read also emitted a line-ending warning and did not modify the file.

```text
git diff --no-index -- NUL F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd05-r3-evidence.txt
git diff --no-index -- NUL F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/mutate-r9-browser.txt
git diff --no-index -- NUL F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/mutate-r9-browser-B6.txt
```

`cd05-r3-evidence.txt` Part 1 records a successful build and all 25 browser cases passing in one serial run at `80a2d3f`, immediately before HEAD's documentation-only commit. Part 2 records gates at `18c20f2`: tsc exit 0; Vitest exit 1 with 235 files passed and 1 failed, 4,469 tests passed, 1 failed and 4 skipped; successful vite build; and a browser run with 8 passed, 1 failed and 16 not run. The later fixture repair preserves the whole services map, and Part 1 is the green browser rerun. No full Vitest rerun after that fixture-only change is claimed. The capability-record failure's reproduction on an untouched branch and its attribution to the repacked object store are the integrator's diagnosis; they were not independently reproduced here. No full browser suite result for this candidate was supplied or inferred.

The mutation logs record B1-B13, with B3 and B4 surviving as the redundant selection guards, and B6 initially surviving. The second log records B6 killed after the late-answer case was added. Across those records, 11 of the 13 distinct removals are killed. These are integrator mutation results, not mutations run here. They do not exercise stale recovery controls after a replacement claim. The new R-11 cases are unexecuted proposals and are not included in any of those counts.
