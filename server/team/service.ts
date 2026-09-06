// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
import { randomBytes } from 'node:crypto';
import type {
  Conversation,
  MailboxMessage,
  Slot,
  TeamMember,
  TeamState,
} from '../../shared/types.js';
import { ApiError } from '../paths.js';
import { identifier, now, type Store } from '../store.js';
import { migrateTeam } from '../store.js';
import {
  acknowledge,
  deliverMessage,
  hasPendingShutdown,
  peekForSlot,
} from './mailbox.js';
import {
  checkCompletionAllowed,
  engineLabel,
  memberAttribution,
  progressSentence,
  putSentence,
  teamStatusToTaskState,
  toTeamTask,
  validateBlockedBy,
  type TeamTaskStatus,
} from './board.js';

const engines: TeamMember['engine'][] = [
  'codex',
  'claude-code',
  'opencode',
  'oh-my-pi',
  'sample',
  'probe',
];
const roles: TeamMember['role'][] = ['lead', 'member'];
const statuses: TeamMember['status'][] = ['idle', 'working', 'waiting', 'stopped', 'error'];

function asName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120)
    throw new ApiError(400, `Provide ${field} of up to 120 characters.`);
  return value.trim();
}

function requireLead(member: TeamMember, tool: string): void {
  if (member.role !== 'lead')
    throw new ApiError(403, `Only the lead can use ${tool}.`);
}

function findMember(team: TeamState, slotId: Slot): TeamMember {
  const member = team.members.find((m) => m.slotId === slotId);
  if (!member) throw new ApiError(404, 'This team member was not found.');
  return member;
}

export class TeamService {
  constructor(private store: Store) {}

  teamState(projectId: string): TeamState {
    return migrateTeam(this.store.state(projectId));
  }

  async authenticate(projectId: string, slotId: string | null, token: string | null): Promise<TeamMember> {
    if (!slotId || !token) throw new ApiError(401, 'Provide a member token and slot.');
    if (slotId === 'owner') throw new ApiError(401, 'The owner slot cannot call the team server.');
    const team = this.teamState(projectId);
    const member = team.members.find((m) => m.slotId === slotId);
    if (!member) throw new ApiError(401, 'This member token was not recognized.');
    const secrets = await this.store.readTeamSecrets(projectId);
    const expected = secrets[slotId];
    if (!expected || expected !== token)
      throw new ApiError(401, 'This member token was not recognized.');
    return member;
  }

  async createMember(
    projectId: string,
    input: { name: unknown; role: unknown; engine: unknown; model?: unknown; threadId?: unknown },
  ): Promise<{ member: TeamMember; token: string }> {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const name = asName(input.name, 'a member name');
    if (!roles.includes(input.role as TeamMember['role']))
      throw new ApiError(400, 'Choose a valid member role.');
    if (!engines.includes(input.engine as TeamMember['engine']))
      throw new ApiError(400, 'Choose a valid engine.');
    const role = input.role as TeamMember['role'];
    const engine = input.engine as TeamMember['engine'];
    let model: string | null = null;
    if (input.model !== undefined && input.model !== null) {
      if (typeof input.model !== 'string' || input.model.length > 200)
        throw new ApiError(400, 'Provide a model of up to 200 characters.');
      model = input.model;
    }
    let threadId: string | null = null;
    if (input.threadId !== undefined && input.threadId !== null) {
      if (typeof input.threadId !== 'string' || !input.threadId.trim())
        throw new ApiError(400, 'Provide a valid thread.');
      const conversation = state.conversations.find((c) => c.id === input.threadId);
      if (!conversation) throw new ApiError(404, 'This thread was not found.');
      threadId = conversation.id;
    }
    const stamped = now();
    const slotId = identifier('S');
    if (!threadId) {
      const conversation: Conversation = {
        id: identifier('C'),
        attachedTo: { kind: 'project', ref: projectId },
        turns: [],
        name: `Thread with ${name}`,
        createdAt: stamped,
        updatedAt: stamped,
        taskId: null,
        helper: { engine, model },
      };
      state.conversations.push(conversation);
      threadId = conversation.id;
    }
    const member: TeamMember = {
      slotId,
      name,
      role,
      engine,
      model,
      status: 'idle',
      threadId,
      createdAt: stamped,
      lastSeenAt: null,
    };
    team.members.push(member);
    const token = randomBytes(32).toString('hex');
    const secrets = await this.store.readTeamSecrets(projectId);
    secrets[slotId] = token;
    await this.store.writeTeamSecrets(projectId, secrets);
    await this.store.persist(state);
    return { member: structuredClone(member), token };
  }

  async stopMember(projectId: string, slotId: Slot): Promise<TeamMember> {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const member = findMember(team, slotId);
    member.status = 'stopped';
    await this.store.persist(state);
    return structuredClone(member);
  }

  async ownerSendMessage(projectId: string, to: Slot, content: string): Promise<MailboxMessage> {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    if (typeof content !== 'string' || !content.trim() || content.length > 16000)
      throw new ApiError(400, 'Provide message content of up to 16,000 characters.');
    let threadId: string | null = null;
    if (to !== 'owner') {
      const recipient = findMember(team, to);
      threadId = recipient.threadId;
    }
    const message = deliverMessage(team.messages, {
      to,
      from: 'owner',
      type: 'message',
      content,
      threadId,
      runId: null,
      approvalId: null,
    });
    await this.store.persist(state);
    return structuredClone(message);
  }

  async sendAsMember(
    projectId: string,
    sender: TeamMember,
    args: { to: unknown; message: unknown; files?: unknown; summary?: unknown },
  ): Promise<MailboxMessage> {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, sender.slotId);
    const to = args.to;
    if (typeof to !== 'string' || !to.trim()) throw new ApiError(400, 'Provide a recipient slot.');
    if (to !== 'owner') findMember(team, to);
    const content = args.message;
    if (typeof content !== 'string' || !content.trim() || (content as string).length > 16000)
      throw new ApiError(400, 'Provide message content of up to 16,000 characters.');
    let files: string[] | undefined;
    if (args.files !== undefined) {
      if (!Array.isArray(args.files) || args.files.some((f) => typeof f !== 'string'))
        throw new ApiError(400, 'Provide files as a list of paths.');
      files = [...(args.files as string[])];
    }
    let summary: string | undefined;
    if (args.summary !== undefined) {
      if (typeof args.summary !== 'string')
        throw new ApiError(400, 'Provide a summary as text.');
      summary = args.summary;
    }
    const pendingShutdown = hasPendingShutdown(team.messages, live.slotId);
    const message = deliverMessage(team.messages, {
      to,
      from: live.slotId,
      type: 'message',
      content: content as string,
      summary,
      files,
      threadId: live.threadId,
      runId: null,
      approvalId: null,
    });
    live.lastSeenAt = now();
    if (
      pendingShutdown &&
      (summary === 'shutdown_approved' || (content as string) === 'shutdown_approved')
    ) {
      live.status = 'stopped';
    }
    await this.store.persist(state);
    return structuredClone(message);
  }

  async readAsMember(
    projectId: string,
    reader: TeamMember,
    sinceMessageId?: string,
  ): Promise<MailboxMessage[]> {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, reader.slotId);
    if (sinceMessageId !== undefined && typeof sinceMessageId !== 'string')
      throw new ApiError(400, 'Provide a valid message id.');
    const found = peekForSlot(team.messages, live.slotId, sinceMessageId);
    acknowledge(
      team.messages,
      found.map((m) => m.id),
    );
    live.lastSeenAt = now();
    await this.store.persist(state);
    return structuredClone(found);
  }

  async taskCreateAsMember(
    projectId: string,
    creator: TeamMember,
    args: {
      subject: unknown;
      description?: unknown;
      owner?: unknown;
      blocked_by?: unknown;
      idempotency_key?: unknown;
    },
  ) {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, creator.slotId);
    const meta = this.store.teamMeta(projectId);
    if (args.idempotency_key !== undefined && args.idempotency_key !== null) {
      if (typeof args.idempotency_key !== 'string' || !args.idempotency_key.trim())
        throw new ApiError(400, 'Provide a valid idempotency key.');
      const existingId = meta.idempotency[args.idempotency_key as string];
      if (existingId) {
        const existing = state.tasks.find((t) => t.id === existingId);
        if (existing) return toTeamTask(existing, meta.blockedBy);
      }
    }
    const subject = asName(args.subject, 'a task subject').slice(0, 200);
    let description = '';
    if (args.description !== undefined && args.description !== null) {
      if (typeof args.description !== 'string' || args.description.length > 10000)
        throw new ApiError(400, 'Provide a description of up to 10,000 characters.');
      description = args.description;
    }
    let assignedTo: Slot = live.slotId;
    if (args.owner !== undefined && args.owner !== null) {
      if (typeof args.owner !== 'string' || !args.owner.trim())
        throw new ApiError(400, 'Provide a valid owner slot.');
      const ownerSlot = args.owner as string;
      if (ownerSlot !== 'owner') findMember(team, ownerSlot);
      assignedTo = ownerSlot;
    }
    const blocked = validateBlockedBy(state.tasks, args.blocked_by as string[] | undefined);
    const task = this.store.createTask(state, {
      name: subject,
      description,
      owner: 'diomedes-with-ok',
    });
    task.createdBy = 'diomedes';
    task.assignedTo = assignedTo;
    meta.blockedBy[task.id] = blocked;
    if (typeof args.idempotency_key === 'string' && args.idempotency_key.trim())
      meta.idempotency[args.idempotency_key] = task.id;
    this.store.addEntry(state, {
      kind: 'tasks-made',
      sentence: putSentence(live, subject),
      actor: 'diomedes',
      taskId: task.id,
    });
    await this.store.persist(state);
    return toTeamTask(task, meta.blockedBy);
  }

  async taskUpdateAsMember(
    projectId: string,
    updater: TeamMember,
    args: {
      task_id: unknown;
      status?: unknown;
      description?: unknown;
      owner?: unknown;
      blocked_by?: unknown;
    },
  ) {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, updater.slotId);
    const meta = this.store.teamMeta(projectId);
    if (typeof args.task_id !== 'string' || !args.task_id.trim())
      throw new ApiError(400, 'Provide a task id.');
    const task = state.tasks.find((t) => t.id === args.task_id);
    if (!task) throw new ApiError(404, 'This task was not found.');
    let changed = false;
    let statusChange: TeamTaskStatus | null = null;
    if (args.description !== undefined && args.description !== null) {
      if (typeof args.description !== 'string' || args.description.length > 10000)
        throw new ApiError(400, 'Provide a description of up to 10,000 characters.');
      if (task.description !== args.description) {
        task.description = args.description;
        changed = true;
      }
    }
    if (args.owner !== undefined && args.owner !== null) {
      if (typeof args.owner !== 'string' || !args.owner.trim())
        throw new ApiError(400, 'Provide a valid owner slot.');
      const ownerSlot = args.owner as string;
      if (ownerSlot !== 'owner') findMember(team, ownerSlot);
      if (task.assignedTo !== ownerSlot) {
        task.assignedTo = ownerSlot;
        changed = true;
      }
    }
    if (args.blocked_by !== undefined && args.blocked_by !== null) {
      const blocked = validateBlockedBy(state.tasks, args.blocked_by as string[] | undefined);
      meta.blockedBy[task.id] = blocked;
      changed = true;
    }
    if (args.status !== undefined && args.status !== null) {
      const status = args.status as TeamTaskStatus;
      if (!['pending', 'in_progress', 'completed', 'deleted'].includes(status))
        throw new ApiError(400, 'Choose a valid task status.');
      statusChange = status;
      if (status === 'deleted') {
        if (!task.deletedAt) {
          task.deletedAt = now();
          changed = true;
        }
      } else {
        const target = teamStatusToTaskState(status);
        if (status === 'completed') {
          checkCompletionAllowed(state, task.id, task.name);
        }
        if (task.state !== target) {
          const previous = task.state;
          task.state = target;
          task.moves.push({
            at: now(),
            by: 'diomedes',
            from: previous,
            to: target,
            undoUntil: new Date(Date.now() + 3600000).toISOString(),
            undone: false,
          });
          changed = true;
        }
        if (task.deletedAt) {
          task.deletedAt = null;
          changed = true;
        }
      }
    }
    if (changed) {
      const sentence = statusChange
        ? progressSentence(live, task.name, statusChange)
        : `${memberAttribution(live)} updated '${task.name}' on the board`;
      this.store.addEntry(state, {
        kind: statusChange === 'deleted' ? 'tasks-made' : 'task-moved',
        sentence,
        actor: 'diomedes',
        taskId: task.id,
      });
      await this.store.persist(state);
    }
    return toTeamTask(task, meta.blockedBy);
  }

  async taskListAsMember(
    projectId: string,
    _reader: TeamMember,
    args: { owner?: unknown; status?: unknown; include_deleted?: unknown; limit?: unknown },
  ) {
    const state = this.store.state(projectId);
    const meta = this.store.teamMeta(projectId);
    let tasks = [...state.tasks];
    const includeDeleted = args.include_deleted === true;
    if (!includeDeleted) tasks = tasks.filter((t) => !t.deletedAt);
    if (args.owner !== undefined && args.owner !== null) {
      if (typeof args.owner !== 'string') throw new ApiError(400, 'Provide a valid owner slot.');
      tasks = tasks.filter((t) => (t.assignedTo ?? null) === args.owner);
    }
    if (args.status !== undefined && args.status !== null) {
      const wanted = Array.isArray(args.status) ? args.status : [args.status];
      for (const s of wanted) {
        if (typeof s !== 'string' || !['pending', 'in_progress', 'completed', 'deleted'].includes(s))
          throw new ApiError(400, 'Choose a valid task status.');
      }
      const wantedSet = new Set(wanted as string[]);
      tasks = tasks.filter((t) => wantedSet.has(toTeamTask(t, meta.blockedBy).status));
    }
    if (args.limit !== undefined && args.limit !== null) {
      if (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 0)
        throw new ApiError(400, 'Provide a valid limit.');
      tasks = tasks.slice(0, args.limit);
    }
    return tasks.map((t) => toTeamTask(t, meta.blockedBy));
  }

  async renameAsLead(projectId: string, caller: TeamMember, slotId: Slot, newName: string) {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, caller.slotId);
    requireLead(live, 'team_rename_agent');
    const target = findMember(team, slotId);
    target.name = asName(newName, 'a member name');
    await this.store.persist(state);
    return structuredClone(target);
  }

  async interruptAsLead(
    projectId: string,
    caller: TeamMember,
    slotId: Slot,
    message: string,
    _reason?: string,
  ): Promise<MailboxMessage> {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, caller.slotId);
    requireLead(live, 'team_interrupt_agent');
    const target = findMember(team, slotId);
    if (typeof message !== 'string' || !message.trim() || message.length > 16000)
      throw new ApiError(400, 'Provide message content of up to 16,000 characters.');
    const reason = typeof _reason === 'string' ? _reason : undefined;
    const outgoing = deliverMessage(team.messages, {
      to: target.slotId,
      from: live.slotId,
      type: 'message',
      content: message,
      summary: `interrupt:true${reason ? ` reason:${reason}` : ''}`,
      threadId: live.threadId,
      runId: null,
      approvalId: null,
    });
    await this.store.persist(state);
    return structuredClone(outgoing);
  }

  async shutdownAsLead(projectId: string, caller: TeamMember, slotId: Slot, reason?: string) {
    const state = this.store.state(projectId);
    const team = migrateTeam(state);
    const live = findMember(team, caller.slotId);
    requireLead(live, 'team_shutdown_agent');
    const target = findMember(team, slotId);
    const outgoing = deliverMessage(team.messages, {
      to: target.slotId,
      from: live.slotId,
      type: 'shutdown_request',
      content: typeof reason === 'string' && reason.trim() ? reason : 'Shutdown requested',
      threadId: live.threadId,
      runId: null,
      approvalId: null,
    });
    if (target.status === 'idle') target.status = 'stopped';
    await this.store.persist(state);
    return { message: structuredClone(outgoing), member: structuredClone(target) };
  }

  engineLabelFor(member: TeamMember): string {
    return engineLabel(member.engine);
  }
}
