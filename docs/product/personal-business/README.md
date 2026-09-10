# Diomedes Personal / Business — implementation package

Package: PB-2026-09-10.1. Owner-approved direction; implementation specifications and candidate commercial defaults are labeled separately. Documentation publication does not mean these features are shipped.

**Start here:** preserve the current Opus Trust/Agent run. After its coherent checkpoint, run PB-01 → PB-02 → PB-03 → PB-04, then the existing GLM corrective-loop prompt with the Business addendum. Each Opus prompt is approximately 200 words and points to its relevant contracts; do not paste every document into every turn.

The design is one Core, a capable free Personal harness and a paid configured Business workspace with managed Diomedes Agent access. Personal never receives the Business questionnaire. Business setup belongs to the organization and authorized membership, not a permanent account-wide personal/business flag.

## Documents

| Document | Repository/local file | Google Doc |
|---|---|---|
| Product and editions | [01](01_PRODUCT_AND_EDITIONS.md) | [Drive](https://docs.google.com/document/d/1YFrdT3GZG-8FFd2Oy4lPbw3CalQCAOB05AcpCdfafGA/edit) |
| Identity and questionnaire | [02](02_IDENTITY_ONBOARDING.md) | [Drive](https://docs.google.com/document/d/1ZbOE67pHN50-_jl8eKXGvpAJFa56T-SDu1_hj8kYUf8/edit) |
| Self-configuration | [03](03_SELF_CONFIGURATION.md) | [Drive](https://docs.google.com/document/d/1DKVj4kSb6iMcKTl95kuf3HX9tgSRUy5b336Dty8-DOA/edit) |
| Harness, rules and Teams | [04](04_HARNESS_RULES_TEAMS.md) | [Drive](https://docs.google.com/document/d/1iuEV4kaBshJRUA_Bd0qjsQ11tVSTm684L9G1uIgyhmM/edit) |
| Managed API allowance | [05](05_MANAGED_USAGE.md) | [Drive](https://docs.google.com/document/d/1kZ9Z1sIp5K3YV-s91lRZcXiPYqo4SOEPly8OiKP2OWc/edit) |
| Edge cases and release gates | [06](06_EDGE_CASES_AND_ACCEPTANCE.md) | [Drive](https://docs.google.com/document/d/1Muj2rpaVtuCNZkepZxSmcyZibwS-8hnsWh5fM_2HGzw/edit) |
| Delivery sequence | [07](07_DELIVERY_SEQUENCE.md) | [Drive](https://docs.google.com/document/d/1lGmdmtAxLw4c-ne9DFpdtbaKD-yldBmS4xzcqsViJKw/edit) |
| Research and licensing | [08](08_SOURCES_AND_LICENSING.md) | [Drive](https://docs.google.com/document/d/1aZzrh0Y-QuICQ2mK9br3kCmcTNYTPyW4u__RG5qFOU4/edit) |
| Prompt collection | [Prompts](prompts/) | [Drive](https://docs.google.com/document/d/12vpITK9JvR7W-zYmviuQuAoaSjVVP-Qfcocvh8bxnuY/edit) |

## Prompts

[PB-01: identity and Business intake](prompts/OPUS_PB01_IDENTITY.md)

[PB-02: configuration and harness](prompts/OPUS_PB02_CONFIGURATION.md)

[PB-03: managed usage boundary](prompts/OPUS_PB03_USAGE.md)

[PB-04: integration and GLM handoff](prompts/OPUS_PB04_HANDOFF.md)

[GLM Business addendum](prompts/GLM_BUSINESS_ADDENDUM.md)

The [synthetic setup fixture](fixtures/business-setup.example.json) is a design example, not an activation payload, grant, runtime wire schema or live customer record.

## Scope and commercial boundary

$300/month including $100 inference is a candidate package, not an approved price change. Preserve existing approved prices and keep live billing unavailable until production identity, entitlement, gateway, spending and provider terms are ready. No company keys in the desktop; no automatic overage or cross-payer fallback.

The current Apache-2.0 license remains unchanged. Sell managed services and maintained organizational capability; do not claim published code is restricted to noncommercial Personal use or that a local flag is an unbreakable paywall.

Application code, release packaging, deployment, payments and licensing changes remain outside this documentation patch. Workers follow AGENTS.md and current explicit authorization. Current source/evidence outranks an intended post-run feature list.
