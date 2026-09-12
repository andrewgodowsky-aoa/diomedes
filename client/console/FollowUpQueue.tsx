import { useState } from 'react';
import type { Route, Task } from '../../shared/types';
import {
  followUpWaitLabel,
  MAX_FOLLOW_UPS_PER_TASK,
  type FollowUpCommand,
  type FollowUpWaitsFor,
} from '../../shared/work-control';
import { editFollowUp, queueFollowUp, removeFollowUp, reorderFollowUps } from '../api';
import { mintCommandId } from '../work-start';

interface FollowUpQueueProps {
  projectId: string;
  task: Task;
  route: Route;
  followUps: FollowUpCommand[];
  busy?: boolean;
}

const OUTCOME: Record<Exclude<FollowUpCommand['state'], 'queued'>, string> = {
  delivered: 'Sent',
  cancelled: 'Cancelled',
  rejected: 'Not sent',
};

function why(item: FollowUpCommand): string | null {
  if (item.state === 'rejected') return item.rejectedReason ?? null;
  if (item.state === 'cancelled')
    return item.cancelledBy && item.cancelledBy !== 'you'
      ? `Cancelled by Stop (${item.cancelledBy.slice('stop:'.length)}).`
      : null;
  return null;
}

/**
 * The queue under the composer. A follow-up is a command the person writes now
 * and Diomedes sends later, so it says when it will run, keeps its place, and
 * shows what became of it. It is not a way to speak into a running turn: the
 * run in progress never sees it.
 */
export function FollowUpQueue({ projectId, task, route, followUps, busy }: FollowUpQueueProps) {
  const [text, setText] = useState('');
  const [waitsFor, setWaitsFor] = useState<FollowUpWaitsFor>('turn');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const mine = followUps.filter((item) => item.taskId === task.id);
  const queued = mine
    .filter((item) => item.state === 'queued')
    .sort((a, b) => a.order - b.order || a.queuedAt.localeCompare(b.queuedAt));
  const settled = mine
    .filter((item) => item.state !== 'queued')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const full = queued.length >= MAX_FOLLOW_UPS_PER_TASK;

  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That could not be done.');
    } finally {
      setWorking(false);
    }
  }
  const move = (index: number, to: number) => {
    const order = queued.map((item) => item.id);
    const [held] = order.splice(index, 1);
    order.splice(to, 0, held);
    return run(() => reorderFollowUps(projectId, { taskId: task.id, order }));
  };
  const disabled = busy || working;

  return (
    <section className="follow-ups" aria-label="Follow-ups">
      <div className="follow-up-compose">
        <textarea
          value={text}
          rows={2}
          maxLength={16000}
          disabled={disabled || full}
          placeholder="Queue a follow-up"
          aria-label="Queue a follow-up"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="row">
          <div className="seg" role="radiogroup" aria-label="When this follow-up runs">
            {(['turn', 'task'] as FollowUpWaitsFor[]).map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={waitsFor === choice}
                className={waitsFor === choice ? 'on' : ''}
                disabled={disabled}
                onClick={() => setWaitsFor(choice)}
              >
                {followUpWaitLabel(choice)}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button
            type="button"
            disabled={disabled || full || !text.trim()}
            onClick={() =>
              void run(async () => {
                await queueFollowUp(projectId, {
                  protocolVersion: 1,
                  commandId: mintCommandId(),
                  taskId: task.id,
                  text: text.trim(),
                  waitsFor,
                  route,
                  model: null,
                  agentId: null,
                  sources: [],
                });
                setText('');
              })
            }
          >
            Queue a follow-up
          </button>
        </div>
        {full && (
          <p className="caption">
            This task holds {MAX_FOLLOW_UPS_PER_TASK} queued follow-ups. Send or remove one first.
          </p>
        )}
      </div>
      {queued.map((item, index) => (
        <div className="follow-up row" key={item.id}>
          {editing?.id === item.id ? (
            <>
              <input
                className="follow-up-text"
                value={editing.text}
                maxLength={16000}
                aria-label="Follow-up text"
                onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
              />
              <button
                type="button"
                disabled={disabled || !editing.text.trim()}
                onClick={() =>
                  void run(async () => {
                    await editFollowUp(projectId, item.id, { text: editing.text.trim() });
                    setEditing(null);
                  })
                }
              >
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="follow-up-text" title={item.text}>
                {item.text}
              </span>
              <span className="lc follow-up-when">{followUpWaitLabel(item.waitsFor)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setEditing({ id: item.id, text: item.text })}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={disabled || index === 0}
                aria-label="Move earlier"
                onClick={() => void move(index, index - 1)}
              >
                Up
              </button>
              <button
                type="button"
                disabled={disabled || index === queued.length - 1}
                aria-label="Move later"
                onClick={() => void move(index, index + 1)}
              >
                Down
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void run(() => removeFollowUp(projectId, item.id))}
              >
                Remove
              </button>
            </>
          )}
        </div>
      ))}
      {settled.map((item) => (
        <div className="follow-up settled row" key={item.id}>
          <span className="follow-up-text" title={item.text}>
            {item.text}
          </span>
          <span className="lc follow-up-when">
            {OUTCOME[item.state as Exclude<FollowUpCommand['state'], 'queued'>]}
            {why(item) ? ` · ${why(item)}` : ''}
          </span>
        </div>
      ))}
      {error && <p className="caption follow-up-error">{error}</p>}
    </section>
  );
}
