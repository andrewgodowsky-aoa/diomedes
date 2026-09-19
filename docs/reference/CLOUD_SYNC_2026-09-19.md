# Cloud canonical synchronisation, 2026-09-19

**State: four new Drive documents hold the repository mirrors; the canonical documents are unchanged.**
This note follows the same protocol as `CLOUD_SYNC_2026-09-12.md` and supersedes it for the three
living documents.

## What was written

The Drive integration available to the session still cannot edit an existing document's body, so
each mirror was published as a new Google Doc in Andrew's Drive, uploaded as Markdown. Each opens
with a note saying it is a copy, that the repository file governs if they differ, and that Andrew
decides which cloud document is canonical.

| Mirror | Version | New document | Canonical document (unchanged) |
|---|---|---|---|
| `docs/DIOMEDES_CORE_PILLARS.md` | 2026-09-19.1 | `17Z516Q9cxopTH4apTMqnc3JYlwL7WLPgG5vhu6-chNI` | `1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4` (still 2026-09-10.1) |
| `docs/DIOMEDES_LIVE_ROADMAP.md` | 2026-09-19.2 | `1WLtb2ABQRIg-7J0YP5QEiQDdaeXTPPJZpmnaKKocPWk` | `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE` |
| `docs/DIOMEDES_PROJECT_MEMORY.md` | 2026-09-19.2 | `1TkGjewpMYM4OMJ0gFQk4N9T9tqC4fg6QHfPe9wB4Sls` | `13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw` |
| `docs/business/PRICING_STRATEGY_2026-09-15.md` | 2026-09-19.1 | `1OrjI7NCBf4YRt2TGgBvPS52GW8LM3hgXCnN6lp7sxIQ` | none; the repository file is the only pricing authority |

The 2026-09-12 mirrors (`1ItgrS9VYFPMqYRc_a03JBDupG4svaA1SgEbD4RM2iAU` roadmap,
`1kfoUCKAKz69p90zRfBi_qTNd4h90mcCGg3AjG9Y3Eo4` project memory) are now older than these and carry
retired prices. They were left in place; removing them is Andrew's call.

## Why these versions

Andrew's decisions of 2026-09-19: included usage is published as a count (up to 1,000 requests a
month) and never as a dollar figure, bounded internally at $0.10 a request and $100 a month; the
monthly graphical update is withdrawn in favour of a design consultation, a first look and up to two
revisions per subscription year; Fractional AI Ops is published; a location is any staffed site, not
only a restaurant; Pillar 07 no longer prefers a subscription the customer already pays for; and
retired Diomedes prices are deleted with the reason written down (`PRICING_STRATEGY_2026-09-15.md`,
"Removed figures"). The public site carries the same decisions as of its commit `a9e4328`
(Cloudflare version `0b3b8aa0-920f-4547-99aa-1efef1a308b1`).

## What remains for Andrew

Either paste each new document's body over its canonical document, or retitle the new documents as
canonical and update the `Cloud canonical:` line in each mirror to the new id. Until one of those
happens, the repository mirrors are the newest text and the canonical ids above point at older
versions that still state retired prices and the old Pillar 07 wording.
