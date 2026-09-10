/** Bounded local scope authority. Store owns persistence and every project mutation. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Need, ProjectState } from '../../shared/types.js';
import type {
  ScopeGrantCommand,
  ScopeGrantRecord,
  ScopedAuthorization,
} from '../../shared/permissions.js';
import { commandIdSchema, digestSchema, findCommand, payloadDigest } from '../command-admission.js';
import { ApiError, projectFile, relativeName, safeAbsolute, textKind } from '../paths.js';
import type { Store, WriteInput } from '../store.js';

const commandSchema = z.strictObject({
  protocolVersion: z.literal(2),
  commandId: commandIdSchema,
  taskId: z.string().min(1).max(100),
  roots: z.array(z.string().min(1).max(1000)).min(1).max(8),
  operations: z
    .array(z.enum(['text.create', 'text.modify']))
    .min(1)
    .max(2),
  engine: z.literal('codex'),
  accountRoute: z.literal('codex:chatgpt'),
  maxWrites: z.number().int().min(1).max(200),
  maxBytes: z.number().int().min(1).max(25_165_824),
  ttlMinutes: z.number().int().min(1).max(480),
  review: z.literal('human'),
});
const failure = (reason: string) => new ApiError(403, reason, { code: 'scope_not_authorized' });
const normalized = (folder: string) => path.resolve(folder).toLowerCase();
const byteCount = (writes: readonly WriteInput[]) =>
  writes.reduce((total, write) => total + Buffer.byteLength(write.text ?? ''), 0);
export const scopeGrantDigest = (record: ScopeGrantRecord) => payloadDigest(record.grant);

const timeSchema = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
const actionHashSchema = z.union([digestSchema, z.string().regex(/^[a-f0-9]{64}$/)]);
/** Strict persisted shape: unknown or widened fields fail closed, never authorize. */
const grantSchema = z.strictObject({
  protocolVersion: z.literal(2),
  id: z.string().min(1).max(100),
  commandId: commandIdSchema,
  payloadDigest: digestSchema,
  projectId: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100),
  tenantId: z.null(),
  issuer: z.strictObject({
    actor: z.literal('local-client'),
    assurance: z.literal('loopback'),
    authenticated: z.literal(false),
    deviceId: z.null(),
    sessionId: z.null(),
  }),
  hostLease: z.string().min(1).max(100),
  projectFolder: z.string().min(1).max(4096),
  roots: z.array(z.string().min(1).max(1000)).min(1).max(8),
  operations: z
    .array(z.enum(['text.create', 'text.modify']))
    .min(1)
    .max(2),
  engine: z.literal('codex'),
  accountRoute: z.literal('codex:chatgpt'),
  review: z.literal('human'),
  budget: z.strictObject({
    maxWrites: z.number().int().min(1).max(200),
    maxBytes: z.number().int().min(1).max(25_165_824),
    providerInference: z.literal('separate-consent'),
  }),
  createdAt: timeSchema,
  expiresAt: timeSchema,
  eventId: z.string().min(1).max(100),
});
const grantRecordSchema = z.strictObject({
  grant: grantSchema,
  generation: z.number().int().min(0).max(1_000_000),
  revokedAt: timeSchema.nullable(),
});
const scopedAuthorizationSchema = z.strictObject({
  protocolVersion: z.literal(2),
  kind: z.literal('scope-grant'),
  id: z.string().min(1).max(100),
  grantId: z.string().min(1).max(100),
  grantDigest: digestSchema,
  grantGeneration: z.literal(0),
  projectId: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  approvalId: z.string().min(1).max(100),
  proposalDigest: digestSchema,
  actionDigest: actionHashSchema,
  baseDigest: digestSchema,
  engine: z.literal('codex'),
  accountRoute: z.literal('codex:chatgpt'),
  writes: z.number().int().min(1).max(8),
  bytes: z.number().int().min(0).max(25_165_824),
  authorizedAt: timeSchema,
  eventId: z.string().min(1).max(100),
});
const scopedExecutionSchema = z.strictObject({
  state: z.enum(['pending', 'applied', 'conflicted', 'not-applied']),
  eventId: z.string().min(1).max(100).nullable(),
  completedAt: timeSchema.nullable(),
  reason: z.string().nullable(),
  conflicts: z.array(z.string().min(1).max(1000)).max(8),
});

/** The lease is live host state, never restored from the grant or a saved principal. */
export class ScopeGrants {
  private readonly lease = randomUUID();
  private readonly issued = new Map<string, string>();
  constructor(private readonly store: Store) {}

  view(projectId: string) {
    return (this.store.state(projectId).scopeGrants ?? []).map((record) => {
      const reason = this.inactiveReason(record);
      return {
        ...structuredClone(record),
        active: !reason,
        reason: reason ?? 'Allowed for this task until expiry or revocation.',
      };
    });
  }
  private inactiveReason(record: ScopeGrantRecord): string | null {
    if (record.revokedAt || record.generation !== 0) return 'This task scope was revoked.';
    if (
      record.grant.hostLease !== this.lease ||
      this.issued.get(record.grant.id) !== scopeGrantDigest(record)
    )
      return 'Confirm this scope again after restarting the local service.';
    if (
      Date.now() >= Date.parse(record.grant.expiresAt) ||
      Date.now() < Date.parse(record.grant.createdAt)
    )
      return 'This task scope has expired.';
    return null;
  }
  async issue(projectId: string, input: unknown): Promise<ScopeGrantRecord> {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError(
        400,
        'Choose a supported task scope: Codex text creates and updates, a bounded lifetime and budget, and human review.',
      );
    const command: ScopeGrantCommand = parsed.data;
    const state = this.store.state(projectId);
    const digest = payloadDigest({ type: 'scope.issue', projectId, ...command });
    const replay = state.scopeGrants?.find((item) => item.grant.commandId === command.commandId);
    if (replay) {
      if (replay.grant.payloadDigest !== digest)
        throw new ApiError(409, 'This command already identifies a different scope.', {
          code: 'scope_command_conflict',
        });
      return structuredClone(replay);
    }
    if (findCommand(state, command.commandId))
      throw new ApiError(409, 'This command is already used by another operation.', {
        code: 'scope_command_conflict',
      });
    if ((state.scopeGrants?.length ?? 0) >= 256)
      throw new ApiError(409, 'This project has reached its retained scope limit.');
    const task = state.tasks.find((item) => item.id === command.taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    const roots = command.roots.map((root) => (root === '.' ? '.' : relativeName(root)));
    if (
      new Set(roots.map((root) => root.toLowerCase())).size !== roots.length ||
      new Set(command.operations).size !== command.operations.length
    )
      throw new ApiError(400, 'List each scope root and operation only once.');
    await safeAbsolute(state.project.folder);
    for (const root of roots) if (root !== '.') await projectFile(state.project.folder, root);
    const createdAt = new Date().toISOString();
    const event = this.store.addEntry(state, {
      kind: 'scope-issued',
      taskId: task.id,
      sentence: `You allowed supported text creates and updates for this task (${roots.join(', ')}). Sending still requires separate consent.`,
    });
    const record: ScopeGrantRecord = {
      generation: 0,
      revokedAt: null,
      grant: {
        protocolVersion: 2,
        id: `G${randomUUID()}`,
        commandId: command.commandId,
        payloadDigest: digest,
        projectId,
        taskId: task.id,
        tenantId: null,
        issuer: {
          actor: 'local-client',
          assurance: 'loopback',
          authenticated: false,
          deviceId: null,
          sessionId: null,
        },
        hostLease: this.lease,
        projectFolder: state.project.folder,
        roots,
        operations: [...command.operations],
        engine: 'codex',
        accountRoute: 'codex:chatgpt',
        review: 'human',
        budget: {
          maxWrites: command.maxWrites,
          maxBytes: command.maxBytes,
          providerInference: 'separate-consent',
        },
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + command.ttlMinutes * 60_000).toISOString(),
        eventId: event.id,
      },
    };
    state.scopeGrants ??= [];
    state.scopeGrants.push(record);
    await this.store.persist(state);
    this.issued.set(record.grant.id, scopeGrantDigest(record));
    return structuredClone(record);
  }
  async revoke(projectId: string, grantId: string) {
    const state = this.store.state(projectId);
    const record = state.scopeGrants?.find((item) => item.grant.id === grantId);
    if (!record) throw new ApiError(404, 'This scope was not found.');
    // Revoke the live lease even if the following persistence fails.
    this.issued.delete(grantId);
    if (!record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      record.generation += 1;
      this.store.addEntry(state, {
        kind: 'scope-revoked',
        taskId: record.grant.taskId,
        sentence:
          'You revoked this task scope. Already-dispatched effects may finish; recorded versions remain in History.',
      });
      await this.store.persist(state);
    }
    return structuredClone(record);
  }
  private async check(
    record: ScopeGrantRecord,
    need: Need,
    writes: readonly WriteInput[],
    engine: string,
    accountRoute: string,
  ) {
    const grant = record.grant;
    const state = this.store.state(grant.projectId);
    const inactive = this.inactiveReason(record);
    if (inactive) throw failure(inactive);
    if (
      grant.tenantId !== null ||
      grant.projectId !== state.project.id ||
      normalized(grant.projectFolder) !== normalized(state.project.folder) ||
      grant.taskId !== need.taskId
    )
      throw failure('This operation belongs to a different project or task.');
    const session = state.sessions.find((item) => item.id === need.sessionId);
    if (
      !session ||
      session.taskId !== need.taskId ||
      session.slotId ||
      session.sample ||
      need.harness
    )
      throw failure('This scope covers direct text proposals only.');
    if (
      engine !== grant.engine ||
      accountRoute !== grant.accountRoute ||
      (session.route && session.route !== engine)
    )
      throw failure('The engine or account route changed.');
    if (
      (this.store.settings.services?.codexAccountRoute ?? 'codex:chatgpt') !== accountRoute ||
      !this.store.settings.services?.codex
    )
      throw failure('The current provider route is no longer authorized.');
    if (!writes.length || writes.length > 8)
      throw failure('This text batch is outside the supported size.');
    for (const write of writes) {
      const name = relativeName(write.path);
      const operation =
        write.text === null ? null : write.expected === null ? 'text.create' : 'text.modify';
      if (!operation || !grant.operations.includes(operation) || textKind(name) === 'unsupported')
        throw failure('Deletion or this operation class requires an exact review.');
      const lower = name.toLowerCase();
      if (!grant.roots.some((root) => root === '.' || lower.startsWith(`${root.toLowerCase()}/`)))
        throw failure('This file is outside the folders you authorized.');
      await projectFile(state.project.folder, name);
    }
    const used = state.needs.flatMap((item) =>
      item.authorization?.grantId === grant.id && item.id !== need.id ? [item.authorization] : [],
    );
    const writesUsed = used.reduce((n, item) => n + item.writes, 0);
    const bytesUsed = used.reduce((n, item) => n + item.bytes, 0);
    if (
      writesUsed + writes.length > grant.budget.maxWrites ||
      bytesUsed + byteCount(writes) > grant.budget.maxBytes
    )
      throw failure('This task scope reached its file or text budget.');
    const latest = this.inactiveReason(record);
    if (latest) throw failure(latest);
  }
  async matching(
    projectId: string,
    need: Need,
    writes: readonly WriteInput[],
    engine: string,
    accountRoute: string,
  ) {
    let boundary: string | undefined;
    for (const record of [...(this.store.state(projectId).scopeGrants ?? [])].reverse()) {
      if (record.grant.taskId !== need.taskId) continue;
      try {
        await this.check(record, need, writes, engine, accountRoute);
        delete need.authorizationBoundary;
        return record;
      } catch (error) {
        if (!(error instanceof ApiError) || error.details.code !== 'scope_not_authorized')
          throw error;
        boundary ??= error.message;
      }
    }
    if (boundary) need.authorizationBoundary = boundary;
    return null;
  }
  async record(
    projectId: string,
    need: Need,
    writes: readonly WriteInput[],
    engine: string,
    accountRoute: string,
  ) {
    if (need.state !== 'open' || need.approvalReceipt || need.authorization || !need.approval)
      throw failure('This proposal already has a decision.');
    const record = await this.matching(projectId, need, writes, engine, accountRoute);
    if (!record) return false;
    const state = this.store.state(projectId);
    const event = this.store.addEntry(state, {
      kind: 'scope-authorized',
      approvalId: need.id,
      sessionId: need.sessionId,
      taskId: need.taskId,
      sentence: `This ${writes.length}-file proposal matched the scope you allowed for this task.`,
    });
    const authorization: ScopedAuthorization = {
      protocolVersion: 2,
      kind: 'scope-grant',
      id: `A${randomUUID()}`,
      grantId: record.grant.id,
      grantDigest: scopeGrantDigest(record),
      grantGeneration: record.generation,
      projectId,
      taskId: need.taskId,
      sessionId: need.sessionId,
      approvalId: need.id,
      proposalDigest: need.approval.proposalDigest,
      actionDigest: need.approval.actionDigest,
      baseDigest: need.approval.baseDigest,
      engine,
      accountRoute,
      writes: writes.length,
      bytes: byteCount(writes),
      authorizedAt: event.time,
      eventId: event.id,
    };
    need.authorization = authorization;
    event.authorization = structuredClone(authorization);
    need.state = 'go-ahead';
    need.decidedAt = event.time;
    need.allowForTask = false;
    need.execution = {
      state: 'pending',
      eventId: null,
      completedAt: null,
      conflicts: [],
      reason: null,
    };
    // No writer can run until this reservation/evidence is durable.
    await this.store.persist(state);
    return true;
  }
  async assertCurrent(projectId: string, need: Need, writes: readonly WriteInput[]) {
    validateScopedAuthorization(this.store.state(projectId), need);
    const evidence = need.authorization!;
    const record = this.store
      .state(projectId)
      .scopeGrants?.find((item) => item.grant.id === evidence.grantId);
    if (
      !record ||
      record.grant.projectId !== projectId ||
      record.generation !== evidence.grantGeneration
    )
      throw failure('This task scope changed before the write.');
    await this.check(record, need, writes, evidence.engine, evidence.accountRoute);
  }
}

/**
 * Validate persisted grants at load/recovery, not on every state read. Legacy v1
 * projects carry no grants and pass untouched. Anything malformed fails closed:
 * the saved state is never rewritten, trimmed, or broadened here.
 */
export function validateScopeGrants(state: ProjectState) {
  const grants = state.scopeGrants;
  if (grants === undefined) return;
  const incompatible = () => {
    throw new Error(
      'A saved scope grant is incompatible or inconsistent. Project state was not rewritten.',
    );
  };
  if (!Array.isArray(grants) || grants.length > 256) throw incompatible();
  // One project-scoped command namespace: a scope command cannot repeat itself
  // or reuse a Work or exact-approval command.
  const commands = new Set<string>([
    ...state.sessions.flatMap((session) => (session.receipt ? [session.receipt.commandId] : [])),
    ...state.needs.flatMap((need) =>
      need.approvalReceipt ? [need.approvalReceipt.commandId] : [],
    ),
  ]);
  const events = new Map(state.history.map((entry) => [entry.id, entry]));
  for (const record of grants) {
    const parsed = grantRecordSchema.safeParse(record);
    if (!parsed.success) throw incompatible();
    const grant = parsed.data.grant;
    if (commands.has(grant.commandId)) throw incompatible();
    commands.add(grant.commandId);
    // Only generation 0 without a revocation timestamp can ever be live. A newer
    // generation survives journal recovery; it is never reset to 0 here.
    if ((parsed.data.generation === 0) !== (parsed.data.revokedAt === null)) throw incompatible();
    if (
      parsed.data.revokedAt !== null &&
      Date.parse(parsed.data.revokedAt) < Date.parse(grant.createdAt)
    )
      throw incompatible();
    if (grant.projectId !== state.project.id) throw incompatible();
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt)) throw incompatible();
    if (
      new Set(grant.roots.map((root) => root.toLowerCase())).size !== grant.roots.length ||
      new Set(grant.operations).size !== grant.operations.length
    )
      throw incompatible();
    for (const root of grant.roots) {
      if (root === '.') continue;
      try {
        if (relativeName(root) !== root) throw incompatible();
      } catch {
        throw incompatible();
      }
    }
    const issued = events.get(grant.eventId);
    if (!issued || issued.kind !== 'scope-issued' || issued.taskId !== grant.taskId)
      throw incompatible();
  }
}

/** Validates historical evidence without resurrecting its authority. */
export function validateScopedAuthorization(state: ProjectState, need: Need) {
  const evidence = need.authorization;
  const record = state.scopeGrants?.find((item) => item.grant.id === evidence?.grantId);
  const event = state.history.find((item) => item.id === evidence?.eventId);
  const session = state.sessions.find((item) => item.id === need.sessionId);
  const fail = () => {
    throw new Error('A saved scoped authorization is inconsistent. No write was dispatched.');
  };
  // Strict shapes first: unknown, widened, or re-typed fields fail closed.
  if (
    !evidence ||
    !scopedAuthorizationSchema.safeParse(evidence).success ||
    !record ||
    !grantRecordSchema.safeParse(record).success ||
    !scopedExecutionSchema.safeParse(need.execution).success
  )
    fail();
  // History stays coherent across a later revocation: the evidence keeps its
  // generation-0 binding (enforced by the strict schema above) and the grant
  // keeps its content digest. Only the write-time assertCurrent compares live
  // generations, and it refuses with scope_not_authorized, never corruption.
  if (
    evidence!.writes > record!.grant.budget.maxWrites ||
    evidence!.bytes > record!.grant.budget.maxBytes
  )
    fail();
  const grantEvent = state.history.find((item) => item.id === record!.grant.eventId);
  if (
    !grantEvent ||
    grantEvent.kind !== 'scope-issued' ||
    grantEvent.taskId !== record!.grant.taskId
  )
    fail();
  if (
    !need.approval ||
    need.approvalReceipt ||
    need.allowForTask ||
    evidence!.grantDigest !== scopeGrantDigest(record!) ||
    record!.grant.projectId !== state.project.id ||
    record!.grant.taskId !== need.taskId ||
    evidence!.projectId !== state.project.id ||
    evidence!.taskId !== need.taskId ||
    evidence!.sessionId !== need.sessionId ||
    evidence!.approvalId !== need.id ||
    session?.taskId !== need.taskId ||
    session.sample ||
    need.state !== 'go-ahead' ||
    evidence!.authorizedAt !== need.decidedAt ||
    Date.parse(evidence!.authorizedAt) < Date.parse(record!.grant.createdAt) ||
    Date.parse(evidence!.authorizedAt) >= Date.parse(record!.grant.expiresAt) ||
    evidence!.engine !== record!.grant.engine ||
    evidence!.accountRoute !== record!.grant.accountRoute ||
    event?.kind !== 'scope-authorized' ||
    event.approvalId !== need.id ||
    event.sessionId !== need.sessionId ||
    event.taskId !== need.taskId ||
    event.time !== evidence!.authorizedAt ||
    JSON.stringify(event.authorization) !== JSON.stringify(evidence) ||
    (['proposalDigest', 'actionDigest', 'baseDigest'] as const).some(
      (key) => evidence![key] !== need.approval![key],
    )
  )
    fail();
  const execution = need.execution!;
  if (
    (execution.state === 'pending') !== (execution.completedAt === null) ||
    (execution.state === 'pending' || execution.state === 'not-applied') !==
      (execution.eventId === null) ||
    (execution.state === 'conflicted') !== execution.conflicts.length > 0 ||
    (execution.state === 'not-applied') !==
      (execution.reason !== null && execution.eventId === null) ||
    (execution.state === 'applied' && (execution.reason !== null || execution.conflicts.length > 0))
  )
    fail();
  if (execution.state === 'applied' || execution.state === 'conflicted') {
    const write = state.history.find((entry) => entry.id === execution.eventId);
    if (
      !write ||
      write.approvalId !== need.id ||
      JSON.stringify(write.authorization) !== JSON.stringify(evidence) ||
      payloadDigest({
        type: 'text.apply',
        writes: write.files.map(({ path, before, after }) => ({ path, before, after })),
      }) !== evidence!.actionDigest
    )
      fail();
  }
}
