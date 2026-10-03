import { useEffect, useMemo, useState } from 'react';
import { MANUAL_HANDOFF_LIMITS, type ManualHandoff } from '../../shared/manual-handoff';
import type { DocumentInfo, Slot, Task, TeamMember } from '../../shared/types';
import { api, listDocuments } from '../api';
import './handoff.css';

/**
 * A manual hand-off (S1, plan section 4.10): the person says what came of one card's work
 * and hands it to the next card's member. Opened from a Team member's lane and from a card on
 * the Board. The changed files are picked from the project's own documents, and the next
 * card's start begins with them; its send dialog still names the engine and the documents.
 */
export function HandoffForm({
  projectId,
  tasks,
  members,
  fromTaskId,
  fromSlot,
  onDone,
  onCancel,
}: {
  projectId: string;
  tasks: readonly Task[];
  members: readonly TeamMember[];
  /** The card handing off, when the form opens from it. */
  fromTaskId?: string;
  /** The member handing off, when the form opens from their lane. */
  fromSlot?: Slot;
  onDone(record: ManualHandoff): void;
  onCancel(): void;
}) {
  const current = (slot: Slot | null | undefined) =>
    members.find((member) => member.slotId === slot && member.status !== 'stopped');
  const named = (slot: Slot | null | undefined) => members.find((member) => member.slotId === slot);
  const live = tasks.filter((task) => !task.deletedAt && task.state !== 'done');
  const sources = live.filter(
    (task) =>
      named(task.assignedTo) &&
      (fromTaskId ? task.id === fromTaskId : fromSlot ? task.assignedTo === fromSlot : true),
  );
  const [from, setFrom] = useState(fromTaskId ?? sources[0]?.id ?? '');
  const targets = live.filter((task) => task.id !== from && current(task.assignedTo) && !task.ownedAssignment);
  const [to, setTo] = useState(targets[0]?.id ?? '');
  useEffect(() => {
    if (!targets.some((task) => task.id === to)) setTo(targets[0]?.id ?? '');
  }, [from, targets.map((task) => task.id).join('|')]);
  const [outcome, setOutcome] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [checks, setChecks] = useState('');
  const [issues, setIssues] = useState('');
  const [documents, setDocuments] = useState<DocumentInfo[] | null>(null);
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    listDocuments(projectId, control.signal).then(
      (listed) => setDocuments(listed.documents.filter((document) => document.kind !== 'unsupported')),
      () => {
        if (!control.signal.aborted) setDocuments([]);
      },
    );
    return () => control.abort();
  }, [projectId]);
  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const fromTask = live.find((task) => task.id === from);
  const toTask = targets.find((task) => task.id === to);
  const full = files.length >= MANUAL_HANDOFF_LIMITS.changedFiles;
  const ready = !!fromTask && !!toTask && !!outcome.trim() && !sending;
  const names = useMemo(() => new Map(members.map((member) => [member.slotId, member.name])), [members]);
  const cardLabel = (task: Task) => `${task.name} · ${names.get(task.assignedTo ?? '') ?? ''}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || !fromTask || !toTask) return;
    setSending(true);
    setProblem('');
    try {
      const record = await api<ManualHandoff>(`/projects/${encodeURIComponent(projectId)}/handoffs`, 'POST', {
        fromTaskId: fromTask.id,
        toTaskId: toTask.id,
        fromSlot: fromTask.assignedTo,
        toSlot: toTask.assignedTo,
        outcome: outcome.trim(),
        changedFiles: files,
        checks: lines(checks),
        openIssues: lines(issues),
      });
      onDone(record);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The hand-off was not saved.');
    } finally {
      setSending(false);
    }
  }

  if (sources.length === 0 || targets.length === 0)
    return (
      <div className="handoff-form" role="group" aria-label="Hand off">
        <p className="caption">
          {sources.length === 0
            ? 'Assign a card to a Team member first.'
            : 'Assign the next card to a Team member first.'}
        </p>
        <div className="handoff-actions">
          <button type="button" onClick={onCancel}>
            Not now
          </button>
        </div>
      </div>
    );

  return (
    <form className="handoff-form" aria-label="Hand off" onSubmit={(event) => void submit(event)}>
      <label>
        <span>From</span>
        <select value={from} disabled={!!fromTaskId} onChange={(event) => setFrom(event.target.value)}>
          {sources.map((task) => (
            <option key={task.id} value={task.id}>
              {cardLabel(task)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>To</span>
        <select value={to} onChange={(event) => setTo(event.target.value)}>
          {targets.map((task) => (
            <option key={task.id} value={task.id}>
              {cardLabel(task)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>What came of it</span>
        <textarea
          rows={3}
          maxLength={MANUAL_HANDOFF_LIMITS.outcome}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Changed files</legend>
        {documents === null ? (
          <p className="caption">Reading the project's files.</p>
        ) : documents.length === 0 ? (
          <p className="caption">This project has no text documents to pick.</p>
        ) : (
          <div className="handoff-files">
            {documents.map((document) => {
              const picked = files.includes(document.path);
              return (
                <label key={document.path} className="handoff-file">
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={!picked && full}
                    onChange={() =>
                      setFiles((list) => (picked ? list.filter((item) => item !== document.path) : [...list, document.path]))
                    }
                  />
                  <span title={document.path}>{document.path}</span>
                </label>
              );
            })}
          </div>
        )}
        {full && <p className="caption">That's the most one hand-off names: {MANUAL_HANDOFF_LIMITS.changedFiles} files.</p>}
      </fieldset>
      <label>
        <span>Checks, one per line</span>
        <textarea rows={2} value={checks} onChange={(event) => setChecks(event.target.value)} />
      </label>
      <label>
        <span>Open issues, one per line</span>
        <textarea rows={2} value={issues} onChange={(event) => setIssues(event.target.value)} />
      </label>
      {problem && (
        <p className="issue" role="alert">
          {problem}
        </p>
      )}
      <div className="handoff-actions">
        <button type="submit" className="go" disabled={!ready}>
          Hand off
        </button>
        <button type="button" onClick={onCancel}>
          Not now
        </button>
      </div>
    </form>
  );
}

/** A hand-off as the next card shows it: who handed it over, what came of it, and the rest. */
export function HandoffNote({ record, members }: { record: ManualHandoff; members: readonly TeamMember[] }) {
  const giver = members.find((member) => member.slotId === record.fromSlot)?.name ?? 'A Team member';
  return (
    <details className="handoff-note" data-handoff-id={record.id}>
      <summary>Hand-off from {giver}</summary>
      <p className="handoff-outcome">{record.outcome}</p>
      {record.changedFiles.length > 0 && (
        <p>
          <span className="handoff-k">Changed files</span> {record.changedFiles.join(', ')}
        </p>
      )}
      {record.checks.length > 0 && (
        <p>
          <span className="handoff-k">Checks</span> {record.checks.join('; ')}
        </p>
      )}
      {record.openIssues.length > 0 && (
        <p>
          <span className="handoff-k">Open issues</span> {record.openIssues.join('; ')}
        </p>
      )}
    </details>
  );
}
