# Cloud canonical synchronisation — pending, 2026-09-10

**State: the cloud canonical documents do not match their repository mirrors.** This file records the
exact divergence and the exact patch, as `AGENTS.md` requires when an agent cannot perform the write
itself.

## Measured divergence

Read directly from Drive on 2026-09-10 (not inferred from a prior report):

| Document | Cloud version | Repository mirror | Gap |
|---|---|---|---|
| Live roadmap (`1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE`) | 2026-09-10.**4** | 2026-09-10.**8** | .5, .6, .7, .8 |
| Project memory (`13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw`) | 2026-09-10.**4** | 2026-09-10.**7** | .5, .6, .7 |
| Core Pillars (`1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4`) | not read this pass | unchanged this pass | none introduced here |

**Most of this gap predates this session.** Revisions .5, .6 and .7 (PB-01 identity and intake, the
reviewer and Agent checkpoint, the autonomy-workbench integration) were written to the repository
mirror and never written to the cloud. Only .8 on the roadmap and .7 on the project memory were added
by the 2026-09-10 decisions patch.

## Why it was not written

The Drive integration available to this session exposes `read_file_content` and an `update_file` that
changes a file's title and parent only. There is no document-content write, so no cloud edit was
attempted. Nothing was overwritten, and no concurrent editor's work was touched.

## The exact patch

The repository mirrors are the reconciled text. The patch is to make each cloud document's body equal
its mirror:

- `docs/DIOMEDES_LIVE_ROADMAP.md` → roadmap document, ending at `Roadmap version: 2026-09-10.8`
- `docs/DIOMEDES_PROJECT_MEMORY.md` → project-memory document, ending at `Version: 2026-09-10.7`

Whoever performs the write must refresh each document first and use its `requiredRevisionId`, and must
reconcile rather than discard any cloud-only edit made since .4. Two paragraphs in the cloud roadmap
carry a stale `F:\Achilles` planning path that the mirror has already corrected to `F:\Diomedes`;
that correction is part of this patch.

### What .8 and .7 add, specifically

Roadmap §2, new subsection *Project as durable container, and the optional Files pane — owner
decision, 2026-09-10.8*, covering the general-purpose Project, the two-tier Files surface (Core
file/artifact surface plus the Software Engineering Capability Pack tier), the capability-pack
contract, repository instruction files as discovered standing guidance, and the derived human
statuses. Plus the §10 change-record line for 2026-09-10.8.

Project memory §*Stable meanings*, six new paragraphs: the Project definition, the derived human work
statuses, History as evidence, path resolution, Files and Artifacts as Core, and the capability-pack
contract.

Both are reproduced verbatim in the mirrors; copy from there rather than from this file, so a
transcription error cannot enter the canonical text.

## Verification when the write lands

Re-read both documents and confirm the version lines read `2026-09-10.8` and `2026-09-10.7`, then
delete this file. A stale "sync pending" note is itself a drift claim.
