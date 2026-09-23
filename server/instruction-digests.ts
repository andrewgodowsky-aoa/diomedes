/**
 * The conversation instruction texts a lineage may keep (owner decisions of 2026-09-23).
 *
 * A conversation lineage records the composed text it started with in its run's scope
 * (`run.input.instructions`). A later message is bound to that recorded text, so an open
 * conversation keeps its instructions and its memory across a release that changes them, only
 * when the text's SHA-256 is listed here as one a shipped build composed and is not revoked.
 * Anything else meets the scope check as before, and the lineage retires. Code, not the file on
 * disk, decides what may be sent: a recorded text reaches a model only when this build already
 * knows it byte for byte.
 *
 * Every digest is the SHA-256 of one text in `tests/fixtures/instruction-texts.json`, which holds
 * each build's own composer output, and `tests/instruction-digests.test.ts` fails when today's
 * composed text is missing. When a release changes a conversation mode's text, add the new
 * digest with its fixture and keep the old ones: an install may still hold lineages on them.
 * To make every lineage on a text retire, for a change that matters to safety, add its digest to
 * `REVOKED_INSTRUCTION_DIGESTS` rather than deleting it here.
 *
 * Build and Fix are not listed: they run no lineage.
 */
import { createHash } from 'node:crypto';

/** The lowercase hex SHA-256 of the text's UTF-8 bytes. */
export function instructionDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Digest to the builds and mode that composed it. */
export const KNOWN_INSTRUCTION_DIGESTS: ReadonlyMap<string, string> = new Map([
  ['f7db240c8969cedeb1f9951e488018e3e4023efc51606d2e2fe5de6fae473e68', 'Ask, v0.1.7'],
  ['c1e0bbd324381687a48c0bdf2d37e400d1036d593ce6fa09ba35308ca7c466ba', 'Plan, v0.1.7'],
  ['ab8ce0359b49036335dc749200482b2cd9f645e0daa08384690855473c9ac895', 'Automatic, v0.1.7 and 0.1.8'],
  ['78350c2f27c9f5c8da93eec26edd85f3bd85530a0ad090a106a68e2fcb0a4d9c', 'Ask, 0.1.8'],
  ['a84d062e38dcbbe25f45e736ee750bf86fb01f7f66ca394853af07e1eddacfd2', 'Plan, 0.1.8'],
]);

/**
 * Digest to why it was revoked. A lineage whose recorded text is revoked retires on its next
 * message and starts again under today's text. Empty: no note carries enforcement today. Launch
 * flags, the permission answers and the host's read checks enforce the read rules on every
 * route, and the notes only describe them.
 */
export const REVOKED_INSTRUCTION_DIGESTS: ReadonlyMap<string, string> = new Map();
