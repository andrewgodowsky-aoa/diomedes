import { z } from 'zod';

export const AUTOMATIC_WORK_POLICY = 'automatic-work-v1' as const;

/** Host evidence of the original request. It grants no file, service or spend authority. */
export const automaticWorkRequestSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('explicit-request'),
  policyRevision: z.literal(AUTOMATIC_WORK_POLICY),
  sourceProjectId: z.string().min(1).max(100),
  threadId: z.string().min(1).max(100),
  commandId: z.string().min(1).max(120),
  sourceMessageId: z.string().regex(/^sm\.[0-9a-f]{32}$/),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  goal: z.string().min(1).max(10_000),
  sources: z.array(z.strictObject({path:z.string().min(1).max(400),sha:z.string().regex(/^[a-f0-9]{64}$/)})).max(32),
  targetProjectId: z.string().min(1).max(100),
  operationCeiling: z.literal('write_internal'),
  /** Host resolved before the first provider send; grants no execution authority. */
  executionPin: z.strictObject({
    route:z.string().min(1).max(40),model:z.string().min(1).max(200).nullable(),
    accountRoute:z.string().min(1).max(400).nullable(),effort:z.string().min(1).max(80).nullable(),
    profile:z.strictObject({id:z.string().min(1).max(120),revision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).nullable(),
  }).optional(),
});
export type AutomaticWorkRequest = z.infer<typeof automaticWorkRequestSchema>;

export interface AutomaticWorkBinding {
  readonly request: AutomaticWorkRequest;
  /** Owned runtime root. Null until the existing Work admission binds it. */
  readonly rootRunId: string | null;
  readonly rootJobId: string | null;
  readonly admissionRef: string;
  readonly policyRevision: typeof AUTOMATIC_WORK_POLICY;
  readonly teamDecision?: import('./automatic-team.js').AutomaticTeamDecision;
}

/** A projection cursor and notes from the existing Harness events; never an execution state. */
export interface TaskRuntimeProgress {
  runId: string;
  lastSeq: number;
}
export interface TaskProgressEvidence {
  readonly runId: string;
  readonly seq: number;
  readonly stepId: string | null;
  readonly phase: 'plan' | 'build' | 'review';
  readonly status: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'waiting';
  readonly certainty: 'confirmed' | 'unknown';
  readonly retry: 'continue' | 'new-root-required' | 'reconcile-first' | 'approval-required';
  readonly error: string | null;
  readonly model: {requested:string|null;reported:string|null;source:'runtime'|'not-recorded'};
}
