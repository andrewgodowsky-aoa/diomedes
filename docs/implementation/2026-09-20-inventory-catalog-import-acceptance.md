# Inventory catalog and import acceptance

This feature imports the exact independently accepted MI02 pure-records subset:
scope-bound immutable catalog indexes, freshness views, bounded CSV/JSON import
previews and opening-count intent. Its six source, test and original evidence
files match the reviewed SHA256 hashes. The prerequisite is inventory-v1 revision
2026-09-19.2, now carried by the separate inventory-contracts feature.

The independent review found no production defect in this subset. Its coherent
focused run passed 227 tests, including 91 independent cases, with no failures or
skips; TypeScript passed. The accepted review composite tree was
536a0c3a32300b020de60307cec489186cfb5e96. Its complete patch SHA256 was
cbe53a32aae821243537c4f34695a093f796ea9048fb779cb0e3149c899ddf61.

Fresh integration gates on 2026-09-20 passed TypeScript, 2533 unit tests (one
pre-existing Windows short-path fixture skip), the Vite build and all 35 browser
smoke tests. This release does not register a route,
authorize a source selection or persist stock. The host must derive current
identity, membership, Project, Files and Trust authority. Full MI02 remains OPEN
until those integration and acceptance requirements are complete.

Original review evidence is preserved in the pinned coordination run under
inventory-records-review, including REPORT.md, manifest.json and its safe release.
