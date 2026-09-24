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
   * the one recorded (another digest or kind). `missing`: the thread holds no artifact at that
   * place, because the turn no longer holds one there or the thread does not hold the turn.
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
 * Each recorded artifact beside what the thread's text holds at its place now, oldest first.
 * Every record is listed: one whose turn the thread does not hold reads as no longer in the
 * conversation rather than being passed over. (A record is written just before its answer is
 * added to the thread, so a read in that moment says so until the next read, which the new turn
 * itself causes.)
 */
export async function artifactEvidence(
  recorded: readonly RecordedArtifact[],
  index: ArtifactIndex,
  turns: readonly TurnLike[],
  digest: (text: string) => Promise<string> = sha256Hex,
): Promise<ArtifactEvidence[]> {
  const held = new Set(turns.map((turn) => turn.id).filter((id): id is string => !!id));
  return Promise.all(
    recorded.map(async (item): Promise<ArtifactEvidence> => {
      const record = held.has(item.turnId) ? (index.forBlock(item.turnId, item.blockIndex) ?? null) : null;
      if (!record) return { recorded: item, record: null, state: 'missing' };
      const same = record.kind === item.kind && (await digest(record.source)) === item.sha256;
      return { recorded: item, record, state: same ? 'recorded' : 'changed' };
    }),
  );
}

/**
 * The summary line's counts, each state counted and named on its own: "2 changed since recorded",
 * "1 no longer in the conversation". Empty when everything is as recorded.
 */
export function evidenceSummary(evidence: readonly ArtifactEvidence[]): string[] {
  const count = (state: EvidenceState) => evidence.filter((item) => item.state === state).length;
  const changed = count('changed');
  const missing = count('missing');
  return [
    ...(changed ? [`${changed} changed since recorded`] : []),
    ...(missing ? [`${missing} no longer in the conversation`] : []),
  ];
}

/**
 * What a recorded artifact is called in the list: the panel's own name for the artifact it opens,
 * so the two never disagree; else the title it recorded; else "Untitled". The server records only
 * an artifact's own title, never the number the panel gives an untitled one among its thread's.
 */
export function evidenceTitle(item: ArtifactEvidence): string {
  return item.record?.title ?? item.recorded.title ?? 'Untitled';
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
