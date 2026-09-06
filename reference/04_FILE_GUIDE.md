# File guide — both packages are self-contained

## Read only what the active role prompt asks for first

The complete source library is included for local reference, not to force every duplicate or historical document into the model's initial context.

| Path | Purpose |
|---|---|
| `00_START_HERE.md` | Role, reading order, limits and expected result. |
| `01_FABLE_PROMPT.md` or `01_ASTRA_PROMPT.md` | The role-specific message to follow after Andrew sends this package. |
| `02_HANDOFF_PRECEDENCE.md` | Active versus superseded instructions and scope boundaries. |
| `03_SOURCE_STATUS.md` | Available sources, missing appendices, stale snapshots and evidence limits. |
| `05_RECONCILIATION_QUEUE.md` | Focused crosswalk requests from the existing review; not new implementation tasks. |
| `context/Fable_latest_reply_verbatim.md` | The latest pasted Fable reply, including its research summary and stale-ZIP note. |
| `review/` | The previous detailed review, Astra foundation-proof prompt and Fable integration note, copied with their own relative source references. |
| `planning/2026-09-05-v4-business/` | Six new v4 documents; their original three strategy sources; supplied checksums. |
| `planning/2026-09-05-v3-replan/` | Complete supplied v3 technical/design/research snapshot. |
| `planning/2026-09-04-master-plan/` | Original plan and inherited requirements, used on demand. |
| `history/chatgpt-v3-amendment/` | Earlier product/harness/visual amendment, historical. |
| `history/earlier-prompts/` | Discovery and earlier master prompts; not instructions to restart the project. |
| `assets/` | Supplied screenshots and design previews. |
| `provenance/` | Input inventory, byte-copy map, source-checksum checks and package validation record. |
| `MANIFEST.sha256` | SHA-256 hashes of all other packaged files. |

Original plan-relative links are retained by placing the three planning folders side by side. The older review retains its own `sources/` subtree. These small duplicate document copies are intentional so both original reading paths remain usable. Private external links and links to unprovided appendices are not represented as locally available.
