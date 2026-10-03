import type { HarnessRun, HarnessEvent } from '../../shared/harness.js';
import type { ProjectState, Task, Session } from '../../shared/types.js';
import type { TaskProgressEvidence } from '../../shared/automatic-work.js';
import { verificationOf } from '../../shared/verification.js';
import { workflowOf } from '../../shared/task-workflow.js';
import type { Store } from '../store.js';
import { applicationOrigin } from '../../shared/attribution.js';
import { isOwnedTeamRun } from '../../shared/agent-collaboration.js';

const important = new Set(['run.created','run.started','run.completed','run.failed','run.cancelled',
  'step.succeeded','step.failed','step.retry_wait','step.uncertain','step.reconcile_required','step.waiting_approval','step.waiting_event','run.reconcile_required','run.waiting']);

function statusOf(event:HarnessEvent,run:HarnessRun):TaskProgressEvidence['status'] {
  if (event.type.includes('cancel')) return 'cancelled';
  if (event.type.includes('reconcile') || event.type.includes('uncertain')) return 'uncertain';
  if (event.type.includes('fail') || event.type.includes('retry_wait')) return 'failed';
  if (event.type.includes('waiting') || event.type.includes('approval')) return 'waiting';
  if (event.type.endsWith('succeeded') || event.type.endsWith('completed')) return 'succeeded';
  return run.state === 'reconcile_required' ? 'uncertain' : 'started';
}

/** Called by the existing bridge inside its Store lock and persisted with its mirror cursor. */
export function projectBoardProgress(input:{store:Pick<Store,'addEntry'>;state:ProjectState;task:Task;session:Session;run:HarnessRun;redact:(text:string)=>string}):void {
  const {store,state,task,session,run,redact} = input;
  if (!task.automaticWork || task.automaticWork.rootRunId !== run.id || run.taskId !== task.id || run.projectId !== state.project.id
    || run.sessionId !== session.id || session.taskId !== task.id) return;
  const cursor = task.runtimeProgress?.runId === run.id ? task.runtimeProgress.lastSeq : 0;
  const ownedUnknown = state.team?.runs.some(child=>isOwnedTeamRun(child) && child.rootRunId === run.id
    && child.rootTaskId === task.id && child.grant.projectId === state.project.id && child.unknownOutcome) ?? false;
  // Stop/recovery can settle the child after the root's terminal event was mirrored.
  // Upgrade that same derived note monotonically, without creating another event or cursor.
  if (ownedUnknown && ['cancelled','failed','completed','reconcile_required'].includes(run.state)) {
    for (const entry of state.history) {
      const progress = entry.progress;
      if (!progress || progress.runId !== run.id || progress.seq > cursor || progress.stepId !== null
        || progress.certainty === 'unknown' || !run.events.some(event=>event.seq === progress.seq
          && ['run.cancelled','run.failed','run.completed','run.reconcile_required'].includes(event.type))) continue;
      entry.progress = {...progress,certainty:'unknown',retry:'reconcile-first'};
      entry.sentence = redact(entry.sentence + ' A root-owned Team response has an unknown outcome. Reconcile it before continuing.');
    }
  }
  const lastPhase = [...state.history].reverse().find(entry=>entry.progress?.runId === run.id && entry.progress.seq <= cursor)?.progress?.phase;
  let phase = lastPhase ?? 'plan';
  for (const event of run.events.filter(item=>item.seq > cursor && important.has(item.type))) {
    if (state.history.some(entry=>entry.progress?.runId === run.id && entry.progress.seq === event.seq)) continue;
    const step = event.stepId ? run.steps.find(item=>item.intent.stepId === event.stepId) : null;
    const status = statusOf(event,run);
    if (event.type === 'step.succeeded' && step?.intent.stepId.startsWith('task-phase:')) {
      const next=(step.intent.input as {phase?:unknown}|null)?.phase;
      if (next === 'build' || next === 'review') phase=next;
    } else if (event.stepId === 'plan' || event.stepId === 'model:plan') phase='plan';
    else if (!run.steps.some(item=>item.intent.stepId.startsWith('task-phase:'))) phase=workflowOf(task).phase;
    const error = typeof event.attributes.error === 'string' ? event.attributes.error
      : typeof event.attributes.message === 'string' ? event.attributes.message
      : status === 'failed' ? step?.error?.message ?? run.failure?.message
        ?? (typeof event.attributes.errorType === 'string' ? event.attributes.errorType : 'The step failed.') : null;
    const model = step?.origin?.model ?? {requested:null,reported:null,source:'not-recorded' as const};
    const unresolved = status === 'uncertain' || (event.type.startsWith('run.') && run.steps.some(item=>item.state === 'reconcile_required'
      || item.effects?.some(effect=>effect.status === 'uncertain')))
      || (ownedUnknown && ['run.cancelled','run.failed','run.completed','run.reconcile_required'].includes(event.type));
    const retrySafe = event.type === 'step.retry_wait';
    const evidence:TaskProgressEvidence = {runId:run.id,seq:event.seq,stepId:event.stepId ?? null,phase,status,
      certainty:unresolved ? 'unknown' : 'confirmed',
      retry:unresolved ? 'reconcile-first' : status === 'waiting' ? 'approval-required'
        : (status === 'failed' && !retrySafe) || status === 'cancelled' ? 'new-root-required' : 'continue',
      error:error ? redact(error).slice(0,1000) : null,model:{...model}};
    const label = phase[0]!.toUpperCase()+phase.slice(1);
    const detail = event.stepId ? ` (${event.stepId})` : '';
    const sentence = status === 'failed' ? `${label}${detail} failed: ${evidence.error}`
      : status === 'uncertain' ? `${label}${detail} has an unknown outcome. Reconcile it before continuing.`
      : status === 'cancelled' ? `${label}${detail} stopped.${unresolved ? ' An effect has an unknown outcome; reconcile it before starting again.' : ''}`
      : status === 'waiting' ? `${label}${detail} waits for approval or a response.`
      : event.type === 'run.completed' ? `${label} execution completed. Its output remains in Review until verification passes.`
      : status === 'succeeded' ? `${label}${detail} succeeded.` : `${label} started.`;
    const entry = store.addEntry(state as Parameters<Store['addEntry']>[0],{kind:'task-progress',actor:'diomedes',taskId:task.id,sessionId:session.id,
      origin:step?.origin ?? applicationOrigin(),sentence:redact(sentence)});
    entry.time = event.at;
    entry.progress = evidence;
  }
  task.runtimeProgress = {runId:run.id,lastSeq:run.lastSeq};
  if (run.state === 'completed') {
    const open = state.needs.some(need=>need.taskId === task.id && (need.state === 'open' || need.execution?.state === 'pending'));
    const verified = verificationOf({session,task,history:state.history}).state === 'verified';
    if (ownedUnknown || open || !verified) {
      task.state = 'waiting';
      task.reason = ownedUnknown ? 'went-wrong' : open ? 'needs-ok' : 'changes-ready';
    }
  }
}
