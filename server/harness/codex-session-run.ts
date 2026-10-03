/**
 * The kept ChatGPT conversation profile (spec 3.2): ChatGPT on the shared native conversation
 * driver (`ClaudeSessionRuns` in claude-session-run.ts), so turn records, replay by command id,
 * fork lineage and startup recovery are the same code as for Claude, OpenCode, Cursor and Devin.
 * What differs is declared here: the capability a run is started under, the checkpoint schema
 * its Codex thread id is saved in, that a message sent while a turn runs is queued by Diomedes,
 * how a restart reconciles a turn that was running, and that the conversation's process is
 * opened and its ChatGPT account checked before a turn is recorded.
 */
import type { CapabilityManifest, NativeCheckpoint } from '../../shared/harness.js';
import {
  codexCheckpointSchema,
  recoverCodexCheckpoint,
  type CodexSessionCheckpoint,
} from '../engines/codex-session.js';
import type { NativeSessionProfile } from './claude-session-run.js';
import { digest, HarnessError } from './policy.js';

export const CODEX_SESSION_CAPABILITY: CapabilityManifest = {
  id: 'codex-native-session',
  version: '1',
  label: 'Codex native conversation',
  description:
    "An explicitly admitted kept ChatGPT conversation on Diomedes' own Codex runtime, with durable turns, its saved thread id and the read scope it was opened with.",
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 128,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
};

export function validateCodexNativeCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
  if (value.providerId !== 'codex')
    throw new HarnessError('invalid_checkpoint', 'Unknown native checkpoint provider.');
  const parsed = codexCheckpointSchema.safeParse(value.payload);
  if (!parsed.success)
    throw new HarnessError('invalid_checkpoint', 'ChatGPT recovery metadata is malformed.');
  return { v: 1, providerId: 'codex', payload: parsed.data };
}

export const CODEX_SESSION_PROFILE: NativeSessionProfile<CodexSessionCheckpoint> = {
  engine: 'codex',
  label: 'Codex',
  capability: CODEX_SESSION_CAPABILITY,
  parseCheckpoint: (value) =>
    codexCheckpointSchema.parse(validateCodexNativeCheckpoint(value).payload),
  // A message sent while ChatGPT answers is held and sent as the next turn; turn/steer is never used.
  steering: 'queue',
  recoverInterrupted: recoverCodexCheckpoint,
  // A refusal found opening the process (signed out, another account, no runtime) is known not sent.
  openBeforeTurn: true,
};

export const codexSessionRunId = (projectId: string, commandId: string) =>
  `codex-session-${digest({ projectId, commandId })}`;
