/**
 * H16 on external engines: trigger rules watch the text a Work request streams back from
 * Codex, Claude Code, OpenCode, the ACP routes (Cursor, Devin, OMP) and the model-API
 * routes (Bedrock, Vertex, Azure, OpenRouter), not only work loop runs.
 *
 * Work on those routes is a proposal: the engine's own file, shell and web tools are off,
 * its answer is the change it proposes, and only a person's approval (or a scope they
 * granted) writes it. So the stream is the one thing to watch, and a Work request passes
 * through Nectovia on its way to becoming a proposal:
 *
 * - the text is matched as it streams, piece by piece, as on a loop run. Codex hands its
 *   raw deltas over; the engine-service routes hand over their preview frames, which have
 *   already had secrets removed;
 * - a steer or a stop is handed to H15 supervision at once, which acts through H08 on the
 *   Work run: Steer where the route steers a running turn (Codex), otherwise Queue; Stop
 *   cancels the request mid-stream;
 * - before the answer can become a proposal, the watch ends on the whole answer, so a route
 *   that streamed nothing is still judged on its final text, and a stop that supervision
 *   could not apply refuses the answer: no proposal is made from it.
 *
 * What an external engine does with its own tools is not watched; see the H16 record.
 */
import type { NativeGenerator } from '../native-work.js';
import { isModelApiRoute } from '../../shared/model-api.js';
import { TEXT_DISPATCH_STEP, textRunId } from '../harness/text-route.js';
import { teamWorkRunId } from '../harness/model-session-run.js';
import type { StreamRuleService } from './service.js';

/** The run and step an external Work request's text streams in, as the route records it. */
export function workStreamPlace(input: {
  engine?: string;
  projectId: string;
  requestId: string;
  team?: unknown;
}): { runId: string; stepId: string } {
  // A model-API team turn is a NativeAgent run of its own that streams nothing; its answer is judged whole.
  if (input.engine && isModelApiRoute(input.engine) && input.team)
    return { runId: teamWorkRunId(input.projectId, input.requestId), stepId: 'answer' };
  // Codex Work is not a harness run; the Session is the record of it.
  if (input.engine === 'codex') return { runId: `codex-work-${input.requestId}`, stepId: 'codex:turn' };
  return { runId: textRunId(input.projectId, input.requestId), stepId: TEXT_DISPATCH_STEP };
}

/**
 * The Work generator, watched. With no text rule for the Work run's task, the request is
 * sent exactly as before. The Work run's Session is its request id.
 */
export function watchedGenerator(generate: NativeGenerator, rules: () => StreamRuleService): NativeGenerator {
  return async (input) => {
    const { projectId, requestId } = input;
    if (!projectId || !requestId) return generate(input);
    const watch = await rules().watchWork(
      projectId,
      requestId,
      workStreamPlace({ ...input, projectId, requestId }),
      () => input.signal?.aborted === true,
    );
    if (!watch) return generate(input);
    let result: Awaited<ReturnType<NativeGenerator>>;
    try {
      result = await generate({ ...input, onStreamText: (text) => watch.onDelta(text) });
    } catch (error) {
      await watch.end(null).catch(() => undefined);
      throw error;
    }
    // Every firing is durable and handed on before the answer can become a proposal.
    await watch.end(result.text);
    return result;
  };
}
