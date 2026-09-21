# SWE-2 independent acceptance and local integration

Date: 2026-09-17. Reviewer/integrator: Codex; no delegated calls.

**04a / B00.R: accepted after immediate repairs. 04b / H01.R: rejected.**
Integrate the passing B00 subset and repaired C00 history into local main. Preserve
H01 in its isolated reviewer worktree and reconstructable archive. Devin ACP and
automatic change review already belong to main and passed this integration run.

## Exact scope and reconstruction

Main began clean at `5da4fec42db90d6fe631a790070b1bde2a608a68`. Both producer and review candidates were
based on `e2c1e1576eea5ba0265a522c1506820c947425a9`, containing the C00 repair history through `8ff9136`.
The producer's released 53-file patch has SHA-256
`17626908e8213a6b40e2fb47cafe710b8abb709af9f2dbd6ba966021f76213fd`.
It was reconstructed and every raw file hash checked against the handoff.
The producer worktree was never edited.

The corrected full reviewer snapshot is Git tree
`1b5c89a35133e8187528c9e946641176c09fba3c`; its 55-file manifest and patch are
in `F:/Diomedes/deliverables/swe2-acceptance-20260917/`. It includes the immediate H01 fixes but is **not** the
accepted integration. `review-candidate.manifest.json` explains reconstruction,
including raw files for exact Windows line endings.

The accepted integration branch is `integration/swe2-b00-20260917`.
Its own commit contains the B00 files, B00 tests, gateway/ledger repairs, one
`server/app.ts` billing-status wiring line, TypeScript include, pinned-tool
instructions and these records. No H01 source is copied into that branch.
`integration-candidate.manifest.json` records the cumulative diff from the
original main, including inherited C00 history. `integration-final.json`
records the resulting commit and main tree identity after the fast-forward.

`B00.I.json` is the producer's unchanged historical record. Its mixed-candidate
paths and test counts are not the scope or proof of this B00-only acceptance.

## Immediate repairs and B00 verdict

Earlier producer repairs passed all 66 independent/repair cases when reconstructed.
New adversarial cases then reproduced 16 failures with one passing control.
The reviewer corrected:

- Membership/lease generations must be safe nonnegative integers, even when invalid
  stored and live values match. Invalid assertions are stale.
- Active entitlements require readable, nonfuture issuance and a valid revision.
  An empty revocation marker is malformed, not absence. Explicit revocation and
  historical snapshot immutability retain their precedence.
- Producer fixes for unreadable clocks/expiries, invalid money ceilings and
  managed security suspension are retained in the integration.
- Vendor evidence now matches the existing Workers static-assets website,
  finite Neon Free limits and Stripe Billing pay-as-you-go fees. Actual accounts
  remain unverified. No new fixed or unapproved variable spend is permitted.

The independent B00 suite has 18 cases. Beyond pure predicates, it creates a fresh
app, verifies Personal with no hosted identity or entitlement, rejects forged
paid/hosted settings over HTTP, and dispatches a BYO request once through the real
EngineService using an explicitly synthetic transport. It also exercises the real
AllowanceLedger and verifies invalid ceilings create no pending hold.

Accepted interface: `CONTROL_PLANE_CONTRACT_VERSION = 1`. Digest:
`02fd4bd31b06731f52527c37d86c0a45bbf5dd4b9911136ddca039942d71275b`.
The digest hashes the UTF-8 LF file `B00-interface-digest-input.txt`: the version
line followed by sorted Git blob IDs and paths of all four contract files.
This binds an exact interface rather than approving broad prose.

## Existing authority map

| Domain | Existing source and exports | B00 boundary |
|---|---|---|
| Current identity and effect permission | `server/trust/authority.ts`: `currentAuthority`, `refOf`, `requireCapability`, `installTrustBackend` | New subject records do not replace Trust or grant effects. |
| Revocation | `server/trust/revocation.ts`: `generationFor`, `revoke`, `revokeTenant` | Membership assertions and credential leases compare current generations. |
| Workspace and membership | `server/workspaces.ts`: `WorkspaceService.switchTo`, `revokeMember`; `shared/workspaces.ts`: `isActiveMember` | Existing tenant and membership records remain authoritative. |
| Entitlement | `shared/workspaces.ts`: `entitlementFor` | Today's service returns absence; `snapshotFromView` cannot turn a local record into paid access. |
| Money and rate card | `shared/managed-usage.ts`: `micro`, `dollars`, `RATE_CARD_V1`, `chargeKindEligibility`, `payerForRoute` | No second currency, rate-card or payer policy implementation. |
| Allowance and reservations | `server/managed-usage.ts`: `AllowanceLedger.reserve`, `settle` | One local ledger writer, including the repaired ceiling/clock guards. |
| Billing status | `server/billing-events.ts`: `BillingEventProcessor.statusOf` | Managed admission checks security suspension; paying an invoice does not lift it. |
| Managed request admission | `server/managed-gateway.ts`: `ManagedGateway.admit`, `verifyAuthorization` | Pure contract predicates document the boundary; the existing gateway performs admission. |
| Project file writes | `server/store.ts`: `Store.writeRecorded` | No alternate file/history writer. |
| Hosted identity | WorkOS AuthKit selected; no hosted flow installed by B00 | `verifySubject` validates trusted record shape/provenance, not JWT signatures or user-supplied claims. |
| Cloud scheduler | None | `CLOUD_SCHEDULER` and the source-map scheduler are null. |

The workspace-root Neon experiment is outside the app repository and was left
untouched. It is not evidence of production WorkOS login, entitlement or a new
identity authority. No hosted backend was silently enabled.

## H01 findings retained for repair

The four blocking findings are anchored to the archived corrected reviewer tree,
not the B00-only main tree:

1. **The operative runtime seam is incomplete.** `server/engines/service.ts:392`
   still calls `adapter.generate` directly. A descriptor and start guard were
   added to existing interfaces, while `TextEngineAdapter` and `ModelAdapter`
   remain distinct operative interfaces. That does not implement the required
   common RunService lifecycle.
2. **Preview identity is incomplete.** `shared/adapter-contract.ts:156` has
   project/thread/request/sequence fields without run, step, attempt or durable
   fence identity. `server/app.ts:2375` reduces the frame to text. An AbortSignal
   does not establish attempt ownership after restart, takeover or reconnect.
3. **ACP routes retain duplicate choreography.** The shared initializer is useful,
   but Cursor's prompt at `server/engines/cursor.ts:371` and Devin's at
   `server/engines/devin.ts:404` still sit in separate update/prompt/cancellation
   implementations. A second agent is not yet launcher/profile configuration.
4. **Required SSE failure proof is absent.** The producer's requirement matrix
   explicitly lacks the OpenCode midstream connection-drop fixture (row 7,
   line 37). Other timeout and cancellation cases do not prove that case.

Immediate H01 bugs were fixed in the isolated snapshot: malformed descriptors now
fail conformance without crashing; event run IDs must match their enclosing run;
and completion/failure closes the preview signal so retained callbacks cannot emit
after terminal completion. Focused reviewer tests passed 164/164 after repairs,
and TypeScript passed. Those results do not satisfy the remaining architectural
requirements or authorize freezing SDKR/H19 extensions.

The next implementation request is saved in
`F:/Diomedes/deliverables/swe2-acceptance-20260917/H01-NEXT-PROMPT.md`. It starts from updated main and preserves
the useful H01 work and these fixes.

## Verification of the combined passing work

All executable source was finalized before this one full integration run.
Subsequent edits only clarify documentation, evidence and a vendor comment.

| Check | Result | Source under the deliverable directory |
|---|---|---|
| TypeScript | exit 0 | `logs/integration-typecheck.log` |
| Unit suite | 104 files; 1,921 passed, one skipped, zero failed | `logs/integration-vitest.log`, `.json` |
| Production web build | exit 0; existing bundle-size warning | `logs/integration-vite.log` |
| Full browser suite | 67 passed, zero skipped/failed | `logs/integration-playwright.log` |
| Current coordination invocation paths | two separate-process exclusion cases passed | `coordination-candidate-proof.json` |

The one skipped unit case requires a Windows 8.3 alias for a guarded directory.
It is not counted as passed. The producer's previously observed work-admission
timing flake did not recur in this full integration run; that test was not changed.

The full unit result includes 45 Devin adapter cases, 85 coordination cases,
52 change-review cases, 36 reviewer-authority cases and 16 reviewer cases.
These are subsets of 1,921, not additional totals. The browser run includes the
repository's required UI/native/Field suites plus the other current browser suites.
Twenty-two PNGs regenerated by this run were copied into `browser-evidence/`
and restored in the integration checkout; generated screenshot churn is not merged.

Devin ACP at `9ddc8b2305e33edf620a0524f25bca60e12eb8dc` and automatic change
review at the original main head were already ancestors of main. Their worktrees
do not need duplicate merges. The current integrated behavior is retested here;
no live authenticated provider call was made.

## C00 rollout and integration policy

C00.R-3 historically rejected `ad21353` only for C00-R2-2, the mixed-tool rollout.
That verdict remains intact. This new local rollout lands reviewed tool blob
`56d3617523cc8dbb7978a8e31e0155c752a85307` on main and directs AGENTS.md to the
shared pin. Pin and proposed default both excluded concurrent directory/child
and case/dot-alias claims in separate processes, using private fixture roots.

The shared root has only this integrator's active claim/slot and no pending
attempts. Producer claims were released for review. Old worktree tools remain
prohibited; origin/main is not updated by this local integration. After the
fast-forward, the same two-path probe runs against main and records
`coordination-main-proof.json`. This establishes current local invocation safety,
not compatibility with deliberately resurrected historical tools or remote rollout.

Andrew's current request authorizes merging passing work and immediate repairs.
The reviewer reconstructed the released patch in owned worktrees, held exact claims
and the heavy slot, and integrates with `git merge --ff-only`. Producer changes,
older verifier trees and user configuration are preserved.

## Product, roadmap and release status

Canonical versions read: Pillars 2026-09-10.1, Roadmap 2026-09-15.5, Project Memory
2026-09-15.4. No definitions or commercial offers change; no cloud canonical edit
is required for a new definition. This record supplies the exact gate status:
B00 accepted, local C00 rollout accepted subject to recorded main verification,
H01 incomplete.

The work advances Personal independence, existing Trust authority and zero new
spend. It does not establish the complete workflow of implementing Diomedes from
within Diomedes across Devin, Cursor, OpenCode, Claude and Codex/ChatGPT.
The next blocker is H01's operative runtime/trace integration; route-specific live
and end-to-end development evidence follows that implementation.

Web build: passed. Packaged app: not run. Installed app: unchanged. Live provider:
not run. Publication/push: not run. Deployment: not run. Main integration is local;
the detached final record names its commit and clean status. H01 remains
uncommitted and unmerged in the preserved worktrees.
