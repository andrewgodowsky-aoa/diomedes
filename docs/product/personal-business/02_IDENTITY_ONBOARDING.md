# Business identity, profiles and questionnaire

PB-2026-09-10.1 | Proposed implementation contract under the approved product direction.

## Ownership

Keep Person, Personal workspace, Organization, Membership, organization-owned Business profile, member preferences, Entitlement, Usage account and execution principal distinct. Reuse post-Opus types instead of creating duplicate concepts. A person can keep Personal and belong to multiple organizations. A one-person company is a valid Business customer. Business registration means verified service identity and authority to configure the organization; do not pretend it proves legal incorporation.

The organization owns its operating configuration and work. A person owns private preferences; membership carries organization-specific roles and allowed preferences. Paying an invoice does not automatically make someone an administrator or grant access to business data. A questionnaire answer is never a grant.

Published-source warning: `shared/types.ts` currently includes `Settings.onboarding.work = business | school | software | personal | mix`. This is a preference, not registration or payment evidence. Migration must not turn an old business answer into membership, credits or permission, or move Personal projects into a company. `shared/harness.ts` describes its current tenant check as single-tenant; adding an organization ID is not production multi-tenancy.

## Entry behavior

Personal opens without the business questionnaire. Ordinary optional personal/model setup remains. Creating or joining a business is explicit. Preserve existing appearance, model settings and data.

Full Business intake requires: active Business workspace, authenticated active membership, setup authority, and new or explicitly resumed setup. Enforce this in the host/API, not only the renderer. Invited ordinary members join the existing setup; optional role preferences do not rerun company onboarding or grant admin rights. Email-domain matching alone never creates membership. Development identities must remain visibly labeled fixtures.

## Branching intake

Ask for the first useful outcome, not a twenty-page company survey. Save and resume by organization and schema revision. Support Back, unknown/optional answers, accessible controls and a short reason for each question. Reveal deeper questions only when the chosen job needs them. Never collect API keys, passwords or payment-card details in free text.

| Question | Meaning and consequence |
|---|---|
| What should we call your business, and what work do you do? | Display name and optional industry; selects examples, not authority. |
| What recurring job should Diomedes help with first? | One concrete outcome; custom answers allowed; unsupported work explained. |
| What is a useful result, and who reviews it today? | Output, baseline and acceptance expectations, not invented savings. |
| Where does the information live? | Supported connections or approved exports; selection is not access. |
| Who uses this workspace, and who approves changes? | Membership and approver proposals, separately confirmed. |
| Are there multiple locations or projects? | Labels and sharing requirements, not automatic access grants. |
| What must always come back to a person? | Draft approval boundaries; consequential actions conservative by default. |
| May this information leave this computer? | Data classes, processing routes and retention; unknown blocks risky cloud use. |
| Which computer does the work, and when is it available? | Explicit discovery consent and host availability. |
| What AI spending limit applies, and who can change it? | Proposed lower caps and payer; no implied overage consent. |
| When should the first job run? | Manual-first; unsupported schedules stay inactive. |
| Here is the proposed setup. What should change? | Review of configuration, access, spending and activation. |

Store typed answers with origin, timestamp, tenant and schema version. Separate explicit facts, model suggestions and unresolved questions. Do not infer employee performance, legal compliance or system authority from a description. Filter what is sent to a provider and disclose the payer before model-assisted setup.

## Lifecycle

Recommended states: not-started, drafting, proposal-ready, validating, needs-approval, rehearsing, ready-to-activate, active; explicit blocked, paused and superseded outcomes. Adapt to existing durable state. A spinner finishing does not prove activation.

Drafting can be deterministic/offline. Assisted setup requires an allowed local/BYO route or a real paid/service-grant route. Before paid entitlement, offer a deterministic preview rather than secretly subsidized inference. Changing answers creates a new proposal, not immediate mutation of active settings. Activation rechecks membership and the expected-base configuration digest. Concurrent admins receive a conflict rather than last-write-wins authority changes.

## Boundary cases

Workspace switching never transfers running work, payer, credentials, retrieved context or business notifications into Personal. Bind search, caches, streams, logs, artifacts and tools to their original scope. Personal-to-Business transfer is explicit export/import with ownership and secret checks, never an onboarding side effect.

Handle invitation expiry/replay, role changes, owner departure, last-owner recovery, organization deletion and expiring consultant access. Support staff get explicit scoped access, not omniscience. Personal account deletion cannot accidentally delete another member's company records. Subscription cancellation does not convert company data into an individual's property.

App scoping cannot protect local files from an OS administrator. Document device isolation and offline validity. Revoking cloud access cannot recall already exported files or guarantee immediate offline revocation.

## Initial proof

Existing Personal skips Business intake; an owner creates/resumes one Business draft; an invited member does not redo it; two businesses remain distinct; revoked membership and stale activation are refused; legacy business preference grants nothing. Preserve Personal settings and distinguish synthetic identity tests from production identity assurance.
