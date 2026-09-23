/**
 * B00.I + H01.I repair regressions — the producer-side counterpart of
 * tests/swe2-independent-review.test.ts.
 *
 * The independent suite pins the five findings end-to-end. This file pins the
 * seams it cannot reach: authorization verification, the ledger ceiling, the
 * preview sink's stamping and refusal, the adapter-side self-guard, the
 * capability map's honesty labels and the source map's module/export handoff.
 * Everything runs through production interfaces — no test-only back doors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  ADMISSION_FIXTURES,
  assertMembership,
  CLOUD_SCHEDULER,
  CONTROL_PLANE_SOURCES,
  decideAdmission,
  ENTITLEMENT_FIXTURES,
  leaseUsable,
  NO_ENTITLEMENT_SNAPSHOT,
  snapshotAt,
  type CredentialLease,
  type EntitlementSnapshot,
} from '../services/control-plane/contract/index.js';
import { VENDOR_ALLOWLIST } from '../services/control-plane/contract/vendors.js';
import type { Membership, Organization } from '../shared/workspaces.js';
import {
  ADAPTER_COMMANDS,
  commandGate,
  OUTPUT_DELTA,
  previewSink,
  transientPreviewSchema,
  type TransientPreview,
} from '../shared/adapter-contract.js';
import { contractChecks, streamChecks } from '../server/harness/conformance.js';
import { ADAPTER_CAPABILITIES, guaranteeSentences } from '../server/harness/adapters.js';
import { routeContractFor, ROUTE_CONTRACTS } from '../server/harness/route-contract.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import { NativeAgent, type ModelAdapter } from '../server/harness/native-agent.js';
import { ToolRegistry } from '../server/harness/tools.js';
import { HarnessError } from '../server/harness/policy.js';
import type { HarnessRun } from '../shared/harness.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { fixtureTextDispatch } from './h01-fixture.js';
import type { TextEngineAdapter } from '../server/engines/contract.js';
import { EngineError } from '../server/engines/process.js';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import type { IntegrationStatus } from '../shared/types.js';
import { Store } from '../server/store.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { ManagedGateway, verifyAuthorization } from '../server/managed-gateway.js';
import {
  entitlementFor,
  isActiveMember,
  NO_ENTITLEMENT_REASON,
  type EntitlementView,
} from '../shared/workspaces.js';
import { dollars, RATE_CARD_V1, type MicroUsd } from '../shared/managed-usage.js';
import { BillingEventProcessor } from '../server/billing-events.js';
import { SPEND_POLICY } from '../services/control-plane/contract/vendors.js';
import { verifySubject } from '../services/control-plane/contract/index.js';

const AT = '2026-09-17T03:00:00.000Z';
const GEN = { identity: 1, principal: 1 };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const tmp = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b00h01-repair-'));
  roots.push(root);
  return root;
};

// ---------------------------------------------------------------------------
// B00: expiry predicates fail closed
// ---------------------------------------------------------------------------

const lease: CredentialLease = {
  handle: 'repair-handle',
  principalId: 'person-a',
  tenantId: 'tenant-a',
  resources: ['repo-a'],
  scopes: ['read'],
  generation: GEN,
  expiresAt: '2026-09-18T03:00:00.000Z',
};

describe('B00: lease and snapshot clocks fail closed', () => {
  it('a lease with an unreadable expiry is never usable, however the clock reads', () => {
    for (const expiresAt of ['', 'not-a-date', 'next Tuesday']) {
      const result = leaseUsable({ ...lease, expiresAt }, GEN, AT);
      expect(result.usable, expiresAt).toBe(false);
      expect(result.reason).toMatch(/expiry|expiration|readable/i);
    }
  });
  it('an unreadable observation clock refuses rather than guesses', () => {
    expect(leaseUsable(lease, GEN, 'invalid-clock').usable).toBe(false);
    // Even when the lease itself would look expired, the reason names the clock.
    const stale = leaseUsable(
      { ...lease, expiresAt: '2026-09-01T00:00:00.000Z' },
      GEN,
      'invalid-clock',
    );
    expect(stale.usable).toBe(false);
  });
  it('an active entitlement without a provable expiry reads unknown, not active', () => {
    const active = ENTITLEMENT_FIXTURES.active;
    for (const expiresAt of [null, '', 'not-a-date'] as const) {
      const read = snapshotAt({ ...active, expiresAt }, AT);
      expect(read.state, String(expiresAt)).toBe('unknown');
    }
  });
  it('an invalid observation clock undoes an active claim, never a recorded refusal', () => {
    expect(snapshotAt(ENTITLEMENT_FIXTURES.active, 'invalid-clock').state).toBe('unknown');
    // A stored non-active state was already refused; it is not re-labelled.
    expect(snapshotAt(ENTITLEMENT_FIXTURES.unknown, 'invalid-clock').state).toBe('unknown');
    expect(snapshotAt(NO_ENTITLEMENT_SNAPSHOT, 'invalid-clock').state).toBe('none');
  });
  it('an unreadable revocation marker is undetermined, never waved through', () => {
    const read = snapshotAt(
      { ...ENTITLEMENT_FIXTURES.active, revokedAt: 'not-a-date' },
      AT,
    );
    expect(read.state).toBe('unknown');
  });
  it('a future-dated revocation does not revoke yet', () => {
    const read = snapshotAt(
      { ...ENTITLEMENT_FIXTURES.active, revokedAt: '2026-12-01T00:00:00.000Z' },
      AT,
    );
    expect(read.state).toBe('active');
  });
  it('membership refuses an unreadable observation time', () => {
    const org: Organization = {
      v: 1,
      id: 'org_r',
      name: 'R',
      industry: null,
      tenantId: 'tenant-a',
      identitySource: 'hosted',
      createdAt: AT,
      createdBy: 'person-a',
    };
    const membership: Membership = {
      v: 1,
      organizationId: 'org_r',
      personId: 'person-a',
      role: 'owner',
      state: 'active',
      invitedAt: AT,
      joinedAt: AT,
      revokedAt: null,
      revokedReason: null,
    };
    const result = assertMembership({
      organization: org,
      membership,
      generation: GEN,
      at: 'invalid-clock',
    });
    expect(result.asserted).toBe(false);
  });
  it('a suspension still refuses before the entitlement snapshot is read', () => {
    const view = structuredClone(ADMISSION_FIXTURES['security-suspended'].view);
    const decision = decideAdmission({ ...view, at: 'invalid-clock' });
    expect(decision).toMatchObject({ decided: 'refused', code: 'security_suspended' });
  });
});

describe('B00: gateway authorization and the ledger ceiling fail closed', () => {
  const authorization = {
    tenantId: 'tenant-a',
    audience: 'codex',
    requestDigest: 'digest-one',
    expiresAt: '2026-09-17T03:10:00.000Z',
    reservationId: 'res_1',
  };
  it('refuses an unreadable authorization expiry or observation time', () => {
    expect(
      verifyAuthorization(
        { ...authorization, expiresAt: 'garbage' },
        { tenantId: 'tenant-a', audience: 'codex', requestDigest: 'digest-one', at: AT },
      ).valid,
    ).toBe(false);
    expect(
      verifyAuthorization(authorization, {
        tenantId: 'tenant-a',
        audience: 'codex',
        requestDigest: 'digest-one',
        at: 'garbage',
      }).valid,
    ).toBe(false);
    // The controls still answer correctly.
    expect(
      verifyAuthorization(authorization, {
        tenantId: 'tenant-a',
        audience: 'codex',
        requestDigest: 'digest-one',
        at: '2026-09-17T04:00:00.000Z',
      }).valid,
    ).toBe(false);
    expect(
      verifyAuthorization(authorization, {
        tenantId: 'tenant-a',
        audience: 'codex',
        requestDigest: 'digest-one',
        at: AT,
      }).valid,
    ).toBe(true);
  });
});

describe('B00: managed admission with an unreadable clock refuses, never throws', () => {
  let ledger: AllowanceLedger;
  const entitled = {
    plan: 'none',
    managedInference: true,
    reason: NO_ENTITLEMENT_REASON,
  } as unknown as EntitlementView;
  const gateway = () =>
    new ManagedGateway({
      ledger,
      entitlementFor: () => entitled,
      tenantFor: () => 'tenant-a',
      memberOf: () => true,
      billingStatusFor: async () => ({ suspended: false, suspendedReason: null }),
      policyFor: () => ({ processing: 'may-leave', organizationRoute: 'managed' }),
      jobCapFor: () => dollars(2),
    });
  beforeEach(async () => {
    const root = await tmp();
    const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    ledger = new AllowanceLedger(store);
    await ledger.init();
    await ledger.allocatePeriod({
      organizationId: 'org_a',
      periodId: '2026-09',
      planVersion: 'plan-test',
      rateCardVersion: 'rate-card-2026-09-10.1',
      grantedMicroUsd: dollars(10),
      startsAt: AT,
      endsAt: '2026-10-01T00:00:00.000Z',
      sourceEventId: 'evt_1',
      at: AT,
    });
  });
  const ask = (overrides: Record<string, unknown> = {}) => ({
    organizationId: 'org_a',
    personId: 'person_a',
    route: 'codex',
    kind: 'generation' as const,
    parentTaskId: null,
    maxMicroUsd: dollars(1),
    requestDigest: 'digest-one',
    reservationId: 'res_1',
    periodId: '2026-09',
    at: AT,
    ...overrides,
  });
  it('an invalid request time is a refusal, not a RangeError', async () => {
    const decision = await gateway().admit(ask({ at: 'not-a-date' }));
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('invalid_clock');
    // No hold was taken on the way out.
    expect(ledger.summary('org_a', '2026-09').pendingMicroUsd).toBe(0);
  });
  it('a valid request still admits and mints a real expiry', async () => {
    const decision = await gateway().admit(ask());
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(Number.isFinite(Date.parse(decision.authorization!.expiresAt))).toBe(true);
  });
  it('a non-finite or non-integer ceiling is refused, not admitted', async () => {
    for (const bad of [Number.NaN, -5, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        ledger.reserve({
          reservationId: `res_${String(bad)}`,
          organizationId: 'org_a',
          periodId: '2026-09',
          parentTaskId: null,
          kind: 'generation',
          route: 'codex',
          payer: 'managed',
          maxMicroUsd: bad as MicroUsd,
          rateCardVersion: 'rate-card-2026-09-10.1',
          parentEnvelopeMicroUsd: null,
          at: AT,
        }),
      ).rejects.toMatchObject({ details: { code: 'invalid_ceiling' } });
    }
  });
  it('a malformed reservation clock is refused by the ledger itself', async () => {
    await expect(
      ledger.reserve({
        reservationId: 'res_bad_clock',
        organizationId: 'org_a',
        periodId: '2026-09',
        parentTaskId: null,
        kind: 'generation',
        route: 'codex',
        payer: 'managed',
        maxMicroUsd: dollars(1),
        rateCardVersion: 'rate-card-2026-09-10.1',
        parentEnvelopeMicroUsd: null,
        at: 'not-a-date',
      }),
    ).rejects.toMatchObject({ details: { code: 'invalid_clock' } });
  });
});

describe('B00: the source map is a module/export handoff, not a comment', () => {
  it('every named authority module exists and exports its named symbol', () => {
    const authorities: Record<string, { module: string; symbol: string; value: unknown }> = {
      externalSubjectMapping: {
        module: CONTROL_PLANE_SOURCES.externalSubjectMapping,
        symbol: 'verifySubject',
        value: verifySubject,
      },
      membershipRecords: {
        module: CONTROL_PLANE_SOURCES.membershipRecords,
        symbol: 'isActiveMember',
        value: isActiveMember,
      },
      entitlementToday: {
        module: CONTROL_PLANE_SOURCES.entitlementToday,
        symbol: 'entitlementFor',
        value: entitlementFor,
      },
      billingEvents: {
        module: CONTROL_PLANE_SOURCES.billingEvents,
        symbol: 'BillingEventProcessor',
        value: BillingEventProcessor,
      },
      allowanceWriter: {
        module: CONTROL_PLANE_SOURCES.allowanceWriter,
        symbol: 'AllowanceLedger',
        value: AllowanceLedger,
      },
      budgetSemantics: {
        module: CONTROL_PLANE_SOURCES.budgetSemantics,
        symbol: 'RATE_CARD_V1',
        value: RATE_CARD_V1,
      },
      managedAdmission: {
        module: CONTROL_PLANE_SOURCES.managedAdmission,
        symbol: 'ManagedGateway',
        value: ManagedGateway,
      },
      spendPolicy: {
        module: CONTROL_PLANE_SOURCES.spendPolicy,
        symbol: 'SPEND_POLICY',
        value: SPEND_POLICY,
      },
    };
    const root = path.resolve(__dirname, '..');
    for (const [domain, { module, symbol, value }] of Object.entries(authorities)) {
      expect(fss.existsSync(path.join(root, module)), `${domain}: ${module}`).toBe(true);
      expect(value, `${domain}: ${module}#${symbol}`).toBeDefined();
      // The import above is the module's real export — a missing or renamed
      // symbol fails typecheck before this test even runs.
    }
    expect(CLOUD_SCHEDULER).toBeNull();
    expect(CONTROL_PLANE_SOURCES.scheduler).toBeNull();
  });
  it('no second implementation of a named authority exists beside the declared one', () => {
    const root = path.resolve(__dirname, '..');
    const dirs = ['server', 'shared', 'services'];
    const named: Record<string, string> = {
      'server/managed-usage.ts': 'AllowanceLedger',
      'server/managed-gateway.ts': 'ManagedGateway',
      'shared/managed-usage.ts': 'RATE_CARD_V1',
    };
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fss.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
      }
    };
    for (const dir of dirs) walk(path.join(root, dir));
    for (const [expectedFile, symbol] of Object.entries(named)) {
      const definition = new RegExp(`export\\s+(?:async\\s+)?(?:class|function|const)\\s+${symbol}\\b`);
      const hits = files.filter((file) => definition.test(fss.readFileSync(file, 'utf8')));
      expect(
        hits.map((file) => path.relative(root, file).replaceAll('\\', '/')),
        symbol,
      ).toEqual([expectedFile]);
    }
  });
});

// ---------------------------------------------------------------------------
// H01: the declared contract is operative
// ---------------------------------------------------------------------------

describe('H01: commandGate makes a descriptor binding operative', () => {
  it('admits a supported command and refuses an unsupported one with its note', () => {
    const contract = routeContractFor('cursor');
    expect(commandGate(contract, 'start')).toEqual({ admitted: true });
    const refused = commandGate(contract, 'resume');
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.code).toBe('command_unsupported');
      expect(refused.reason).toMatch(/provider session/i);
    }
  });
  it('refuses a descriptor that is not a contract at all', () => {
    for (const bogus of [null, {}, { routeId: 'cursor' }, 'codex']) {
      const result = commandGate(bogus, 'start');
      expect(result.admitted).toBe(false);
      if (!result.admitted) expect(result.code).toBe('contract_invalid');
    }
  });
});

// --- EngineService dispatch consumes the contract ----------------------------

const installedFor = (engine: string): IntegrationStatus => ({
  id: engine,
  name: engine,
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Repair fixture',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  installedVersion: TESTED_VERSIONS[engine as keyof typeof TESTED_VERSIONS],
  location: 'fixture.exe',
  disclosure: [],
});
const engineFixture = (
  engine: (typeof EXTERNAL_ENGINES)[number],
  adapter: Partial<TextEngineAdapter> & Pick<TextEngineAdapter, 'generate'>,
  deps: ConstructorParameters<typeof EngineService>[1] = {},
) => {
  const version = TESTED_VERSIONS[engine];
  return (async () => {
    const root = await tmp();
    const service = new EngineService(root, {
      discover: async () => [installedFor(engine)],
      version: async () => version,
      adapter: () => ({
        id: engine,
        contract: routeContractFor(engine),
        inspect: async () => ({
          authentication: 'signed-in',
          accountRoute: 'fixture:account',
          models: [
            { slug: 'fixture-model', name: 'Fixture', description: '', efforts: [], defaultEffort: null },
          ],
          detail: 'Offline fixture',
        }),
        ...adapter,
      }),
      ...deps,
    });
    // The real runtime seam — a RunService over a file store, authorized by
    // the same Settings-record authorizer the host wires. Only the provider
    // transport (the adapter above) is scripted.
    service.dispatch = fixtureTextDispatch(path.join(root, 'runs'), {
      [`${engine}AccountRoute`]: 'fixture:account',
    }).dispatch;
    return service;
  })();
};
const request = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p',
  threadId: 't',
  requestId: 'q',
  model: 'fixture-model',
  accountRoute: 'fixture:account',
  prompt: 'Offline fixture',
  instructions: '',
  documents: [],
  ...overrides,
});

describe('H01: EngineService dispatch is bound by the carried contract', () => {
  it('refuses to start a route whose descriptor declares start unsupported', async () => {
    const contract = structuredClone(routeContractFor('opencode'));
    contract.commands.start = { support: 'unsupported', note: 'Disabled for the repair proof.' };
    let dispatches = 0;
    const service = await engineFixture('opencode', {
      contract,
      generate: async () => {
        dispatches += 1;
        throw new Error('should never run');
      },
    });
    await expect(service.generate('opencode', request())).rejects.toMatchObject({
      code: 'COMMAND_UNSUPPORTED',
    });
    expect(dispatches).toBe(0);
  });
  it.each([null, {}, { routeId: 'opencode' }] as const)(
    'refuses an adapter carrying no valid descriptor: %j',
    async (contract) => {
      const service = await engineFixture('opencode', {
        contract: contract as never,
        generate: async () => {
          throw new Error('should never run');
        },
      });
      await expect(service.generate('opencode', request())).rejects.toMatchObject({
        code: 'CONTRACT_INVALID',
      });
    },
  );
  it('refuses a descriptor bound to a different route or an unproven build', async () => {
    for (const contract of [
      { ...structuredClone(routeContractFor('opencode')), routeId: 'devin' },
      {
        ...structuredClone(routeContractFor('opencode')),
        engine: { id: 'opencode', version: '0.0.0-unproven', protocolVersion: 'http+sse' },
      },
    ]) {
      const service = await engineFixture('opencode', {
        contract,
        generate: async () => {
          throw new Error('should never run');
        },
      });
      await expect(service.generate('opencode', request())).rejects.toMatchObject({
        code: 'CONTRACT_MISMATCH',
      });
    }
  });
  it('refuses a caller-supplied raw delta sink; previews arrive stamped', async () => {
    const service = await engineFixture('opencode', {
      generate: async (input) => ({
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        text: 'done',
        version: TESTED_VERSIONS.opencode,
      }),
    });
    await expect(
      service.generate('opencode', request({ onDelta: () => {} })),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTRACT' });
  });
});

describe('H01: the preview contract is byte-bounded, stamped and redacted', () => {
  const identity = {
    projectId: 'p',
    threadId: 't',
    requestId: 'q',
    runId: 'p-q',
    stepId: 'text:dispatch',
    attempt: 1,
    fence: 1,
  };
  it('stamps identity and a dense sequence onto each frame', () => {
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, onPreview: (frame) => frames.push(frame) });
    sink('a');
    sink('b€');
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(frames[1]).toMatchObject({ kind: 'text-delta', ...identity, text: 'b€' });
  });
  it('redacts before measuring or emitting', () => {
    const frames: TransientPreview[] = [];
    const sink = previewSink({
      identity,
      redact: (text) => text.replace(/secret-[A-Za-z0-9]+/g, '[redacted]'),
      onPreview: (frame) => frames.push(frame),
    });
    sink('token secret-ABC123 inside');
    expect(frames[0].text).toBe('token [redacted] inside');
  });
  it('an over-budget frame is an error, never a truncation', () => {
    const frames: TransientPreview[] = [];
    const failures: { code: string; reason: string }[] = [];
    const sink = previewSink({
      identity,
      onPreview: (frame) => frames.push(frame),
      onInvalid: (failure) => failures.push(failure),
    });
    sink('x'.repeat(OUTPUT_DELTA.maxChunkBytes)); // exactly at the bound: emitted
    sink('€'.repeat(30_000)); // 90 KB in UTF-8: refused
    sink('after'); // a poisoned stream emits nothing further
    expect(frames.map((frame) => frame.seq)).toEqual([1]);
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe('OUTPUT_LIMIT');
  });
  it('without an onInvalid sink the violation throws to the caller', () => {
    const sink = previewSink({ identity });
    expect(() => sink('€'.repeat(30_000))).toThrowError(/byte/i);
  });
  it('the schema measures UTF-8 bytes, not JavaScript characters', () => {
    const at = 'x'.repeat(OUTPUT_DELTA.maxChunkBytes);
    const over = '€'.repeat(Math.ceil(OUTPUT_DELTA.maxChunkBytes / 3) + 1);
    expect(transientPreviewSchema.safeParse({ kind: 'text-delta', ...identity, seq: 1, text: at }).success).toBe(true);
    expect(Buffer.byteLength(over, 'utf8')).toBeGreaterThan(OUTPUT_DELTA.maxChunkBytes);
    expect(transientPreviewSchema.safeParse({ kind: 'text-delta', ...identity, seq: 1, text: over }).success).toBe(false);
  });
  it('rejects unknown fields and partial binding', () => {
    const base = { kind: 'text-delta' as const, ...identity, seq: 1, text: 'hi' };
    expect(transientPreviewSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(transientPreviewSchema.safeParse({ ...base, requestId: '' }).success).toBe(false);
  });
});

describe('H01: EngineService emits stamped, redacted preview frames', () => {
  it('adapts adapter deltas into contract frames for the caller', async () => {
    const service = await engineFixture(
      'opencode',
      {
        generate: async (input) => {
          input.onDelta?.('first secret-XYZ');
          input.onDelta?.('second');
          return {
            projectId: input.projectId,
            threadId: input.threadId,
            requestId: input.requestId,
            model: input.model,
            text: 'done',
            version: TESTED_VERSIONS.opencode,
          };
        },
      },
      { redactFor: () => (text: string) => text.replace(/secret-[A-Za-z0-9]+/g, '[redacted]') },
    );
    const frames: TransientPreview[] = [];
    await service.generate('opencode', request({ onPreview: (frame: TransientPreview) => frames.push(frame) }));
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(frames[0]).toMatchObject({
      kind: 'text-delta',
      projectId: 'p',
      threadId: 't',
      requestId: 'q',
      runId: 'p-q',
      stepId: 'text:dispatch',
      attempt: 1,
      fence: 1,
      text: 'first [redacted]',
    });
  });
  it('refuses the response when the adapter violated the preview bound', async () => {
    const service = await engineFixture('opencode', {
      generate: async (input) => {
        input.onDelta?.('€'.repeat(30_000));
        return {
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
          model: input.model,
          text: 'done',
          version: TESTED_VERSIONS.opencode,
        };
      },
    });
    // The dispatch reached the provider before the bound was violated, so the
    // run parks as uncertain rather than resolving either way.
    await expect(service.generate('opencode', request())).rejects.toMatchObject({
      code: 'DISPATCH_UNCERTAIN',
    });
  });
});

// ---------------------------------------------------------------------------
// H01: conformance additions
// ---------------------------------------------------------------------------

describe('H01: conformance checks reject false completion and drifted proof', () => {
  const makeRun = async () => {
    const root = await tmp();
    const service = new RunService(new FileRunStore(root));
    await service.start({
      id: 'repair-run',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principal: {
        id: 'worker',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        capabilities: [],
        identityGeneration: 1,
      },
      capability: {
        id: 'repair-fixture',
        version: '1',
        label: 'Repair fixture',
        description: 'Offline conformance input',
        tools: [],
        requestedPermissions: [],
        approvalPolicy: 'show-first',
        maxTurns: 1,
        supportedPlatforms: ['win32'],
      },
      budget: { units: 1, modelCalls: 1, toolCalls: 1, wallMs: null },
    });
    return service.get('repair-run');
  };

  it('a live run passes the new checks', async () => {
    const run = await makeRun();
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
  });
  it('a terminal state without its event fails terminal-state-agrees', async () => {
    const run = await makeRun();
    const corrupted: HarnessRun = structuredClone(run);
    corrupted.state = 'completed';
    const check = streamChecks(corrupted).find((c) => c.id === 'terminal-state-agrees');
    expect(check?.outcome).toBe('failed');
  });
  it('a disagreeing terminal event fails terminal-state-agrees', async () => {
    const run = await makeRun();
    const corrupted: HarnessRun = structuredClone(run);
    corrupted.state = 'failed';
    corrupted.failure = { name: 'HarnessError', message: 'boom' };
    corrupted.events.push({
      v: 1,
      seq: corrupted.lastSeq + 1,
      runId: corrupted.id,
      at: AT,
      type: 'run.completed',
      attributes: {},
    });
    corrupted.lastSeq += 1;
    const check = streamChecks(corrupted).find((c) => c.id === 'terminal-state-agrees');
    expect(check?.outcome).toBe('failed');
  });
  it('a lastSeq that outruns the stream fails lastseq-matches-stream', async () => {
    const run = await makeRun();
    const corrupted: HarnessRun = structuredClone(run);
    corrupted.lastSeq += 3;
    const check = streamChecks(corrupted).find((c) => c.id === 'lastseq-matches-stream');
    expect(check?.outcome).toBe('failed');
  });
  it('a descriptor whose engine moved past its proof fails tested-version-current', () => {
    const descriptor = structuredClone(routeContractFor('devin'));
    descriptor.engine.version = '9999.0.0';
    const check = contractChecks(descriptor).find((c) => c.id === 'tested-version-current');
    expect(check?.outcome).toBe('failed');
  });
  it('every shipped descriptor still passes contract conformance', () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
      const failed = contractChecks(contract).filter((c) => c.outcome === 'failed');
      expect(failed, routeId).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// H01: the harness-side adapters carry the same contract
// ---------------------------------------------------------------------------

describe('H01: ModelAdapter is bound to a descriptor the loop enforces', () => {
  const registry = () => new ToolRegistry();
  it('a contractless adapter is not an adapter', async () => {
    const root = await tmp();
    const runs = new RunService(new FileRunStore(root));
    const adapter = {
      id: 'fixture',
      version: '1',
      capabilities: () => ADAPTER_CAPABILITIES['native-fixture'],
      complete: async () => ({ response: { type: 'final' as const, text: 'x' } }),
    } as unknown as ModelAdapter;
    expect(() => new NativeAgent(runs, adapter, registry())).toThrowError(HarnessError);
  });
  it('an adapter whose descriptor refuses start cannot drive a run', async () => {
    const root = await tmp();
    const runs = new RunService(new FileRunStore(root));
    const contract = structuredClone(routeContractFor('native-fixture'));
    contract.commands.start = { support: 'unsupported', note: 'Off for the repair proof.' };
    const adapter: ModelAdapter = {
      id: 'fixture',
      version: '1',
      contract,
      capabilities: () => ADAPTER_CAPABILITIES['native-fixture'],
      complete: async () => ({ response: { type: 'final' as const, text: 'x' } }),
    };
    expect(() => new NativeAgent(runs, adapter, registry())).toThrowError(/unsupported/i);
  });
});

// ---------------------------------------------------------------------------
// H01: capability labels are honest
// ---------------------------------------------------------------------------

describe('H01: text-route capability labels do not overclaim enforcement', () => {
  it('the five text routes label filesystem writes observed, not enforced', () => {
    for (const engine of EXTERNAL_ENGINES) {
      expect(ADAPTER_CAPABILITIES[engine].filesystemWrites, engine).toBe('observed');
      expect(
        ADAPTER_CAPABILITIES[engine].notes.some((note) => /proposal|containment|sandbox/i.test(note)),
        engine,
      ).toBe(true);
    }
  });
  it('the recorded-writer routes keep the enforced label they earned', () => {
    for (const route of ['native-fixture', 'sample', 'codex', 'codex-team'] as const)
      expect(ADAPTER_CAPABILITIES[route].filesystemWrites, route).toBe('enforced');
  });
  it('the Console sentence for an observed control says who reports it', () => {
    const sentences = guaranteeSentences(ADAPTER_CAPABILITIES.cursor);
    expect(sentences.some((line) => /Writing project files: reported by the helper/.test(line))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B00: the vendor matrix carries dated sources and honest account state
// ---------------------------------------------------------------------------

describe('B00: the vendor matrix cites dated primary sources', () => {
  it('every selected vendor names its free-tier limits, sources and unverified account state', () => {
    for (const vendor of VENDOR_ALLOWLIST.filter((v) => v.selected)) {
      expect(vendor.limits.length, vendor.vendor).toBeGreaterThan(0);
      expect(vendor.sources.length, vendor.vendor).toBeGreaterThan(0);
      for (const source of vendor.sources) {
        expect(source.url, vendor.vendor).toMatch(/^https:\/\//);
        expect(source.asOf, `${vendor.vendor} source`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      // No account has been observed in this build; the label must say so.
      expect(vendor.accountState, vendor.vendor).toBe('unverified');
    }
  });
  it('Stripe separates processing fees from the Billing product', () => {
    const stripe = VENDOR_ALLOWLIST.find((v) => v.vendor === 'stripe');
    expect(stripe).toBeDefined();
    expect(stripe!.fees).toMatch(/processing/i);
    expect(stripe!.fees).toMatch(/billing/i);
  });
});
