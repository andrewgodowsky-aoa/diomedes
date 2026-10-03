Continue your current Diomedes thread after the in-flight Trust/Agent work reaches a coherent checkpoint. Use the newest integrated source and preserve other workers' changes.

Implement PB-01 from docs/product/personal-business/07_DELIVERY_SEQUENCE.md. Read AGENTS.md, the current canonical roadmap/memory, and this package's 01_PRODUCT_AND_EDITIONS.md and 02_IDENTITY_ONBOARDING.md.

Personal/Business is now an immediate product priority. Keep one Core and Console. Separate a person's identity and Personal workspace from organization membership, organization-owned Business configuration, entitlement and usage. Reuse sound existing types/services. Legacy onboarding.work=business is only a preference; it must never grant membership, credit or authority.

Deliver the explicit create/join/switch Business flow and a short resumable Business-only questionnaire. Personal never receives it. Owners/admins configure the organization; ordinary invitees join the existing setup. Preserve Personal settings/data, multiple-business separation and safe handling of revoked membership and stale setup.

Implement the actual supported host/UI/persistence path, not just mock screens. If production identity is unavailable, keep its boundary explicit and isolate development fixtures; do not fake paid readiness or rebuild an unrelated identity stack.

WorkOS amendment, 2026-10-03: read [WA-2026-10-03.1](../../../architecture/workos-agent-authority.md)
and the [prepared implementation prompts](../../PROMPT_workos-agent-authority-2026-10-03.md)
when changing identity/session contracts. Preserve human-only login and membership
APIs; agent tokens and Connect MCP/M2M credentials must never become Persons,
human sessions, approvers or staff keys. WorkOS organization IDs need a verified
mapping to existing Nectovia organizations, not a matching name or email domain.
Keep Personal's existing path until a personal mapping is explicitly approved.
No Agent Auth, EMA, token broker or early-access production wiring is added to
PB-01 by this amendment. Record the missing Business Trust/revocation prerequisites
for the existing Runtime/Trust owner rather than creating another auth system.

This slice excludes billing, live connector creation, full Team orchestration and the GLM correction loop. Follow the current Console/Engines visual system and repository quality/publication rules. Give a brief handoff with what works, contracts changed, actual check results and PB-02 prerequisites. Make routine implementation judgments without widening the task.
