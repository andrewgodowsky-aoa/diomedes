# P01 and P03: versioned pack manifests and the pack lifecycle

Date: September 24, 2026. Lane `p01-p03-pack-lifecycle`, branch
`feature/p01-p03-pack-lifecycle`. Linear DIO-27 (P01) and DIO-29 (P03). P02 (DIO-28, private
registry and GitHub acquisition) is **not** in this slice beyond a local folder the person names.

Canonical documents read: Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project Memory
2026-09-23.1. None of them is edited here; the proposed patch is at the end.

---

## What shipped

### P01: the manifest contract (`shared/pack-manifest.ts`, `shared/semver.ts`)

- A zod `PackManifest`, `schemaVersion: 1`: dotted id, semver `version`, `publisher`, `description`,
  `compatibility.contract` (a semver range over the pack host contract revision, `1.0.0` in this
  build, whose major is `CAPABILITY_PACK_CONTRACT_VERSION`), typed contributions (tools with a
  declared effect and the capabilities they use; Agents with `grantsAuthority: false`; standing,
  correction and instruction-file rules; context sources; workflows with `acts: false`; UI
  affordances on the four existing surfaces only), `permissions.requested` with
  `grantsAuthority: false`, `dependencies` with semver ranges, payload `files` with their sha-256,
  and a `digest` that is the sha-256 of the canonical (sorted-key) JSON of everything else.
- The schema refuses an outward capability request (the same `OUTWARD` list `validateManifest`
  already used, now exported), a tool or context source that uses a capability the pack did not
  request, duplicate contribution ids, a self-dependency, an instruction file named by path, and
  any unknown field.
- `resolvePacks` is deterministic: ids visited in sorted order, each takes the newest version
  every range on it admits and whose contract range admits this host, repeated to a fixed point,
  then a depth-first cycle check. Refusals are named: `missing`, `version-conflict` (with every
  range that caused it), `cycle` (with the path) and `incompatible-contract`. No backtracking
  search: a conflict is reported rather than solved around.
- The built-in packs are expressed as manifests without changing them:
  `manifestFromCapabilityPack` maps Software Engineering and Small Business (needs become
  requests, instruction files become instruction-file rules, skills become workflows);
  `weeklyBriefPackManifest` wraps the `shared/packs.ts` template; each of the four
  `resources/industry-variants/*` folders becomes `diomedes.industry.<id>` depending on
  `diomedes.weekly-brief ^1.0.0`, with every byte of its folder pinned in `files`
  (`server/pack-catalogue.ts`). The industry registry and business setup read the variants exactly
  as before; installing or not installing the pack does not gate them (see gaps).

### P03: the lifecycle (`server/pack-lifecycle.ts`, `server/pack-routes.ts`)

- A versioned on-disk store at `<dataDir>/packs/store.json` (`schemaVersion: 1`). A store naming
  another schema is refused, left untouched, and every operation refuses with it; the Console shows
  the refusal.
- On first open, Software Engineering and Small Business are recorded as installed **by
  Diomedes** (truthful attribution) and are off in every project, which is exactly today's
  behaviour. The weekly brief and the four variants ship bundled and are installable.
- Install (bundled or local folder), update, rollback and uninstall. Each writes `started`, then
  `completed`, `refused` or `failed`; a restart that finds a `started` with no ending appends
  `interrupted`. The list is append-only and never pruned (decision 10). Activation decisions are
  also History entries in the Project, through the one activation writer the built-in packs use
  (`recordPackActivation`, factored out of `setActivation` with the same sentences).
- Crash safety: content is staged under `staging/<op>`, each file checked against its sha and the
  manifest against its digest, renamed into `objects/<id>/<version>-<digest12>`, and only then does
  one atomic `jsonWrite` of `store.json` make it installed. A crash before that write leaves the
  store as it was; the next open appends `interrupted` and sweeps staging and unreferenced objects.
  An installed manifest is re-verified against its digest on read; one altered on disk is reported
  damaged and will not turn on.
- A local folder carries `diomedes-pack.json`; the folder goes through `safeAbsolute` (links
  refused at every component, forbidden locations refused), only the listed files are read, each
  must match its recorded size and sha, and the `diomedes` publisher and id namespace are reserved
  for bundled packs.
- Activation per project: an uninstalled pack cannot be turned on; a dependency that is off is
  asked about (`needs-dependencies`) and turned on with it only on a second, explicit request.
  Turning off a pack another active pack in that project depends on is refused with the
  dependent's name. Uninstall is refused while any project has the pack on (named) or an installed
  pack depends on it. Update and rollback are refused when an installed dependent's range would
  break, and each adds a History entry to every project where the pack is on.
- **Activation is not authorization.** Nothing here reads or writes a grant, Need, thread
  permission, task, session, schedule, connection or setting; a test deep-compares all of them
  before and after a sequence of activations and deactivations.
- **On demand.** `loadedContributions(projectId)` returns contributions only for installed packs
  that are on in that Project. The Software Engineering discovery path is unchanged and still
  refuses to run where the pack is off.

### Console (`client/console/PackSettings.tsx`)

Inside the existing task-permissions dialog: each installed pack with its version and on/off state
in this project, the other projects it is on in, its requested permissions under
`Requests · Trust decides at use`, a contribution count line, and Activate / Turn off, Update to,
Roll back to and Uninstall, each destructive or version-changing action behind an explicit second
button. Bundled packs not installed are listed with Install. A local folder is checked first
(digest verified, requests shown) and then installed or updated. The last five recorded
operations are shown with the total count. A pack whose contributions this build only records
says so in one line.

---

## Tests

| File | Covers |
| --- | --- |
| `tests/pack-manifest.test.ts` (44) | semver ranges and refusals; schema accepts the minimal manifest and refuses 14 named violations; canonical bytes ignore key order and exclude the digest; the SE, Small Business, weekly brief and a variant manifest keep what their runtime form says; the resolution table: newest admissible, determinism under input order, missing, no version in range, version conflict, cycle, incompatible contract, and an incompatible newest passed over |
| `tests/pack-lifecycle.test.ts` (23) | preinstall by Diomedes with nothing on; unknown store version refused and untouched; bundled install asks for its dependency then installs in order; local folder verified; four spoiled folders refused, recorded and not installed; reserved namespace; missing dependency; contributions load only in the activating project; activation-is-not-authorization deep comparison; SE through the lifecycle behaves as before (AGENTS.md discovered, same History sentence); dependency asked then both on; turning off a depended-on pack refused; not-installed refused; update → rollback with project History; update breaking a dependent's range refused; uninstall refused in use, then append-only records preserved; crash after `staged`, `placed` and `committed`; damaged install refused |
| `tests/pack-routes.test.ts` (3) | the listing's new fields; bundled install and activation through HTTP with the dependency asked; uninstall in use names the project; unknown ids 404 on every route; a folder with no manifest refused by code |
| `tests/pack-lifecycle-ui.spec.ts` (2) | the settings journey in Chromium: installed list and versions, requests shown as requests, bundled install and activation each asking about the weekly brief, grants unchanged, uninstall in use refused, and a local folder checked, installed, updated, rolled back, uninstall cancelled then confirmed |

All existing pack tests (`capability-packs`, `small-business-skills`, `packs`,
`fd04-industry-registry`, `contract-revision`, `native-work`) pass unmodified.

Gate counts are in the pull request, from the final run on the merged head.

---

## Known gaps (not shipped, and not claimed)

1. **No registry, marketplace or GitHub acquisition.** P02 is untouched; the only sources are the
   bundled catalogue and a local folder.
2. **Installed packs other than Software Engineering and Small Business are declared, not
   run.** Their contributions are validated, stored, versioned and listed per project, and the
   Console says so; the Runtime does not yet register their tools or Agents, deliver their rules
   or offer their workflows. Wiring each contribution kind into its Core owner is follow-up work.
3. **The industry variants are not gated by installation.** Business setup and rehearsal read
   them through the industry registry exactly as before; installing the manifest records it and
   lets a project turn it on, nothing more. Gating them would change their behaviour, which this
   slice was told not to do.
4. **A bundled pack's update arrives only with a Diomedes update.** The update path is exercised
   for local folders and by the bundled-newer check; no bundled pack has a second version today.
5. **Uninstall removes the pack's object folders**; the operation record keeps the id, version
   and digest. Deletion of the records themselves is not offered (decision 10).
6. **Folder choice is a typed full path.** There is no native folder picker in this slice.

## Proposed defaults recorded here (Andrew's to confirm)

- Software Engineering and Small Business count as installed with Diomedes and cannot be claimed
  by a local folder (`diomedes` namespace reserved). They can be uninstalled; doing so is refused
  while any project has them on.
- Turning on a pack whose dependency is off asks, rather than refusing outright or turning the
  dependency on silently. Turning off or uninstalling something in use refuses and names the user.
- Rollback steps back one version at a time and grants and restores no permission (AGENTS.md:
  configuration and rollback never revive authority).

---

## Proposed canonical-doc patch

For the integrator. Nothing below is applied on this branch.

**`docs/DIOMEDES_LIVE_ROADMAP.md`, section 5 (Runtime, Projects, Files and packs), append after
the paragraph beginning "Packs compose tools, Agents, rules…":**

> P01 and P03 landed (2026-09-24, `docs/implementation/2026-09-24-p01-p03-pack-lifecycle.md`):
> every pack is described by a versioned manifest (`shared/pack-manifest.ts`) with typed
> contributions, requested permissions that Trust still decides, semver dependencies and a content
> digest, and dependency resolution refuses a missing pack, a version conflict, a cycle or an
> incompatible contract revision by name. Packs install from the bundled catalogue or a local
> folder verified by digest, and are activated per Project, updated, rolled back and uninstalled
> as recorded, append-only, crash-safe operations. Only the Software Engineering and Small Business
> packs' contributions are run by the Runtime; other installed packs are declared and listed, not
> run. P02 (registry and GitHub acquisition) is not started.

**`docs/DIOMEDES_PROJECT_MEMORY.md`, definitions, add:**

> **Pack manifest.** The installable description of a capability pack: id, version, publisher,
> the pack host contract range it was written for, typed contributions, requested permissions (a
> request, never a grant), dependencies and a content digest. **Installed** means the pack's
> verified content is in the pack store; **on** (active) is a separate, per-Project decision.
> Neither is an authorization event.

**`docs/product/2026-09-10-capability-packs.md` §6 "What is true today", append:**

> Versioned manifests (P01) and the install/activate/update/rollback/uninstall lifecycle (P03)
> landed on 2026-09-24; see `docs/implementation/2026-09-24-p01-p03-pack-lifecycle.md` for what is
> run versus only declared.

**`QUESTIONS.md`:** no question is answered by this slice. §5 question 2 (activation surface)
remains open; this slice keeps the existing task-permissions dialog as the surface.

---

PILLAR IMPACT: advances the pack contract (decision 14) with an enforceable manifest and a
recorded lifecycle; activation stays non-authorizing and on demand, History stays append-only
(decision 10), attribution stays truthful (bundled installs recorded as Diomedes, everything else
as you). No pillar conflict.

ROADMAP IMPACT: P01 (DIO-27) implemented as described; P03 (DIO-29) implemented with the gaps
above; P02 (DIO-28) unchanged, not started.

BUILD STATUS: feature branch only; draft pull request against `main`; not merged, not packaged,
no version bump, no native-runtime hash change.
