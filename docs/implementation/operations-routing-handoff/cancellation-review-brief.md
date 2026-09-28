# Bounded independent review: dispatch cancellation

Read-only review authorized by the user's request for independent review. Work
only in F:/Diomedes/diomedes-wt/operations-routing. Do not edit, test, build,
install, start servers, contact providers/databases, read credentials, commit,
push, contact other chats or delegate. The shared test slot belongs to other work.

Review this new, bounded timing hypothesis and its planned repair. Existing
broad routing and receipt reviews are complete; do not repeat them.

Read `services/control-plane/src/managed-inference.ts`, specifically runScoped,
holdAndDispatch, park and managedErrorResponse; the relevant FundingService
markDispatched/release/markUncertain contracts in `funding.ts`; and the new
`stops cancellation during the dispatch write` case in
`services/control-plane/tests/scoped-routing.test.ts`. Follow the immediate
provider cancellation seam in `managed-bindings.ts` if needed.

Current production SHA256:
48C2874275CDDEE425340AEB662056C15FFD930264DED586935354947A3D53EB.
The test is authored and unrun. Its next reserved window runs original production
before any repair. It aborts the real Request signal immediately after the real
FundingService.markDispatched resolves. The current later addEventListener misses
that abort; the synthetic transport intentionally ignores signals, allowing a
deterministic check that the gateway itself refuses to invoke it.

Proposed narrow repair after a reproduced failure:

1. In managed-inference.ts runScoped, when linking its provider AbortController,
   call onAbort immediately if the
   incoming Request signal is already aborted; otherwise register the listener.
2. At the start of the existing attempt try block, call
   abort.signal.throwIfAborted() before callManagedProvider. This prevents even a
   custom transport that ignores signals from seeing an already-cancelled call.
3. Preserve the existing park behavior once markDispatched has committed. Never
   release the committed attempt as though it were a verified provider refusal.
4. After removing the listener, check request.signal.aborted before writing any
   provider cooldown or considering backup. Return ManagedError 499/cancelled
   with the recorded receipt and a message explaining any retained hold.

The test expects zero transport invocations, no backup, one committed uncertain
attempt, no settlement, no provider cooldown and the cancelled response/receipt.
Assess whether this is reachable, whether the proposed repair preserves funding
and cancellation semantics, and whether the fixture can falsely pass. Identify
only concrete defects or missing necessary controls; include exact lines and a
counterexample. State if no actionable issue is found. No runtime acceptance
claim is possible from this source-only review.

Review reconciliation: all four required ordering/funding controls are retained.
The immediate-abort link is specifically in runScoped; the binding already has
its own link. The 499 branch belongs after listener removal and before
saveCircuit/mayFailOver. Zero transport invocation is claimed only for the
reproduced abort during the dispatch write, before the attempt try entry. Later
cancellation also relies on the transport honoring its AbortSignal.
