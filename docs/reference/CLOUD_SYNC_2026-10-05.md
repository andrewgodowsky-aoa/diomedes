# Cloud canonical synchronisation, 2026-10-05

**State: the three canonical cloud documents carry version 2026-10-05.1 and the same credit decisions as these mirrors. The Pillars hold the same text in a different order. The Roadmap and Project memory are still forked in other content (DIO-222).**

Andrew authorised the write on 2026-10-05 at 23:07 EDT. The decisions are recorded in Pillar 12, its amendment 2026-10-05.1, and `docs/business/PRICING_STRATEGY_2026-09-15.md`.

## What was found

Each cloud document was exported and compared with its mirror before writing. The cloud documents had last changed on 2026-09-28 and 2026-09-29, after the last sync record (`CLOUD_SYNC_2026-09-24.md`).

- **Pillars:** the same lines as the 2026-09-27.2 mirror. The cloud copy has the NC-IF-2026-09-27.1 section at the top; the mirror has it at the end.
- **Roadmap and Project memory:** forked. A cloud session working from the 2026-09-24 text added the following:
  - a checkpoint dated 2026-09-28;
  - Board, NC-IF-2026-09-27.1 and SC-2026-09-26.1 sections;
  - some rewording.

  The mirrors gained other material over the same days: the 2026-09-24 and 2026-09-25 checkpoints, harness and H-lane detail, and the Owner Surface item. Both copies were labelled 2026-09-27.2, and each carries a note saying not to overwrite the other.

## What was written

Replacing a whole body would have deleted the other side's material, so each cloud document got only the 2026-10-05.1 edits, made in place:

| Document | Edits |
|---|---|
| Pillars | Version line, the Technical contract sentence on bought credits, the free-account sentence, and amendment 2026-10-05.1 appended after 2026-09-27.2 |
| Roadmap | Version line, the bought-credits exception in the engine and provider checkpoint, and the credit paragraph (Model B, plan and no-plan prices, 12-month expiry, approved check-ins, plan-less business purchases) |
| Project memory | The same three edits as the Roadmap |

### Method

- **In-paragraph edits:** Docs' Find and replace dialog, opened from the Edit menu, with Match case on and regular expressions off. Each find string occurred once.
- **The Pillars amendment:** pasted after the document's last line.
- **Checking:** after every step, Google's plain-text export was normalised and hashed and compared with the expected text computed beforehand.
- **Three slips, all in the Pillars:** a search string meant for the find box was typed into the body, and two pastes landed in the wrong paragraph. Each was undone straight away, and the export hash confirmed the earlier text before the next step.

## Digests

Normalisation is the one used on 2026-09-24:
- byte-order mark removed;
- line endings made LF;
- trailing spaces trimmed;
- empty lines dropped.

Each digest is the first 16 hex characters of the SHA-256 of the normalised text. The file SHA-256 column hashes the mirror's bytes with LF line endings.

| Document | Cloud ID | Cloud before | Cloud after (verified) | Mirror (normalised) | Mirror file SHA-256 (LF bytes) |
|---|---|---|---|---|---|
| Core Pillars | `1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4` | `8dbcdf838000a96f` | `0102a6e7b78388a4` | `4ef861c5b6aa90b2` | `ffde9ea4d1eb7d5ff361eed2ab265840e258fd86704de240cee5a2ffd91f8f30` |
| Live roadmap | `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE` | `d99053e32dbce3b0` | `d2ec1b3a17cdb26d` | `500e0dc3709312f2` | `6ef8c0710b0bc6ba98ce6092aea3f83fbf09b6bf58a465be5d1c762e806d214d` |
| Project memory | `13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw` | `0fffc45f28aa244d` | `949392509cadf6ab` | `f326933c98e2fdd6` | `cd26030e0cb1a5dbc3beff27a39ba2f7807b704d9f0e7b65a30021af41c6e827` |

The cloud and mirror digests differ for the reasons in "What was found". After the edits, the normalised lines that are still on one side only are:

| Document | Cloud only | Mirror only |
|---|---|---|
| Pillars | 0 | 0 |
| Roadmap | 50 | 88 |
| Project memory | 35 | 64 |

## What remains

- **DIO-222:** a three-way reconcile of the Roadmap and Project memory from the 2026-09-24 base (app commit 269c651). It keeps every decision from both sides, then writes one text to both copies.
- **Mirrors:** these files carry 2026-10-05.1 on `feature/credit-pricing-docs`. Main carries them once that branch merges.
