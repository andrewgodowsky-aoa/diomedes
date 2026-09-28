import { z } from 'zod';
import type { StepIntent } from './harness.js';

/** Pure approval identity shared by persistence, presentation and the runtime. */
export const TASK_PHASE_INTENT_NAME = 'continue_task_phase' as const;
export const TASK_PHASE_VERSION = 'v1' as const;
export const TASK_PHASES = ['build', 'review'] as const;
export type TaskPhaseGate = (typeof TASK_PHASES)[number];

export const taskPhaseInputSchema = z.strictObject({
  projectId: z.string().min(1).max(100),
  runId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  phase: z.enum(['build', 'review']),
});
export type TaskPhaseInput = z.infer<typeof taskPhaseInputSchema>;
export const taskPhaseStepId = (phase: TaskPhaseGate): string => `task-phase:${phase}`;

export function isTaskPhaseIntent(intent: Pick<StepIntent, 'kind' | 'effect' | 'destination' | 'name' | 'permission' | 'input'>): boolean {
  return intent.name === TASK_PHASE_INTENT_NAME && intent.kind === 'transform' &&
    intent.effect === 'pure' && intent.destination === 'local' && intent.permission === null &&
    taskPhaseInputSchema.safeParse(intent.input).success;
}

export const taskPhaseOutputSchema = z.strictObject({
  v: z.literal(1),
  phase: z.enum(['build', 'review']),
  advanced: z.boolean(),
});
