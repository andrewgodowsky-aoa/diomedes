import type { Json, ModelRequest, ModelResult } from '../../shared/harness.js';
import { ADAPTER_CAPABILITIES } from './adapters.js';
import { FIXTURE_ENGINE, REPORT_PATH } from './approval.js';
import type { ModelAdapter } from './native-agent.js';
import { HarnessError } from './policy.js';

function textFrom(value: Json | undefined): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string')
    throw new HarnessError('fixture_observation', 'The fixture did not return its text.');
  return value.text;
}

/** Fixed local script, not a model/provider. Resuming uses the same portable observations. */
export class ScriptedModelAdapter implements ModelAdapter {
  readonly id = FIXTURE_ENGINE;
  readonly version = 'v1';
  constructor(
    private readonly target: (
      runId: string,
    ) => Promise<{ projectId: string; expected: string | null }>,
  ) {}
  capabilities() {
    return ADAPTER_CAPABILITIES['native-fixture'];
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    signal.throwIfAborted();
    const observations = request.messages.filter((message) => message.role === 'tool');
    switch (observations.length) {
      case 0:
        return { response: { type: 'tool', name: 'read_fixture', input: {} } };
      case 1:
        return {
          response: {
            type: 'tool',
            name: 'format_lines',
            input: { text: textFrom(observations[0].output) },
          },
        };
      case 2:
        return {
          response: {
            type: 'tool',
            name: 'propose_write',
            input: {
              ...(await this.target(request.runId)),
              runId: request.runId,
              files: [REPORT_PATH],
              text: textFrom(observations[1].output),
            },
          },
        };
      case 3:
        return {
          response: {
            type: 'final',
            text: `Formatted ${REPORT_PATH}. The recorded change is in History.`,
          },
        };
      default:
        throw new HarnessError('fixture_script', 'The fixture received an unexpected observation.');
    }
  }
}
