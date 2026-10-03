/**
 * The Console's start of a Diomedes loop run: H13's versioned start command
 * (`POST /api/projects/:id/loop/start`), built from the dialog's fields. The
 * server admits or refuses it; nothing here decides which route may run.
 */
import type { AgentTeamSelection } from '../../shared/agent-collaboration';
import type { AgentReviewSelection } from '../../shared/agent-review';

/** The fixed review is selected by saved connection, never by editable questions. */
export const LOOP_REVIEW_PROFILE: AgentReviewSelection['profileId'] = 'agent.inventory-reconciliation';

export interface LoopHelperSelection {
  scope: string[];
  worker: { profileId: string };
  advisor: null;
}

interface CollaborationOffer {
  name: string;
  model: string | null;
  admitted: boolean;
  reason: string | null;
}

export interface LoopCollaborationOptions {
  leads: (CollaborationOffer & { slotId: string; route: string })[];
  members: (CollaborationOffer & { slotId: string; route: string })[];
  helpers: (CollaborationOffer & { profileId: string; route: string })[];
  reviews: (CollaborationOffer & { profileId: string; connectionId: string })[];
  reason?: string | null;
}

export interface LoopStartCommand {
  protocolVersion: 1;
  commandId: string;
  taskId: string;
  goal: string;
  route: string;
  sources: string[];
  consent?: true;
  maxTurns?: number;
  composition?: true;
  persistentTeam?: AgentTeamSelection;
  team?: LoopHelperSelection;
  review?: AgentReviewSelection;
}

/** The goal a loop starts with unless the person changes it: the task's statement, else its name. */
export function defaultLoopGoal(task: { name: string; description?: string | null }): string {
  return task.description?.trim() || task.name.trim();
}

/**
 * One start, as one command. The command id is made once per dialog, so a
 * second click, or a resend after a lost answer, names the same run and
 * admits nothing new. Turns are left out unless the person set them, so H13's
 * own default applies.
 */
export function loopStartCommand(input: {
  commandId: string;
  taskId: string;
  goal: string;
  route: string;
  sources: readonly string[];
  consent: boolean;
  maxTurns: number | null;
  persistentTeam?: AgentTeamSelection | null;
  team?: LoopHelperSelection | null;
  review?: AgentReviewSelection | null;
}): LoopStartCommand {
  if (input.review && input.review.profileId !== LOOP_REVIEW_PROFILE)
    throw new Error('Only the inventory reconciliation review is available here.');
  return {
    protocolVersion: 1,
    commandId: input.commandId,
    taskId: input.taskId,
    goal: input.goal.trim(),
    route: input.route,
    sources: [...input.sources],
    ...(input.consent ? { consent: true as const } : {}),
    ...(input.maxTurns !== null ? { maxTurns: input.maxTurns } : {}),
    ...(input.persistentTeam || input.team || input.review ? { composition: true as const } : {}),
    ...(input.persistentTeam ? {
      persistentTeam: {
        leadSlotId: input.persistentTeam.leadSlotId,
        memberSlotId: input.persistentTeam.memberSlotId,
      },
    } : {}),
    ...(input.team ? {
      team: {
        scope: [...input.team.scope],
        worker: { profileId: input.team.worker.profileId },
        advisor: null,
      },
    } : {}),
    ...(input.review ? {
      review: { profileId: LOOP_REVIEW_PROFILE, connectionId: input.review.connectionId },
    } : {}),
  };
}

export const LOOP_START_CHANGED_CHOICES =
  'The previous start may have been received. Retry with the same choices, or reopen this dialog to change them.';

/** A lost answer can only resend the exact command; edited choices need a new dialog. */
export function retainLoopStartCommand(
  submitted: LoopStartCommand | null,
  next: LoopStartCommand,
): LoopStartCommand {
  if (!submitted) return next;
  if (JSON.stringify(submitted) !== JSON.stringify(next))
    throw new Error(LOOP_START_CHANGED_CHOICES);
  return submitted;
}

export const newLoopCommandId = () =>
  `console-loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
