# Home client guard review R1

Independent executing review of candidate `f37f29a4068f6b9b6e3b6cce80eb46f685a938ae`.
The reviewer did not author the client implementation or its producer tests.
Verdict: targeted product behavior is green, but guard coverage needs the bounded test
corrections below before expanded client acceptance. No product defect is inferred from a
surviving mutation alone. This report is immutable.

## Executed evidence

Clean review worktree: `F:/Diomedes/diomedes-wt/core-agent-home-driver-review`.
Own coordination identity: `astra`, PID 43452, start `2026-09-21T04:32:24.4162630Z`.
Heavy slot: `slot_mubct1pj_5c932e02`.
Evidence directory: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`.
Each `home-client-C<number>-result.json` records candidate, exact selected tests, exit codes,
original and restored SHA-256, and final tree status. Its sibling patch and red/green logs are
retained. Browser runs build both the mutant and the restored source, with separate artifact
directories. Every completed restoration passed and restored the original source bytes.

Before mutations, this exact candidate passed TypeScript, 143 tests in nine focused files,
the production build, and all 48 cases across the original page file, Home file and frozen
route review file. These are focused/page results, not the full suite or live-provider proof.
The HCR-3 correction preserves the original R05 post-response state-read failure schedule;
route metadata now comes from the existing thread-list read. Frozen R2/R4 payloads and the
AWS/admission oracle files were checked unchanged.

| Probe | Removal or alteration | Result before restoration |
|---|---|---|
| C1 | Send abort check after reading claim | One intended failure; 47 restored green |
| C2 | Resend abort check at lock callback entry | Survived 47/47; 47 restored green |
| C3 | Notify queued same-window identity listeners | Three failures; 47 restored green |
| C4 | Give an already-issued identity to a late join | Survived 47/47; 47 restored green |
| C5 | Register an early join for later identity issuance | One missing-identity failure; 47 restored green |
| C6 | Issue the resend's dispatch identity | One missing-identity failure; 47 restored green |
| C7 | Incorrectly issue an identity for a settled read-only resend | One failure; 47 restored green |
| C8 | Incorrectly clear the claim on interrupt request | Pending-preservation failure; 47 restored green |
| C9 | AWS-current term in first route-option branch | Survived 6/6; the next generic current-route branch is equivalent here |
| C10 | Generic current-route option preservation | Off-list route failure; six restored green |
| C11 | Active-delivery check in Stop | Duplicate-Stop page error reading null issued; 13 restored green |
| C12 | Issued-command check in Stop | Early-Stop page error reading null projectId; 13 restored green |
| C13 | Release the active identity synchronously on Stop | Survived 13/13; 13 restored green |
| C14 | Visit fence on nonconfirming interrupt acknowledgement | Old acknowledgement painted a new scope; 13 restored green |
| C15 | Visit fence on failed interrupt acknowledgement | Old failure painted a newer visit; 13 restored green |
| C16 | Latest-choice fence on successful route response | Frozen HLR-01 expected AWS, saw Claude; restored case green |
| C22 | Ownership fence when an old delivery clears its active reference | Survived 13/13; 13 restored green |

Other numbered probes are separate work in progress and receive no result in this report.
The initial duplicate case uses two protocol-level dispatchEvent calls in Promise.all. It
does not establish both event handlers ran before the abort continuation, despite its comment.

## Required test-only closure

HCG-1: Add a same-window join after the first identity is issued and its POST is demonstrably
in flight. Both callers receive the same identity once, share the same result, and cause one
POST. The existing test joins before issuance and therefore does not test C4.

HCG-2: Add or correct a duplicate-Stop schedule so both click events fire synchronously in one
page evaluation, before any promise continuation. Assert one interrupt request for the exact
command, no uncaught page error, and preserved pending recovery. Retain the current later-Stop
case as useful separate coverage. C13 must be tested against this schedule.

HCG-3: Hold an old scope's provision response, move to another scope, dispatch its held message,
then release the old provision response. After the old continuation finishes, Stop must still
name the new delivery's exact command. No old POST may occur. C22 must be tested against this
schedule. Use observable request/response boundaries and cleanup in finally, not sleeps.

HCG-4: Exercise the explicit resend abort check at lock callback entry. The current test aborts
while queued and is already stopped by the lock implementation. A controlled fixture may abort
after granting the lock immediately before invoking its callback. Label that modeled boundary
honestly. Assert no read/POST, no issued identity, and unchanged pending claim/reference.

C9 is a disclosed equivalent survivor, not a missing behavior test: the generic second branch
still appends AWS once and in the same order. Do not change product code to force a mutation kill.

The original implementation remains frozen for these additions. Preserve every frozen reviewer
payload and historical review unchanged. The four exact mutation patches already executed are
`home-client-C2.patch`, `home-client-C4.patch`, `home-client-C13.patch`, and
`home-client-C22.patch` in the evidence directory. The independent reviewer will reapply those
unchanged patches to the new test candidate, run red, restore exact source bytes, and run green.
No client acceptance or PR readiness is granted here.
