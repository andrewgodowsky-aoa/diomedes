/**
 * The OpenCode native conversation profile (H04). The lifecycle is the shared
 * native conversation driver's (`ClaudeSessionRuns` in claude-session-run.ts):
 * turn records, replay by command id, fork lineage and startup recovery are the
 * same code for both engines. What differs is declared here: the capability a
 * run is started under, the checkpoint schema its native session id is saved
 * in, and that a message sent while a turn runs is queued by Diomedes.
 */
import type { CapabilityManifest, NativeCheckpoint } from '../../shared/harness.js';
import {
  openCodeCheckpointSchema,
  type OpenCodeSessionCheckpoint,
} from '../engines/opencode-session.js';
import { validateClaudeNativeCheckpoint, type NativeSessionProfile } from './claude-session-run.js';
import { digest, HarnessError } from './policy.js';

export const OPENCODE_SESSION_CAPABILITY: CapabilityManifest = {
  id: 'opencode-native-session',
  version: '1',
  label: 'OpenCode native conversation',
  description:
    'An explicitly admitted kept OpenCode session with durable turns and the read scope it was opened with.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 128,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
};

export function validateOpenCodeNativeCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
  if (value.providerId !== 'opencode')
    throw new HarnessError('invalid_checkpoint', 'Unknown native checkpoint provider.');
  const parsed = openCodeCheckpointSchema.safeParse(value.payload);
  if (!parsed.success)
    throw new HarnessError('invalid_checkpoint', 'OpenCode recovery metadata is malformed.');
  return { v: 1, providerId: 'opencode', payload: parsed.data };
}

/** The host's one checkpoint validator: each provider's checkpoint is read by its own schema. */
export function validateNativeCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
  if (value.providerId === 'opencode') return validateOpenCodeNativeCheckpoint(value);
  return validateClaudeNativeCheckpoint(value);
}

export const OPENCODE_SESSION_PROFILE: NativeSessionProfile<OpenCodeSessionCheckpoint> = {
  engine: 'opencode',
  label: 'OpenCode',
  capability: OPENCODE_SESSION_CAPABILITY,
  parseCheckpoint: (value) =>
    openCodeCheckpointSchema.parse(validateOpenCodeNativeCheckpoint(value).payload),
  steering: 'queue',
  openBeforeTurn: true,
};

export const opencodeSessionRunId = (projectId: string, commandId: string) =>
  `opencode-${digest({ projectId, commandId })}`;
