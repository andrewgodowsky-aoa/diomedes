# Acceptance coverage

PB-2026-09-10.1 | Coverage as measured, not as intended.

This file records what was actually verified by reading the tests named below, not what the suite names suggest. A row is COVERED only where the cited test asserts the required result; sounding related is not coverage. No cumulative historical totals appear in it — only the counts measured for this table, on this date.

Note: the brief for this work said 33 rows; the source table in `06_EDGE_CASES_AND_ACCEPTANCE.md` holds 30, and those 30 are what is mapped here. Split: 22 COVERED, 5 GAP, 3 OUT-OF-HARNESS.

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| legacy-onboarding-business | Legacy onboarding says business | COVERED | `tests/workspaces.test.ts:203` — an old "business" answer grants no membership, credit or authority |
| personal-opens | Personal opens | COVERED | `tests/workspaces.test.ts:149` — is where a fresh install starts, with no organization and no intake |
| one-person-org | One-person organization | COVERED | `tests/business-setup.test.ts:107` — a one-person business is not asked about multiple locations |
| ordinary-invitee | Ordinary invitee joins | COVERED | `tests/workspaces.test.ts:393` — an invited member joins the existing setup and does not redo it |
| same-person-two-companies | Same person, two companies | COVERED | `tests/workspaces.test.ts:522` — stay separate in tenant, setup and answers |
| crafted-tenant-or-stale-membership | Crafted tenant ID or stale membership | COVERED | `tests/configuration-service.test.ts:289` — a stranger and a revoked member are refused at both stage and activate |
| switch-workspace-during-run | Switch workspace during a run | COVERED | `tests/harness.test.ts:409` — a different tenant cannot execute a run |
| billing-contact-without-admin | Billing contact lacks admin role | GAP | `tests/acceptance-matrix.test.ts` — a billing contact who is only a member configures nothing and administers nobody |
| questionnaire-bypass-instructions | Questionnaire contains instructions to bypass rules | GAP | `tests/acceptance-matrix.test.ts` — an answer that tries to grant its own permission is refused as data, not adopted as policy |
| concurrent-draft-edit | Admins edit the same draft | COVERED | `tests/workspaces.test.ts:339` — two administrators editing at once conflict rather than overwrite |
| setup-fails-halfway | Setup fails halfway | COVERED | `tests/configuration-proof.test.ts:324` — a refused activation leaves the setup that is running exactly as it was |
| activation-response-lost | Activation response lost | COVERED | `tests/configuration-service.test.ts:212` — replaying an activation id returns the identical manifest and writes nothing |
| rollback-old-version | Rollback to an old version | COVERED | `tests/execution.test.ts:238` — an old snapshot cannot revive a revoked grant |
| connector-unavailable | Connector is unavailable | COVERED | `tests/configuration.test.ts:587` — a required connection with no fallback blocks; with a fallback it degrades; connected is silent (18) |
| local-only-model-fails | Local-only model fails | COVERED | `tests/execution.test.ts:178` — a local-only job never becomes cloud-backed after an outage |
| adapter-boundary-unenforceable | Adapter cannot enforce a required boundary | COVERED | `tests/capabilities.test.ts:44` — no route claims an isolation boundary Diomedes owns |
| team-delegation-retry | Team delegates or retries | COVERED | `tests/execution.test.ts:140` — business work on a paid route is paid by the organization, and covers children |
| reviewer-author-labels | Reviewer/author labels differ | COVERED | `tests/agents.test.ts:92` — a reviewer identity can never be a writer |
| race-for-last-credit | Two calls race for last credit | GAP | `tests/acceptance-matrix.test.ts` — two concurrent holds against one balance admit only the affordable one |
| generation-response-lost | Generation response is lost | COVERED | `tests/managed-usage.test.ts:168` — a lost response goes uncertain, and uncertain never auto-releases |
| billing-event-duplicate-late | Billing event duplicates or arrives late | GAP | `tests/acceptance-matrix.test.ts` — a duplicated billing event is visibly a duplicate and grants nothing twice |
| balance-exhausted | Balance is exhausted | COVERED | `tests/execution.test.ts:264` — an exhausted allowance stops the effect |
| subscription-lapses | Subscription lapses | GAP | `tests/acceptance-matrix.test.ts` — a lapsed subscription destroys no data and membership still governs access |
| owner-leaves | Owner leaves or deletes personal account | COVERED | `tests/workspaces.test.ts:507` — the last owner cannot be removed |
| offline-revoked-device | Offline device is revoked | OUT-OF-HARNESS | Needs a desktop smoke that revokes mid-offline and measures bounded validity; unit code cannot prove recall timing. |
| shared-os-administrator | Shared local OS administrator | OUT-OF-HARNESS | Needs an operational control statement, not code: OS-level access bypasses app tenant checks by definition. |
| schedule-while-asleep | Schedule while computer sleeps | COVERED | `tests/packs.test.ts:267` — a weekly start is recorded but stays inactive and non-blocking |
| malicious-regex-field | Malicious/oversized regex or field | COVERED | `tests/predicates.test.ts:133` — groups, backreferences and lookaround are refused |
| rule-template-update | Rule/template update | COVERED | `tests/configuration.test.ts:907` — a removed agent is reported as removed, not silently dropped (34) |
| narrow-window-large-text | Narrow window, large text, long names | COVERED | `tests/allowance-ui.spec.ts:161` — the panel holds together in a narrow window with a long name. Recorded OUT-OF-HARNESS in the first pass; the Playwright case it asked for was written afterwards, at a 900 px viewport with a 65-character organization name, asserting neither the body nor the dialog scrolls sideways. |
