import { useEffect, useState } from 'react';
import type { ChangeSetEntryView, ChangeSetView } from '../../shared/sandbox';
import type { TextDiff } from '../../shared/text-diff';
import { displayName } from '../attribution-display';
import { api } from '../api';
import { mintCommandId } from '../work-start';
import { DiffView } from './DiffView';
import './change-set.css';

/**
 * The change set a sandboxed delegate or worker returned (shared/sandbox.ts),
 * inside its row of the loop inspector or the Team view. Each entry says what
 * became of it once; one that waits for you offers P06's readable diff with
 * Keep and Discard, and Keep selected when some of its parts are ticked.
 * Machine strings wrap where they are written (decision 5).
 */

const STATE_WORD: Record<ChangeSetEntryView['state'], string> = {
  applied: 'applied, in Review',
  kept: 'kept by you',
  discarded: 'discarded',
  conflict: 'not applied: changed since',
  waiting: 'waits for you',
  pending: 'waits for you',
};
const OP_WORD = { created: 'new', modified: 'changed', deleted: 'deleted' } as const;

function Entry({
  projectId,
  changeSet,
  entry,
  onDecided,
}: {
  projectId: string;
  changeSet: ChangeSetView;
  entry: ChangeSetEntryView;
  onDecided: (next: ChangeSetView) => void;
}) {
  const open = entry.state === 'waiting' || entry.state === 'pending';
  const [diff, setDiff] = useState<TextDiff | null>(null);
  const [shown, setShown] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}/change-sets/${encodeURIComponent(changeSet.id)}`;
  const show = async () => {
    if (shown) {
      setShown(false);
      return;
    }
    setShown(true);
    if (diff) return;
    try {
      setDiff((await api<{ diff: TextDiff }>(`${base}/entries/${entry.index}/diff`)).diff);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : 'The change could not be read.');
    }
  };
  const decide = async (decision: 'keep' | 'discard', hunks?: number[]) => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api<{ changeSet: ChangeSetView }>(`${base}/decide`, 'POST', {
        protocolVersion: 1,
        commandId: mintCommandId(),
        decisions: [{ index: entry.index, decision, ...(hunks ? { hunks } : {}) }],
      });
      onDecided(answer.changeSet);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : 'That could not be done.');
    } finally {
      setBusy(false);
    }
  };
  const partial = Boolean(open && diff?.selectable && kept.size > 0 && kept.size < diff.hunks.length);
  return (
    <li className="cs-entry" data-entry={entry.index} data-state={entry.state}>
      <span className="cs-head">
        <span className="cs-path loop-code">{entry.path}</span>
        <span className="cs-op">{OP_WORD[entry.op]}</span>
        <span className="loop-turn-state cs-state">{STATE_WORD[entry.state]}</span>
      </span>
      {entry.state !== 'applied' && entry.decision?.reason && <span className="loop-obs-detail cs-reason">{entry.decision.reason}</span>}
      <span className="cs-actions">
        <button type="button" onClick={() => void show()} aria-expanded={shown}>
          {shown ? 'Hide changes' : 'Show changes'}
        </button>
        {open && (
          <>
            <button type="button" disabled={busy} onClick={() => void decide('keep', partial ? [...kept] : undefined)}>
              {partial ? 'Keep selected' : 'Keep'}
            </button>
            <button type="button" disabled={busy} onClick={() => void decide('discard')}>
              Discard
            </button>
          </>
        )}
      </span>
      {shown && diff && (
        <DiffView
          diff={diff}
          selection={
            open && diff.selectable
              ? {
                  kept,
                  disabled: busy,
                  onToggle: (index) =>
                    setKept((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    }),
                }
              : undefined
          }
        />
      )}
      {problem && <span role="alert" className="loop-obs-detail">{problem}</span>}
    </li>
  );
}

export function ChangeSetReview({ projectId, changeSet }: { projectId: string; changeSet: ChangeSetView }) {
  const [view, setView] = useState(changeSet);
  // A fresh read of the loop replaces what this row last decided.
  useEffect(() => setView(changeSet), [changeSet]);
  if (!view.entries.length && !view.dropped.length)
    return <p className="loop-obs-detail cs-none">It changed nothing in its copy.</p>;
  const writer = view.models.map((model) => displayName(model.reported)).filter(Boolean)[0] ?? null;
  return (
    <section className="cs-review" data-change-set={view.id} aria-label="Changes it returned">
      <span className="caption cs-title">
        Changes it returned{writer ? <span className="loop-code"> · written by {writer}</span> : null}
      </span>
      <ol className="cs-entries">
        {view.entries.map((entry) => (
          <Entry key={entry.index} projectId={projectId} changeSet={view} entry={entry} onDecided={setView} />
        ))}
      </ol>
      {view.dropped.map((item) => (
        <span key={item.path} className="loop-obs-detail cs-dropped">
          <span className="loop-code">{item.path}</span> was not returned: {item.reason}
        </span>
      ))}
    </section>
  );
}
