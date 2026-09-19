# FD02 facilitated prospect discovery

Status: implemented as an uncommitted integration candidate on `feature/fd02-discovery-20260919` from `57e8b6ae10eb410598c600cf97f6792a89023bdb`.

Canonical versions read before implementation:

- Core Pillars `2026-09-10.1`
- Live Roadmap `2026-09-19.1`
- Project Memory `2026-09-19.1`
- unified execution contract `2026-09-13.1`
- B00 accepted interface `CONTROL_PLANE_CONTRACT_VERSION=1`

The approved 2026-09-17 Field Readiness and prospect-demonstration amendments are the product authority for this slice. This implementation adds no Business membership, customer login, credential, separate Runtime, separate permission service, or project for a prospect.

## Implemented boundary

`shared/discovery.ts` defines the prospect record, current-process map, immutable fact revisions, five provenance classes, one distinguished demo hypothesis, append-only hypothesis outcomes, stage, personalization level, strict Prospect Research Brief schemas and deterministic Markdown export. Process fields point to fact identities; a correction appends a replacement and projections follow the replacement chain, so the view and export change while prior evidence remains in fact history.

Public source URLs are bounded HTTP or HTTPS URLs without embedded credentials. Retrieval dates are real ISO dates or UTC date-times. JSON and data-only Markdown front matter are parsed locally. Unknown keys, person-shaped keys, observations without source indices, source indices outside the source list, and item URLs absent from `sources` are refused with the offending field path. Import performs no fetch and every imported value becomes a `public` fact with URL and retrieval date. Imported content retains origin `imported-document`; it cannot become guidance through the existing rule-authority contract.

An imported public business name remains a public fact; it does not overwrite the consultant-recorded prospect name used by the view and export heading. Importing the same brief again is idempotent, so identical public facts and import events do not accumulate.

Public facts have only two transitions: owner confirmation appends a `reported` replacement; contradiction appends an `unknown` replacement. Public-to-observed and public-to-hypothesized transitions are refused. An observation is a separate fact whose evidence is one of:

```ts
{ kind: 'approved-file'; projectId; path; sha; historyEntryId }
{ kind: 'diomedes-execution'; projectId; executionId; historyEntryId }
```

`DiscoveryService` requires an injected verifier to accept either evidence shape and refuses observations by default. The integrator verifies the current approved-file hash plus its durable History entry, or a completed Diomedes execution plus its History entry.

The service uses the existing Store mutation queue and exported atomic JSON writer under `store.dataDir/prospects/`. It persists active prospect selection under a hash of the trusted operator identity. HTTP never accepts the active prospect from a header or request body. Selecting a known record checks its stored operator; foreign and missing records have the same 404 response. Owner-facing reads return only that operator's active record, including only that record's exports.

Every persisted record is parsed through the complete strict schema before use or write. The parser checks fact identities, references, correction graphs, canonical timestamps, provenance and public-lineage rules. Stored observed facts are rechecked against their durable evidence after operator ownership succeeds; a foreign lookup cannot trigger verification under the record owner's identity.

Stage and personalization can move forward only. `pilot` is refused because B03/B11 own promotion. Demo-hypothesis outcomes append and never delete or replace the hypothesis; `not-a-weak-point` is rendered as a normal export result.

The Console component receives one already-scoped record and renders goals, the process map, provenance, demo-hypothesis outcome, classification and exports. It does not render record ids, prospect ids, operator ids, repository instructions or other developer context. `Shell.tsx` remains integrator-owned.

## HTTP integration contract

`mountDiscoveryRoutes(app, service, dependencies)` takes:

```ts
{
  operatorId(req): string;
  importDocument?(req, { projectId, path, sha }): Promise<{ filename, content }>;
  exportToProject?(req, artifact, projectId): Promise<{ id, path, createdAt }>;
}
```

The callbacks must reuse Files. Import must read a selected `.json` or `.md` document whose current SHA matches its recorded `Imports/` creation. Export must use the existing recorded writer, an explicitly selected existing project, a unique path and `expected: null`; only after that write succeeds does the route append the export receipt to the discovery record.

Routes return `{ record }`:

- `GET /api/discovery`
- `POST /api/discovery`
- `POST /api/discovery/:prospectId/select`
- `POST /api/discovery/:prospectId/import` with `{ projectId, path, sha }`
- `POST /api/discovery/:prospectId/facts`
- `POST /api/discovery/:prospectId/facts/correct`
- `POST /api/discovery/:prospectId/facts/public-transition`
- `POST /api/discovery/:prospectId/hypothesis/outcome`
- `POST /api/discovery/:prospectId/classification`
- `POST /api/discovery/:prospectId/export` with `{ projectId }`

Every route containing `:prospectId` compares it with the service-owned active selection before reading or mutating. The select route is the only operation that changes that selection.

## Verification boundary

Focused deterministic tests cover strict JSON and Markdown import, YAML front matter, no-fetch import, URL/date refusal, no-account record creation, provenance projection, public transitions, stale-correction refusal, durable active selection, cross-operator isolation, observed-evidence verification, export shape, correction propagation, append-only hypothesis outcomes, forward-only classification and owner-facing rendering without developer context.

At the time this record was written, the focused command and TypeScript check passed. Full Vitest, Vite, Playwright, desktop packaging, a live provider call and a packaged prospect demonstration were not run by this worker; they remain integration-owner gates. No commit, push, release, installation or deployment was performed.

## Product impact

This advances Pillars 02, 08, 09 and 10 by keeping discovery general-purpose, deterministic where possible, explicit about fact provenance and unwilling to invent measured savings. It advances the FD02 deterministic rows A08-A10 and PD-01-PD-03 plus the view half of PD-08. It does not complete FR-D, FD04, pilot promotion, packaged isolation or live demonstration evidence.
