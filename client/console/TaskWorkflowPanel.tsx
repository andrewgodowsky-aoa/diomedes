import { useEffect, useRef, useState } from 'react';
import type { Conversation, Task } from '../../shared/types';
import { childBlocker, workflowOf } from '../../shared/task-workflow';
import { api } from '../api';

interface SkillOption {
  packId: string;
  skillId: string;
  name: string;
  packName: string;
  value: string;
}

const PHASE_NAMES = { plan: 'Plan', build: 'Build', review: 'Review' } as const;

/** Task continuation is separate from the existing grant for files and services. */
export function TaskWorkflowPanel({ projectId, task, tasks, busy, onOpenTask, onOpenOrigin, onReview }: {
  projectId: string;
  task: Task;
  tasks: readonly Task[];
  busy: boolean;
  onOpenTask(task: Task): void;
  onOpenOrigin?(): void;
  onReview?(): void;
}) {
  const workflow = workflowOf(task);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [output, setOutput] = useState('');
  const [source, setSource] = useState<{ name: string; text: string } | null>(null);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const inFlight = useRef(false);
  const childCommand = useRef<string | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`;
  const disabled = busy || saving;
  const selectedSkill = workflow.skill ? `${workflow.skill.packId}/${workflow.skill.skillId}` : 'none';
  const selectedKnown = selectedSkill === 'none' || skills.some((item) => `${item.packId}/${item.skillId}` === selectedSkill);

  useEffect(() => {
    let cancelled = false;
    api<{ skills: SkillOption[] }>(`${base}/skills`)
      .then((result) => { if (!cancelled) setSkills(result.skills ?? []); })
      .catch((error) => {
        if (!cancelled) {
          setSkills([]);
          setIssue(error instanceof Error ? error.message : 'The project playbooks could not be read.');
        }
      });
    return () => { cancelled = true; };
  }, [base]);
  const parent = tasks.find((item) => item.id === workflow.parentTaskId);
  const children = tasks.filter((item) => item.workflow?.parentTaskId === task.id && !item.deletedAt);
  const cannotBranch = childBlocker(tasks, task);
  const next = workflow.phase === 'plan' ? 'build' : workflow.phase === 'build' ? 'review' : null;

  async function openOrigin() {
    if (onOpenOrigin) { onOpenOrigin(); return; }
    if (!task.origin) return;
    setIssue('');
    try {
      const result = await api<{ threads: Conversation[] }>(`/projects/${encodeURIComponent(task.origin.projectId)}/threads`);
      const thread = result.threads.find((item) => item.id === task.origin!.threadId);
      const turn = thread?.turns.find((item) => item.id === task.origin!.turnId);
      if (!thread || !turn) throw new Error('The source conversation or message is no longer available.');
      setSource({ name: thread.name ?? 'Source conversation', text: turn.text });
    } catch (error) {
      setIssue(error instanceof Error ? error.message : 'The source conversation could not be read.');
    }
  }

  async function change(path: string, method: 'PUT' | 'POST', body: unknown, after?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setIssue('');
    try {
      await api(`${base}/${path}`, method, body);
      after?.();
    } catch (error) {
      setIssue(error instanceof Error ? error.message : 'The task could not be changed.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <section className="ti-workflow" aria-label="Task permissions and phases">
    <h3>Task permission</h3>
    <label>
      Continue through phases
      <select aria-label="Task permission" value={task.workflow ? workflow.continuation : ''} disabled={disabled}
        onChange={(event) => void change('workflow', 'PUT', {
          expectedRevision: workflow.revision, continuation: event.target.value,
        })}>
        <option value="" disabled>Choose a task permission</option>
        <option value="stop-on-phase-change">Stop on phase change</option>
        <option value="full-approval">Full approval</option>
      </select>
    </label>
    <p className="ti-quiet">{!task.workflow
      ? 'Choose how the Nectovia work loop continues through this task.'
      : workflow.continuation === 'full-approval'
      ? 'The agent may continue through this task within its granted scope and limits.'
      : 'The agent must wait for your approval before starting the next phase.'}</p>
    <p className="ti-quiet">File access, service consent and spending limits still apply.</p>
    <label>
      Maximum action turns
      <input aria-label="Maximum action turns" type="number" min={1} max={16}
        key={`${task.id}-${workflow.revision}`} defaultValue={workflow.maxTurns} disabled={disabled}
        onBlur={(event) => {
          const value = Number(event.target.value);
          if (value !== workflow.maxTurns) void change('workflow', 'PUT', {
            expectedRevision: workflow.revision, maxTurns: value,
          });
        }} />
    </label>
    <p className="ti-quiet">The work loop makes one planning call before these action turns.</p>
    <label>
      Playbook (optional)
      <select aria-label="Playbook (optional)" value={selectedSkill} disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'none') {
            void change('workflow', 'PUT', { expectedRevision: workflow.revision, skill: null });
            return;
          }
          const found = skills.find((item) => `${item.packId}/${item.skillId}` === value);
          if (!found) return;
          void change('workflow', 'PUT', {
            expectedRevision: workflow.revision, skill: { packId: found.packId, skillId: found.skillId },
          });
        }}>
        <option value="none">None</option>
        {!selectedKnown && workflow.skill && <option value={selectedSkill}>{workflow.skill.skillId}</option>}
        {skills.map((item) => <option key={`${item.packId}/${item.skillId}`} value={`${item.packId}/${item.skillId}`}>
          {item.name} · {item.packName}
        </option>)}
      </select>
    </label>
    <p className="ti-quiet">Optional guidance for how the work is done. It grants nothing.</p>
    <h3>Phase: {PHASE_NAMES[workflow.phase]}</h3>
    {workflow.inbox ? <button type="button" className="verb light" disabled={disabled}
      onClick={() => void change('accept', 'POST', { expectedRevision: workflow.revision })}>
      Accept task
    </button> : workflow.pendingPhase ? <div role="status">
      <p>Approval needed to continue to {PHASE_NAMES[workflow.pendingPhase]}.</p>
      <button type="button" className="verb light" disabled={saving || (busy && !onReview)}
        onClick={() => busy && onReview ? onReview() : void change('approve-phase', 'POST', { expectedRevision: workflow.revision })}>
        {busy ? 'Review phase approval' : 'Approve next phase'}
      </button>
    </div> : next ? <button type="button" className="verb" disabled={disabled}
      onClick={() => void change('handoff', 'POST', {
        expectedRevision: workflow.revision, phase: next, reason: 'Phase handoff requested from the task view.',
      })}>Continue to {PHASE_NAMES[next]}</button> : null}
    {task.origin && <button type="button" className="verb" onClick={() => void openOrigin()}>Open source conversation</button>}
    {source && <aside aria-label="Source conversation"><h3>{source.name}</h3><p className="ti-objective">{source.text}</p>
      <button type="button" className="verb" onClick={() => setSource(null)}>Close source</button></aside>}
    {parent && <p>Part of <button type="button" className="verb" onClick={() => onOpenTask(parent)}>{parent.name}</button></p>}
    {children.length > 0 && <><h3>Separate tasks</h3><ul>{children.map((child) =>
      <li key={child.id}><button type="button" className="verb" onClick={() => onOpenTask(child)}>{child.name}</button>
        {child.workflow?.output && <small>{child.workflow.output}</small>}
      </li>)}</ul></>}
    {cannotBranch && <p className="ti-quiet">{cannotBranch}</p>}
    {!adding ? <button type="button" className="verb" disabled={disabled || !!cannotBranch}
      onClick={() => setAdding(true)}>Add a separate task</button> : <form onSubmit={(event) => {
        event.preventDefault();
        childCommand.current ??= `child.${crypto.randomUUID()}`;
        void change('children', 'POST', {
          commandId: childCommand.current, name, description: '', output,
        }, () => { setAdding(false); setName(''); setOutput(''); childCommand.current = null; });
      }}>
      <label>Task name<input required disabled={disabled} maxLength={200} value={name} onChange={(event) => { setName(event.target.value); childCommand.current = null; }} /></label>
      <label>Separate result<input required disabled={disabled} maxLength={1000} value={output} onChange={(event) => { setOutput(event.target.value); childCommand.current = null; }} /></label>
      <p className="ti-quiet">The new task waits in Inbox and inherits this task's continuation and turn limit.</p>
      <button type="submit" className="verb light" disabled={disabled || !!cannotBranch}>Create task</button>
      <button type="button" className="verb" disabled={saving} onClick={() => setAdding(false)}>Cancel</button>
    </form>}
    {issue && <p className="ti-issue" role="alert">{issue}</p>}
  </section>;
}
