// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
import type { Task, TaskState, TeamMember } from '../../shared/types.js';
import { ApiError } from '../paths.js';

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export function engineLabel(engine: TeamMember['engine']): string {
  switch (engine) {
    case 'codex':
      return 'Codex';
    case 'claude-code':
      return 'Claude Code';
    case 'opencode':
      return 'OpenCode';
    case 'oh-my-pi':
      return 'oh-my-pi';
    case 'sample':
      return 'Sample';
    case 'probe':
      return 'Probe';
    default:
      return String(engine);
  }
}

export function memberAttribution(member: TeamMember): string {
  return `${member.name} (${engineLabel(member.engine)})`;
}

export function putSentence(member: TeamMember, subject: string): string {
  return `${memberAttribution(member)} put '${subject}' on the board`;
}

export function progressSentence(member: TeamMember, subject: string, status: TeamTaskStatus): string {
  if (status === 'completed') return `${memberAttribution(member)} marked '${subject}' done`;
  if (status === 'in_progress') return `${memberAttribution(member)} marked '${subject}' in progress`;
  if (status === 'deleted') return `${memberAttribution(member)} removed '${subject}' from the board`;
  return `${memberAttribution(member)} moved '${subject}' back to todo`;
}

export function teamStatusToTaskState(status: Exclude<TeamTaskStatus, 'deleted'>): TaskState {
  if (status === 'pending') return 'todo';
  if (status === 'in_progress') return 'working';
  return 'done';
}

export function taskStateToTeamStatus(task: Task): { status: TeamTaskStatus; waiting_for?: string } {
  if (task.deletedAt) return { status: 'deleted' };
  if (task.state === 'todo') return { status: 'pending' };
  if (task.state === 'working') return { status: 'in_progress' };
  if (task.state === 'waiting') return { status: 'in_progress', waiting_for: 'owner' };
  return { status: 'completed' };
}

export interface TeamTaskView {
  id: string;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  owner: string | null;
  blocked_by: string[];
  waiting_for?: string;
  deletedAt?: string | null;
}

export function toTeamTask(
  task: Task,
  blockedBy: Record<string, string[]>,
): TeamTaskView {
  const mapped = taskStateToTeamStatus(task);
  const view: TeamTaskView = {
    id: task.id,
    subject: task.name,
    description: task.description,
    status: mapped.status,
    owner: task.assignedTo ?? null,
    blocked_by: blockedBy[task.id] ?? [],
  };
  if (mapped.waiting_for) view.waiting_for = mapped.waiting_for;
  if (task.deletedAt) view.deletedAt = task.deletedAt;
  return view;
}

export function validateBlockedBy(tasks: Task[], blockedBy: string[] | undefined): string[] {
  if (!blockedBy) return [];
  if (!Array.isArray(blockedBy)) throw new ApiError(400, 'Provide blocked_by as a list of task ids.');
  for (const id of blockedBy) {
    if (typeof id !== 'string' || !id.trim()) throw new ApiError(400, 'Provide valid blocked_by task ids.');
    if (!tasks.some((t) => t.id === id))
      throw new ApiError(400, `A blocked_by task was not found: ${id}.`);
  }
  return [...blockedBy];
}

export function checkCompletionAllowed(state: {
  needs: { taskId: string; state: string; id: string }[];
  changes: { taskId: string | null; state: string; id: string }[];
}, taskId: string, subject: string): void {
  const openNeed = state.needs.find((n) => n.taskId === taskId && n.state === 'open');
  if (openNeed)
    throw new ApiError(
      409,
      `Cannot complete '${subject}': an open Need (${openNeed.id}) is waiting for the owner.`,
    );
  const waitingChange = state.changes.find((c) => c.taskId === taskId && c.state === 'waiting');
  if (waitingChange)
    throw new ApiError(
      409,
      `Cannot complete '${subject}': a waiting Change (${waitingChange.id}) needs review.`,
    );
}
