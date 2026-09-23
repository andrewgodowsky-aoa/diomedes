import { useEffect, useRef, useState } from 'react';
import type { ArtifactIndex, ArtifactRecord, TurnLike } from './artifacts';
import {
  artifactEvidence,
  EVIDENCE_WORDS,
  type ArtifactEvidence,
  type RecordedArtifact,
} from './artifact-evidence';
import { KIND_LABEL, type ArtifactKind } from './turn-blocks';
import './recorded-artifacts.css';

/** Where a conversation's recorded artifacts are read from, and when to read them again. */
export interface RecordedSource {
  /** Changes whenever what was recorded may have: the thread, its lineages or its turns. */
  key: string;
  read(signal: AbortSignal): Promise<readonly RecordedArtifact[]>;
}

const kindLabel = (kind: string) => KIND_LABEL[kind as ArtifactKind] ?? kind;

/**
 * The artifacts this conversation's runs recorded (artifact-evidence.ts), read-only, under the
 * artifact panel's head. Each one opens from the thread's own text, the only thing the panel
 * draws; one whose text no longer matches its record says "Changed since recorded", and the
 * count of those stays in the summary line while the list is folded. Nothing shows until
 * something was recorded, and nothing is read until an artifact is open.
 */
export function RecordedArtifacts({
  source,
  index,
  turns,
  current,
  onOpen,
}: {
  source: RecordedSource;
  /** The conversation's own artifacts, read from its turns. */
  index: ArtifactIndex;
  turns: readonly TurnLike[];
  /** The key of the artifact the panel is showing. */
  current: string | null;
  onOpen(record: ArtifactRecord): void;
}) {
  const read = useRef(source.read);
  read.current = source.read;
  const [recorded, setRecorded] = useState<readonly RecordedArtifact[] | null>(null);
  const [evidence, setEvidence] = useState<readonly ArtifactEvidence[]>([]);
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    read.current(controller.signal).then(
      (list) => {
        setRecorded(list);
        setTrouble(null);
      },
      () => {
        if (!controller.signal.aborted) setTrouble('What this conversation recorded could not be read.');
      },
    );
    return () => controller.abort();
  }, [source.key]);

  useEffect(() => {
    if (!recorded) return;
    let live = true;
    artifactEvidence(recorded, index, turns).then(
      (next) => {
        if (live) setEvidence(next);
      },
      () => {
        // Nothing unchecked is ever shown as matching.
        if (!live) return;
        setEvidence([]);
        setTrouble('The recorded artifacts could not be checked against the conversation.');
      },
    );
    return () => {
      live = false;
    };
  }, [recorded, index, turns]);

  if (trouble) return <p className="art-recorded-note">{trouble}</p>;
  if (evidence.length === 0) return null;
  const off = evidence.filter((item) => item.state !== 'recorded').length;
  return (
    <details className="art-recorded">
      <summary>
        Recorded in this conversation <span className="art-recorded-count">{evidence.length}</span>
        {off > 0 && <b>{off} changed since recorded</b>}
      </summary>
      <ul>
        {evidence.map((item) => {
          const { recorded: entry, record, state } = item;
          const label = (
            <>
              <span className="art-recorded-kind">{kindLabel(entry.kind)}</span>
              <span className="art-recorded-title">{entry.title}</span>
            </>
          );
          return (
            <li key={`${entry.sourceMessageId}:${entry.blockIndex}`} className={state}>
              {record ? (
                <button
                  type="button"
                  aria-current={record.key === current || undefined}
                  onClick={() => onOpen(record)}
                >
                  {label}
                </button>
              ) : (
                <span className="art-recorded-gone">{label}</span>
              )}
              <span className="art-recorded-state">{EVIDENCE_WORDS[state]}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
