# Cloud canonical synchronisation, 2026-09-24

**State: the three canonical cloud documents and these repository mirrors carry the same text.**
This note follows the protocol of `CLOUD_SYNC_2026-09-19.md` and closes the "What remains" list of
`CLOUD_SYNC_2026-09-23.md`. Before this pass the cloud and the repository had forked:

- the cloud canonicals carried the NC-2026-09-22.1 commercial text;
- the repository mirrors carried the Nectovia rename (2026-09-23.1);
- neither had the 2026-09-23 tier decision or the 2026-09-24 Automations decisions.

The texts were rebuilt from these mirrors at `origin/main` 559a1ab. That base:

- keeps the rename;
- carries the tier and cap paragraphs;
- adds the 2026-09-24 checkpoint: releases 0.1.8 to 0.1.11, the Workbook removal, the Conversation and Architect views, the History and Sample project removal, and Artifacts v2;
- adds the Milestone A decisions D1 to D5 (PR #69).

## Canonical documents replaced in place

Each cloud body was replaced as a whole. Checking: Google's plain-text export of each document and
the file here were normalised the same way, hashed, and the hashes compared. The digests below are
the first 16 hex characters of the SHA-256 of that normalised text. Every pair matched.

| Document | Cloud ID | Version | Normalised digest | File SHA-256 (LF bytes) |
|---|---|---|---|---|
| Core Pillars | `1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4` | 2026-09-22.1 (sync note updated) | `208e9d80a14453c4` | `7a63a8c6869dc460679558ea3700941a2320377953f4f7589f782274e6a57b56` |
| Live roadmap | `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE` | 2026-09-24.1 | `f03d1e9e5fc21996` | `814c3dc996ca5651ddbf17e74984cdaff072285779b4e431f168ebd912179ff6` |
| Project memory | `13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw` | 2026-09-24.1 | `d57d0308dda89f51` | `e405952607a078c4f5be332c65810d244e542264f926b8d013144188a716b2a2` |

The body replacement used a signed-in Google Docs tab in the session's browser: select all, then dispatch a synthetic `paste` event carrying the text to Docs' text-event iframe. The Drive integration can still change only a file's title and parent.

## Other Drive changes the same day

- **Pricing:** `1OrjI7NCBf4YRt2TGgBvPS52GW8LM3hgXCnN6lp7sxIQ` is now "Nectovia pricing and service scope — reconciled 2026-09-24". Its changes:
  - the tier map replaces the Sol-led Focused and Opus 5.5 Thorough preferences;
  - the 20/50/100 caps are marked approved;
  - it adds Vertex and the $10 test-spend limit;
  - the status line now names 559a1ab, 45bbd96 and 0.1.11;
  - the plan names are now Nectovia Business and Managed Nectovia.
- **Entry point:** "START HERE - Nectovia cloud development - 2026-09-24.md" (`1beKodbrmjrj8ojDXijFAQgZ17MxHBykK`) replaces the 2026-09-21 START HERE, which is now titled SUPERSEDED. It also records that the routing text in the 2026-09-22 execution-package ZIP is superseded.
- **Retitled SUPERSEDED:**
  - the 2026-09-19 mirrors of the roadmap, memory and Pillars;
  - "DIOMEDES PRICING & SERVICES — CURRENT 2026-09-15".
- **Retitled HISTORICAL:** "MARKETABILITY & INCOME — SCENARIOS".
- **Status banners** were added at the top of:
  - the SDK Luna first-route doc (its section D model-picker sentence was also replaced with the tier decision);
  - the CD-1 package, the CD-1 launchers and the Bots handoff;
  - the Automations plan, which now points at the Milestone A work order and D1 to D5.

## What remains

- Linear and Notion were reconciled in the same pass. The Automations issues the cloud thread is working (DIO-84 to DIO-90) were left untouched.
- The Option B wording pass from `CLOUD_SYNC_2026-09-23.md` is still open.
