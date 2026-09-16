/**
 * Contract revision 2026-09-13.1 — the frozen additive amendment proposed by
 * C00 of the unified execution program.
 *
 * Nothing here changes an existing contract version: `HARNESS_CONTRACT_VERSION`
 * stays 1, `WORK_CONTROL_CONTRACT_VERSION` stays 1, `CAPABILITY_PACK_CONTRACT_VERSION`
 * stays 1 and `AgentResolution.protocolVersion` stays 1. This file names, in one
 * place, the shapes that later items (H01 onward, B00 onward) consume, each
 * built from fields that already exist:
 *
 * | frozen thing                        | existing source                                              |
 * |-------------------------------------|--------------------------------------------------------------|
 * | command identity + expected revision| `commandIdSchema`, `payloadDigest` (server/command-admission)|
 * | authoritative run/turn/event ids    | `HarnessEvent{v,seq,runId}`, `Session.id`, `Turn`            |
 * | native session reference            | `ProviderTranscriptRef{providerId,lineageId,opaqueRef}`      |
 * | steering acknowledgment             | `StopReceipt.acknowledged`, `FollowUpState`                  |
 * | resume / retry / fork               | `HarnessRun.parentRunId/forkPoint`, `StepIntent.maxAttempts` |
 * | exact-model profile snapshot        | `OriginSnapshot.model`, `AgentResolution.*Selection`         |
 * | pack identity + dependency lock     | `CapabilityPackManifest{id,version}`, `PackActivation`       |
 * | tool capability/effect reference    | `ToolDescriptor` minus handler-side fields                   |
 * | verification evidence               | gates vocabulary: not-run / passed / failed / inconclusive   |
 *
 * Capability (what is implemented), evidence level (how it was shown) and
 * enforcement level (who could stop a violation) are three separate fields
 * and are never derived from one another.
 *
 * Backward handling: an existing v:1 saved run or receipt is read exactly as
 * it was written. `compatibilityForSavedRun` reports only the powers that run
 * recorded; unknown extra fields are ignored and never promoted. A run file
 * with another `v` is still refused by `FileRunStore.read`.
 */
import { z } from 'zod';
import { HARNESS_CONTRACT_VERSION, type HarnessRun, type StepRecord } from './harness.js';
import type { OriginSnapshot } from './attribution.js';

export const CONTRACT_REVISION = Object.freeze({
  revision: '2026-09-13.1',
  amends: Object.freeze({ harness: 1, workControl: 1, capabilityPacks: 1, agents: 1 }),
  status: 'proposed',
} as const);
export type ContractRevisionId = typeof CONTRACT_REVISION.revision;
/** What a v:1 record written before this file existed is reported as. */
export const PRE_REVISION = 'pre-2026-09-13.1' as const;

// --- patterns shared with the admission layer -----------------------------------
// Kept byte-identical to server/command-admission.ts; tests/contract-revision.test.ts
// checks both accept and reject the same samples.
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;

const id = z.string().trim().min(1).max(200);
const iso = z.string().datetime({ offset: true });
const digest = z.string().regex(DIGEST_PATTERN);

/** Command families that already carry a versioned command identity, plus the ones later items add. */
export const COMMAND_FAMILIES = [
  'work.start',
  'approval.decide',
  'scope.issue',
  'task.create',
  'follow-up.queue',
  'stop',
  'steer',
] as const;

// --- 1. command identity and expected revision ------------------------------------
export const commandIdentitySchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: z.string().regex(COMMAND_ID_PATTERN),
  family: z.enum(COMMAND_FAMILIES),
  /** Digest of the canonical payload; a replay with another digest conflicts. */
  payloadDigest: digest,
  /** The contract revision the caller was written against. A mismatch is refused, never guessed around. */
  expectedRevision: z.string().regex(REVISION_PATTERN),
});
export type CommandIdentity = z.infer<typeof commandIdentitySchema>;

// --- 2. authoritative run / turn / event identifiers ------------------------------
export const authoritativeIdsSchema = z
  .strictObject({
    runId: id,
    /** The Session and Turn presenting this run, when the host has linked them. */
    turn: z.strictObject({ sessionId: id, turnId: id }).nullable(),
    /** The durable event cursor: contract version, sequence, run. */
    event: z.strictObject({
      v: z.literal(HARNESS_CONTRACT_VERSION),
      seq: z.number().int().nonnegative(),
      runId: id,
    }),
    /** Identifiers are minted by the host. A provider's ids are references, never authority. */
    authority: z.literal('host'),
  })
  .refine((ids) => ids.event.runId === ids.runId, {
    message: 'The event cursor must name the same run.',
  });
export type AuthoritativeIds = z.infer<typeof authoritativeIdsSchema>;

// --- 3. native session reference ---------------------------------------------------
/** The identity part of a `ProviderTranscriptRef`. Opaque; never flattened into portable messages. */
export const nativeSessionRefSchema = z.strictObject({
  providerId: id,
  lineageId: id,
  opaqueRef: id,
});
export type NativeSessionRef = z.infer<typeof nativeSessionRefSchema>;

// --- 4. steering acknowledgment ----------------------------------------------------
/**
 * What happened to a steering command. `delivered` is what `StopReceipt.acknowledged: true`
 * means for a stop: the runtime confirmed the text reached the live provider turn, and the
 * acknowledgment names the native session it went through. `logged-only` is today's `note`:
 * appended to the thread and changing nothing already being prepared. The state is an enum
 * on purpose; a boolean would let a logged note read as delivered.
 */
export const STEERING_STATES = [
  'pending',
  'delivered',
  'logged-only',
  'rejected',
  'cancelled',
] as const;
export const steeringAckSchema = z
  .strictObject({
    commandId: z.string().regex(COMMAND_ID_PATTERN),
    state: z.enum(STEERING_STATES),
    nativeSession: nativeSessionRefSchema.nullable(),
    at: iso,
    detail: z.string().max(2000),
  })
  .refine((ack) => ack.state !== 'delivered' || ack.nativeSession !== null, {
    message:
      'A delivered steering acknowledgment names the native session it was delivered through.',
  });
export type SteeringAck = z.infer<typeof steeringAckSchema>;

// --- 5. resume / retry / fork ------------------------------------------------------
/**
 * Three continuation modes, never a fourth spelled "restart from copied text".
 * `resume` is `host` (the run service replays persisted steps and continues at the first
 * unresolved one) or `native` (the provider continues its own session; needs a native ref
 * and a route whose `resumability` is not `unsupported`). `retry` re-dispatches one intent
 * under its `maxAttempts`. `fork` starts a child run at a recorded point (`parentRunId`,
 * `forkPoint`).
 */
export const continuationModeSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('resume'),
      ofRunId: id,
      kind: z.enum(['host', 'native']),
      nativeSession: nativeSessionRefSchema.nullable(),
    }),
    z.strictObject({
      mode: z.literal('retry'),
      ofRunId: id,
      nativeSession: nativeSessionRefSchema.nullable(),
    }),
    z.strictObject({
      mode: z.literal('fork'),
      ofRunId: id,
      forkPoint: id,
      nativeSession: nativeSessionRefSchema.nullable(),
    }),
  ])
  .refine((c) => !(c.mode === 'resume' && c.kind === 'native' && c.nativeSession === null), {
    message: 'A native resume needs the native session it resumes.',
  });
export type ContinuationMode = z.infer<typeof continuationModeSchema>;

// --- 6. exact-model profile snapshot -----------------------------------------------
/**
 * The Agent, route and model a run actually resolved to, taken at resolution time and
 * never rewritten. `model` is `OriginSnapshot.model`: requested and reported stay apart,
 * and `source` says whether the runtime reported anything. `selection` is
 * `AgentResolution.agentSelection` / `modelSelection`: whether a person chose or Auto did.
 */
export const profileSnapshotSchema = z.strictObject({
  agentId: id,
  agentVersion: id,
  agentDigest: id,
  routeId: id,
  model: z.strictObject({
    requested: z.string().nullable(),
    reported: z.string().nullable(),
    source: z.enum(['runtime', 'not-recorded']),
  }),
  selection: z.strictObject({
    agent: z.enum(['manual', 'automatic']),
    model: z.enum(['manual', 'automatic', 'runtime-default']),
  }),
  effort: z.string().nullable(),
  resolvedAt: iso,
});
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;

// --- 7. pack identity and dependency lock -----------------------------------------
export const packLockSchema = z.strictObject({
  id: id,
  /** `CapabilityPackManifest.version`, recorded on activation. */
  version: z.string().min(1).max(100),
  /** Digest of the manifest bytes when a registry supplies them; null for the built-in map. */
  digest: digest.nullable(),
  dependencies: z.array(z.strictObject({ id: id, version: z.string().min(1).max(100) })).max(32),
  /** When a person activated it; activation is not authorization. */
  activatedAt: iso.nullable(),
});
export type PackLock = z.infer<typeof packLockSchema>;

// --- 8. tool capability / effect reference ----------------------------------------
/** `ToolDescriptor` as a reference: identity, effect and policy, without schema or handler. */
export const toolRefSchema = z.strictObject({
  name: id,
  version: id,
  effect: z.enum(['pure', 'read', 'idempotent', 'non-idempotent']),
  permission: z.string().nullable(),
  approval: z.boolean(),
  destination: z.enum(['local', 'external']),
  trustedInputRequired: z.boolean(),
  inputSchemaDigest: digest,
});
export type ToolRef = z.infer<typeof toolRefSchema>;

// --- 9. verification evidence -------------------------------------------------------
export const EVIDENCE_OUTCOMES = [
  'not-run',
  'passed',
  'failed',
  'inconclusive',
  'not-applicable',
] as const;
export const EVIDENCE_LEVELS = [
  'deterministic',
  'live-provider',
  'browser',
  'packaged',
  'installed-app',
] as const;
export const CAPABILITY_STATES = ['implemented', 'partial', 'absent'] as const;
export const ENFORCEMENT_LEVELS = ['enforced', 'observed', 'instructional', 'unsupported'] as const;

export const verificationEvidenceSchema = z
  .strictObject({
    /** What was verified: a run id, candidate id or coverage row. */
    subject: id,
    /** Implementation capability. Orthogonal to the two below. */
    capability: z.enum(CAPABILITY_STATES),
    /** Evidence level: how it was shown. */
    level: z.enum(EVIDENCE_LEVELS),
    /** Enforcement level: who could have stopped a violation. */
    enforcement: z.enum(ENFORCEMENT_LEVELS),
    outcome: z.enum(EVIDENCE_OUTCOMES),
    verifier: id,
    verifiedAt: iso.nullable(),
    reason: z.string().max(2000),
  })
  .refine((e) => e.outcome !== 'not-applicable' || e.reason.trim().length > 0, {
    message: 'not-applicable needs a reason.',
  });
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

// --- examples ----------------------------------------------------------------------
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

export const CONTRACT_EXAMPLES = Object.freeze({
  command: {
    protocolVersion: 1,
    commandId: 'cmd_2026-09-13_task-create_01',
    family: 'task.create',
    payloadDigest: ZERO_DIGEST,
    expectedRevision: '2026-09-13.1',
  },
  ids: {
    runId: 'run_01',
    turn: { sessionId: 'session_01', turnId: 'turn_01' },
    event: { v: 1, seq: 7, runId: 'run_01' },
    authority: 'host',
  },
  nativeSession: { providerId: 'codex', lineageId: 'lineage_01', opaqueRef: 'thread_01' },
  steeringAck: {
    commandId: 'cmd_steer_01',
    state: 'logged-only',
    nativeSession: null,
    at: '2026-09-13T05:00:00.000Z',
    detail: 'Appended to the thread; no route has proven a live steering channel.',
  },
  continuation: { mode: 'resume', ofRunId: 'run_01', kind: 'host', nativeSession: null },
  profile: {
    agentId: 'diomedes.general',
    agentVersion: '1.0.0',
    agentDigest: 'sha256:agent',
    routeId: 'codex',
    model: { requested: 'gpt-5.5', reported: null, source: 'not-recorded' },
    selection: { agent: 'automatic', model: 'manual' },
    effort: 'high',
    resolvedAt: '2026-09-13T05:00:00.000Z',
  },
  packLock: {
    id: 'diomedes.software-engineering',
    version: '0.1.0',
    digest: null,
    dependencies: [],
    activatedAt: null,
  },
  toolRef: {
    name: 'read_document',
    version: '1',
    effect: 'read',
    permission: 'read',
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    inputSchemaDigest: ZERO_DIGEST,
  },
  evidence: {
    subject: 'HAR-06',
    capability: 'implemented',
    level: 'deterministic',
    enforcement: 'enforced',
    outcome: 'passed',
    verifier: 'tests/rule-hooks.test.ts',
    verifiedAt: '2026-09-13T05:00:00.000Z',
    reason: '',
  },
} as const);

// --- backward handling for existing saved runs and receipts ------------------------

export interface SavedRunCompatibility {
  readonly readable: true;
  /** `pre-2026-09-13.1` for every run written before this revision existed. */
  readonly revisionAtWrite: string;
  /** Exactly `capabilityTools` as saved. Nothing added. */
  readonly tools: readonly string[];
  /** No saved run recorded a steering channel; none is invented. */
  readonly steering: 'unsupported';
  readonly continuation: {
    readonly resume: 'host';
    readonly retry: boolean;
    readonly fork: boolean;
  };
  /** Saved runs carry no pack lock; packs are never inferred from activation history. */
  readonly packs: readonly PackLock[];
  readonly profile: { readonly model: OriginSnapshot['model'] };
  /** References the run recorded. A reference is not a resume power. */
  readonly nativeSessions: readonly NativeSessionRef[];
  readonly lineage: { readonly parentRunId: string; readonly forkPoint: string | null } | null;
}

/**
 * Read an existing v:1 run under revision 2026-09-13.1. Only recorded facts are
 * reported. Fields this revision did not exist to write (`steering`, `packs`,
 * `nativeSession`, anything else unknown) are ignored even when present.
 */
export function compatibilityForSavedRun(run: HarnessRun): SavedRunCompatibility {
  if (run.v !== HARNESS_CONTRACT_VERSION)
    throw new Error(
      `Run ${String(run.id)} was written by contract version ${String(run.v)}; the compatibility policy covers version ${HARNESS_CONTRACT_VERSION} only.`,
    );
  const recorded = (run as { contractRevision?: unknown }).contractRevision;
  const revisionAtWrite =
    typeof recorded === 'string' && REVISION_PATTERN.test(recorded) ? recorded : PRE_REVISION;
  const tools = Array.isArray(run.capabilityTools)
    ? run.capabilityTools.filter((name): name is string => typeof name === 'string')
    : [];
  const transcripts =
    run.transcripts && typeof run.transcripts === 'object' ? Object.values(run.transcripts) : [];
  const nativeSessions = transcripts
    .filter((ref) => ref && typeof ref.providerId === 'string' && typeof ref.opaqueRef === 'string')
    .map((ref) => ({
      providerId: ref.providerId,
      opaqueRef: ref.opaqueRef,
      lineageId: ref.lineageId,
    }));
  const parentRunId = typeof run.parentRunId === 'string' ? run.parentRunId : null;
  return {
    readable: true,
    revisionAtWrite,
    tools,
    steering: 'unsupported',
    continuation: { resume: 'host', retry: true, fork: parentRunId !== null },
    packs: [],
    profile: { model: lastRuntimeModel(run.steps) },
    nativeSessions,
    lineage: parentRunId
      ? { parentRunId, forkPoint: typeof run.forkPoint === 'string' ? run.forkPoint : null }
      : null,
  };
}

function lastRuntimeModel(steps: readonly StepRecord[] | undefined): OriginSnapshot['model'] {
  if (Array.isArray(steps))
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const origin = steps[index]?.origin;
      if (origin?.model?.source === 'runtime')
        return {
          requested: origin.model.requested,
          reported: origin.model.reported,
          source: 'runtime',
        };
    }
  return { requested: null, reported: null, source: 'not-recorded' };
}

/**
 * Receipts (`Session.receipt`, `Need.approvalReceipt`, `ScopeGrantRecord.grant`,
 * `StopReceipt`, `FollowUpCommand`) written before this revision carry no
 * `contractRevision`; they are read as `pre-2026-09-13.1` and keep their exact
 * meaning. A receipt is never re-issued or re-digested on read.
 */
export function receiptRevision(receipt: { readonly contractRevision?: unknown }): string {
  const recorded = receipt.contractRevision;
  return typeof recorded === 'string' && REVISION_PATTERN.test(recorded) ? recorded : PRE_REVISION;
}
