/**
 * Contract revision 2026-09-13.1: the frozen additive amendment C00 proposes.
 *
 * Every shape here is either an existing type re-exported under a frozen name
 * or a small new record that reuses existing fields. The tests validate the
 * examples against the shared schemas and pin the compatibility policy: an old
 * saved run reopened under this revision never silently acquires new powers.
 */
import { describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTRACT_REVISION,
  commandIdentitySchema,
  authoritativeIdsSchema,
  nativeSessionRefSchema,
  steeringAckSchema,
  continuationModeSchema,
  profileSnapshotSchema,
  packLockSchema,
  toolRefSchema,
  verificationEvidenceSchema,
  CONTRACT_EXAMPLES,
  compatibilityForSavedRun,
  type SavedRunCompatibility,
} from '../shared/contract-revision.js';
import { HARNESS_CONTRACT_VERSION, type HarnessRun } from '../shared/harness.js';
import { FileRunStore } from '../server/harness/run-store.js';

describe('the revision identity', () => {
  test('is a dated, frozen literal that names the contract versions it amends', () => {
    expect(CONTRACT_REVISION).toEqual({
      revision: '2026-09-13.1',
      amends: { harness: 1, workControl: 1, capabilityPacks: 1, agents: 1 },
      status: 'proposed',
    });
    expect(Object.isFrozen(CONTRACT_REVISION)).toBe(true);
  });
});

describe('examples validate against the shared schemas', () => {
  test.each([
    ['command', commandIdentitySchema, CONTRACT_EXAMPLES.command],
    ['authoritative ids', authoritativeIdsSchema, CONTRACT_EXAMPLES.ids],
    ['native session ref', nativeSessionRefSchema, CONTRACT_EXAMPLES.nativeSession],
    ['steering ack', steeringAckSchema, CONTRACT_EXAMPLES.steeringAck],
    ['continuation mode', continuationModeSchema, CONTRACT_EXAMPLES.continuation],
    ['profile snapshot', profileSnapshotSchema, CONTRACT_EXAMPLES.profile],
    ['pack lock', packLockSchema, CONTRACT_EXAMPLES.packLock],
    ['tool ref', toolRefSchema, CONTRACT_EXAMPLES.toolRef],
    ['verification evidence', verificationEvidenceSchema, CONTRACT_EXAMPLES.evidence],
  ] as const)('%s example parses and round-trips', (_name, schema, example) => {
    const parsed = (schema as { parse: (value: unknown) => unknown }).parse(example);
    expect(parsed).toEqual(example);
  });

  test('command identity reuses the admission regex and digest shape', () => {
    expect(
      commandIdentitySchema.safeParse({ ...CONTRACT_EXAMPLES.command, commandId: 'has space' })
        .success,
    ).toBe(false);
    expect(
      commandIdentitySchema.safeParse({ ...CONTRACT_EXAMPLES.command, payloadDigest: 'md5:abc' })
        .success,
    ).toBe(false);
    expect(
      commandIdentitySchema.safeParse({
        ...CONTRACT_EXAMPLES.command,
        expectedRevision: '2026-09-13.1',
      }).success,
    ).toBe(true);
    expect(
      commandIdentitySchema.safeParse({ ...CONTRACT_EXAMPLES.command, expectedRevision: 'latest' })
        .success,
    ).toBe(false);
  });

  test('a steering acknowledgment is a distinct state, never a boolean that reads as delivered', () => {
    expect(
      steeringAckSchema.safeParse({
        ...CONTRACT_EXAMPLES.steeringAck,
        state: 'delivered',
        nativeSession: CONTRACT_EXAMPLES.nativeSession,
      }).success,
    ).toBe(true);
    expect(
      steeringAckSchema.safeParse({ ...CONTRACT_EXAMPLES.steeringAck, state: 'logged-only' })
        .success,
    ).toBe(true);
    expect(
      steeringAckSchema.safeParse({ ...CONTRACT_EXAMPLES.steeringAck, state: true }).success,
    ).toBe(false);
    // A delivered ack must carry the native reference it was delivered through.
    expect(
      steeringAckSchema.safeParse({
        ...CONTRACT_EXAMPLES.steeringAck,
        state: 'delivered',
        nativeSession: null,
      }).success,
    ).toBe(false);
  });

  test('continuation modes are resume, retry and fork, and native resume needs a native ref', () => {
    expect(
      continuationModeSchema.safeParse({ mode: 'retry', ofRunId: 'run_1', nativeSession: null })
        .success,
    ).toBe(true);
    expect(
      continuationModeSchema.safeParse({
        mode: 'fork',
        ofRunId: 'run_1',
        forkPoint: 'step_3',
        nativeSession: null,
      }).success,
    ).toBe(true);
    expect(
      continuationModeSchema.safeParse({
        mode: 'resume',
        ofRunId: 'run_1',
        kind: 'native',
        nativeSession: null,
      }).success,
    ).toBe(false);
    expect(
      continuationModeSchema.safeParse({
        mode: 'resume',
        ofRunId: 'run_1',
        kind: 'host',
        nativeSession: null,
      }).success,
    ).toBe(true);
    expect(continuationModeSchema.safeParse({ mode: 'restart', ofRunId: 'run_1' }).success).toBe(
      false,
    );
  });

  test('a profile snapshot keeps requested and reported model apart and records the selection source', () => {
    const alias = {
      ...CONTRACT_EXAMPLES.profile,
      model: { requested: 'gpt-5.5', reported: 'gpt-5.5-2026-08', source: 'runtime' },
    };
    expect(profileSnapshotSchema.safeParse(alias).success).toBe(true);
    const invented = {
      ...CONTRACT_EXAMPLES.profile,
      model: { requested: 'gpt-5.5', reported: 'gpt-5.5', source: 'assumed' },
    };
    expect(profileSnapshotSchema.safeParse(invented).success).toBe(false);
  });

  test('a pack lock pins id and version and a dependency lock cannot be empty-string', () => {
    expect(packLockSchema.safeParse({ ...CONTRACT_EXAMPLES.packLock, version: '' }).success).toBe(
      false,
    );
    expect(
      packLockSchema.safeParse({
        ...CONTRACT_EXAMPLES.packLock,
        dependencies: [{ id: 'x', version: '' }],
      }).success,
    ).toBe(false);
  });

  test('verification evidence has four outcomes and keeps capability, evidence level and enforcement orthogonal', () => {
    for (const outcome of ['not-run', 'passed', 'failed', 'inconclusive']) {
      expect(
        verificationEvidenceSchema.safeParse({ ...CONTRACT_EXAMPLES.evidence, outcome }).success,
      ).toBe(true);
    }
    expect(
      verificationEvidenceSchema.safeParse({ ...CONTRACT_EXAMPLES.evidence, outcome: 'green' })
        .success,
    ).toBe(false);
    const parsed = verificationEvidenceSchema.parse(CONTRACT_EXAMPLES.evidence);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'capability',
        'enforcement',
        'level',
        'outcome',
        'reason',
        'subject',
        'verifiedAt',
        'verifier',
      ].sort(),
    );
    expect(['deterministic', 'live-provider', 'browser', 'packaged', 'installed-app']).toContain(
      parsed.level,
    );
  });
});

describe('compatibility for existing saved runs and receipts', () => {
  const baseRun = (): HarnessRun => ({
    v: HARNESS_CONTRACT_VERSION,
    id: 'run_old',
    tenantId: 'local',
    projectId: 'p1',
    taskId: 't1',
    sessionId: 's1',
    capabilityId: 'format-report',
    capabilityVersion: '1',
    capabilityTools: ['read_document'],
    policyVersion: 'p1',
    principal: {
      id: 'you',
      tenantId: 'local',
      projectId: 'p1',
      capabilities: ['read'],
      identityGeneration: 1,
    },
    state: 'completed',
    budget: { units: 10, modelCalls: 5, toolCalls: 5, wallMs: null },
    used: { units: 2, modelCalls: 1, toolCalls: 1 },
    owner: null,
    fence: 1,
    leaseExpiresAt: null,
    parentRunId: null,
    forkPoint: null,
    contextRevision: 1,
    transcripts: {},
    result: null,
    failure: null,
    cancelReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    steps: [],
    approvals: [],
    events: [],
    lastSeq: 0,
  });

  test('an old v:1 run reopens with exactly the powers it recorded: no steering, no native resume, no extra tools, no packs', () => {
    const compat: SavedRunCompatibility = compatibilityForSavedRun(baseRun());
    expect(compat.readable).toBe(true);
    expect(compat.revisionAtWrite).toBe('pre-2026-09-13.1');
    expect(compat.tools).toEqual(['read_document']);
    expect(compat.steering).toBe('unsupported');
    expect(compat.continuation).toEqual({ resume: 'host', retry: true, fork: false });
    expect(compat.packs).toEqual([]);
    expect(compat.profile.model.source).toBe('not-recorded');
  });

  test('unknown extra fields on an old run are ignored, never promoted into powers', () => {
    const tampered = {
      ...baseRun(),
      steering: { state: 'delivered' },
      nativeSession: { providerId: 'codex', opaqueRef: 'thr_1' },
      capabilityTools: ['read_document'],
      extraTools: ['shell'],
      packs: [{ id: 'diomedes.software-engineering', version: '9.9.9' }],
    } as unknown as HarnessRun;
    const compat = compatibilityForSavedRun(tampered);
    expect(compat.tools).toEqual(['read_document']);
    expect(compat.steering).toBe('unsupported');
    expect(compat.continuation.resume).toBe('host');
    expect(compat.packs).toEqual([]);
  });

  test('a recorded native transcript is reported as a reference, not as a resume power', () => {
    const withTranscript: HarnessRun = {
      ...baseRun(),
      transcripts: {
        codex: {
          providerId: 'codex',
          modelId: 'gpt-5.5',
          lineageId: 'l1',
          opaqueRef: 'thr_1',
          prefixHash: 'sha256:0',
        },
      },
    };
    const compat = compatibilityForSavedRun(withTranscript);
    expect(compat.nativeSessions).toEqual([
      { providerId: 'codex', opaqueRef: 'thr_1', lineageId: 'l1' },
    ]);
    // Recording a transcript is not the same as being able to resume it.
    expect(compat.continuation.resume).toBe('host');
  });

  test('a forked run reports fork lineage, and the fork point is the recorded one', () => {
    const forked: HarnessRun = { ...baseRun(), parentRunId: 'run_parent', forkPoint: 'step_2' };
    const compat = compatibilityForSavedRun(forked);
    expect(compat.continuation.fork).toBe(true);
    expect(compat.lineage).toEqual({ parentRunId: 'run_parent', forkPoint: 'step_2' });
  });

  test('the store still refuses a newer run version; the compatibility policy is for v:1 files only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-runs-'));
    try {
      const store = new FileRunStore(dir);
      const run = baseRun();
      await fs.writeFile(path.join(dir, run.id + '.json'), JSON.stringify({ ...run, v: 2 }));
      await expect(store.read(run.id)).rejects.toMatchObject({ code: 'unsupported_run_version' });
      expect(() => compatibilityForSavedRun({ ...run, v: 2 } as unknown as HarnessRun)).toThrow(
        /version/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
