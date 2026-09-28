import { routingReceiptPageSchema, routingReceiptSchema, type RoutingReceiptPage } from '../../shared/routing-policy.js';
import { ApiError } from '../paths.js';
import { HarnessError } from './policy.js';
import type { RunService } from './run-service.js';
import type { ModelSessionRuns } from './model-session-run.js';

/** Project/thread-scoped projection of existing records. No prompts, tools or native state leave this reader. */
export async function conversationRoutingReceipts(input: {
  projectId: string; threadId: string;
  /** Model-API lineage ids taken by the host from this thread, oldest first. */
  lineageIds: readonly string[];
  before?: string | null;
  models: Pick<ModelSessionRuns, 'get' | 'turnRun'>;
  runs: Pick<RunService, 'get'>;
}): Promise<RoutingReceiptPage> {
  const { projectId, threadId, models, runs } = input;
  const before = input.before ?? null;
  if (before !== null && (before.length === 0 || before.length > 400))
    throw new ApiError(400, 'Choose a recorded page of run details.');
  const entries: RoutingReceiptPage['entries'] = [];
  let skipping = before !== null, visited = 0, lastCursor: string | null = null;
  for (const lineageId of [...input.lineageIds].reverse()) {
    let parent: Awaited<ReturnType<typeof models.get>>;
    try { parent = await models.get(projectId, lineageId); }
    catch (error) {
      if (error instanceof HarnessError && error.code === 'unknown_run') continue;
      throw error;
    }
    const scope = parent.input;
    if (parent.projectId !== projectId || !scope || typeof scope !== 'object' || Array.isArray(scope) || scope.threadId !== threadId)
      throw new ApiError(409, 'A recorded conversation has inconsistent scope.');
    for (const turn of [...parent.steps].reverse()) {
      if (!turn.intent.stepId.startsWith('turn:')) continue;
      const cursor = `${parent.id}/${turn.intent.stepId}`;
      if (skipping) { if (cursor === before) skipping = false; continue; }
      if (visited === 20) return routingReceiptPageSchema.parse({ entries, nextBefore: lastCursor });
      visited++; lastCursor = cursor;
      const request = turn.intent.input;
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.requestId !== 'string')
        throw new ApiError(409, 'A recorded message has no verifiable command identity.');
      const child = await models.turnRun(projectId, parent.id, request.requestId);
      if (!child) continue;
      const records = [child];
      try { records.push(await runs.get(`${child.id}-writing`)); }
      catch (error) {
        if (!(error instanceof HarnessError && error.code === 'unknown_run')) throw error;
      }
      for (const record of records) {
        const recorded = record.input;
        if (record.projectId !== projectId || record.tenantId !== parent.tenantId || record.capabilityId !== 'model-api-turn' ||
            !recorded || typeof recorded !== 'object' || Array.isArray(recorded) ||
            recorded.conversationRunId !== parent.id || recorded.commandId !== request.requestId)
          throw new ApiError(409, 'A recorded model attempt has inconsistent scope.');
        for (const step of record.steps) {
          if (step.intent.kind !== 'model') continue;
          const output = step.output;
          const success = output && typeof output === 'object' && !Array.isArray(output) ? output.managed : undefined;
          const failure = step.error && 'managed' in step.error ? step.error.managed : undefined;
          const raw = success ?? failure;
          if (raw === undefined) continue;
          const receipt = routingReceiptSchema.safeParse(raw);
          if (!receipt.success) throw new ApiError(409, 'A recorded managed attempt cannot be verified.');
          entries.push({ runId: record.id, stepId: step.intent.stepId, receipt: receipt.data });
        }
      }
    }
  }
  if (skipping) throw new ApiError(400, 'This page is no longer available. Read the latest messages.');
  return routingReceiptPageSchema.parse({ entries, nextBefore: null });
}
