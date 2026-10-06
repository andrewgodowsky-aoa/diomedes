# Cloud canonical synchronisation, 2026-10-06

**State: the three canonical cloud documents carry Pillar 07 amendment 2026-10-06.1. The Pillars cloud document and its mirror hold the same lines, in a different order. The Roadmap and Project memory are still forked in other content (DIO-222).**

Andrew approved the Pillar 07 wording on 2026-10-06 at 04:21 EDT, and the cloud write at 05:37 EDT. The mirrors took the amendment in PR #240 (main `c02ddac`).

## What was found

Each cloud document was exported and hashed before writing, and compared with the digests recorded on 2026-10-05 (`CLOUD_SYNC_2026-10-05.md`).

- **Pillars:** unchanged since 2026-10-05.
- **Roadmap and Project memory:** another session edited both after 2026-10-05, for the owner-default tier contract that PR #236 implements. It added:
  - an "Owner-default contract 2026-10-06.1" paragraph in place of the Luna paragraph;
  - a change to the credit paragraph;
  - version 2026-10-06.1.

  These mirrors don't carry that work yet. They get it when #236 merges. The version 2026-10-06.1 in the Roadmap and Project memory covers both changes.

## What was written

Each edit was made in place:

| Document | Edits |
|---|---|
| Pillars | Version line, the amendment paragraph under Pillar 07's technical contract, and amendment 2026-10-06.1 appended after 2026-10-05.1 |
| Roadmap | The 2026-10-06.1 paragraph after the engine and provider checkpoint's paid-entitlement paragraph |
| Project memory | The same paragraph as the Roadmap |

The cloud's amendment entry says "synchronized 2026-10-06", and this change makes the Pillars mirror say the same. It drops the mirror's sentence that the mirror was ahead of the cloud.

### Method

- **The version line:** Docs' Find and replace dialog, opened from the Edit menu, with Match case on and regular expressions off. The find string occurred once.
- **New paragraphs mid-document:** the dialog's Next selected the sentence that ends the paragraph before. That match was unique. A paste then replaced it with itself plus the new paragraph.
- **The Pillars amendment:** pasted after the document's last line.
- **Checking:** after every step, Google's plain-text export was normalised and hashed and compared with the expected text computed beforehand. Every step matched the first time.

## Digests

Normalisation is the one used on 2026-09-24 and 2026-10-05:
- byte-order mark removed;
- line endings made LF;
- trailing spaces trimmed;
- empty lines dropped.

Each digest is the first 16 hex characters of the SHA-256 of the normalised text. The file SHA-256 column hashes the mirror's bytes with LF line endings, as of this change.

| Document | Cloud ID | Cloud after 2026-10-05 | Cloud before | Cloud after (verified) | Mirror (normalised) | Mirror file SHA-256 (LF bytes) |
|---|---|---|---|---|---|---|
| Core Pillars | `1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4` | `0102a6e7b78388a4` | `0102a6e7b78388a4` | `3fd88edc72bb759e` | `fdd7bd56b5d8c94c` | `1bd7214e10b4ad465556ebcee2d3d1d920077072a197887c606c5a4821dfd4ee` |
| Live roadmap | `1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE` | `d2ec1b3a17cdb26d` | `4048aa8c38f835ae` | `7c741e7910ac9f12` | `5765c1ebb34419b5` | `d81c30d8ea2ca2a198a0eeb6cb6a62de4e59c3fdd0dae3ecc1d430f749584fa2` |
| Project memory | `13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw` | `949392509cadf6ab` | `424d9b075137f9c4` | `4cfa129f8aa437f1` | `52e4ef6232eb185f` | `109b50dddbe9b43f492fc1fe2a4f2490afd9bbf6ef95aa62d1e76da7f255d0ce` |

After the edits, the normalised lines still on one side only:

| Document | Cloud only | Mirror only |
|---|---|---|
| Pillars | 0 | 0 |
| Roadmap | 52 | 90 |
| Project memory | 37 | 66 |

The Roadmap and Project memory each gained two lines on each side since 2026-10-05. On the cloud side they are #236's paragraph and its credit paragraph. On the mirror side they are the Luna paragraph and the earlier credit paragraph.

## What remains

- **DIO-222:** a three-way reconcile of the Roadmap and Project memory from the 2026-09-24 base (app commit 269c651). It should run after #236 merges, so the reconcile starts from the mirrors with the owner-default contract in them.
