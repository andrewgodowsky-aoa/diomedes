import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  memoryProposalSchema, memoryRecordSchema, memoryUseReceiptSchema, sourceRefSchema,
  memorySnapshotBindingSchema, resolveMemoryProposalSources, sameMemorySnapshot,
  type MemorySnapshotBinding, type SourceRef,
} from '../shared/memory.js';
import { continuationCapsuleSchema, continuationNarrativeSchema } from '../shared/continuation.js';

const packageRoot = new URL('../docs/product/memory-context/NC-MEM-LC-2026-10-06.1/', import.meta.url);
const examples: unknown[] = JSON.parse(readFileSync(new URL('contracts/examples.json', packageRoot), 'utf8'));
const record = memoryRecordSchema.parse(examples[0]);
const capsule = continuationCapsuleSchema.parse(examples[1]);
const receipt = memoryUseReceiptSchema.parse(examples[2]);
const proposal = memoryProposalSchema.parse(examples[4]);
const source = sourceRefSchema.parse(record.sources[0]);
const binding: MemorySnapshotBinding = {
  tenantId: 'synthetic-A', workspaceId: 'synthetic-personal-A', sourceSnapshotId: 'snapshot-1',
  accessEpoch: 1, deletionEpoch: 0,
};

describe('W00 strict memory and continuation contracts', () => {
  it.each([
    ['memory', memoryRecordSchema, examples[0]],
    ['capsule', continuationCapsuleSchema, examples[1]],
    ['receipt', memoryUseReceiptSchema, examples[2]],
    ['proposal', memoryProposalSchema, examples[4]],
  ] as const)('preserves the package %s example without defaults or rewritten text', (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each(['tenantId', 'workspaceId', 'accessEpoch', 'deletionEpoch', 'epistemic', 'lifecycle',
    'sources', 'restrictionsRef', 'scopeRef', 'createdAt', 'grant', 'verified', 'dependencies'])
  ('rejects model-supplied host field %s instead of stripping it', key => {
    expect(memoryProposalSchema.safeParse({ ...proposal, [key]: key === 'epistemic' ? 'live-verified' : 'forged' }).success).toBe(false);
  });

  it.each(['taskId', 'runId', 'goal', 'constraints', 'runtimeStateRefs', 'memoryRevisionRefs',
    'coverageRefs', 'sourceSnapshotId', 'transcript', 'approval', 'continuationIndex', 'previousRevision'])
  ('rejects generated capsule authority field %s', key => {
    expect(continuationNarrativeSchema.safeParse({
      openQuestions: [], nextIntentions: [], [key]: 'forged',
    }).success).toBe(false);
  });

  it('rejects unknown fields at every source and constraint boundary', () => {
    expect(sourceRefSchema.safeParse({ ...source, granted: true }).success).toBe(false);
    expect(memoryProposalSchema.safeParse({ ...proposal, sourceLocators: [{ ...proposal.sourceLocators[0], revision: 'forged' }] }).success).toBe(false);
    expect(memoryRecordSchema.safeParse({ ...record, sources: [{ ...source, tenantId: 'synthetic-B' }] }).success).toBe(false);
    expect(continuationCapsuleSchema.safeParse({ ...capsule, constraints: [{ ...capsule.constraints[0], approved: true }] }).success).toBe(false);
    expect(memoryUseReceiptSchema.safeParse({ ...receipt, omissions: [{ ref: 'x', reason: 'not supplied', grant: true }] }).success).toBe(false);
  });

  it('keeps unknown source revision/digest and token usage unknown across a round trip', () => {
    const unknown = { ...receipt, sources: [{ ...source, revision: null, contentSha256: null }],
      tokenCountQuality: 'unknown', estimatedTokens: null, reportedTokens: null };
    expect(memoryUseReceiptSchema.parse(JSON.parse(JSON.stringify(unknown)))).toEqual(unknown);
    const { reportedTokens: _missing, ...missing } = unknown;
    expect(memoryUseReceiptSchema.safeParse(missing).success).toBe(false);
  });

  it.each(['candidate', 'active', 'superseded', 'retracted'] as const)
  ('does not infer truth from lifecycle %s', lifecycle => {
    for (const epistemic of ['asserted', 'source-supported', 'live-verified', 'inferred'] as const)
      expect(memoryRecordSchema.parse({ ...record, lifecycle, epistemic })).toMatchObject({ lifecycle, epistemic });
  });

  it('rejects unsupported versions and unsafe revision/epoch integers', () => {
    expect(memoryRecordSchema.safeParse({ ...record, v: 2 }).success).toBe(false);
    expect(continuationCapsuleSchema.safeParse({ ...capsule, v: 2 }).success).toBe(false);
    for (const key of ['revision', 'accessEpoch', 'deletionEpoch']) {
      expect(memoryRecordSchema.safeParse({ ...record, [key]: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
      expect(memoryRecordSchema.safeParse({ ...record, [key]: 1.5 }).success).toBe(false);
      expect(memoryRecordSchema.safeParse({ ...record, [key]: -1 }).success).toBe(false);
    }
  });

  it('preserves exact whitespace and JSON Schema code-point bounds', () => {
    expect(memoryProposalSchema.parse({ ...proposal, body: '  Keep the exact exception.\n' }).body).toBe('  Keep the exact exception.\n');
    const body = String.fromCodePoint(0x1f600).repeat(16000);
    expect(memoryProposalSchema.parse({ ...proposal, body }).body).toBe(body);
    expect(memoryProposalSchema.safeParse({ ...proposal, body: body + 'x' }).success).toBe(false);
    expect(memoryProposalSchema.safeParse({ ...proposal, body: '' }).success).toBe(false);
  });

  it('bounds repeated references, constraints and generated intentions', () => {
    expect(memoryProposalSchema.safeParse({ ...proposal, sourceLocators: Array(257).fill(proposal.sourceLocators[0]) }).success).toBe(false);
    expect(continuationCapsuleSchema.safeParse({ ...capsule, constraints: Array(65).fill(capsule.constraints[0]) }).success).toBe(false);
    expect(continuationNarrativeSchema.safeParse({ openQuestions: [], nextIntentions: Array(33).fill('Read a source.') }).success).toBe(false);
    expect(memoryUseReceiptSchema.safeParse({ ...receipt, renderedSha256: 'unverified' }).success).toBe(false);
  });
});

describe('W00 exact source and snapshot binding (no authorization)', () => {
  it('resolves only the exact source span issued to this proposal', () => {
    const issued: SourceRef[] = [structuredClone(source)];
    const input = { ...proposal, sourceLocators: [{ sourceId: source.sourceId, locator: source.locator }] };
    const result = resolveMemoryProposalSources(input, { binding, sources: issued }, binding);
    expect(result).toEqual({ proposal: input, sources: issued });
    issued[0].restrictionsRef = 'changed-after-snapshot';
    input.body = 'changed-after-proposal';
    expect(result.sources[0].restrictionsRef).toBe(source.restrictionsRef);
    expect(result.proposal.body).toBe(proposal.body);
    expect(result).not.toHaveProperty('lifecycle');
    expect(result).not.toHaveProperty('epistemic');
  });

  it.each([
    { sourceId: 'synthetic-B-only-source', locator: source.locator },
    { sourceId: source.sourceId, locator: 'message:invented' },
  ])('refuses an unissued source or locator: $sourceId / $locator', locator => {
    expect(() => resolveMemoryProposalSources({ ...proposal, sourceLocators: [locator] }, { binding, sources: [source] }, binding)).toThrow('invalid_source_reference');
  });

  it('refuses ambiguous revisions rather than selecting one by input order', () => {
    const input = { ...proposal, sourceLocators: [{ sourceId: source.sourceId, locator: source.locator }] };
    expect(() => resolveMemoryProposalSources(input, { binding, sources: [source, { ...source, revision: '2' }] }, binding)).toThrow('invalid_source_reference');
  });

  it('permits an equal host snapshot without claiming permission', () => {
    expect(sameMemorySnapshot(binding, { ...binding })).toBe(true);
  });

  it.each([
    ['tenantId', 'synthetic-B'], ['workspaceId', 'synthetic-personal-B'],
    ['sourceSnapshotId', 'snapshot-2'], ['accessEpoch', 2], ['deletionEpoch', 1],
  ] as const)('rejects reuse after %s changes', (key, value) => {
    expect(sameMemorySnapshot(binding, { ...binding, [key]: value })).toBe(false);
    expect(() => resolveMemoryProposalSources(proposal, { binding, sources: [source] }, { ...binding, [key]: value })).toThrow('stale_evidence');
  });

  it('does not invent missing epochs or merge authority fields into bindings', () => {
    const { accessEpoch: _missing, ...missing } = binding;
    expect(memorySnapshotBindingSchema.safeParse(missing).success).toBe(false);
    expect(memorySnapshotBindingSchema.safeParse({ ...binding, permission: 'all' }).success).toBe(false);
  });
});
