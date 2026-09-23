// Recorded artifacts, read back as evidence (artifacts v2, frozen item 5; draft (c), read path).
// When a conversation message's answer holds artifacts, its run records one index-only step per
// artifact: where it is, its kind and title, and the SHA-256 of its source, never the source
// (shared/recorded-artifact.ts). This module reads those steps back through the run read the
// Console already uses and sets each beside what the thread's text holds at that place now. The
// text stays the only thing the panel draws and opens; a step that no longer matches it is said
// to be "changed since recorded", never passed over. Nothing here writes, and nothing is new on
// the server.

import { api, ApiError } from '../api';
import type { HarnessRun } from '../../shared/harness';
import { recordedArtifactsOf, type RecordedArtifact } from '../../shared/recorded-artifact';
import type { ArtifactIndex, ArtifactRecord, TurnLike } from './artifacts';

export type { RecordedArtifact };

export type EvidenceState = 'recorded' | 'changed' | 'missing';

export interface ArtifactEvidence {
  recorded: RecordedArtifact;
  /** The artifact as the thread's text holds it now, which the panel opens; null when there is none. */
  record: ArtifactRecord | null;
  /**
   * `recorded`: the text at that place is what was recorded. `changed`: it is an artifact, but not
   * the one recorded (another digest or kind). `missing`: the turn is there, and holds no artifact
   * at that place.
   */
  state: EvidenceState;
}

/** What each state says in the panel. */
export const EVIDENCE_WORDS: Record<EvidenceState, string> = {
  recorded: 'As recorded',
  changed: 'Changed since recorded',
  missing: 'No longer in the conversation',
};

/** The lowercase hex SHA-256 of a text's UTF-8 bytes, as the server records it. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Each recorded artifact beside what the thread's text holds at its place now, oldest first. A
 * record whose turn the thread does not show yet (its answer is still being projected) is left out
 * until it does, so a late projection never reads as a change.
 */
export async function artifactEvidence(
  recorded: readonly RecordedArtifact[],
  index: ArtifactIndex,
  turns: readonly TurnLike[],
  digest: (text: string) => Promise<string> = sha256Hex,
): Promise<ArtifactEvidence[]> {
  const shown = new Set(turns.map((turn) => turn.id).filter((id): id is string => !!id));
  const listed = recorded.filter((item) => shown.has(item.turnId));
  return Promise.all(
    listed.map(async (item): Promise<ArtifactEvidence> => {
      const record = index.forBlock(item.turnId, item.blockIndex) ?? null;
      if (!record) return { recorded: item, record: null, state: 'missing' };
      const same = record.kind === item.kind && (await digest(record.source)) === item.sha256;
      return { recorded: item, record, state: same ? 'recorded' : 'changed' };
    }),
  );
}

/**
 * The artifacts a conversation's runs recorded, in lineage order, through the existing run read
 * (`GET /projects/:id/harness/runs/:runId`). A run that is not there reads as nothing recorded;
 * any other failure is the caller's to show.
 */
export async function readRecordedArtifacts(
  projectId: string,
  runIds: readonly string[],
  signal?: AbortSignal,
): Promise<RecordedArtifact[]> {
  const runs = await Promise.all(
    runIds.map((runId) =>
      api<HarnessRun>(
        `/projects/${encodeURIComponent(projectId)}/harness/runs/${encodeURIComponent(runId)}`,
        'GET',
        undefined,
        signal,
      ).then(recordedArtifactsOf, (error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }),
    ),
  );
  return runs.flat();
}
