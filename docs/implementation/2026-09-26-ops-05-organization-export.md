# OPS-05: the Business owner's copy of the business's records, and leaving

| | |
|---|---|
| Brief | OPS-05 (user-owned exit), decision package SC-2026-09-26.1 |
| Branch | `feature/organization-export`, worktree `F:/Diomedes/diomedes-wt/organization-export` |
| Base | `feature/organization-setup` at `b8bd433` (ORG-01). This branch exports ORG-01's setup revisions, so it is stacked on ORG-01 and merges after it |
| Contract | `shared/organization-export.ts` (what an export holds, leaves out and says about leaving) and `services/control-plane/src/organization-export/schema.ts` (the answer the desktop accepts). This page is their prose |
| Status | Built. Not merged and not deployed. Needs no migration and no new database grant. One account-service route is added, so the Worker changes |

The brief asks for four things: an export with no bearer token in it, no export for a former member, a manifest that names what is left out, and revocation that stops future work without corrupting the records a business keeps. It also asks that export, credential revocation, cancelling the subscription and retained evidence stay separate, and that nothing promises data Nectovia never held.

A Business owner can now take a copy of the business's records from the Workspaces panel. The copy is written as plain files into the project the business writes into. Taking it changes nothing: nobody loses access, and nothing is revoked, cancelled or deleted. Leaving is a list of separate steps, each through a control that already exists.

## What an export holds

One folder, `Exports/business-records-<time>Z/`, in a project that belongs to the business, written as one recorded write in that project's History. Every file is new; nothing is overwritten. A second export in the same second gets its own folder.

| File | Holds | From | Format |
|---|---|---|---|
| `business.json` | The business, its people (every membership, revoked ones included), open invitations (never their codes), the plan as the owner's access view shows it, and the computers phones can reach (never their keys), or why there are none to list | Account service | `nectovia.organization-export.business/1` |
| `setup-revisions.json` | Every revision of the business's setup (ORG-01), exactly as saved, with who saved it and when | Account service | `nectovia.organization-export.setup-revisions/1` |
| `account-history.json` | Who joined, left, changed role or was invited, oldest first. The newest 20,000 events, and `complete: false` with a note when there were more | Account service | `nectovia.organization-export.account-history/1` |
| `configuration.json` | Every configuration revision this computer holds for the business, oldest first, and which one is active | This computer | `nectovia.organization-export.configuration/1` |
| `access.json` | The business's access resources, profiles and assignments on this computer | This computer | `nectovia.organization-export.configuration/1` |
| `this-computer.json` | The business's projects on this computer, with their folders (already plain files the owner holds), and where the business writes | This computer | `nectovia.organization-export.this-computer/1` |
| `manifest.json` | Every file with its category, format, source, record count and part; what is left out and why; the steps of leaving; the build that wrote it | | `nectovia.organization-export.manifest/1` |
| `README.md` | The same, for a person reading the folder without Nectovia | | |

Each JSON file names its own format and version. A category too large for one file (the store writes at most 8 MB of text per file) is split into numbered parts, `account-history-001.json` onwards, each within 7 MB, and the manifest lists them in order. A single record too large for any file stops the export with `413 export_too_large`, and nothing is written.

## Who may export

Only the Business owner, and the account service decides, whatever a computer remembers:

| Who, or what | Answer |
|---|---|
| The Business owner | `GET /account/organizations/:id/export` answers. The owner's membership is read again inside the transaction that reads the setup revisions and the history, so an owner demoted or removed a moment earlier is refused |
| A Manager or an Employee | `403 role_not_allowed`: "Only the Business owner can export the business's records." |
| Anyone not in the business, including a former owner or member | `403 not_a_member`, even from a computer that still lists the business. Once that computer has heard, `404 organization_not_found` before the account service is asked |
| A project that does not belong to the business | `409 export_project_not_owned`, before the account service is asked, and checked again before writing |
| A business kept only on this computer | `409 export_needs_account`: it has no account records |
| A value that looks like a key, password or card number | `422 export_secret_like`, naming the files and fields, and nothing is written |
| The phone relay's hub cannot answer, for a business with phone access | `503 relay_unavailable`, and nothing is written. An export is complete or it is not taken |

## No credential in it

Three layers, each tested on its own:

1. **What the service answers.** The export reuses the owner's own views: the roster, the access view and the device list. Those already carry no token, code, hash, key, identity-provider id or staff note, and the export adds none. An `invited` event's target is the invitee's identity-provider id, which is not the business's to keep, so it is exported as `null`. `services/control-plane/tests/organization-export.test.ts` checks the answer for the owner's and a Manager's bearer tokens, an unused invitation code, a direct invitation token, a registered phone key, the invitee's id and the staff note on the plan grant ("Demo business with the Nectovia Agent included."), and for the field names `tokenHash`, `codeHash`, `publicKey`, `passwordHash`, `subject`, `issuer`, `note`, `reference`, `issuedBy` and `sessionId`.
2. **What the desktop accepts.** `ControlPlaneClient.organizationExport` reads the answer through a strict schema. A field this version does not know is refused (`502 unreadable_answer`), not written, so a later change on the service cannot put something new in a customer's files without this contract changing first. Values that only name a kind (event kinds, features, grant sources, states) are checked as slugs, so an older desktop can still export after the service adds one.
3. **What is written.** Before writing, every value in every file is checked with `containsSecretLikeText`, the setup's own credential check, one field at a time (`secretLikePaths`). Fields that hold ids, times and digests the app or the account service generated are skipped, and nothing else is. The skip is needed. A random id is often all digits in places, and by the card check's own arithmetic (computed, not measured) about one random id in 23,000 passes it. With a thousand events in the history, about one export in twenty-five would have been refused for nothing. `tests/organization-export-archive.test.ts` builds such an id and shows both halves: the id alone passes the card check, it is skipped in an id field, and the same text in a name or label is found.

`tests/organization-export.test.ts` then exports through the desktop over HTTP. It collects every bearer token the desktop sent, every access and refresh token it was given, and an unused invitation code, then checks that none appears in any written file, and that no field of any file looks like a credential.

## What it leaves out, and why

Listed in every manifest and README (`OMITTED_CATEGORIES`):

- **Sign-in sessions, invitation tokens and codes, connection keys, and phones' device keys.** They are credentials, and an export never carries one.
- **Billing, payments and credit.** Kept for accounting; not part of this export.
- **Nectovia's notes on the plan.** Each grant's working note and the invoice or agreement it answers to. The export has the plan itself.
- **Data in the services the business connected.** It stays with those services, and Nectovia never held a copy. Export it from each service.
- **Configuration, work and files on other computers.** Each computer keeps its own. Export on each computer to take theirs.
- **Records of Nectovia Agent admissions and usage.** Not in this export yet.

## Leaving

Also in every manifest and README (`EXIT_STEPS`), and shown in the Workspaces panel before anything is exported. Each step is separate and uses a control that already exists. None happens because of an export:

1. **Remove people.** Their access ends at their next check. Nobody removed can export.
2. **Turn off phone access.** A computer turned off can never connect again.
3. **Disconnect connected services,** on each computer, then remove Nectovia from each service's own settings.
4. **End the Business plan.** Ending it stops the paid Agent and does not delete these records.
5. **What stays.** The account service keeps every setup revision and the membership history. They are never rewritten, and after leaving they are not shown to anyone no longer in the business.

There is deliberately no single "leave" switch. A blunt switch would revoke access for people still working and could not honestly promise to erase what must be kept.

## The account service

- `GET /account/organizations/:id/export` (`services/control-plane/src/organization-export/`). It sends three SELECT statements, on `memberships`, `organization_setups` and `account_events`, all of which `scripts/runtime-permissions.sql` already lets the Worker login read. The adapter test checks both ways that nothing else is needed. No migration and no new grant.
- The history is read newest first, cut to the limit, and returned oldest first. Ties at one instant fall by id in byte order (`COLLATE "C"`), the same order the faux store keeps, whatever the database's collation.
- The desktop waits up to a minute for the answer. Every other account call waits 15 seconds.

## Acceptance cases

| Case | Where | What is shown |
|---|---|---|
| The exit export contains no bearer tokens | `tests/organization-export.test.ts`: "writes every file into a project of the business…"; `services/control-plane/tests/organization-export.test.ts`: "holds the people, plan, phones…" | Not one of the tokens and codes the desktop sent or was given appears in any file. No field looks like a credential. The service's answer holds none of the credentials, hashes or staff notes the test planted |
| A former member cannot request an organization export | `tests/organization-export.test.ts`: "a former owner cannot request an export…"; `services/control-plane/tests/organization-export.test.ts`: "refuses a former owner after a transfer…" and "checks the owner again with the records…" | A former owner is refused with `403 not_a_member` while their computer still lists the business, then with `404` once it has heard, and nothing is written. The service also refuses an owner demoted or removed between its first check and the read |
| The export manifest identifies omitted and non-portable source categories | `tests/organization-export-archive.test.ts`; `tests/organization-export.test.ts`; `tests/organization-export-ui.spec.ts` | `manifest.omitted` is the six categories above, each with why. The README repeats them, and the Workspaces panel shows them before any export |
| Revocation stops future work without corrupting permitted retained records | `tests/organization-export.test.ts`: "revoking a person stops their future work…" | A removed Manager's computer can neither read nor change the business's setup. Every stored revision, the Manager's included, is byte for byte as it was, and a later export holds the same revisions, the Manager as revoked, and the change in the history |

The archive reads back: `tests/organization-export-archive.test.ts` puts the account service's answer back together from the files, as a reader without Nectovia would, including from split parts, and the strict schema reads it as exactly what the service sent.

## Migration and rollback

No schema migration and no grant change. The Worker gains a read-only route and the desktop gains a route, a Console section and the archive writer. Reverting the branch removes them. Archives already written stay in the business's projects: they are the owner's files, recorded in each project's History.

## What this does not do

- **It is not a point-in-time snapshot.** The setup revisions and the history are read in one transaction. The roster, the plan and the phones are read one after another, so a change landing during an export can show in one part and not yet in another.
- **The history read scans `account_events`,** which has no index on `organization_id`. That is fine at today's size. An index is a migration for the owner to approve.
- **An export is recorded only in the History of the project it was written into,** not as an account event. The account service keeps no record that an export was taken.
- **Only a business the account service keeps can be exported.** A business kept only on one computer has no account records. Its configuration is on that computer.
- **Private skills and artifact metadata** (named in the brief) are not exported as their own categories. MEM-01, MEM-05 and CON-02 are not built. Artifacts are files in the business's projects, which the export lists with their folders.
- **Agent admission and usage records are not included,** and the manifest says so.
- **The Console exports into the project the business writes into.** An owner who has not chosen one is told to choose it first. The route accepts any of the business's projects.
- **Credential revocation and offboarding are the existing controls,** listed as steps. This change adds none.

## PILLAR IMPACT (Core Pillars v2026-09-22.1)

- **Advances:** 09. Revocation, audit and evidence, and credentials stay separate. A copy carries no credential, and only the owner can take one. Also 05: leaving is a documented, self-served path, not a founder task.
- **Risks/conflicts:** none found. The export does not promise upstream portability, and it leaves the retained records as they are.
- **Evidence:** the four acceptance cases above, the archive round trip, and the Workspaces panel spec.

## State of this branch

| Gate | Result |
|---|---|
| OPS-05's own tests: desktop (archive and app, 2 files), control plane (2 files), the Console spec | 16, 14 and 2 passed |
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run --maxWorkers=4` | 475 files; 8,087 passed, 2 failed, 4 skipped. See below |
| Control plane `npm test` | 42 files passed, 3 skipped; 618 passed, 33 skipped (the skipped files need a PostgreSQL database) |
| Control plane `npm run typecheck` | exit 0 |
| `npx wrangler deploy --dry-run` | exit 0; 1,266.82 KiB, gzip 242.82 KiB |
| `npx vite build` | exit 0 |
| `npx playwright test` | 256 passed, 5 failed, 49 did not run. Both export specs passed |

All of these ran at b8bd433 plus this change, under one heavy slot, on 2026-09-26.

The five Playwright failures are the same five as on ORG-02's branch: main's four reds (`diomedes-home.spec.ts:185`, `home-luna.spec.ts:232`, `artifacts-ui.spec.ts:1434`, `home-route-ownership.review-20260921.spec.ts:140`) and the `h03-claude-controls.spec.ts:261` flake, which fails on the base b8bd433 without this change.

The two vitest failures are in files this change does not touch, and both come from a restart under load:

- `tests/automation-scheduler.test.ts`: "a pause that lands before the slot suppresses it…" ran a tick that admitted nothing.
- `tests/remembered-approvals.test.ts`: "a remembered approval survives a restart…" got a 500 from `/needs/:id/resolve`.

Run alone on this branch, twice, under the same slot, both files passed all 92 of their tests each time. They are contention flakes, not regressions.
