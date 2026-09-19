/**
 * A real runtime seam for standalone EngineService tests.
 *
 * `fixtureTextDispatch` builds the same machinery `createHarnessHost` wires —
 * a FileRunStore-backed RunService, the text-route authorizer over a settings
 * record, and the TextRouteRuntime's `request` — so a test's EngineService
 * exercises the durable run path rather than a stubbed dispatch. Only the
 * provider transport stays scripted, through the adapter the test supplies.
 */
import path from 'node:path';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { HarnessError } from '../server/harness/policy.js';
import {
  ENGINE_TEXT_TURN,
  TextRouteRuntime,
  textDispatchAuthorizer,
  type TextDispatch,
} from '../server/harness/text-route.js';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import type { TextRequest, TextResponse } from '../server/engines/contract.js';

export function fixtureTextDispatch(
  root: string,
  services: Record<string, unknown> = {},
): { dispatch: TextDispatch; runs: RunService } {
  const settings: Record<string, unknown> = {};
  for (const engine of EXTERNAL_ENGINES) {
    settings[engine] = true;
    settings[`${engine}AccountRoute`] = 'fixture:account';
  }
  Object.assign(settings, services);
  const authorize = textDispatchAuthorizer(() => settings);
  const runs: RunService = new RunService(new FileRunStore(path.join(root, 'harness-runs')), {
    authorizeEgress: async (runId, intent, _principal, phase) => {
      const run = await runs.get(runId);
      if (run.capabilityId !== ENGINE_TEXT_TURN.id)
        throw new HarnessError('egress_denied', 'This run is not a text-route run.');
      return authorize(run, intent, phase);
    },
  });
  return { dispatch: new TextRouteRuntime(runs).request, runs };
}

/** A clean provider response — what a real adapter constructs, never an echo of the request. */
export function textResponse(input: TextRequest, text: string, version: string): TextResponse {
  return {
    projectId: input.projectId,
    threadId: input.threadId,
    requestId: input.requestId,
    model: input.model,
    version,
    text,
  };
}
