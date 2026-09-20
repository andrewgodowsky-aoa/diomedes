# Inventory records and import preparation

MI02.I candidate, pure subset only. Base: `80263205133c410d590549efd1c8f40cedf33b1c`.
Feature/branch: `inventory-records` / `feature/inventory-records`.
Worktree: `F:/Diomedes/diomedes-wt/inventory-records`.
Author task: `01a0b997-c98f-73c1-8ca9-97dded6699c0`, actual model `gpt-6-astra`.
Prerequisite: independently accepted MI00-contract-v2, inventory contract 1,
revision `2026-09-19.2`, tree `1b10d949ecfc35a6aa3352e110c53745000167e4`.
Its three frozen files are reconstructed unchanged. `shared/inventory.ts` is not edited.

## Implemented boundary

`server/inventory/catalog.ts` validates one catalog against the selected host
organization, tenant and Project. It creates private item, exact barcode, physical
site, bin and stock-location indexes. Every public read requires that same host
scope. Parsed data are cloned by the shared schema and deeply frozen; mutating an
input or returned record cannot corrupt the indexes. Missing objects/locations
stay missing. An item with no recorded locations returns an empty location list.
Two stations do not create two physical sites.

`lookup(scope, { by: 'item' | 'barcode', value }, policy)` projects the item and
its recorded locations. Policy supplies `now`, `maxSourceAgeMs` and
`maxCountAgeMs`; source observation, record observation and physical count have
separate current/stale/future states. Missing count evidence displays `Count
unknown`. A source observation never manufactures a physical count. Exact barcode
matching preserves leading zeros and does not coerce numbers, trim or fold case.
Item variant, unit and scale are retained. On-hand/reserved/available nulls remain
null; untracked reservations never become zero.

`server/inventory/import.ts` consumes text snapshots already read by the owning
Files boundary. `prepareInventoryImport(selection, snapshot, mapping, options)`
returns an immutable `inventory-import-preview`; it never saves or applies it.
The selected `recorded-ledger` catalog authority describes the intended MI00 data
owner, not proof that this preview has been admitted into that ledger.

The separate trusted-host selection and declared snapshot both carry:

```ts
{
  scope: { organizationId, tenantId, projectId },
  source: { kind, reference, revision, observedAt, sha256 },
  format: 'csv' | 'json-table'
}
```

The snapshot additionally carries `text`. Source kind is synthetic, approved-file
or connected provenance. `reference` is an opaque source ID, never a read path or
URL. Exact metadata, scope and format must match the host selection, and the
SHA256 must match the UTF-8 text actually parsed. Lone surrogates are rejected
before hashing and after JSON string decoding, preventing replacement-character
encoding from disguising different text. A BOM is removed only after hashing.
Preview versions include source identity/digest, scope, mapping, reservation mode,
observation time and contract revision; remapping the same file changes versions.

Selection is not authentication. The future host must resolve current identity,
membership, Trust, Project binding and authorized Files source independently of
the artifact or client. It must re-read/re-authorize the source when required.
The pure function cannot establish that an arbitrary caller supplied honest host
inputs. No `authorized: true`, client actor, role or filesystem location is accepted
as authority. Current authorization and source-access enforcement are unimplemented
integration gates, not claimed by scope/digest comparison tests.

## Import format and validation

The existing `shared/file-imports.ts` 1 MiB per-file limit is reused. This importer
also permits at most 10,000 data rows, 32 columns and 500 characters per cell.
Existing `server/file-imports.ts` remains the guarded file reader/recorded importer;
no second file reader, Files store or configuration path is introduced here.

CSV uses comma separators, LF/CRLF records, doubled quoted quotes and exact row
width. Structured input is a JSON array of arrays with the first row containing
headers, for example `[["SKU","Quantity"],["0001042",101]]`. It requires a complete
inventory mapping to be useful. Object-shaped rows, duplicate headers (including
case aliases), reused/missing mapped columns, extra mapping keys and malformed
quoting are refused. Plain natural-language text, including instruction-like text
and URLs inside labels, stays literal data. No URL, filesystem, shell or model
operation is invoked from source content. Formula prefixes and control characters
are rejected at the cell boundary; path-like identifiers fail the shared ID schema.

Required mapped fields: itemId, name, unit, scale, siteId, siteName, binId, binName
and onHandMinor. Optional fields: variant, barcode, reservedMinor, lastMovementAt,
lastPhysicalCountAt and countReference. Count time/evidence columns must be mapped
together, and each count row must supply both or neither. Blank/null quantities
mean unknown. Optional absent reservation data remain unknown in either mode.

Each row describes one item/location. Identical item/site/bin definitions may be
reused across distinct locations; conflicting definitions and duplicate locations
are refused. A barcode identifies only one item. The CSV mapping supports one
barcode per item; the catalog itself preserves the MI00 multiple-barcode contract.
Extra barcode splitting, object-row adapters and unit conversions are unsupported.

Quantities are safe nonnegative integer minor units. For example, 101 at scale 2
means 1.01 of the declared unit. Scale is 0-6. CSV quantity strings use decimal
digits; JSON numeric tokens must also be nonnegative integer literals, never
fractional, exponential or negative tokens that could round during JSON.parse.
Availability is computed only when both inputs are known. Reservations exceeding
on-hand and unit/precision mismatches are rejected. Movement/count timestamps
cannot follow their source observation; source observation cannot follow the
supplied host time. Millisecond precision follows the accepted shared contract.

## Opening counts

`prepareOpeningCount(catalog, hostScope, intent, now)` returns the shared
`record-count` command after validating item/location, exact expected version,
base unit/precision, explicit count evidence, count time and known reservations.
It only prepares an opening count where physical count evidence is absent. It
refuses counts predating a recorded movement and future observations. Existing
physical counts require the later reviewed recount/correction path. A zero count
is legitimate when compatible with known reservations.

No catalog mutation, balance write, receipt, History entry, approval or proof of
physical observation is produced. MI03 must revalidate against the current ledger,
current authority and atomic recorded-effect admission before any effect. A command
prepared here is intent, never a reusable authority token or a durable success.

## Verification and remaining gates

Run evidence lives under the existing coordination run:
`F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/runs/mi-demo-20260919/inventory-records/`.
The frozen candidate manifest records raw file hashes, exact complete/delta patch
hashes, predecessor identity, tree, commands and final counts. The initial absent
module runs were collection failures with zero executed tests. Subsequent genuine
RED evidence records seven parser/chronology/error regressions and three source
version/Unicode regressions, followed by GREEN results. TypeScript initially found
three test-fixture typing errors; their correction passed repository typecheck.

The deterministic 100- and 1,000-item fixtures contain two fictional physical sites,
three bins, duplicate-looking variants, a long label, unknown stock, reservations,
low stock and a stale physical count. Each measurement runs 1,000 exact local
lookups and reports construction time, p50/p95 and failed request count. These are
in-process fixture observations under Vitest on Windows, not an HTTP/device/network
benchmark or proof of MI-A21. See the final test log for unrounded values.

The new production modules import no provider/model route and perform zero model
calls. Tests exercise the real exported functions; an instruction-like label also
passes with network access trapped. This proves the deterministic pure slice, not
stock mutations, deployed authentication or the entire MI-A15 row.

MI-A04/MI-A06/MI-A15 receive pure-domain evidence only. Independent MI02.R, H21
persistence/recovery, B03/current authorization, the Files host adapter, MI03 stock
effects, full integration/browser/build gates, actual devices and observed human
acceptance remain pending. No full MI02 or MI-DEMO acceptance/DONE is claimed.

PILLAR IMPACT: deterministic work and one Files/Trust/Store owner advance P01/P02/P03;
no pillar meaning changes. ROADMAP IMPACT: no status or completion-ledger change.
BUILD/PUBLICATION/DEPLOYMENT: no build, packaging, app launch, commit, push, merge,
release, deployment or installed-app change. This is an uncommitted review candidate.
