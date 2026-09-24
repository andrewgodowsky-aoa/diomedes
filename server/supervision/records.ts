/**
 * The durable records of one Work run, read into the route-agnostic
 * `DriftInput` the detectors take. Every field comes from a record that already
 * exists: History (what was written), Needs (what was proposed and what a
 * person approved), task scope grants (what a person admitted), the run's
 * inputs and task (what it was scoped to), the linked harness run (tool calls,
 * observations, budget and the H18 context account), the delivered instruction
 * files (H11), and the H17 verification evidence.
 */
import type { HarnessRun } from '../../shared/harness.js';
import type { ContextAccount } from '../../shared/context-accounting.js';
import type {
  DriftAction,
  DriftBudgetLine,
  DriftInput,
  DriftRule,
  DriftTouch,
} from '../../shared/supervision.js';
import type { ProjectState, Session } from '../../shared/types.js';
import { digest } from '../harness/policy.js';
import { machineRules } from './detectors.js';

const LIVE: readonly Session['state'][] = ['queued', 'working', 'waiting'];

/** Path-like fields a tool input may carry. The tool's own names; nothing is parsed from prose. */
const PATH_KEYS = ['path', 'paths', 'file', 'files', 'target', 'document', 'documents'];
function pathsIn(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) found.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return found;
}

function contextAccountOf(output: unknown): ContextAccount | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const context = (output as { context?: unknown }).context;
  if (!context || typeof context !== 'object') return null;
  const account = context as Partial<ContextAccount>;
  return typeof account.estimatedTokens === 'number' && account.window ? (account as ContextAccount) : null;
}

export interface InstructionSource {
  /** The exact bytes of an instruction file as delivered, or null when they cannot be shown to be. */
  (path: string, sha: string): Promise<string | null>;
}

export async function driftInputFor(input: {
  state: Pick<ProjectState, 'tasks' | 'needs' | 'history' | 'sessions' | 'scopeGrants'>;
  session: Session;
  harness: HarnessRun | null;
  instructions: InstructionSource;
  now?: number;
}): Promise<DriftInput> {
  const { state, session, harness } = input;
  const task = state.tasks.find((item) => item.id === session.taskId) ?? null;
  const ownNeeds = state.needs.filter(
    (need) => need.sessionId === session.id && !need.supervision,
  );
  const approvedFiles = new Set(
    ownNeeds.filter((need) => need.state === 'go-ahead').flatMap((need) => need.files),
  );
  const approvedNeeds = new Set(
    ownNeeds.filter((need) => need.state === 'go-ahead').map((need) => need.id),
  );

  const touches: DriftTouch[] = [];
  for (const entry of state.history) {
    if (entry.sessionId !== session.id || entry.verification || entry.kind === 'saved-version')
      continue;
    const approved =
      Boolean(entry.authorization) || Boolean(entry.approvalId && approvedNeeds.has(entry.approvalId));
    for (const file of entry.files) {
      if (!file.recorded || file.before === file.after) continue;
      touches.push({
        ref: entry.id,
        at: entry.time,
        kind: 'file',
        target: file.path,
        access: 'write',
        status: 'recorded',
        approved: approved || approvedFiles.has(file.path),
      });
    }
  }
  for (const need of ownNeeds) {
    if (need.state === 'go-ahead' || need.state === 'expired') continue;
    for (const file of need.files)
      touches.push({
        ref: need.id,
        at: need.createdAt,
        kind: 'file',
        target: file,
        access: 'write',
        status: 'proposed',
        approved: false,
      });
  }

  const actions: DriftAction[] = [];
  const budget: DriftBudgetLine[] = [];
  if (harness) {
    const approvals = new Set(
      harness.approvals
        .filter((approval) => approval.decision === 'approved')
        .map((approval) => approval.stepId),
    );
    for (const step of harness.steps) {
      if (step.intent.kind !== 'tool') continue;
      const tool = step.intent.name || step.intent.stepId;
      const at = step.startedAt ?? harness.createdAt;
      actions.push({
        ref: step.intent.stepId,
        at,
        tool,
        inputDigest: digest(step.intent.input),
        outputDigest: step.outputHash,
      });
      const write = step.intent.effect === 'idempotent' || step.intent.effect === 'non-idempotent';
      const status = step.state === 'succeeded' ? 'recorded' : 'proposed';
      for (const target of pathsIn(step.intent.input))
        touches.push({
          ref: step.intent.stepId,
          at,
          kind: 'file',
          target,
          access: write ? 'write' : 'read',
          status,
          approved: approvals.has(step.intent.stepId),
        });
      if (step.intent.destination === 'external')
        touches.push({
          ref: step.intent.stepId,
          at,
          kind: 'destination',
          target: tool,
          access: write ? 'write' : 'read',
          status,
          approved: approvals.has(step.intent.stepId),
        });
    }
    const limit = (dimension: DriftBudgetLine['dimension'], used: number, max: number) => {
      if (max > 0) budget.push({ dimension, used, limit: max, source: `harness run ${harness.id}` });
    };
    limit('units', harness.used.units, harness.budget.units);
    limit('model-calls', harness.used.modelCalls, harness.budget.modelCalls);
    limit('tool-calls', harness.used.toolCalls, harness.budget.toolCalls);
    if (harness.budget.wallMs !== null)
      limit(
        'wall-ms',
        Math.max(0, (input.now ?? Date.now()) - Date.parse(harness.createdAt)),
        harness.budget.wallMs,
      );
    const account = [...harness.steps].reverse().map((step) => contextAccountOf(step.output)).find(Boolean);
    if (account?.window.tokens)
      budget.push({
        dimension: 'context-tokens',
        used: account.estimatedTokens,
        limit: account.window.tokens,
        source: `the ${account.model} window (${account.window.source})`,
      });
  }

  const rules: DriftRule[] = [];
  for (const file of session.instructions?.files ?? []) {
    if (file.state !== 'sent' || !file.sha) continue;
    const text = await input.instructions(file.path, file.sha);
    if (text === null) continue;
    rules.push(...machineRules(text, { path: file.path, sha: file.sha }, file.scope ?? ''));
  }

  const grants = (state.scopeGrants ?? []).filter(
    (record) => record.grant.taskId === session.taskId,
  );
  const admitted = grants.flatMap((record) =>
    record.grant.roots.map((root) => {
      const folder = root.replace(/\\/g, '/').replace(/^\.\/?$/, '').replace(/\/+$/, '');
      return folder ? `${folder}/` : './';
    }),
  );

  return {
    run: {
      id: session.id,
      taskId: session.taskId,
      live: LIVE.includes(session.state),
      startedAt: session.startedAt,
    },
    scope: {
      declared: [task?.sourceDocument, task?.from?.plan].filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      ),
      selected: [...(session.inputs?.sources ?? [])],
      admitted,
      ...(harness ? { destinations: [...harness.capabilityTools] } : {}),
    },
    touches,
    actions,
    budget,
    plan: null,
    rules,
    verification: {
      history: state.history,
      sessions: state.sessions.map(({ id, state: runState, taskId }) => ({
        id,
        state: runState,
        taskId,
      })),
      tasks: state.tasks.map(({ id, acceptance }) => ({ id, acceptance })),
    },
  };
}
