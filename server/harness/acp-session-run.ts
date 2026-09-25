/**
 * The kept ACP conversation profiles (H05): Cursor and Devin on the shared
 * native conversation driver (`ClaudeSessionRuns` in claude-session-run.ts), so
 * turn records, replay by command id and startup recovery are the same code as
 * for Claude and OpenCode. What differs is declared here: the capability a run
 * is started under, the one ACP checkpoint schema its session id is saved in,
 * that no message is steered into a running turn, and how a restart reconciles
 * a turn that was running (`recoverAcpCheckpoint`).
 */
import type { CapabilityManifest, NativeCheckpoint } from '../../shared/harness.js';
import {
  acpCheckpointSchema,
  recoverAcpCheckpoint,
  type AcpSessionCheckpoint,
  type AcpSessionEngine,
} from '../engines/acp-session.js';
import type { NativeSessionProfile } from './claude-session-run.js';
import { digest, HarnessError } from './policy.js';

const capability = (engine: AcpSessionEngine, label: string): CapabilityManifest => ({
  id: `${engine}-native-session`,
  version: '1',
  label: `${label} native conversation`,
  description: `An explicitly admitted kept ${label} conversation over ACP with durable turns, its saved session id and the read scope it was opened with.`,
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 128,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
});

export const CURSOR_SESSION_CAPABILITY = capability('cursor', 'Cursor');
export const DEVIN_SESSION_CAPABILITY = capability('devin', 'Devin');
export const ACP_SESSION_CAPABILITY_IDS = [CURSOR_SESSION_CAPABILITY.id, DEVIN_SESSION_CAPABILITY.id];

export const isAcpProvider = (providerId: string): providerId is AcpSessionEngine =>
  providerId === 'cursor' || providerId === 'devin';

export function validateAcpNativeCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
  if (!isAcpProvider(value.providerId))
    throw new HarnessError('invalid_checkpoint', 'Unknown native checkpoint provider.');
  const parsed = acpCheckpointSchema.safeParse(value.payload);
  if (!parsed.success || parsed.data.engine !== value.providerId)
    throw new HarnessError('invalid_checkpoint', 'ACP recovery metadata is malformed.');
  return { v: 1, providerId: value.providerId, payload: parsed.data };
}

const profile = (
  engine: AcpSessionEngine,
  label: string,
  manifest: CapabilityManifest,
): NativeSessionProfile<AcpSessionCheckpoint> => ({
  engine,
  label,
  capability: manifest,
  parseCheckpoint: (value) => {
    if (value.providerId !== engine)
      throw new HarnessError('invalid_checkpoint', `This is not a ${label} checkpoint.`);
    return acpCheckpointSchema.parse(validateAcpNativeCheckpoint(value).payload);
  },
  steering: 'none',
  recoverInterrupted: recoverAcpCheckpoint,
});

export const CURSOR_SESSION_PROFILE = profile('cursor', 'Cursor', CURSOR_SESSION_CAPABILITY);
export const DEVIN_SESSION_PROFILE = profile('devin', 'Devin', DEVIN_SESSION_CAPABILITY);

export const acpSessionRunId = (engine: AcpSessionEngine) => (projectId: string, commandId: string) =>
  `${engine}-${digest({ projectId, commandId })}`;
