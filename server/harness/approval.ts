import { z } from 'zod';
import type { ApprovalIdentity, Need } from '../../shared/types.js';
import type { StepIntent } from '../../shared/harness.js';
import type { WriteInput } from '../store.js';
import { relativeName } from '../paths.js';
import { digest } from './policy.js';
import { payloadDigest } from '../command-admission.js';

export const FIXTURE_ENGINE = 'native-fixture';
export const CODEX_ENGINE = 'codex-harness';
export const REPORT_PATH = 'Harness report.md';
export const writeInputSchema = z.strictObject({
  projectId: z.string().min(1).max(100),
  runId: z.string().regex(/^R[a-f0-9]{12}$/),
  files: z.tuple([z.literal(REPORT_PATH)]),
  expected: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  text: z
    .string()
    .max(128000)
    .refine((value) => !value.includes('\0')),
});

/** The Need carries the reviewed intent; the run file remains execution authority. */
export function harnessWrites(projectId: string, need: Need): WriteInput[] {
  const binding = need.harness;
  if (!binding || !need.approval || digest(binding.intent) !== need.approval.actionDigest)
    throw new Error('The harness approval no longer matches its step intent.');
  const intent: StepIntent = binding.intent;
  if (
    intent.name !== 'propose_write' ||
    intent.kind !== 'tool' ||
    intent.effect !== 'idempotent' ||
    intent.permission !== 'write-project-file' ||
    !intent.approval ||
    intent.destination !== 'local'
  )
    throw new Error('This harness approval is not a recorded local write.');
  const input = writeInputSchema.parse(intent.input);
  if (
    input.projectId !== projectId ||
    input.runId !== binding.runId ||
    digest(need.files) !== digest(input.files) ||
    need.preview?.length !== 0
  )
    throw new Error('The harness approval has inconsistent files or scope.');
  return [{ path: relativeName(input.files[0]), expected: input.expected, text: input.text }];
}

export function identifyHarnessApproval(
  projectId: string, need: Need, sources: ApprovalIdentity['sources'] = need.approval?.sources ?? [],
): ApprovalIdentity {
  if (!need.harness) throw new Error('A harness intent binding is required.');
  const actionDigest = digest(need.harness.intent);
  const expiresAt = new Date(Date.parse(need.createdAt) + 60 * 60 * 1000).toISOString();
  const baseDigest = payloadDigest({
    type: 'harness-write-base',
    expected: writeInputSchema.parse(need.harness.intent.input).expected,
    ...(sources.length ? { sources } : {}),
  });
  return {
    protocolVersion: 1,
    actionDigest,
    baseDigest,
    expiresAt,
    sources,
    proposalDigest: payloadDigest({
      type: 'harness-step-proposal',
      protocolVersion: 1,
      projectId,
      approvalId: need.id,
      taskId: need.taskId,
      sessionId: need.sessionId,
      createdAt: need.createdAt,
      expiresAt,
      actionDigest,
      baseDigest,
      binding: need.harness,
      what: need.what,
      why: need.why,
      consequence: need.consequence,
      files: need.files,
      preview: need.preview,
    }),
  };
}
