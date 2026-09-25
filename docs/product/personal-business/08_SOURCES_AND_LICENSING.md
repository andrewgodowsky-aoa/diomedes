# Source ledger, licensing and decision status

PB-2026-09-10.1 | Checked September 10, 2026.

## Source-derived project context

Repository: https://github.com/andrewgodowsky-aoa/diomedes

Inspected main: a70ae5d9523d81bf5db98304a657cf16ed014a7a. Relevant files: AGENTS.md; docs/DIOMEDES_LIVE_ROADMAP.md; docs/DIOMEDES_PROJECT_MEMORY.md; the 2026-09-10 pricing checkpoint (removed 2026-09-19); docs/harness/CHANGES.md; docs/harness/RUNTIME_VERIFICATION.md; shared/types.ts; shared/harness.ts; LICENSE. Some reports describe earlier checkpoints and are not current execution proof.

The 2026-09-10.3 roadmap/memory define shared Core/Runtime/Trust boundaries, local/BYO versus paid company-funded inference, Console-only work, preserved Engines typography, correction/evidence foundations and commercial gates. Pricing at that date retained the then-planned Business and Managed figures (retired and removed from this sentence on 2026-09-19; see the pricing authority). This package adds the owner's newly approved product direction; $300 with $100 usage remains a candidate, not a silent public price replacement.

Canonical roadmap: https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit
Canonical memory: https://docs.google.com/document/d/13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw/edit

## First-party outside research

Anthropic — Prompting Claude Opus 5:
https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
Complete task context and clear scope work well; avoid redundant self-check/verification scaffolding and unnecessary delegation. Our design implication: short milestone prompts plus relevant durable contracts, not a giant repetitive instruction block. This does not cancel mandatory repository quality gates.

Z.AI — Best Practice:
https://docs.z.ai/devpack/resources/best-practice
The general coding guidance emphasizes Goal, Context, Constraints and Done when, and storing recurring rules in project context. This is not a claim of a separately verified Flash-specific benchmark. The GLM handoff uses those four fields.

Stripe — Usage recording:
https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage
Stripe — Billing credits:
https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
Stripe — Entitlements:
https://docs.stripe.com/billing/entitlements
Stripe — Webhooks:
https://docs.stripe.com/webhooks
These describe usage reporting, service-feature entitlements, billing credits, and duplicate/out-of-order event handling. Design implication: payment events and reporting are not an atomic runtime spending gate. Diomedes needs its own request admission/reservation boundary, reconciled to the chosen billing service. Stripe is a researched option, not selected or connected for production by this package.

OWASP — Multi-Tenant Security Cheat Sheet:
https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
Useful guidance on authenticated tenant context and scoping data/caches/operations. The proposed isolation cases apply these principles; they do not establish that Diomedes already meets them.

## Licensing constraint

Updated 2026-09-25. Until September 25, 2026 the repository carried Apache License 2.0. Releases published before then (through 0.1.11) keep that grant: it allows modification and redistribution under its terms, does not limit use to individuals or prohibit businesses from using that code, and distinguishes trademark rights from copyright permission. On September 25, 2026 the root `LICENSE` was replaced with an interim all-rights-reserved notice from Diomedes Systems LLC (PR #135). Code from that point on is source-available for inspection only; using, copying, modifying, distributing or commercially using it needs written permission.

Current terms: the root `LICENSE`. Terms for releases through 0.1.11: https://www.apache.org/licenses/LICENSE-2.0

Recommended path now: keep the existing Core intact and sell the official managed Business service, maintained configuration, organization infrastructure, included inference and scoped support. Do not rely on a desktop flag as an unbreakable paywall. Users can modify locally available software; server-controlled service access is a separate boundary.

Separately licensed future Business modules may be an option only after deliberate ownership/contributor and licensing review. Releases published under Apache 2.0 cannot be relicensed: do not claim exclusivity over that code or add restrictions to it. Any license change beyond the interim notice needs owner and legal review. This is product/engineering guidance, not a legal opinion.

## Approval versus proposal versus implementation

Owner direction: strong free Personal; managed paid Business; Business-only questionnaire; organization-specific Diomedes Agent access/usage; integration with Agents, Teams, rules and correction; urgent staged work and short Opus prompts.

Design recommendations: identity decomposition, hybrid configuration compiler, activation/recovery design, conservative usage and offline defaults, scenario-based acceptance.

Still to approve commercially: exact price/tier names, allowance cost basis and exclusions, overage/rollover, seat/host/location limits, support terms, identity/billing provider, production model route and any different licensing.

No application capability, customer deployment, subscription checkout, model training or actual cost saving is proved by publication of these documents.
