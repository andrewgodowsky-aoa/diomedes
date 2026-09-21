import { randomUUID } from 'node:crypto';
import { EngineService, TESTED_VERSIONS } from '../../server/engines/service';
import type { PersistentTextAdapter } from '../../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../../server/engines/claude-session';
import { routeContractFor } from '../../server/harness/route-contract';
import { hash } from '../../server/store';

// A Claude Code provider that answers by script, for the Diomedes page's browser spec. Everything
// above it is real: the Store, the Runtime, the session driver and both admissions. It starts no
// native engine, reads no credentials and contacts nobody. `tests/interaction-seam.test.ts` holds
// the same script over HTTP; this one leaves out that file's lock instrumentation.

export const SCRIPTED_MODEL = 'claude-fixture';
const ACCOUNT_ROUTE = 'claude-code:claude.ai';

/**
 * The fake model. It reads the issued identity off the last line, as the instructions tell a real
 * one to. A message starting with ACT proposes internal work; anything else is an ordinary answer.
 */
export function scripted(prompt: string): string {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  if (!text.startsWith('ACT') || !issued) return `You said: ${text}`;
  const decision = {
    source_message_id: issued,
    disposition: 'act',
    requested_project_id: null,
    operation_class: 'write_internal',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: `Do this: ${text}`,
  };
  return `I can start that.\n\n\`\`\`diomedes-decision\n${JSON.stringify(decision)}\n\`\`\``;
}

export function scriptedEngineService(enginesDir: string, cwd: string): EngineService {
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute: ACCOUNT_ROUTE,
      detail: 'Fixture only',
      models: [
        {
          slug: SCRIPTED_MODEL,
          name: SCRIPTED_MODEL,
          description: '',
          efforts: [],
          defaultEffort: null,
        },
      ],
    }),
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = options.restore
        ? structuredClone(options.restore)
        : {
            version: 1,
            nativeSessionId: randomUUID(),
            lineageId: randomUUID(),
            parentSessionId: null,
            projectId: input.projectId,
            threadId: input.threadId,
            cwd,
            cliVersion: TESTED_VERSIONS['claude-code'],
            accountDigest: hash('fixture-account')!,
            requestedModel: input.model,
            reportedModel: null,
            instructionDigest: hash(input.instructions)!,
            state: 'idle',
            requests: [],
            results: [],
          };
      const signal = new AbortController().signal;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return checkpoint.nativeSessionId
            ? {
                providerId: 'claude-code',
                lineageId: checkpoint.lineageId,
                opaqueRef: checkpoint.nativeSessionId,
              }
            : null;
        },
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          const text = scripted(turn.prompt);
          turn.onDelta?.(text);
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: SCRIPTED_MODEL,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model: SCRIPTED_MODEL,
            version: TESTED_VERSIONS['claude-code'],
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => {
          throw new Error('No held turn in this fixture');
        },
        close: async () => undefined,
      };
    },
  };
  return new EngineService(enginesDir, {
    discover: async () => [
      {
        id: 'claude-code',
        name: 'Fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS['claude-code'],
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS['claude-code'],
    adapter: () => adapter,
  });
}
