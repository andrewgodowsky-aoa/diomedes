# Cloud canonical synchronisation, 2026-09-12

**State: two new Drive documents hold the repository mirrors; the canonical documents are unchanged.**
This note supersedes `CLOUD_SYNC_PENDING_2026-09-11.md`.

## What was written

The Drive integration available to this session can create a document with content but has no
way to edit an existing document's body (`update_file` changes title and folder only). So instead
of a pending handoff, the mirrors were written as new documents in the same folder as the
canonical ones, each opening with a note that says it is a copy and that Andrew decides which
becomes canonical:

| Mirror | Version | New document | Canonical document (unchanged) |
|---|---|---|---|
| `docs/DIOMEDES_LIVE_ROADMAP.md` | 2026-09-12.1 | `1ItgrS9VYFPMqYRc_a03JBDupG4svaA1SgEbD4RM2iAU` | `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE` (last read 2026-09-10.4) |
| `docs/DIOMEDES_PROJECT_MEMORY.md` | 2026-09-10.7 | `1kfoUCKAKz69p90zRfBi_qTNd4h90mcCGg3AjG9Y3Eo4` | `13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw` (last read 2026-09-10.4) |
| `docs/DIOMEDES_CORE_PILLARS.md` | 2026-09-10.1 | not written (no change since the canonical was last reconciled) | `1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4` |

Both were uploaded as plain text and converted by Drive into Google Docs, so Markdown marks appear
as characters, the same way the canonical documents already read.

## What remains for Andrew

Either paste each new document's body over its canonical document (refreshing first and keeping
any cloud-only edit since .4), or retitle the new documents as canonical and update the
`Cloud canonical:` line in each mirror to the new id. Until one of those happens, the repository
mirrors are the newest text and the canonical ids above point at older versions.
