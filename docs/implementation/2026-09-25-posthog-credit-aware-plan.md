# Nectovia: credit-aware PostHog implementation

**Revision:** NC-PH-2026-09-25.3 | **Owner:** Andrew | **Date:** September 25, 2026

**Status:** Revised implementation handoff, not a deployed feature. Supersedes the NC-PH .1 and .2 downloads and their stale account/budget instructions. Read the companion `../prompts/2026-09-25-posthog-opus-5-5.md` for executable work orders. Current source and accepted implementation evidence supersede dated capability claims here.

## 1. Decision and first deliverable

Use PostHog as Nectovia's company-operated analytics and observability service. Use ordinary PostHog data queries, then Nectovia or Claude, for investigation. Do not make PostHog's own AI agents or Desktop a dependency of this integration.

Andrew reports approval for $50,000 of startup credit. The public program provides a 12-month benefit and explicitly includes AI observability and the context warehouse, while excluding specified PostHog AI products [S1]. Account balance, exact effective/expiry dates, per-product billing controls and actual invoice offsets have not been verified in this review. Treat approval as owner-reported fact, not as either a rejected application or a verified $50,000 current balance.

Build the first proof around an authorized internal synthetic Nectovia run through the real runtime. It must yield a correctly linked observation of a model attempt, a registered tool and verification; the scripted provider remains explicitly synthetic. Free/direct-engine negative controls send no PostHog request. With PostHog unavailable, the Agent result, authoritative audit and financial behavior remain unchanged. Real provider inference, actual ingestion, packaged behavior and customer production activation are separate evidence levels.

The observation contract and offline tests can start before customer billing is complete. Real customer export waits for the actual server-authoritative Agent admission and telemetry policy. Never invent a paid flag to make an onboarding checklist pass.

## 2. What this revision changes

- **Account status corrected:** the company project exists, has been renamed to Nectovia — Agent & Operations, and the approved conservative privacy defaults were applied and read back. They are not awaiting confirmation. The latest inspected project still reports no first ingested event. Private project identifiers belong in operator configuration, not public source examples.
- **Funding corrected:** $50,000 is a bounded, expiring subsidy of eligible actual usage, not cash, model tokens or guaranteed savings. Remove the multi-year runway division and headline event volumes as planning guarantees.
- **Product boundary clarified:** AI observability of Nectovia is eligible; PostHog doing AI work itself is a different bill. Covered data does not automatically make an AI action over that data covered.
- **MCP correction:** read-only limits writes, not AI inference or all usage charges. Use a reviewed ordinary-tool allowlist, not merely `readonly=true`.
- **Implementation order improved:** scope/privacy and the internal trace come first; then customer admission, useful metrics and a bounded company investigator. Replay and warehouse expansion do not block that proof.
- **Existing protections retained:** provider independence, no Free/direct-engine capture, paid BYO support, no raw content, stable run identity, uncertain accounting, safe flags, separate website analytics and packaged-app checks.

## 3. Fresh source and account audit

The application snapshot inspected is `c4ce1c2d33698b6f312cc131a872464b25b1c37d` on `andrewgodowsky-aoa/diomedes`. It is an evidence anchor, not a reset target. The inspected roadmap mirror is version 2026-09-25.2. No application tests were run during this documentation revision.

| Source anchor | What it contributes | Integration constraint |
|---|---|---|
| `server/engines/model-api-core.ts` | Shared guarded provider exchange, dispatch distinction, streaming outcome and usage/spend handling | Observe accepted outcomes; preserve explicit provider, retry and tool-execution behavior |
| `server/harness/run-service.ts` | Canonical runs, steps, policy, approvals and durable observations | Project recorded facts; do not give PostHog run-state authority |
| `shared/usage-contract.ts`, `server/spend-exposure.ts`, `shared/managed-usage.ts` | Normalized usage, costs, uncertainty and allowance rules | Reuse exact units/rate snapshots; no analytics-derived settlement |
| `services/control-plane/src/worker.ts` | Account/membership routes and an organization usage read at the inspected commit | It does not expose the completed paid-Agent admission/telemetry service this integration needs |
| `services/control-plane/src/funding.ts` and `funding-postgres.ts` | Existing company funding authority | Do not add a PostHog credit wallet beside customer credits |
| Native/model-session, evaluation/Jev, tools and worker adapters | Existing places where supervision and attempts are recorded | Refresh exact paths/interfaces; opaque external engines remain opaque |
| Current Automations definitions and scheduler | Operational workflow state | No second scheduler; the deterministic weekly brief remains model-free |
| Root and website `package.json` | Electron/React/Node application; separate Astro site | Different instrumentation boundaries; no generic Next.js installation |

The GitHub and Drive searches did not locate an already-published dedicated PostHog handoff. That is a search finding, not proof about every uncommitted worktree. Refresh before implementation. Open PR #146 concerned desktop/setup changes and #115 the software pack at inspection; coordinate any overlapping renderer, setup or packaging paths. Never undo a newer executable-name decision to satisfy this packet's historical descriptions.

Live account readback confirmed IP anonymization enabled and broad autocapture, automatic exceptions/web vitals, console/performance capture, session replay, heatmaps and dead-click capture disabled. UTC and existing retention were not changed. These settings are defense in depth: code-level exclusion still has to prevent collection and SDK requests.

## 4. Apply the award to the right work

### 4.1 Coverage and exclusions

PostHog's current startup FAQ states that from September 14, 2026, credits exclude PostHog Desktop, the PostHog Slack app, Replay Vision, PostHog AI and Inbox. It explicitly retains AI observability and the context warehouse [S1]. The Desktop documentation also describes a startup-plan task-access restriction, which is distinct from whether a bill is credit-eligible [S2].

| Product/use | Treatment for this implementation |
|---|---|
| AI-observability generations, spans and traces | Core intended credit use; metadata-only, actual admitted work |
| Product/web analytics, error tracking, flags/experiments, ordinary replay, surveys, warehouse/CDP and logs | Eligible platform usage subject to actual SKU/account terms; enable only the slices justified below |
| PostHog AI, Desktop, Slack AI app, Replay Vision, Inbox | Not funded by the startup award; disabled as integration dependencies |
| Model-based evaluations, AI summaries, playground reruns, enrichment and AI-powered MCP tools | Classify the actual bill first; no blanket assumption from a screen's product name; off initially |
| Nectovia/Claude investigator inference; AWS/Azure/OpenRouter bills | Separate company/model funding, not PostHog startup credit |
| Paid onboarding/custom professional services, BAA under Boost, priority support | Do not promise these from the award; the public FAQ limits these benefits [S1] |

A normal alert notification to Slack is not automatically the same product as the PostHog Slack AI agent. Classify the actual destination/operation and any third-party charge. No additional connector or messaging purchase is authorized here.

### 4.2 Credit record and expiry behavior

Use a private company vendor-benefit/configuration record, reusing an existing registry when suitable. Record reported award amount/status, credited amount and remaining balance when observed, evidence source/time, start/expiry, eligible products, billing plan, product limits, full-price usage estimate, actual offset and authorized cash continuation. Missing values remain unknown. Never derive expiry from project creation, turn the award into customer credits, or represent a stale billing observation as a real-time balance.

Before live export, verify that the exact project/organization, selected product, regional host and bounded pilot fall inside a funded allowance without unauthorized cash liability. Do not automatically raise a $0 billing limit because an award exists: inspect how that account applies limits before/after credit. Do not add a card, switch plans, redeem another offer or enable auto-upgrade in this task.

Separate **gross PostHog usage**, **actual promotional offset** and **net cash expense**. Review the projected full-price monthly bill even while net cash is zero. Once exact expiry is known, plan reviews 60, 30 and 7 days beforehand; this document does not schedule them. Without a new authorized cash policy at expiry/depletion, stop or reduce optional export using the configured safe policy, preserve local records and show reduced observability. Do not backfill a large queue later and accidentally incur a bill.

Never spend to exhaust the grant. The useful benefit is the eligible bill the company would otherwise incur while learning which events matter.

## 5. Observation scope and authority

| Scope | Rule |
|---|---|
| Paid Nectovia Agent | Current authenticated organization rights, actual Nectovia supervision and permitted telemetry data class |
| Paid Agent on approved BYO/local/external worker | Same eligibility; payer recorded independently; observe only exposed internals |
| Qualifying service grant | Only its explicit workflow/capability, period and telemetry scope; an audit invoice alone is not a lifetime grant |
| Company operations/internal tests | Trusted company identity or explicit test authorization; no client `internal=true` bypass |
| Company/product website | Separate reviewed marketing surface and consent/data policy; no Free app instrumentation by alias |
| Free/Personal or direct engine outside Nectovia Agent | No PostHog app requests, flag polling, replay, exception export or later backlog upload, even for a subscriber |
| Paid private/offline deployment | Respect its no-export policy; subscription is not screen/content permission |

Keep Agent entitlement, inference payer, essential service observation, optional analytics, replay and content diagnostics separate. A company endpoint may retain bounded aggregate service-health/refusal counts without importing Free users' work or identity. Mandatory local security/audit records are never disabled or sold as premium telemetry.

At runtime, bind scope to existing tenant/principal/run/attempt identity and the admitted policy revision. At optional export, check the applicable current data policy and original scope. Logout, organization switch, revocation or withdrawal stops optional collection and discards inappropriate queued events; it never relabels events to the next user. Finish only essential terminal observations that remain authorized for an already admitted run. Do not grant new work or retrospectively upload excluded pre-upgrade history.

A customer-local `server/` module is not a trusted company service. Company-host observations can be trusted within their source contract. Customer-host observations are authenticated, validated and marked client-reported; they are not billing evidence. A collector must reject arbitrary event names, tenant/plan spoofing, oversized or unexpected fields and anonymous forwarding. The capture token is an ingestion credential, not an entitlement or proof of provenance [S4]. Private query/management credentials must never enter customer bundles.

## 6. Runtime and data contracts

### 6.1 Implementation locations

Prefer a pure shared observation contract, a narrow runtime projection module, and separate Node/edge transports at existing boundaries. Candidate new files are `shared/observability.ts`, `server/observability/observation.ts`, `server/observability/posthog-exporter.ts` and matching tests. These are proposed locations, not claims about existing files. PH-00 maps them to actual owners before edits.

The shared provider exchange remains untouched in semantics. Read normalized attempt outcomes after their recorded boundary. Extend existing lifecycle publication where possible rather than sprinkling direct capture calls through every route. No PostHog network request in a transaction, permission check, model callback that can alter output, or financial settlement path.

Manual capture means deliberate event construction using the supported SDK/API, not manual data entry [S3]. Use Node support for company Node workloads and a supported bounded edge transport for Cloudflare. Do not upgrade the AI SDK or install a second OpenTelemetry/automatic-generation exporter merely to add this feature. One component owns each observation; no automatic wrapper plus manual double capture.

### 6.2 Trace identity and content

Use one `$ai_trace` per request/root job, child `$ai_span` records for meaningful work, and `$ai_generation` only for an actual observable model attempt. Group related requests with pseudonymous `$ai_session_id` where appropriate. Map embedding observations only if the operation really exists. Deterministic work produces an operational span/event, not a fabricated model generation [S3].

Pin identities to environment, tenant, existing root/run, step and attempt. Replayed completed operations keep their identity; new retries get new attempt IDs. Use stable event UUIDs and the supported vendor deduplication mechanism, but do not promise exactly-once remote delivery. Late settlement/verification is a distinct reconciliation observation whose metric projection replaces or joins the original fact, not an extra charge.

Allowed fields: bounded IDs/revisions, environment/surface/build, synthetic flag, source trust class, tier, route, requested/reported model when known, payer, safe registered operation ID, timestamps/durations, normalized counts, safe failure code, outcome, verification state, accounting/telemetry completeness and rate-card version. Customer-created names are not safe IDs.

Exclude prompts, responses, reasoning, files, source snippets, vectors, tool arguments/results, emails, names, arbitrary URLs, query strings, local paths, raw exception objects and secrets. Construct new allowlisted objects; never spread a run/request/error into the exporter. Omit `$ai_input` and `$ai_output_choices` and any equivalent span content. Suppress unintended SDK enrichment/person profiles/IP/URL properties. Hashing sensitive content does not make it acceptable [S4–S5].

External engines that expose only session outcomes get an external-worker span. Unknown tokens/model/cost stay unknown, not zero. A successful model response is separate from a verified business result. Pre-dispatch denial, cancellation, provider refusal, interrupted streams, waiting for approval/data and uncertain financial outcomes stay distinct.

### 6.3 Delivery safety and technical pilot limits

Start with a bounded metadata-only queue and no persistence unless an existing safe outbox provides it. An observation can be lost; customer work cannot be rerun to recover telemetry. Bound flushing/shutdown and isolate observer exceptions. Count drops locally without recursively sending an error about the exporter to the exporter.

Proposed initial engineering defaults, not commercial promises: event at most 8 KiB; batch at most 50 events and 256 KiB; local queue at most 1,000 events and 8 MiB; 5-second transport deadline; at most three attempts total per batch with jitter and bounded Retry-After; maximum queue age one hour. Use stricter current host limits where needed. Prove boundaries with virtual clocks. Live pilot export is disabled until its separate funded limit is configured. Deployment-wide and per-source rate limits must be enforced by the company collector; per-process limits alone do not bound fleet cost.

At high volume use trace-consistent sampling, record policy/probability and dropped counts, and distinguish aggregate counters from sampled diagnostics. Do not derive population failure rates by combining unsampled errors with sampled successes. Paid telemetry collection must not be a denial-of-service lever against the runtime.

### 6.4 Financial measurements

Keep provider gross cost, actual company promotional offsets/net cash, customer allowance debit and PostHog expense distinct. Nectovia's integer micro-USD ledger stays authoritative; convert to vendor display dollars only on export. Use seconds for fields documented in seconds. Preserve provider-specific normalized cache/reasoning counts; no double counting [S3, S6].

A customer-funded worker can leave managed allowance untouched while a managed planner/reviewer in the same root job consumes it. Do not mark a whole mixed job free. PostHog's model-price lookup is an estimate, not a cloud invoice; known route-specific receipts/rate snapshots take precedence in company metrics. Unknown cost rows are visible, not silently dropped from a seemingly complete total.

PostHog and company investigation are company overhead, not additional customer inference-credit debits. No plan price, allowance, top-up or support-scope change is part of this lane.

## 7. Product intelligence and investigation

Build the useful dashboard after real schema discovery. Every metric records its grain, denominator, exclusions, date attribution, source confidence, sampling and definition version.

- **Activation:** eligible observed setup to first verified root job. It cannot measure the excluded Free onboarding population.
- **Outcome quality:** verified, failed, canceled, waiting and unknown counts separately, segmented by comparable build/profile/tier/route.
- **Latency:** first-token and execution p50/p95; show approval/data waiting separately from execution.
- **Cost per verified root job:** total known costs of all attempts/helpers in the selected root-job cohort divided by verified roots in that same cohort. Include failed-root expense; show unknown cost coverage and a null result when no root verified. This is not the mean cost of only successful requests.
- **Coverage/operations:** exported/dropped/late observations, unsupported engine internals, selected sample, missing terminal events and PostHog full-price cost versus actual offset.

Comparisons are observational unless work mix is controlled. Do not claim a provider is intrinsically better because it received easier jobs.

Use ordinary deterministic queries or existing saved metrics, with the connected project's schema verified first. Do not invoke an AI query writer to avoid writing SQL. Operator dashboards stay private; customers receive only tenant-authorized projections through Nectovia, never the company MCP or a public cross-tenant share link.

The first investigator is on-demand: one evidence package, one internal investigation, proposed next action. It reuses the current work-item/approval path. Pin the PostHog project, restrict credential permissions and the exposed ordinary tools; review the actual tool list and internal-AI behavior. `readonly=true` does not prevent an AI bill. PostHog's `features` and `tools` filters combine as a union; for a narrow allowlist use exact approved tools, not a broad category added beside them [S7].

A future scheduled investigator needs a separate company model budget, finite queries/rows/context, cooldown, deduplication and recursion exclusion. It must not charge a customer root job or use their personal subscription as company inventory. No autonomous merges, releases, flag changes, rerouting, permission edits or customer business effects. Signals and logs are untrusted evidence, never instructions. Missing data means insufficient evidence, not healthy service.

## 8. Other surfaces, deliberately staged

**App analytics and errors:** initialize only in eligible contexts, with automatic collectors off. Send selected setup/Agent/approval/automation events and sanitized error frames. Test transition to direct mode, logout, tenant switch, privacy withdrawal and no-export deployments. A browser library does not automatically capture the Windows installer, external OAuth window or native crashes.

**Flags:** first flag controls one reversible, nonsafety UI presentation. Choose an explicit safe baseline for missing/stale/timeout/quota results. A flag never grants entitlements, changes payer, disables Trust or becomes the only emergency stop. Record meaningful exposure once, not every render. No flag requests from excluded contexts.

**Astro site:** separate repo/worktree and company-marketing purpose. Track allowlisted views, CTA click and server-confirmed submission success; never the form body/email, arbitrary URL or individual Apollo contact identifier. Do not override consent controls or connect site identities to app users implicitly.

**Replay:** internal synthetic proof first. Customer replay remains off until separately authorized. Block chat, files, previews, terminals, credentials, images/canvas and sensitive DOM before serialization. No network bodies, console capture or screenshot/canvas recording. Test actual outgoing payloads and packaged behavior; remote settings cannot widen the app's collection policy [S8].

**Warehouse/CDP, surveys and workflows:** optional follow-up once a concrete question justifies them. Start with minimal company projections rather than syncing the full operational database or customer documents. Preserve deletions, source permissions and retention; warehouse is not Nectovia Business Knowledge or operational truth. Use existing runtime/scheduler for investigations; a PostHog workflow trigger does not authorize a business action. Outbound effects and third-party fees need their own approval.

## 9. Order and acceptance

PH-00 is a short reconciliation/contract check, not a new architecture program. Then PH-01 → PH-02 → PH-03 → PH-04. PH-05 website work may run after PH-01 with distinct ownership. PH-06 replay/warehouse follow-ups are optional and must not block the first trace. PH-07 independently reviews each material candidate and the final packaged rollout.

| Test family | Required proof | Owner |
|---|---|---|
| Scope | Free + valid provider, paid + direct engine and no-export paid deployment send zero PostHog requests, including flags | PH-01/03 |
| Authority | Spoofed tenant/plan/internal labels cannot authorize export; customer cannot access company query credentials | PH-01/02/04 |
| Privacy | Nested/encoded canaries absent from actual exporter, exception, SDK enrichment and replay bytes | PH-01/03/06 |
| Identity | Concurrent tenants, logout, switch, revocation and queued events cannot cross identities or upload excluded history | PH-01/02/03 |
| Runtime | Export failure/429/timeout/cap, queue overflow and observer exception leave result, Trust and ledger unchanged | PH-01/02 |
| Attempts | Replay exports stable identity; real retry differs; canceled/partial/refused/uncertain outcomes accurate | PH-02 |
| Units/cost | Seconds vs milliseconds, cache/reasoning normalization, mixed payer, late cost, zero known cost vs unknown | PH-02/04 |
| Credit controls | Eligible/excluded/unverified product, unknown/expired award, stale observation and no cash continuation | PH-02/07 |
| Metrics | Failed roots and helpers included; zero verified roots yields no ratio; sample/unknown coverage disclosed | PH-04 |
| MCP | Project pin, no unauthorized writes, no AI-billed tool leak, union-filter trap, prompt injection and loop prevention | PH-04 |
| UI/site | Eligible state changes, safe flag baseline, consent, no form text, correct Astro integration | PH-03/05 |
| Packaging | Correct Electron host/renderer startup/shutdown, no private key, no claims about unobserved OS surfaces | PH-03/07 |
| First proof | Real runtime with synthetic adapter, positive and negative controls, actual ingestion readback, vendor outage | PH-02/07 |

Run test-first against exact source and use current package scripts. Typecheck, focused Vitest, full required gates, Vite/Astro builds and relevant Playwright/desktop journeys apply according to changed files and repository rules. Respect the shared heavy-test slot. Ordinary tests have no external model or telemetry access.

Record source-present, fixture-tested, ingested-synthetic, real-provider-tested, packaged-app-tested, deployed and invoice-verified independently. This publication performs none of the future application tests. A docs PR is not a shipped feature. Rollback disables the observer/optional feature, never deletes canonical runs or replays effects.

## 10. PILLAR IMPACT and canonical context

Advances Pillars 07 (provider resources behind Nectovia), 09 (separate trust/data/billing), 10 (measured value) and 11 (less founder diagnosis). Preserves deterministic work under 01/08 and shared safety under 12. The intentional absence of Free telemetry is an observation-scope decision, not a mandate to remove Free functionality or change licenses. Metadata-only observation limits semantic diagnosis; explicitly record this rather than implying automatic factual verification.

Implementation must refresh `AGENTS.md`, `docs/DIOMEDES_CORE_PILLARS.md`, `docs/DIOMEDES_LIVE_ROADMAP.md`, `docs/DIOMEDES_PROJECT_MEMORY.md`, their linked Drive canonicals, and the current cloud builder pack. This lane does not replace paid-Agent access, SDK routing, Automations or deployment owners. Add their exact accepted interfaces to the PH-00 record, not duplicate services.

## 11. Primary references

Public facts were checked September 25, 2026. Account-specific terms and runtime conformance remain separate evidence. Use the relevant current documentation and pinned installed types at implementation time.

- S1. PostHog startup terms, exclusions, duration, support: https://posthog.com/startups
- S2. Desktop startup-plan eligibility: https://posthog.com/docs/posthog-desktop/download-posthog-desktop
- S3. Manual AI-event capture: https://posthog.com/docs/ai-observability/installation/manual-capture
- S4. Capture/batch API and identity semantics: https://posthog.com/docs/api/capture
- S5. AI privacy mode: https://posthog.com/docs/ai-observability/privacy-mode
- S6. Cost calculation: https://posthog.com/docs/ai-observability/calculating-costs
- S7. MCP scope, internal-AI charges and filter semantics: https://posthog.com/docs/model-context-protocol/faq
- S8. Replay privacy: https://posthog.com/docs/session-replay/privacy
- S9. Pricing/limits: https://posthog.com/pricing
- S10. Opus 5.5 prompting guidance: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
- S11. Claude Code MCP setup and scopes: https://code.claude.com/docs/en/mcp

**End of plan — NC-PH-2026-09-25.3.**
