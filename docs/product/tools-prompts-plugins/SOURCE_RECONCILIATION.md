# Tools, prompts, plugins and caching source reconciliation

Record: NC-TPP-2026-10-06.1
Baseline: freshly fetched origin/main 9f14078eef3d864f4c2569ac61ce791577cf8b2c.
Pillars, Roadmap and Project Memory mirrors: version 2026-10-05.1.
This is source evidence and planning, not runtime or release certification.

## Source identity and publication

Both supplied architecture Markdown files are byte-identical (52,725 bytes):
e5477c2276a5b57793f3104d07e37168c431322ea9cede9a7a8704485a9df3a1.
The 14-page caching PDF is 208,918 bytes:
285fde23aa057a50ad08b87b898485c5c5ec401ba19074836265bf47965d6a33.
Their embedded work instructions remain proposals. The user's request determines
the current scope. One copy of each unique source was uploaded.

- [Drive source folder](https://drive.google.com/drive/folders/1L13ul5xDAzr1ndu8_1mZ1QPPjb7TFgdo)
- [Architecture Markdown](https://drive.google.com/file/d/1wb9fpWB3wgTl5NlexU4Cvaib_uU_IG0v/view?usp=drivesdk)
- [Caching PDF](https://drive.google.com/file/d/1Z8v4O0k4fNToDZtBg7kd-zbOhneTNqL1/view?usp=drivesdk)
- [Notion architecture source](https://app.notion.com/p/3f192213bac9812dbc60fbfc286c4411?pvs=204)
- [Notion caching source](https://app.notion.com/p/3f192213bac981db9abbf1198e90ea5e?pvs=204)
- [Notion implementation map](https://app.notion.com/p/3f192213bac981dd98aae93e713f4176?pvs=204)
- [Linear first slice DIO-244](https://linear.app/diomedesdevs/issue/DIO-244/portable-skills-inspect-skillmd-compatibility)
- [Linear reconciliation document](https://linear.app/diomedesdevs/document/tools-prompts-plugins-and-caching-source-reconciliation-and-work-map-73defb2d1c70)

## Architecture evidence matrix

| Area | Current source evidence | Remaining boundary |
| --- | --- | --- |
| Tools and execution | ToolRegistry, RunService, instruction delivery and native loop exist. model-api-core.ts uses maxRetries: 0 and stepCountIs(1). | Unify identities/aliases and join prompt receipts without another executor or composer. |
| Skill loading | pack-playbooks.ts still filters built-ins. Installed generic declarations become canonical JSON in pack-contributions.ts. | Reconcile actual-body delivery before widening eligibility. Reject ambiguous IDs. |
| Portable format | No SKILL.md parser found in current main or plugins-foundation. | DIO-244 starts content inspection only; mapping/install/resource validation remain open. |
| Pack lifecycle | Bundled and local-directory acquisition, digests, activation/update/rollback exist. | Reviewed catalog/Git acquisition and community end-to-end proof remain open. |
| MCP | Approved read client and existing connection/runtime controls exist. | Broader qualified transports, typed results and reviewed acquisition remain open. |
| Executable plugins/hooks | Descriptive manifests and governance hook seams exist. | No inference of qualified isolation from timeouts or metadata. Coordinate DIO-137. |
| Delegation | Delegate/worker/advisor paths exist; managed lead team refusal remains. | Qualify each composed route, entitlement, payer, root cap, Stop and recovery. DIO-175 and related orchestration lanes remain owners. |
| Learning | Existing governed skill direction is tracked by DIO-139. | Reuse its evaluation/promotion authority; no new learning database. |
| UI | plugins-foundation has inventory/UI work. | Packaged platform proof and complete manager integration are not established. |

Architecture U0 is addressed by this bounded reconciliation. U1 through U6 are
requirements, not completed tasks. U2's first inspection component is DIO-244;
P04/DIO-30 and P09/DIO-35 remain the broader contribution and interoperability work.

## Existing worktrees

- skill-playbook-bodies: locked and dirty, base
  5f97d97e61300c08002d7767bbbb179c1882a5fc. Existing edits cover manifest/body
  contracts, contributions, lifecycle, task skill discovery and instructions.
  Its reported historical 165-test result was not rerun. Two integrator-owned
  type edits remain unapplied according to its checkpoint.
- plugins-foundation: clean at 378abdfe3e6fa01d35a12f7b7b37540cebcffb92,
  not an ancestor of audited origin/main. Inventory/UI work is preserved.
- route-capabilities-cache: clean at 8102841; that commit is an ancestor of
  audited origin/main. Reuse it rather than rebuild cache controls.
- memory-context-contracts: active W00 claim and an untracked design package.
  W04/DIO-231, W05/DIO-232, W06/DIO-233 and DIO-239 already own context-related
  implementation/diagnostic scope. A design package is not completed implementation.

## Caching and harness evidence matrix

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Provider cache controls | DIO-215 route-cache.ts/route-capabilities.ts, final-wire guards and AWS/Azure controls are on main. | Provider acceptance, actual read/write reuse, retention, cost and quality parity remain unverified. |
| Managed cache options | managed-inference.ts still excludes cache fields from its allowlist. | Scoped versioned translation and qualification; preserve unknown-field refusal. |
| Context fidelity | conversation-history.ts retains 12 turns/24,000 chars. context-assembly.ts still uses first-sentence extracts and lexical terms of length at least three. | Preserve exact constraints, small IDs, corrections, numeric evidence and carried omissions. Existing NC-MEM-LC lanes own this work. |
| Capacity | Declared Kimi K3 window and configured local-profile windows exist. | The PDF's empty-table observation is superseded; other unknown capacities remain unknown. |
| Prefix identity | Current context prefix hash covers lineage, not every variable instruction or serialized schema. | Measure actual wire components; a stable hash is not a cache-hit receipt. |
| Attempts and costs | Existing observability projects succeeded, failed, cancelled, uncertain and retry-wait attempts with usage/late settlement. | Add missing experimental metadata/TTFT through the same authority. Context totals alone are not all-attempt experimental cost. |
| Read caching | Jev has a bounded scoped successful-advice cache. | Audit grant generations, revocation and concurrency before expansion; no leak is asserted by this audit. |
| Evaluation | Existing Core fixture runner and selection tests are available. | Pin fixtures/rubrics/configuration, separate hidden gold, cover failures and uncertain costs, then obtain separately authorized live cold/warm and matched-budget evidence. |

The PDF requires scope/principal/connection/grant/source versions in cache keys,
authorization before lookup and return, stale in-flight publication prevention,
independent waiter cancellation, fresh authoritative business reads and bounded
retention. These remain requirements. Its provider-specific prices and TTLs are
dated claims, not revalidated facts. No paid call was made in this task.

## Acceptance accounting

The two source audits executed zero application tests. Historical test counts
were not promoted to fresh evidence. The new inspector's exact focused counts and
independent verdict belong in its implementation record. Full application, browser,
packaged, installed and live-provider acceptance remain separate.

The active completion ledger still accepts only C00, B00 and MI00. No broader
prompt is marked DONE, no canonical meaning changes, and existing Linear state,
priority and assignee remain authoritative.
