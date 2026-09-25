/**
 * The Console's start of a Diomedes loop run: H13's versioned start command
 * (`POST /api/projects/:id/loop/start`), built from the dialog's fields. The
 * server admits or refuses it; nothing here decides which route may run.
 */

export interface LoopStartCommand {
  protocolVersion: 1;
  commandId: string;
  taskId: string;
  goal: string;
  route: string;
  sources: string[];
  consent?: true;
  maxTurns?: number;
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
}): LoopStartCommand {
  return {
    protocolVersion: 1,
    commandId: input.commandId,
    taskId: input.taskId,
    goal: input.goal.trim(),
    route: input.route,
    sources: [...input.sources],
    ...(input.consent ? { consent: true as const } : {}),
    ...(input.maxTurns !== null ? { maxTurns: input.maxTurns } : {}),
  };
}

export const newLoopCommandId = () =>
  `console-loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
