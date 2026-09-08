import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Need, ProjectState, Session } from '../shared/types.js';
import { ApiError } from './paths.js';

// Shared by two proven command families. The adapters still own payload schemas,
// authorization, persistence and dispatch; this is not a generic workflow engine.
export const commandIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Callers construct fixed-property canonical payloads, with explicit defaults. */
export const payloadDigest = (payload: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;

export function usesCommandProtocol(body: Record<string, unknown>, family: 'work' | 'approval') {
  if (!Object.hasOwn(body, 'protocolVersion') && !Object.hasOwn(body, 'commandId')) return false;
  if (body.protocolVersion !== 1)
    throw new ApiError(409, `This ${family} command version is unsupported.`, {
      code: `unsupported_${family}_protocol`,
      supportedVersions: [1],
    });
  return true;
}

type CommandRecord =
  | { type: 'work.start'; subject: Session; digest: string }
  | { type: 'approval.decide'; subject: Need; digest: string };

/** One project-scoped namespace: a key cannot be reused by another adapter. */
export function findCommand(state: ProjectState, commandId: string): CommandRecord | undefined {
  const session = state.sessions.find((item) => item.receipt?.commandId === commandId);
  if (session?.receipt)
    return { type: 'work.start', subject: session, digest: session.receipt.payloadDigest };
  const need = state.needs.find((item) => item.approvalReceipt?.commandId === commandId);
  if (need?.approvalReceipt)
    return { type: 'approval.decide', subject: need, digest: need.approvalReceipt.payloadDigest };
}
export function assertReplay(
  record: CommandRecord | undefined,
  type: CommandRecord['type'],
  digest?: string,
) {
  if (record && (record.type !== type || (digest !== undefined && record.digest !== digest)))
    throw new ApiError(409, 'This command already names a different request.', {
      code: type === 'work.start' ? 'work_command_conflict' : 'approval_command_conflict',
    });
}
