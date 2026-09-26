# PostHog PH-07 round 4: re-review of the R3-1 to R3-4 repair and the no-PostHog-AI guard

| | |
|---|---|
| Work order | PH-07 round 4 |
| Candidate | `f4ef0b9` on `feature/posthog-observation`: `5226b0c` (round 3's `51ddca6`, cherry-picked), `9190826` (the R3-1 to R3-4 repair), `f4ef0b9` (the guard for the owner's rule) |
| Round 3 | `docs/implementation/2026-09-25-posthog-ph07-review-round3.md`, `tests/ph07-round3-review.test.ts` (`51ddca6`) |
| Rounds 1 and 2 | `tests/ph07-review.test.ts` (a3f7a3c), `tests/ph07-round2-review.test.ts` (7e4f0c9) |
| Review branch | `review/posthog-ph07-round4` in `F:/Diomedes/diomedes-wt/posthog-review`, created at `f4ef0b9` |
| Additions | `tests/ph07-round4-review.test.ts` (6 tests, all passing on `f4ef0b9`), committed with this document |
| Owner | Andrew |
| Date | 2026-09-26 |

The reviewer wrote round 3 but not the repair or the guard, and did not see the builder's
conversation. Every result below was produced in this worktree. No request reached PostHog, AWS or
any other host. The PostHog origin is `https://posthog.invalid`, answered in process. The account
service is the faux service in process, with its own managed gateway. Every `file:line` is at
`f4ef0b9`.

The candidate's source was modified only for the three mutation runs in "The guard". Each plant was
reverted before the next run, and only the two guard files ran while a plant was present. After the
last revert, `git status --short` listed only the new test file.

**The earlier reproducers are unchanged.** The round 3 file has blob `4ea3c8c7…` at `51ddca6` and at
`f4ef0b9`. `git diff --quiet f35f06e f4ef0b9 -- tests/ph07-review.test.ts tests/ph07-round2-review.test.ts`
exits 0. The only earlier test the builder changed is `tests/observability-eligibility.test.ts:221`
(ruling 6 below).

## Verdicts

| Slice | Verdict |
|---|---|
| **PH-01**, metadata observation | **Accepted.** R3-1 to R3-4 are fixed at their cause. The five round 3 reproducers that failed at `f35f06e` pass unchanged (K1, K2, M1, B1, E1). Rounds 1, 2 and 3 pass in full: 17, 13 and 15 tests. Round 3's conditions for PH-04 and customer activation are met. Two new P3 findings follow. R4-2 is about the repair. R4-1 is about the guard. |
| **PH-02**, the `/batch/` transport, off by default | **Accepted.** The owner's rule holds today on the full turn path, not only on the exporter path. G2 ran a Nectovia turn and an AWS turn in `posthog` mode, with no fetch injected, from bind through projection to export. The only request that left the process was the `POST https://posthog.invalid/batch/`. **Condition (R4-1):** before `posthog` mode is switched on, fold G1 and G2, or an equivalent, into `tests/observability-no-posthog-ai.test.ts`. As shipped, the guard does not fail for a PostHog path added outside `server/observability/`, or for a request made on the turn path. |

## R3-1 to R3-4

| # | Verdict | Evidence |
|---|---|---|
| R3-1 | **Fixed at cause.** | The cause had two halves. The session stored any 200 as an answer, and the recheck read `unknown` as final. Both are repaired. `accessAnswer` (`server/accounts/session.ts:99-102`) keeps an answer only if it parses against `accessAnswerSchema` (`:86-96`) and names the business asked about. `loadAccess` uses it (`:439`). A rejected answer is stored as `null`, which `entitlement()` reports as `unknown` (`:492-497`). `recheckScope` returns `account-service-unavailable` for `unknown` (`server/observability/eligibility.ts:299`), before the `entitlement-inactive` check. The schema matches the service's `AccessView` field for field (`shared/access.ts:250`, `:265-284`), including `agent.reason: ''` when included (`services/control-plane/src/commercial.ts:377-402`). **K1 and K2 pass**, and so do the builder's R3-1 tests (`tests/observability-r3-repair.test.ts:138`, `:150`, `:187`). |
| R3-2 | **Fixed at cause.** | `admitAgent` maps to `not_a_member` only when `refusedMembership(error)` holds (`session.ts:556`). That means a 403 whose code is `not_a_member`, or whose message is one of the service's two membership sentences (`:112-121`). Anything else is `entitlement_unknown`. **M1 passes.** The builder's positive control drives the real service end to end, including its serialization. A member is withdrawn with `setMembership(... 'revoked')`, and the next admission is `not_a_member` (`observability-r3-repair.test.ts:303`). Every `Error(403` in `services/control-plane/src` was listed: only `account-service.ts:97` and `:358` are on the admission path (`commercial.ts:420-464`). |
| R3-3 | **Fixed at cause.** | `admitModelApi` reads `observation.ask(projectId)` before the gate's round trip (`server/engines/service.ts:1998-2002`). It passes that read to `refused` (`:2008`), to the owner-paid `bind` (`:2037-2044`) and to the Nectovia `bind` (`:2137`). `decide` uses the active business from the ask as the baseline (`server/observability/scopes.ts:212`). It uses the change count from the ask as the generation (`:228`), so a switch during the round trip ends the scope. Every admission goes through `admitModelApi`: each message (`service.ts:2202`), Work (`:2282`), team (`:2413`), `:2461`, and loops (`server/app.ts:1174`). These are also the only two `bind` call sites. **B1 passes.** |
| R3-4 | **Fixed at cause.** | `resolve` claims a scope for its run (`scopes.ts:307-315`). The projector marks it ended only after projecting a run in a final state (`server/observability/projector.ts:323`, `scopes.ts:326-328`). `evictOverflow` forgets the oldest ended scope first, then the oldest unclaimed one (counted `scope-evicted`). It never forgets a live one or the scope just bound (`scopes.ts:254-274`). A run saved after its scope was forgotten is counted once in the projector's `scopeEvicted` (`projector.ts:289-297`). **E1 passes.** A running loop survives 2,000 later messages at the production limit, and its trace is projected (`observability-r3-repair.test.ts:461`). |

## The builder's rulings

| # | Ruling | Verdict | Note |
|---|---|---|---|
| 1 | R3-2 recognizes the service's two membership refusals by exact text, with a drift test, because `services/control-plane` was read-only. | **Accept, with a follow-up for the service.** | The drift test (`observability-r3-repair.test.ts:237-242`) pins that both sentences still exist as `new AccountError(403, '…')`. It does not pin that they are the only membership 403s on the admission path, which is true today. Suppose the service adds a third membership refusal. The host then reads it as `entitlement_unknown`, and two things follow. First, observation of that business is not ended at the admission. It ends at the next reload instead, when `entitlement()` reads the membership row as not active (`session.ts:491`). Second, the person sees "could not be reached" instead of "not a member". The durable fix belongs in the service: send `code: 'not_a_member'` with its membership 403s, as `services/control-plane/src/managed-inference.ts:753` already does. The host accepts the code today (`session.ts:120`). |
| 2 | An edge-page 403 or 404 is told as "could not be reached". | **Accept.** | This is more accurate than "not a member". Person-visible: for these cases the sentence changes from the membership refusal to the `entitlement_unknown` sentence. The status and body code are unchanged, as C1 in round 3 showed for every gate refusal. |
| 3 | A membership the service lists as not active reads as not included, final. | **Accept. R3-1 requires it.** | Without it, such a row would have no stored answer (`loadAccess` reads active rows only, `session.ts:433`). It would then report `unknown` and, after R3-1, never end. With it, the service's own listing is final, like the refusal the next admission would give. One new person-visible sentence, not listed with the rulings: `NOT_A_MEMBER_REASON` (`session.ts:124`). It replaces "The account service has not answered…" wherever the workspace view shows that business's entitlement (`server/workspaces.ts:373`, `:1766`). The sentence is accurate. |
| 4 | R3-4 eviction order: ended scopes first, then never-used ones, never a live one; an evicted never-used scope is counted as `scope-evicted`. | **Accept.** | Note: `reconcile_required` (parked) and `waiting` runs are not final (`scopes.ts:135`), so their scopes are live and are kept past the bound. The builder pins this as the design (`observability-r3-repair.test.ts:475`), and the contract says so (PH-00 4.6). The map then grows with unfinished runs, not without bound, and it is in memory only. Not a finding. |
| 5 | R3-3 binds nothing when the gate admits a different business than asked; a switch-and-back now also drops events, per N-3. | **Accept.** | The guard at `scopes.ts:204` is defensive, because the gate and the ask pick the business by the same rule on the same turn. When it fires, it fails closed (`workspace-changed`). Dropping the events on a switch and back during the round trip is N-3's rule: undoing a change never revives a scope. Pinned at `observability-r3-repair.test.ts:342`, `:365`. |
| 6 | `tests/observability-eligibility.test.ts:221` updated to the new R3-1 rule. | **Accept.** | The old assertion (`unknown` gives `entitlement-inactive`) encoded R3-1's defect. The new lines still assert a non-live result, `account-service-unavailable`, and add the `agent: false` case. The other assertions in that test are unchanged. |

## The guard (question 4)

The guard file `tests/observability-no-posthog-ai.test.ts` has three layers:

- **Driven, `:124-186`.** Runs the runtime's exporter and transport against every answer and host spelling.
- **Static, `:221-346`.** A TypeScript-parser pass over `server/observability/`.
- **Canary, `:348-367`.** Scans `server/observability/` and `shared/observability.ts`.

Its driven layer is strong for what it drives. The static and canary layers are exact about the
current code. But nothing in the file reaches outside `server/observability/`, and the driven layer
never runs a turn. Mutations, each run on the two guard files only (slot `slot_mui20sx2_7fba6a87`):

| Plant | f4ef0b9's guard (9 tests) | This review's G1/G2 |
|---|---|---|
| **M1**: the transport's `this.url` becomes `` `${origin.origin}/i/v0/e/` `` | **5 fail**: the three driven tests, the `this.url` test, the path-literal test. The value-import, `fetch`-identifier and both canary tests pass. The builder reported six for an `llm_analytics` path, which the canary test also catches. | G2 fails. |
| **M2**: in `ObservationScopes.resolve` (turn path), `(globalThis as …)['fe' + 'tch'](new URL('flags/?v=2', this.operator.posthog.host))`, no `method` | **All 9 pass.** No `fetch` identifier, no literal starting with `/` or containing `://`, no method, and `flags/` does not contain the `/flags` canary. The driven tests never call `resolve`. | **G2 fails**: `expected 'https://posthog.invalid/flags/?v=2' to be 'https://posthog.invalid/batch/'` (`tests/ph07-round4-review.test.ts:357`). |
| **M3**: a new, never-imported `server/posthog-flags.ts` that reads `NECTOVIA_POSTHOG_CAPTURE_KEY` and `fetch`es `https://us.i.posthog.com/decide/?v=3` | **All 9 pass.** Outside the scanned folder. | **G1a and G1b fail** (`:95`, `:102`). G2 passes: nothing runs the plant. |

The mutation runs used this file before G1d was added (5 tests). G1d is shown to be non-vacuous
inside the file (`:122`).

**What the additions pin (`tests/ph07-round4-review.test.ts`; all six pass on `f4ef0b9`):**

- **G1, static.** It covers `server`, `shared`, `client`, `desktop`, `scripts`, the account service's `src`, `contract` and `scripts`, and the root pages and configuration (`index.html`, `vite.config.ts`, `wrangler.jsonc` and the like).
  - **G1a.** No PostHog host, as a URL or a bare host, appears outside `server/observability/`. The pattern is keyed on the host, so the vendor contract's `github.com/PostHog/posthog.com` citation does not trip it.
  - **G1b.** `NECTOVIA_POSTHOG_*` and `phc_` appear only in `server/observability/eligibility.ts`.
  - **G1d.** `captureKey`, `posthog.host` and `posthog-transport` appear only in `server/observability/`.
  - **G1c.** No `posthog` package is a dependency of the app or of the account service.
- **G2, driven.** One Nectovia turn and one AWS turn run in `posthog` mode with no fetch injected, so the production transport uses the global fetch. The global fetch passes only the test's requests to its own local app. Everything else is recorded and answered in process. Every recorded request must be `POST https://posthog.invalid/batch/` with `redirect: 'error'`, the one header, and a `{api_key, batch}` body. Both turns' `$ai_trace` must be present, one managed and one owner-paid.

**What no test here can close.** Suppose a later module outside `server/observability/` imports the
operator config under another name. It then reaches PostHog through `node:https` or `undici`, runs off
the conversation turn path, and never names a host, a variable or a config field. It would still pass.
G1 and G2 make an accidental regression fail. They do not make a deliberate evasion impossible.

Two facts bound the AI half of the rule:

- **The only key is a project capture key.** The configured key must match `^phc_…`
  (`eligibility.ts:65`). Round 1 pins that a personal key (`phx_`) is refused (`tests/ph07-review.test.ts:1155`).
  The host therefore holds no credential for PostHog's private API, which serves queries, summaries
  and evaluations.
- **A capture key still reaches more than `/batch/`.** It can reach `/decide` and `/flags`, which are
  outside the owner's "only POST /batch/" rule though not billed in AI credits. That is what M2 plants.

**Operational condition, not a code finding.** Some AI features run on PostHog's side over ingested
`$ai_*` events if the project enables them: LLM-analytics evaluations, trace summaries, or PostHog AI
over the project. No code guard can see those settings. Before `posthog` mode is switched on, the
operator confirms in the PostHog project that none is enabled and that no AI data processing is
approved. This review did not check PostHog's settings or documentation, and made no call to PostHog.

## New findings

| # | Severity | Evidence | Summary |
|---|---|---|---|
| R4-1 | P3 | M2 and M3 above. G1 and G2 in `tests/ph07-round4-review.test.ts` catch both. | The guard for the owner's rule does not fail for two kinds of later change. One is a PostHog path added outside `server/observability/`. The other is a request made on the turn path that avoids the identifier `fetch` and leading-slash literals. The builder's second guard claims "nothing in `server/observability/` can reach the network except the transport's one call" (the guard file's header, `:11-12`), and M2 is a counterexample. Today's code meets the rule (G2 passes), so no request violates it. **Fix:** adopt G1 and G2, or an equivalent, in the guard file. The same plant fails G2 and passes the guard. |
| R4-2 | P3 | By reading. There is no reproducer, because the schema is not exported and the service would have to change. | `accessAnswerSchema` (`session.ts:86-96`) is written by hand over a type the service shares (`AccessView`, `AccessState` at `shared/access.ts:250`). Nothing ties the two at compile time. If the service adds an access state, or changes a field's type, the host reads every such answer as no answer. `entitlement()` then reports `unknown` for a business the service did answer. Observation fails closed: events are held, then age out. The same view also feeds the workspace list (`server/workspaces.ts:1766`), the customization gate (`server/customization-gate.ts:141`) and the managed-usage routes (`server/managed-usage-routes.ts:107`), so the person sees "has not answered" and plan features read as unavailable. A `z.ZodType<AccessView>` annotation would not catch an added state, because a narrower enum is still assignable. **Fix:** derive both from one `as const` list in `shared/access.ts` (`z.enum(ACCESS_STATES)`), or add a compile-time equality check between `z.infer<typeof accessAnswerSchema>` and `AccessView`. |

## What may merge, be used internally, or be activated

- **PH-01 and PH-02 may merge** as accepted above. Nothing here blocks internal `memory` mode.
- **Internal `posthog` mode** still waits on round 1's preconditions (funding date, daily cap, operator configuration). This round adds two more: R4-1's guard extension, and the operator's check of the PostHog project's AI settings.
- **R4-2** should be fixed before the account service's access states or fields next change. It does not block either mode.

## Commands and counts

Each heavy run took the shared slot (`scripts/coordination.ts slot --role opus --pid 14868 --node PH-07`) and released it before the next. Vitest ran with `--maxWorkers=2`.

| Slot | Command | Result |
|---|---|---|
| `slot_mui1wrcd_45eb2e5c` | `tsc --noEmit -p tsconfig.json` (includes `tests/`) | exit 0 |
| `slot_mui1xnca_5af09545` | vitest: `ph07-review`, `ph07-round2-review`, `ph07-round3-review`, `ph07-round4-review` (5-test version), the nine `observability-*` files, `nectovia-route`, `nectovia-bot-app` | **15 files, 189 passed**, 0 failed. Per file: round 1 17, round 2 13, round 3 15, round 4 5, r3-repair 14, no-posthog-ai 9, eligibility 19, exporter 11, first-trace 9, managed-payer 1, posthog-transport 12, record 24, runtime 11, nectovia-route 18, nectovia-bot-app 11. The builder's 14 files and 184 tests, plus this review's 5. |
| `slot_mui1zxrl_2202d6ef` | vitest, the neighbours of the changed session and engine-service code: `customer-accounts-app`, `configuration-proof`, `engine-service`, `managed-gateway`, `account-foundation`, `account-foundation-independent`, `b00-acceptance-20260917`, `b00-control-plane-contract`, `b00-h01-repair`, `execution-resolver`, `swe2-independent-review`, `h16-external-model-api`, `thread-conversation-model-api`, `team-any-route`, `native-loop-routes`, `work-admission` | **16 files, 289 passed**, 0 failed |
| `slot_mui20sx2_7fba6a87` | M1, M2 and M3, each on `observability-no-posthog-ai` and `ph07-round4-review` only, reverted after each | as tabled above; the tree was clean afterwards |
| `slot_mui23b0z_f4217830` | `tsc --noEmit -p tsconfig.json`, after G1d was added | exit 0 |
| `slot_mui240e4_aa8e0402` | vitest: `ph07-round4-review` (final, 6 tests) and `observability-no-posthog-ai` | **2 files, 15 passed** |

**Did not run:** the full root suite (the builder reports 7,878 passed and 4 skipped), the account
service's own suite, and the Playwright suites. The repair touches `server/accounts/session.ts`,
`server/engines/service.ts` and `server/observability/`. The two vitest sets above cover every test
file that names the changed behaviour: the membership codes, `entitlement_unknown`, `unknown`
entitlements and the observation modules.
