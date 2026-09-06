# Source reconciliation for the executed build

2026-09-05. These decisions describe this implementation; they do not rewrite archived plans or claim broader architecture approval.

| Difference | Build decision |
| --- | --- |
| ZIP foundation-only stop versus current request | The current request explicitly says to execute, build, integrate, and continue. It supersedes the older stop-before-app scope. |
| Achilles branding and older Stele/Instrument design versus live Diomedes v5 | Live v5 files 00-15, the merge note, and user-supplied artifact screenshots govern UI. Diomedes branding; Achilles directory retained. |
| Conflicting writers in v5 | Follow `MERGE-NOTE.md`: numbered UX specs and actual boards govern wording/layout; appendix 24 supplies mechanisms. Do not edit originals. |
| Automatic V0.5 to V1-A versus current bounded implementation | Build a useful local application with proven integrations. Do not treat untested remote, native-workspace tools, shell choice, or business services as completed. |
| Desktop Electron/Tauri choice | Browser client and separate local service keep the shell replaceable. No desktop runtime installed. |
| AionCore artifact/source uncertainty | Do not adopt an unproven host. Use the documented native-protocol fallback for text-only Codex. AionCore remains visibly unconfigured. |
| Codex standalone executable/helper mismatch | Isolate matching existing 0.153.4 binaries in app-local data, verify hashes and actual Windows write denial, and preserve originals. |
| Sample-only Work versus current integration request | Keep sample mode for deterministic exercises. Add native text-generated proposals, human approval, and host-recorded edits. This does not grant Codex file or shell tools. |
| C-drive app-data proposal versus F-drive workspace | Store app state and newly generated sample projects inside this app on F:. Explicit user-chosen projects can use other permitted roots. |
| Separate JSON/JSONL store documents versus crash recovery | Consolidate canonical per-project records in atomic state.json; keep content-addressed history objects and durable pending-write journals separate. |
| Font binaries absent in ZIP | Install and bundle the specified open-license families with their license texts. No Google Fonts request at runtime. |
| Exact screenshot labels versus actual data | Match structure, fonts, colors, borders, spacing, and controls. Render current filenames/counts/status, never counterfeit engine, pricing, or document results from mockups. |
| Restore claim for all files versus text-only implementation | Enforce the UTF-8/8 MB boundary and disclose unsupported files. History cleanup remains inactive rather than promising unenforced retention. |

The input ZIP SHA-256 and all internal manifest results are in `package-integrity.json`. The supplied ZIP predates live v5 and is supporting context, not a replacement for the current artifacts.
