# FD04 industry registry and deterministic fixture leaf

Status: implemented as an isolated, uncommitted FD04 leaf. This is not FD04 acceptance, prospect activation, a rehearsal run, packaging evidence, publication, or deployment.

Base: `57e8b6ae10eb410598c600cf97f6792a89023bdb` on `feature/fd04-industry-registry-20260919`.

Canonical documents read from this checkout: Core Pillars `2026-09-10.1`, Live Roadmap `2026-09-19.1`, and Project Memory `2026-09-19.1`. The approved prospect-demonstration design was read from the isolated documentation worktree because the base commit does not yet contain `docs/product/2026-09-17-prospect-demo.md`.

## Implemented boundary

This leaf adds an open data-folder registry, uses it in the existing configuration compiler and HTTP route, and provides a pure fixture renderer:

- `resources/industry-variants/` ships the preserved restaurant-operations and professional-services pack values plus tire/service and carpentry as data. Each folder has strict `variant.json`, `fixtures.json`, and admitted fixture bytes.
- `loadIndustryVariantRegistry()` loads bundled and optional operator directories. One malformed folder yields a refusal record and does not block unrelated variants.
- The registry admits only the deterministic `weekly-brief` engine. Adding another output shape remains a code change outside this item.
- Exact admitted bytes produce a stable SHA-256 identity. The loaded record is frozen and carries its source path and bundled/operator origin.
- Folder ids are path-guarded slugs. Only contract version 1 is admitted. Fixture and destination paths must remain relative, reject Windows drive, colon, reserved-name, and traversal spellings, use an admitted text/data extension, and may use only the location-index placeholder in an output path.
- Symbolic links and reparse points, unexpected files, executable extensions, malformed fields, duplicate ids, duplicate fixture paths, excess files, and excess bytes are refused with field or path detail. Duplicate-id diagnostics name both folders.
- `renderSyntheticFixtures()` strictly validates a prospect overlay, substitutes only the named business, location, and terminology slots in one pass, and never accepts guidance, rules, instructions, or arbitrary fields from the overlay.
- Location fixtures are emitted once per supplied public location name. With no locations, those slots are omitted. No location is invented.
- Every result is a typed `{ path, text, sample: true, route: 'synthetic' }` candidate carrying the demonstration-data declaration and immutable variant digest. Markdown/text use a leading declaration, CSV uses a first declarative record, and JSON uses a `syntheticNotice` property so the full artifact remains parseable. CSV and JSON substitutions are escaped for their file formats. The function writes nothing.
- `shared/packs.ts` now accepts a validated registry map as compiler input and performs keyword selection across that map while preserving `professional-services` as the neutral fallback. It reads no files and remains pure.
- The compile route freshly loads bundled variants plus `<dataDir>/industry-variants` on each request. Explicit ids must be admitted registry entries, unknown ids and extra body keys are refused, and refused or duplicate folders do not block an unrelated valid operator variant.
- `ConfigurationService` now accepts either the existing organization id or a strict `{ kind: 'prospect', prospectId, operatorId }` owner. Existing organization files remain in their original location; prospect histories live separately under `prospects/configuration/<operator>/<prospect>.json` with null organization and tenant ids.
- The app composition seam is `ProspectConfigurationSource.resolve(owner)`. It must return the freshly active FD02 record projected into deterministic answers and a typed overlay. Staging and every activation or rollback re-read that source and compare record, answer, overlay, and variant identities.
- `ProspectRehearsalService` requires a trusted `ProspectRehearsalAuthority.resolve({ projectId, owner })` adapter. That adapter must bind the active FD02 record to the project and return the current `ConfigurationManifest` plus a freshly loaded registry variant; the service never accepts either object from the request. It rechecks that authority before fixture writes and again before the brief write. The `synthetic` route renders into a revision-specific project namespace and pins source hashes to the exact rendered bytes, so an intervening edit is refused by `WeeklyBriefService`. The `approved-file` route writes no fixtures and admits only exact path/hash references present in the project's `Imported exports` History and still unchanged in Store. Synthetic briefs are recorded with `sample: true`; approved-file briefs use `sample: false`; both state their route and pinned configuration/variant identities.

The fixture numbers are deliberately synthetic. Only the provided business and location names enter generated text. There are no person fields.

## Authority and architecture boundary

The implementation does not add a Store, runtime, permission, approval, rule, instruction, or configuration authority. It extends the existing `ConfigurationService`, `WeeklyBriefService`, and `Store.writeRecorded` path. It does not import executable code from a variant, evaluate data, fabricate a Business membership or tenant, or touch `shared/types.ts`, `server/app.ts`, `server/store.ts`, Console files, package manifests, or dependencies.

## Verification

TDD red:

```text
node_modules/.bin/vitest.cmd run tests/fd04-industry-registry.test.ts
FAIL: Cannot find module '../server/rehearsal/fixture-template.js'
```

Focused registry, compiler, and real-route green:

```text
npx vitest run tests/packs.test.ts tests/configuration-routes.test.ts tests/fd04-industry-registry.test.ts
Test Files  3 passed (3)
Tests       32 passed (32)
```

Combined producer and independent adversarial verification after the boundary repairs:

```text
npx vitest run tests/packs.test.ts tests/configuration-routes.test.ts tests/fd04-industry-registry.test.ts tests/fd04-adversarial.test.ts --reporter=dot
Test Files  4 passed (4)
Tests       41 passed (41)
```

Prospect configuration, rehearsal, organization-regression, and registry verification:

```text
npx vitest run tests/fd04-prospect-configuration.test.ts tests/fd04-rehearsal-service.test.ts tests/configuration-service.test.ts tests/weekly-brief.test.ts tests/packs.test.ts tests/configuration-routes.test.ts tests/fd04-industry-registry.test.ts tests/fd04-adversarial.test.ts --reporter=dot
Test Files  8 passed (8)
Tests       75 passed (75)
```

The independent adversarial lane is also recorded at `F:/Diomedes/deliverables/prompt-package-20260919/fd04-adversarial.md` with 9/9 focused tests passing.

Type check:

```text
npm run check
exit 0
```

No full Vitest, Vite, browser, desktop, packaging, or live-provider gate ran; those require the shared heavy slot and the integration owner.

## Remaining parent integration

The parent/integrator still owns:

1. parent app/routes wiring from active FD02 records into `ProspectConfigurationSource` and `ProspectRehearsalAuthority`; the latter remains deliberately unwired until the parent supplies a trusted project-to-prospect binding rather than fabricating a `Project.prospectId` field;
2. Console overlay form, exact diff, revalidation, rerun, H22 summary, active-prospect scoping, and the Workflow Opportunity take-away;
3. independent review, full integration gates, packaged proof, and all live FD04 acceptance rows. The packaging source now snapshots and stages `resources/`; the import-meta path was checked to resolve both repository `server/../resources` and packaged `stage/server/../resources` to their intended roots. No package was built or run in this slice.

## Pillar and roadmap impact

The leaf advances Pillar 02 by proving industry variation is data over one Core and Pillar 08 by keeping fixture production deterministic. It preserves Pillars 05, 09, 10, and 11 by granting no authority, loading no code, labeling synthetic output, and returning candidates to the one recorded writer. No roadmap checkbox or publication status changed.

Everything remains uncommitted and unpushed.
