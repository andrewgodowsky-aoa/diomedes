import { describe, expect, test } from 'vitest';
import { EVIDENCE_ORDER, evidenceRows } from '../shared/evidence-rows.js';
import { evidenceFor, type ExecutionResolution } from '../shared/execution.js';
import { sessionEvidenceView } from '../client/workbench/run-evidence';
import type { Session } from '../shared/types';
import { sessionFixture } from './workbench-fixtures';
import type { AgentResolution } from '../shared/agents';

const agent: AgentResolution = {
  protocolVersion: 1,
  agentId: 'diomedes.analyst',
  agentVersion: '1.2.0',
  agentName: 'Weekly Operations Analyst',
  agentOrigin: 'built-in',
  agentDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  agentSelection: 'manual',
  requestedAgentId: 'diomedes.analyst',
  mode: 'ask',
  routeId: 'codex',
  requestedModel: 'gpt-5-codex',
  modelSelection: 'manual',
  compatible: true,
  unmet: [],
  policy: {
    agentCeiling: 'review',
    granted: 'review',
    effective: 'review',
    grantId: null,
    grantsAuthority: false,
  },
  resolvedAt: '2026-09-10T12:00:00.000Z',
};

const resolution: ExecutionResolution = {
  v: 1,
  resolvedAt: '2026-09-10T12:00:00.000Z',
  principal: { kind: 'local-owner', id: 'owner', tenantId: 'tenant-a', assurance: 'owner-local' },
  workspace: { kind: 'business', organizationId: 'org-1' },
  membership: { role: 'owner', state: 'active' },
  configuration: { organizationId: 'org-1', revision: 3, digest: 'sha256:cfg' },
  agent: {
    agentId: 'diomedes.analyst',
    agentVersion: '1.2.0',
    agentDigest: 'sha256:agent',
    agentName: 'Weekly Operations Analyst',
    agentSelection: 'manual',
    effectivePermission: 'review',
  },
  team: null,
  route: { routeId: 'codex', requestedModel: 'gpt-5-codex', modelSelection: 'manual' },
  rules: { revision: 'r1-abc', governing: [] },
  context: { scopeIds: ['approved-files'], instructionRevision: 'r1-def' },
  payer: { kind: 'bring-your-own', id: 'org-1', coversChildren: true, reason: 'Your account.' },
  budget: null,
  gates: [],
  admitted: true,
};

const view = () =>
  evidenceFor(resolution, {
    runtimeModel: 'gpt-5-codex',
    runtimeEngine: 'codex',
    proposer: 'Weekly Operations Analyst',
    reviewer: null,
    writer: 'Diomedes',
    verifier: null,
    effect: 'Wrote notes/weekly.md',
    verification: null,
  });

describe('the inspector projection', () => {
  test('every field the contract requires has a row, in a fixed order', () => {
    const rows = evidenceRows(view());
    expect(rows.map((row) => row.label)).toEqual([...EVIDENCE_ORDER]);
  });

  test('no row is ever blank', () => {
    for (const row of evidenceRows(view())) expect(row.value.trim().length).toBeGreaterThan(0);
  });

  test('an unknown row says what is missing rather than showing nothing', () => {
    const rows = evidenceRows(view());
    const reviewer = rows.find((row) => row.label === 'Reviewed by')!;
    expect(reviewer.unknown).toBe(true);
    expect(reviewer.value).toContain('reviewed');
  });

  test('the four roles stay four rows', () => {
    const labels = evidenceRows(view()).map((row) => row.label);
    for (const label of ['Proposed by', 'Reviewed by', 'Written by', 'Checked by'])
      expect(labels).toContain(label);
  });

  test('identifiers are marked for code styling and prose is not', () => {
    const rows = evidenceRows(view());
    expect(rows.find((row) => row.label === 'Rules')!.code).toBe(true);
    expect(rows.find((row) => row.label === 'Permission')!.code).toBe(false);
  });

  test('personal work says Personal rather than leaving the business blank', () => {
    const personal = evidenceFor(
      { ...resolution, workspace: { kind: 'personal' }, configuration: null },
      {
        runtimeModel: null,
        runtimeEngine: null,
        proposer: null,
        reviewer: null,
        writer: null,
        verifier: null,
        effect: null,
        verification: null,
      },
    );
    const business = evidenceRows(personal).find((row) => row.label === 'Business')!;
    expect(business.unknown).toBe(true);
    expect(business.value).toContain('personal');
  });
});

describe('what a session can honestly show today', () => {
  const session = (over: Partial<Session> = {}): Session => ({
    ...sessionFixture(),
    route: 'codex',
    agent,
    ...over,
  });

  test('the Agent, its revision and how it was chosen come from the session record', () => {
    const rows = evidenceRows(sessionEvidenceView(session()));
    expect(rows.find((row) => row.label === 'Worker')!.value).toContain(
      'Weekly Operations Analyst',
    );
    expect(rows.find((row) => row.label === 'Worker')!.value).toContain('1.2.0');
    expect(rows.find((row) => row.label === 'Chosen')!.value).toContain('by hand');
  });

  test('the permission shown is the effective one the session recorded', () => {
    expect(
      evidenceRows(sessionEvidenceView(session())).find((row) => row.label === 'Permission')!.value,
    ).toContain('review');
  });

  test('a session with no Agent snapshot says so instead of naming one', () => {
    const rows = evidenceRows(sessionEvidenceView(session({ agent: undefined })));
    const worker = rows.find((row) => row.label === 'Worker')!;
    expect(worker.unknown).toBe(true);
    expect(worker.value.length).toBeGreaterThan(10);
  });

  test('nothing records the business setup or the rules for a session yet, and it says that', () => {
    const rows = evidenceRows(sessionEvidenceView(session()));
    for (const label of ['Business', 'Setup', 'Rules', 'Paid by', 'Reserved'])
      expect(rows.find((row) => row.label === label)!.unknown).toBe(true);
  });

  test('the session view never invents a reviewer or a verifier', () => {
    const rows = evidenceRows(sessionEvidenceView(session()));
    expect(rows.find((row) => row.label === 'Reviewed by')!.unknown).toBe(true);
    expect(rows.find((row) => row.label === 'Checked by')!.unknown).toBe(true);
  });
});
