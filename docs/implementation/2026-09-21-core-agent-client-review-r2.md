**Rejected.**

CD-05.R-2, package CD-1, lane CD-05b, at `28ead7310e1be7b0c9d474d5afa087a41639a8ff`. The checkout was clean before any source read. Six client defects prevent acceptance: a confirmed send can become a new send, another window cannot recover the pending identity, late operations can overwrite the current scope, outcome cards cannot survive a reload, a refusal after uncertainty hides recovery, and concurrent first sends can create competing project conversations. These are source-traced results, not executed browser observations. The page/transport separation and the ordinary navigation changes are sound within the limits below. O5 / CD01-R-17 is closed separately. No implementation rewrite is requested.

**Findings, most severe first**

All six are P2 correctness defects and acceptance blockers. Numbering resumes at CD05-R-05. The regression snippets are proposed tests only; they were not executed or added to test files. Browser snippets use the imports and helpers already in `tests/diomedes-home.spec.ts`. Paste the following two helpers once alongside them. Each browser case can run independently with that fixture; the existing serial suite's earlier failures must not be mistaken for execution of these cases.

```ts
async function reviewProject(page: Page, name: string) {
  const p = await api<Project>('/projects', 'POST', { name });
  const store = application!.locals.store as Store;
  const saved = store.state(p.id);
  saved.project.ai = { engine: 'sample', model: null };
  await store.persist(saved);
  await open(page);
  await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
  await say(page, `Warm ${name}`);
  await expect(answers(page).last()).toHaveText(`You said: Warm ${name}`);
  await page.getByRole('combobox', { name: 'Mode' }).selectOption('automatic');
  return p;
}

async function painted(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}
```

**CD05-R-05 | P2 | A transcript-read failure turns a confirmed message back into a fresh send**

Claim and location: `client/console/DiomedesHome.tsx:165-183` puts the successful message POST and subsequent state GET inside one catch. `client/conversation-send.ts:190-198` has already removed the pending record and remembered the confirmed command before that GET. `client/console/Diomedes.tsx:124-133` restores the composer whenever the container returns false.

Observed source result: send a greeting, let its POST succeed, then fail only the state GET. The container treats that read error as a refusal, returns false, and restores the already-accepted text. There is no pending record. Pressing Enter again mints a second command for the same message and can call the provider again. The original confirmation was never uncertain. This is a retry duplication introduced by the container, despite the transport helper's correct cleanup behavior.

Smallest fix: separate message admission/confirmation from transcript refresh. Once `sendMessage` resolves, preserve that confirmation and return true even if the later read fails. Report a refresh failure and offer a read retry; do not put the text back or POST a new command. Closure requires the following case plus an assertion that retrying the refresh leaves one user turn and one message command.

```ts
test('CD05-R-05: a failed transcript read does not return a confirmed send', async ({ page }) => {
  await open(page);
  await say(page, 'Warm R05');
  await expect(answers(page).last()).toHaveText('You said: Warm R05');
  const bound = (await home())!;
  await page.route(`**/api/projects/${bound.projectId}/state`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Transcript read failed' } }),
    }), { times: 1 });
  await say(page, 'Only once R05');
  await expect(page.getByRole('alert')).toHaveText('Transcript read failed');
  const recorded = await api<ProjectState>(`/projects/${bound.projectId}/state`);
  const turns = recorded.conversations.find((t) => t.id === bound.threadId)!.turns;
  expect(turns.filter((t) => t.role === 'you' && t.text === 'Only once R05')).toHaveLength(1);
  // Candidate instead restores "Only once R05". Enter then sends a new command.
  await expect(composer(page)).toHaveValue('');
});
```

**CD05-R-06 | P2 | Pending identity is confined to one tab**

Claim and location: `client/conversation-send.ts:35`, `:134-144`, and `:224-248` use a module-local in-flight map and session storage. The shared local storage at `:151-164` holds only a confirmed command and is never consulted to recover a pending send.

Observed source result: window A loses both replies and retains command `uuid-1`. An independently opened window B has a separate session storage area. Sending the same pending text on the same thread there mints `uuid-2`. A copy of session storage inherited at window creation would only be a snapshot and would not coordinate later sends. The second-tab guarantee in requirement 1 does not hold. This is distinct from intentionally sending the same text again after a confirmed conversation turn.

Consequence: recovery in another window can duplicate generation and its recorded message. The server cannot recognize two different commands as one retry. No two-bodies-under-one-command path was established for valid, unmodified storage in a single tab.

Smallest fix: give pending sends an atomic owner/claim shared across windows, retaining the exact command and body before the request and reconciling completion/discard by that command. Session storage may remain a window reference, but cannot be the only record used by a second window. Merely changing to a localStorage get-then-set has its own simultaneous-writer race. Do not deduplicate all equal text forever. Closure must cover independent windows, simultaneous first claims, uncertainty, reload and explicit discard.

Paste into `tests/conversation-send.test.ts`; its existing `beforeEach` applies:

```ts
test('CD05-R-06: another window retries the pending command', async () => {
  fetchMock.mockRejectedValue(new TypeError('network'));
  await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
    mod.UnconfirmedMessage,
  );
  const original = sent(0);
  const firstWindow = session;
  // A new tab shares local storage, but has a new session storage and module instance.
  vi.stubGlobal('sessionStorage', makeStorage());
  vi.resetModules();
  const secondWindow = await import('../client/conversation-send.js');
  fetchMock.mockImplementationOnce(answered);
  await secondWindow.sendMessage(PROJECT, THREAD, input());
  expect(JSON.parse(firstWindow.getItem(PENDING)!).commandId).toBe(original.commandId);
  // Candidate sends uuid-2 here, after two attempts with uuid-1 in the first window.
  expect(sent(2)).toEqual(original);
});
```

**CD05-R-07 | P2 | Late selection and load results are not fenced to the current visit**

Claim and location: `client/console/DiomedesHome.tsx:204-227` publishes selection success, failure recovery, notice and busy state with no scope check. Scope changes at `:234-237` abort only message sends. The checks in `load` and `send` at `:103`, `:115`, `:172` and `:186` compare only scope IDs, so leaving A and returning to A also admits an obsolete operation from the first visit.

Observed source result: start a proposal in project A, hold its successful selection response, switch to All projects and finish a greeting there, then release A's response. The home greeting acquires a "Started in A" card. The result is authoritative for A, but does not belong to the displayed transcript. A similar delayed selection can overwrite a later message in the same scope. An old load can also overwrite a newer load after A -> B -> A. Abort alone is not a publication fence.

Consequence: the page associates an outcome/action with the wrong conversation or command and can clear another operation's busy state. This does not establish an unauthorized server start: the original Start click still supplied its own consent and digest.

Smallest fix: use a monotonically changing visit/request token, not only scope equality. Capture binding and command for each operation; verify ownership before every state publication, including catch/finally, pin bookkeeping and composer restoration. Invalidate old loads when sending or starting a newer load. Selection results must also remain associated with the current last command. Closure needs the delayed selection case below, selection followed by a later message, and A -> B -> A with delayed load and aborted-send completion.

```ts
test('CD05-R-07: a selection result cannot paint a different scope', async ({ page }) => {
  const p = await reviewProject(page, 'R07 project');
  await say(page, 'ACT R07 work');
  await expect(page.locator('.dio-card')).toContainText('Diomedes can start this');
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const recorded = new Promise<void>((resolve) => { reached = resolve; });
  await page.route('**/messages/*/select', async (route) => {
    const response = await route.fetch();
    reached();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true }).click();
    await recorded;
    await page.getByRole('combobox', { name: 'In' }).selectOption({ label: 'All projects' });
    await say(page, 'Home after R07');
    await expect(answers(page).last()).toHaveText('You said: Home after R07');
    const arrived = page.waitForResponse((r) => r.url().endsWith('/select'));
    release();
    await arrived;
    await painted(page);
    await expect(page.getByRole('combobox', { name: 'In' })).not.toHaveValue(p.id);
    // Candidate shows "Started in R07 project" under the home greeting.
    await expect(page.locator('.dio-card')).toHaveCount(0);
  } finally {
    release();
  }
});
```

**CD05-R-08 | P2 | Every outcome card disappears on reload**

Claim and location: `client/console/DiomedesHome.tsx:111-118` requires `ending.text === recorded.answerText`. The actual outcome GET implementation in `server/interaction-service.ts:291-309` always returns `answerText: null`. `shared/conversation.ts` explicitly permits null, while `Turn.text` is a string. The route does not hydrate an answer before returning it.

Observed source result: send a project request, receive a proposed card, reload and select that project again. The saved command is read, its authoritative outcome is fetched, and the transcript is rendered, but the condition that installs the card can never succeed. The same happens for a started card. This is an ordinary reproducible failure, not merely a race with another window.

Consequence: an offered proposal loses its Start control after reload, and started work loses its card/link. Last-command persistence does not deliver the promised recovery.

Smallest fix: match the outcome's run/command to the transcript's projected turn identity, not answer prose. The existing projection in `server/app.ts:2734-2736` derives the assistant turn ID from run ID and command ID; use a shared, consistent identity projection or an explicitly agreed server field. Keep the authoritative outcome GET. Do not fix this by removing the end-of-transcript guard or replaying POST merely to recover text. If answer text were later populated, equal answers from different commands would still make the current comparison unsafe. Revalidate the current transcript/operation before publishing a delayed outcome.

Closure requires reload recovery of both proposed and started cards, suppression after a newer message, two different commands with equal answer text, and an outcome read delayed while another window changes the transcript. The supplied eight cases test a greeting reload, which has no card, and cannot close this finding.

```ts
test('CD05-R-08: a proposal remains selectable after reload', async ({ page }) => {
  const p = await reviewProject(page, 'R08 project');
  await say(page, 'ACT R08 proposal');
  await expect(page.locator('.dio-card')).toContainText('Diomedes can start this');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Diomedes', exact: true })).toBeVisible();
  const outcomeRead = page.waitForResponse((r) =>
    r.request().method() === 'GET' && /\/messages\/[^/]+$/.test(r.url()));
  await page.getByRole('combobox', { name: 'In' }).selectOption(p.id);
  const result = await (await outcomeRead).json();
  expect(result.outcome.status).toBe('proposed');
  expect(result.answerText).toBeNull();
  await expect(answers(page).last()).toContainText('I can start that.');
  // Candidate has no card, even though the read above returned the proposal.
  await expect(page.locator('.dio-card').getByRole('button', { name: 'Start', exact: true }))
    .toBeVisible();
});
```

**CD05-R-09 | P2 | Refusal after uncertainty leaves a hidden pending message**

Claim and location: `client/conversation-send.ts:200-204` correctly keeps storage when a retry receives a 4xx after an uncertain attempt, but throws the ordinary ApiError. `client/console/DiomedesHome.tsx:177-183` classifies only `UnconfirmedMessage` as possibly sent and never checks the retained record.

Observed source result: let the first POST reach the server and lose its reply, then return 409 for the retry. Storage retains the original command, but the container returns false, restores its text and shows only a notice. The unconfirmed strip is absent. Replacing the text and sending is then refused by the helper as an earlier unconfirmed message, again without showing Send again or Discard. Changing Mode before retry similarly prevents the saved exact body from being used by the normal composer.

Consequence: the page says, through its composer behavior, that a possibly accepted message was refused, and hides the controls needed to resolve it. The transport does not discard the uncertain command; the defect is its presentation and recovery contract with the container.

Smallest fix: propagate pending/uncertain identity explicitly, or have the container inspect the retained pending record for the attempted binding before classifying failure. Show its exact saved text and expose resend/discard; return true for a message that may have been accepted. Keep the original refusal detail as a notice if useful. Closure requires the case below, resend after changing the visible Mode, and a fresh definitive refusal that still restores text normally.

```ts
test('CD05-R-09: refusal after a lost reply exposes the retained message', async ({ page }) => {
  await open(page);
  await say(page, 'Warm R09');
  await expect(answers(page).last()).toHaveText('You said: Warm R09');
  let attempts = 0;
  await page.route('**/api/projects/*/threads/*/messages', async (route) => {
    if (++attempts === 1) {
      await route.fetch();
      return route.abort('failed');
    }
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Retry refused R09' } }),
    });
  });
  await say(page, 'Uncertain R09');
  await expect(page.getByRole('alert')).toHaveText('Retry refused R09');
  const bound = (await home())!;
  const key = `diomedes.conversation.pending.${encodeURIComponent(bound.projectId)}|${encodeURIComponent(bound.threadId)}`;
  expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).not.toBeNull();
  // Candidate has the saved command but no strip or Discard control.
  await expect(page.getByRole('group', { name: 'A message that was not confirmed' }))
    .toContainText('Uncertain R09');
});
```

**CD05-R-10 | P2 | Concurrent first sends create competing project conversations**

Claim and location: `client/console/DiomedesHome.tsx:138-142` reads state and then separately creates an ordinary thread. `server/app.ts:2268-2283` creates a new thread for each such POST. `diomedesThread` deterministically chooses an oldest thread only after threads exist; it does not make the preceding read/create atomic.

Observed source result: two windows scope to a fresh project, both read no qualifying conversation, and both send. Each creates and sends on its own Diomedes thread. The next load in both windows chooses only the oldest. The other conversation's answer is absent from that page; if its reply was lost, its pending record remains keyed to a thread the page no longer loads. A per-thread identity repair for R-06 alone does not fix a race that chose two different threads.

Consequence: the project has two apparent Diomedes conversations, and recovery can strand one message. Home's server provisioner already avoids this category of race; project creation does not.

Smallest fix: make project conversation discovery/adoption/creation one serialized operation for that project, with all supported clients using it. A server-side project conversation provisioner under the existing Store lock is the natural boundary; keep its read path non-creating. If implemented client-side for this slice, the lock must span windows, re-read after acquiring it, and cover thread creation before any message identity is bound to the thread. Closure requires two concurrent first sends selecting one thread, plus loss/reload recovery of either window's message.

```ts
test('CD05-R-10: concurrent first sends adopt one project thread', async ({ page, context }) => {
  const p = await api<Project>('/projects', 'POST', { name: 'R10 project' });
  const other = await context.newPage();
  try {
    await Promise.all([open(page), open(other)]);
    await Promise.all([page, other].map(async (window) => {
      const loaded = window.waitForResponse((r) => r.url().endsWith(`/projects/${p.id}/state`));
      await window.getByRole('combobox', { name: 'In' }).selectOption(p.id);
      await loaded;
      await painted(window);
    }));
    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    for (const window of [page, other]) {
      await window.route(`**/api/projects/${p.id}/state`, async (route) => {
        const snapshot = await route.fetch();
        if (++readers === 2) release();
        await bothRead;
        await route.fulfill({ response: snapshot });
      }, { times: 1 });
    }
    await Promise.all([say(page, 'First R10'), say(other, 'Second R10')]);
    await Promise.all([
      expect(answers(page).last()).toHaveText('You said: First R10'),
      expect(answers(other).last()).toHaveText('You said: Second R10'),
    ]);
    const saved = await api<ProjectState>(`/projects/${p.id}/state`);
    // Candidate creates two. No test here sends the same text twice.
    expect(saved.conversations.filter((t) => t.name === 'Diomedes')).toHaveLength(1);
  } finally {
    await other.close();
  }
});
```

**Client-side engine pin**

The ordinary thread PUT is acceptable for this bounded slice. The reviewed conversation seam is explicitly Claude Code-only, the pin changes only that thread, and Work remains on the project's own selection. It is performed on send, not on a scope read; the page does not fall back to the old /ask route. This is not a new authority grant or an approval to switch arbitrary project work to that provider.

The `pinned` ref is an optimization, not an invariant. Another window can change an ordinary project thread's engine after this page caches it; the next message is then refused until the page reloads/revalidates. Re-read or invalidate that cache on such a refusal rather than claiming the ref guarantees the server's current engine. When closing R-10 with a server provisioner, pin the adopted/created project Diomedes thread there, in the same Store-locked operation, analogous to home provisioning. Do not make all ordinary threads Claude Code-only, widen message/select authority, or use GET to repair it. Moving the pin server-side by itself would not close R-05 through R-09.

**O5 / CD01-R-17: closed**

The live guard at `server/app.ts:2303-2307` uses reserved Project identity and rejects an explicitly supplied non-Claude engine with 409 before name, permission, mode, requested model or engine assignment. It neither rewrites the choice nor changes home discovery/provisioning. The live cases at `tests/home-conversation.test.ts:578-654` include the original reproducer, mixed rename/mode/engine atomic refusal, invalid-engine refusal, preservation across close/open and a successful answer afterward, allowed Ask/Plan/Automatic, and an ordinary-project control. The closing conditions are recorded at `docs/implementation/2026-09-21-core-agent-contract-review-r7.md:122`; I-19 in the contract records the repair. The `26b33ff` diff leaves message/select/outcome shapes unchanged.

Source inspection establishes the guard and case coverage. Execution support is the integrator's full Vitest run at `105adfc`, which includes this unchanged repair and its tests; this review did not run the home suite independently. The documented P1 guard-removal result is the integrator's mutation claim, not a mutation performed here. It is plausible from the two direct guard assertions, but is not needed to inflate the independent evidence. The later HEAD diff changes App and the browser landmark, not O5. These limits do not reopen the bounded home engine defect.

**Checks that held and acceptance limits**

- Same-tab transport saves normalized exact text/mode/sources with a minted command before dispatch; consent is a constant true in every send body. Its automatic retry uses the same body and identity. Valid differing input is blocked while that record exists. A fresh 4xx other than 408 clears the pending record; an earlier uncertain attempt keeps it. Abort retains it and produces `UnconfirmedMessage`. No client-minted source-message identity is sent.
- Persistent client state holds pending input, last confirmed command identity, navigation and pins, not an outcome status. Outcome cards are derived from `MessageResult`; the view-model offers Start only for proposed and Open the work only for started. The late-result and reload defects above still prevent truthful association/recovery in the container.
- Selection carries consent, digest and target on the message's /select route. Work does not start from an inferred project or a simple greeting. No new conversation request uses /ask Build/Fix.
- Scope loading uses GET /home/conversation or a project's state and creates nothing. The thread selector excludes task/document/review attachments, prefers the oldest qualifying thread, and uses ID to break ties. Sequential adoption works; R-10 covers concurrent creation.
- `Diomedes.tsx` remains props-only. A definitive refusal restores text only if the composer is empty. A displayed unconfirmed message disables normal Send and offers explicit recovery. The defects are the container's classification and asynchronous ownership, not a need to move network logic into this component.
- A fresh session starts with Diomedes and does not consult openProjects to choose home or a Work target. `Home.tsx` no longer chooses `byRecency[0]`; its ask requires a chosen project. Projects is available in the default rail, and the existing destinations remain reachable through Projects/Everything, including Sample project through Projects. Automations is a held real button: `Rail.tsx` displays its reason without routing it.
- `App.tsx:211-238` stores only a project ID for this window, removes it when selected becomes null, and restores only a project in the current listing. Returning to Projects/Diomedes therefore clears the ordinary same-window restoration path; a removed project is not restored. There is no outcome/authority in this value. No claim is made that session storage distinguishes every browser session-restoration behavior from a launch. A fresh browsing session has no saved place; a browser that restores the session can retain it. Installed-window lifecycle behavior remains untested. No additional launch blocker was established from the ordinary same-window source path.

The eight browser cases do not reach R-05 through R-10. In particular they have no confirmed-POST/failed-GET split, no second window, no delayed scope/selection response, no proposal or started-card reload, no uncertainty followed by a definitive retry refusal, and no concurrent project provisioning. Their lost-response test reloads the same tab on All projects and loses both replies; it does not prove a second window, project-scope pending recovery, or abort during provisioning. The fixture's interrupt method throws rather than exercising a held provider turn. Plan only, changing Mode while uncertain, latest-transcript reconciliation after another window writes, restored/deleted project navigation, long-content narrow layout, and preservation of newly typed composer text during a refusal need additional coverage. These are coverage limits, not extra unproved defect findings.

The browser fixture uses createApp, the Store and Runtime with a scripted provider and a built bundle freshness check. Its eight declared tests are not eight passed tests. No streaming preview, populated results ledger, real-provider run or installed-build run is claimed. The duplicate scripted fixture can be consolidated after the frozen seam work permits it; that mechanical duplication is not an acceptance blocker.

Repository authorities read: Core Pillars `2026-09-19.1`; Live Roadmap `2026-09-19.2`; Project Memory `2026-09-19.2`. Pillar impact: the proposed wiring advances the single Console and native conversation boundary, but duplicate retry identity and misassociated evidence conflict with the recovery and truthful-state requirements of P06/P09. No pillar definition is changed. Roadmap impact: CD-05b remains unaccepted; O5 closes. No canonical roadmap status was edited. Build status: this HEAD type-checks, but browser behavior remains unproven. Publication/deployment status: nothing committed, pushed, packaged or deployed. Only this review file is new and uncommitted; the fixes above are requested, not implemented.

**Independent commands and results**

All commands ran from `F:/Diomedes/diomedes-wt/core-agent-client-review`. No source was read from the integration worktree or the main checkout. The dependency junction appears in Vitest's stack trace; it was not modified or recreated.

| Command | Real result |
| --- | --- |
| `git status --short` | Exit 0, empty before all reads; empty again after validation and before writing this report. Final check lists only this new report. |
| `git log -1 --format="%H %D"` | Exit 0; HEAD `28ead7310e1be7b0c9d474d5afa087a41639a8ff`, branch `feature/core-agent-client-review`. |
| `git log --oneline 6ead078~1..HEAD` | Exit 0; checked the five client commits and intervening server-lane merges. |
| `git diff 6ead078~1..HEAD --stat -- client/ tests/conversation-send.test.ts tests/diomedes-view.test.ts tests/diomedes-home.spec.ts tests/fixtures/scripted-conversation.ts tests/ui.spec.ts playwright.config.ts` | Exit 0; 13 files, 1,714 insertions, 33 deletions. |
| `git diff 6ead078~1..HEAD -- client/ tests/conversation-send.test.ts tests/diomedes-view.test.ts tests/diomedes-home.spec.ts tests/fixtures/scripted-conversation.ts tests/ui.spec.ts playwright.config.ts` | Exit 0; large output truncated, supplemented by direct file reads and the focused diffs below. |
| `git diff 6ead078~1..HEAD -- client/App.tsx client/console/Home.tsx client/console/Diomedes.tsx client/console/diomedes-view.ts client/console/diomedes.css playwright.config.ts tests/ui.spec.ts` | Exit 0; reviewed client wiring, view changes and entry-step edits. |
| `git diff 6ead078~1..HEAD -- client/App.tsx` | Exit 0; focused launch/navigation review. |
| `git show 26b33ff -- server/app.ts tests/home-conversation.test.ts` | Exit 0; reviewed O5 patch against closing conditions and current files. |
| `git diff 105adfc..HEAD -- client/App.tsx tests/diomedes-home.spec.ts tests/ui.spec.ts` | Exit 0; App session-place repair and corrected browser landmark; no ui.spec.ts delta in that final commit. |
| `./node_modules/.bin/tsc --noEmit` | Exit 0, no diagnostics. |
| `./node_modules/.bin/vitest run tests/conversation-send.test.ts tests/diomedes-view.test.ts` | Exit 1 before collection: EPERM opening `node_modules/.vite-temp/vitest.config.ts.timestamp-1789979720465-7fa3822872df5.mjs`. No tests executed. One attempt only. |

Source reading used PowerShell Get-Content and rg, including line-numbered views. A few discovery searches used nonexistent guessed driver paths or a Windows glob argument and returned path errors; subsequent searches used the actual files. They are not test failures or execution evidence. The report was created with apply_patch. No full suite, browser command, build, package, provider call, Git mutation or dependency installation was run.

**Integrator evidence, separate from the above**

Read `F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/bot-gates.txt`. It names `105adfca7f1900d669ae4572d2a0c89f46861800`, one commit before the reviewed HEAD. It records tsc exit 0; Vitest exit 0 with 234 files passed, 4,438 tests passed and 4 skipped; and a completed vite build. The new browser spec exited 1: 3 passed, 1 failed at the retired Project pages landmark, 4 did not run. The full browser run exited 1: 29 failed, 84 did not run, 21 passed. These are the file's actual counts, not this review's counts. The log's final status lists two modified evidence images and the spec. The corrected landmark and session-place change at HEAD have no green browser evidence in that file. Entry-step migration elsewhere was neither read nor accepted here.

**Source-read appendix**

Files actually relied on: `AGENTS.md`; the three canonical repository mirrors named above; the thirteen files in the requested diff; `client/api.ts`; the command-ID helper in `client/work-start.ts`; `client/console/Rail.tsx`; `shared/conversation.ts`; `shared/ai-selection.ts`; the Turn/Conversation definitions in `shared/types.ts`; the specified routes and projection in `server/app.ts`; `server/engines/interaction-routes.ts`; the outcome read in `server/interaction-service.ts`; identity definitions in `server/interaction-turn.ts`; `tests/home-conversation.test.ts`; `docs/implementation/2026-09-21-core-agent-contract-review-r7.md`; and the Round 8/I-19 section of `docs/implementation/2026-09-20-core-agent-contract.md`. Server inspection was limited to the consumer contract, the project-thread creation boundary needed for R-10, and O5; this is not a second acceptance review of CD-01.
