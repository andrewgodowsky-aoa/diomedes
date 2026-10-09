# Expert tier

Owner request: October 6, 2026. Feature and prompt: EXPERT-TIER.
Owner: Codex, integrator seat, implementing Andrew's requested fourth tier.
Branch: feature/expert-tier, based on f885d50e235cd900312976d0f36618d180f2b54a.
App worktree: C:/Users/andre/Documents/Codex/2026-10-06/site-pr-56-merged-on-october/work/expert-tier-app.
Operations worktree: C:/Users/andre/Documents/Codex/2026-10-06/site-pr-56-merged-on-october/work/expert-tier-operations.
These isolated worktrees are inside this chat's writable workspace; unrelated F:/Diomedes checkouts are preserved.

## Contract

Expert is the fourth Nectovia tier after Efficient, Focused, and Thorough. It applies to Agent and Bot on Managed Small, Standard, and Plus. It uses the existing work-style, job, routing, entitlement, and funding authorities. It grants no tool permission and does not change modes, source restrictions, account identity, or payer.

The account service enforces access before each managed call. Operations explicitly configures a qualified route and credit price. There is no guessed production model, price, fallback to another tier, or inferred live qualification.

The default Expert check-in scales linearly from 750 to 1,000 credits with the plan's included monthly API allowance: Small 3,000 gives 750; Standard 5,000 gives 850; Plus 8,000 gives 1,000. Bought credits do not upgrade a plan or its default. Explicit staff and business settings retain their existing precedence. Balance, reservation, member, and company limits remain separate.

## Evidence status

### Recorded dependency handoff

Integrated the frozen Operations model-selection patches after the other lane released its file claims and test slot. Source bases match this candidate. The handoff was written at F:/Diomedes/local-models/audit/operations-model-selection-handoff-2026-10-06/; app.patch SHA-256 is 2f7e835ce03af519e25bc0bfb12e67a09701359cb71d8316a76d87d55eeb1e99 and operations.patch is da84fd07f312a03b08b08cf347c5c68e4190c054e9b894630de92cb9a6faeaf6. Both cleanly applied after hash verification. This preserves Operations-selected System One, its provider-price evidence and policy revision, without inserting a fixed model into Expert. Tests below must cover the combined candidate; the handoff's prior test counts are not this candidate's evidence.

### Compatibility and deployment order

Migration 021 adds Expert to the funded-job and immutable charge-snapshot constraints. Apply it before serving Expert. No historical record is rewritten. The migration was renumbered to 021 on 2026-10-09 because main's 020 (DIO-128) landed first; nothing else changed. Publish the compatible control plane before the new desktop and Operations clients. Clients opt into fourth-tier response fields with X-Nectovia-Expert-Tier: 1. Historical records may omit Expert; no route or price is inferred. Older writers retain Expert routing, prices and check-in overrides. An old Operations build cannot remove an Expert qualification it could not read. Explicit null resets price or check-in settings; historical rollback restores the selected record.

Operations must publish a route with current Expert qualification, privacy, access, health and price evidence, and a customer credit price that passes the existing provider-cost ceiling. The migration and policy writes were not performed against any live service. No provider call, installed-app replacement, packaging or deployment is authorized by this source validation.

### Canonical documents

Live cloud Project Memory and Roadmap were read at their current revisions. Their existing version is 2026-10-06.1. Additive Expert amendments are retained in the repository mirrors, visibly pending cloud synchronization. The Google Docs skill's required initial file bridge rejects Windows absolute paths (`workspaceRoot must be an absolute path`); it validates only leading-slash paths. The cloud documents have not been mutated. Re-read their revisions before applying the amendments with requiredRevisionId; preserve existing native document structures.

### Final local verification

- Full app suite: 10,251 passed, 0 failed, 5 skipped; all 606 files passed. Two workers, 1,033.79 seconds. Source log: expert-app-accepted.txt in this task's work directory.
- Full control-plane suite: 1,250 passed, 0 failed, 59 skipped across 69 files. Database-dependent suites remain skipped. Source log: expert-service-accepted.txt.
- Private Operations: 195 passed, 0 failed, 0 skipped across 12 files; TypeScript and Vite build passed. Source logs: expert-ops-tests.txt and expert-ops-build.txt.
- App/service TypeScript and app Vite build passed. Source logs: expert-app-typecheck-final.txt and expert-app-build-final.txt. The existing bundle-size warning remains.
- Required Console, native UI and field browser suites: 36 passed, 0 failed, 0 skipped, within expert-browser-final.txt.
- Latest Home browser suite: 35 passed, 0 failed, 0 skipped, including both Expert eligibility cases. Source log: expert-home-accepted.txt.

The first complete app run found seven outdated three-tier expectations (10,244 passed, 7 failed, 5 skipped); they were repaired and the final full run passed. Browser regressions also reproduced and verified repairs for Expert's preflight-header allowlist and Home's missing host eligibility view.

Two earlier Home browser runs failed intermittently: a lost-reply reload reached an initial Failed to fetch screen, and stale Discard showed an older retained message. Untouched main passed all 33 existing Home cases. The candidate subsequently passed three isolated stale-Discard attempts and all 35 Home cases. Their underlying causes remain unresolved. Earlier unrestricted service and six-worker app runs terminated with ERR_IPC_CHANNEL_CLOSED; bounded final runs completed, but that termination's underlying cause was not established. These failures are retained for review and release acceptance.

### Publication boundary

The source implementation and local evidence are complete. Operations is draft PR #12 at 473a3769beab20d46aa97ece63983bbc03996719; the companion app candidate remains for review. Runtime/Trust, account, payer and permission authority are unchanged. Roadmap status is source implementation with local evidence, not shipped or DONE.

Migration execution on disposable PostgreSQL, live provider/account journeys and installed-client acceptance remain DID_NOT_RUN. GitHub Actions stayed disabled under the standing CI stop. No merge, deployment, live migration, production policy publication, package or installed-app replacement was performed. Site PR #56 does not establish Expert's production availability.
