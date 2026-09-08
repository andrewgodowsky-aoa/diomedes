# 3c — Ctrl+K palette (report)

The placeholder `client/console/Palette.tsx` is now the operational command
surface from `05-instrumented-density-prototype.html` §"Ctrl+K: find a thing
and act on it in its current state". Files touched: `Palette.tsx`
(replaced), `palette.css` (new), `paletteEntries.ts` (new), `Shell.tsx`
(entries + mount + "Ctrl K" link + `onPaletteKey` registration), `App.tsx`
(Ctrl+K branch only), `types.ts` (optional `query`/`onQuery` on
`PaletteProps` only). `BoardView.tsx`, `board.css`, `TeamView.tsx`,
`team.css` untouched.

## Context shape settled on

`paletteEntries.ts` exports `buildEntries(ctx: PaletteContext)` returning
unfiltered `PaletteEntry[]`, plus `filterPalette` (verb search),
`applyQuery` (verb search + Recent prepend), `noteRecent` / `peekRecent` /
`clearRecent` (module-memory last-three), and `taskBoardState`.

```ts
PaletteContext = {
  tasks: Task[]; sessions: Session[]; needs: Need[]; changes: Change[];
  members: TeamMember[];
  catalogs: Record<string, EngineCatalog>;   // live GET /engines/:id/models, as the Picker reads it
  integrations: IntegrationStatus[];         // engine names for model subs
  projects: Project[];                       // open projects, from App via Shell's `projects` prop
  currentProjectId: string; currentThread: Conversation | null;
  policy: 'first' | 'go'; view: ShellView;
  focusTaskId?: string; focusTaskName?: string;   // Views sub "{focus}, from here"
  pendingTaskId: string | null; routingTaskId: string | null;  // two-step confirms
  onPendingTask(id): void; onRoutingTask(id): void;
  onPivotModels(): void;                     // Model verb: sets palette query to "use", stay
  handlers: PaletteHandlers;
}
```

Query/pending/routing state lives in the Shell (`paletteQuery`,
`pendingTaskId`, `routingTaskId`) so the entries the Shell builds and the
input stay in sync; `Palette` takes them as optional controlled props with an
uncontrolled fallback. `needs`/`changes` are accepted per the contract but
unused: the review/blocked split follows the board mapping on
`task.reason` (`needs-ok`/`changes-ready` → review, other `waiting` →
blocked), exactly as specified.

Worker for a task sub (`{state} on {worker}, {age}`): live session engine
name → assigned member name → owner (`You`/`Diomedes`). Age from
`task.createdAt`: `now`, `N m`, `N h`, `N d`, else the weekday (`sun`…),
matching the prototype's age column.

## Which handler each action calls

All actions call the same Shell closures the board/lanes call:

| Row | Action | Handler |
|---|---|---|
| ready | Start (go) / Start now | `startTask(task, firstRoute)` |
| ready | Start / Not now (first) | `onPendingTask` only (stay) |
| working | Pause | live session → `stopSession(id)` |
| working | Team | `setView('Team')` |
| review | Review | `openTaskThread` + scroll to its need |
| blocked | Route to | `onRoutingTask` (stay) → per-member `PUT assignedTo` + reload |
| done | Reopen | `moveTask(task, 'todo')` |
| non-done | Board | `setView('Board')` |
| non-done | Model | `onPivotModels` (stay) |
| worker | Message (light) | `setView('Team')` + focus composer, target in a ref |
| worker | Stop / Start | `stopMember` / `wakeMember` |
| worker | Lane / Thread | `setView('Team')` / `setSelectedId` + `setView('Thread')` |
| model | Use here (light) | `setRequested(selected, {model, defaultEffort})`; Default rows `setRequested(selected, null)` |
| project | Open | App `onOpenProject` |
| view | Open | `setView` |

Non-`stay` actions record `noteRecent(name)` then close; closing returns
focus to `.console .composer textarea`. Opening clears query, selection and
both pending confirms.

## Deviations from the prototype and why

1. **No Handoff on Working; no Pause/Take over on workers.** The brief's
   action lists rule: Working → Pause, Team; workers → Message, Stop,
   Start, Lane, Thread. Prototype-only verbs dropped.
2. **Route to is a two-step member list** (stay → one action per member +
   Cancel), per the brief. The prototype routed directly to a hard-coded
   worker; the brief explicitly requires the member-list step.
3. **Worker sub shows the engine id** (`member, opencode`), per the brief;
   the prototype showed the model slug. Point mapping: working live,
   waiting/idle hollow, error attn (+ `, blocked`), stopped done.
4. **Models group needs a current thread** and is skipped when none is
   open (Use here must `setRequested` on it). Default row per engine
   clears the request; its point is live when the thread has no request.
5. **Message with no composer:** the lane view is still the placeholder
   with no composer, so Message opens Team, records the slot in a ref for
   the pass that adds the composer, and focuses the first composer
   available. No parallel-agent files touched.
6. **No rail entry:** the rail (`Rail.tsx`) is outside the editable set,
   so the palette opens from Ctrl+K and the top-strip "Ctrl K" link only.
7. **App Ctrl+K gating reads `settingsRef` + `showSettings`** rather than a
   hoisted `consoleActive`, so the Workbook project search is untouched and
   there is no null-settings crash on first paint.

## Test summary (exact lines)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run` — `Test Files 10 passed (10)` / `Tests 227 passed (227)`.
- `npx vite build` then `npx playwright test tests/ui.spec.ts
  tests/native-ui.spec.ts` — final runs: `16 passed (24.9s)` for
  `tests/ui.spec.ts`; `1 passed (5.0s)` for `tests/native-ui.spec.ts`.
  (`grep` for `Control+k|Ctrl+K|search` in both specs: no matches — the
  Workbook search has no playwright coverage to break. Mid-verification
  failures were environmental: two parallel agents share this worktree and
  its fixed test ports — `native-ui`'s dist-freshness guard tripped on
  their live `styles.css` edits, and one run collided on port 5174. Both
  pass on quiet runs.)
- Throwaway `tsx` matrix over `buildEntries`/`applyQuery` (36 checks, file
  removed after): state mapping, per-state actions/points/subs,
  pending/routing expansions, worker conditionals (Stop unless stopped,
  Start only waiting+unread, Thread only with threadId), model Default
  rows, verb search (`pause` → 1 row, `route` → 1 row, `use` → models
  only), Recent-first-on-empty-query — `ALL PASS`.
- Manual look (`DIOMEDES_CLIENT_PORT=5183`, `DIOMEDES_PORT=47643`,
  `.data-3c`, onboarding skipped per brief): project + 3 tasks created;
  Ctrl+K opens `role="dialog" Find and act`; `start` → 3 rows; Enter →
  `START NOW / NOT NOW / BOARD / MODEL`; Start now closes the palette and
  the task leaves `todo`; `pause` correctly shows `Nothing matches` (the
  started task sits in review under Show-me-first); Esc closes; Workbook
  Ctrl+K still opens the project search. No page errors. Server stopped
  after.

Not committed, per instructions.
