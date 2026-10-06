import fs from 'node:fs';
import path from 'node:path';
import { parseLocalModelDescriptor, type LocalModelStatus } from '../../shared/local-model.js';
import type { LocalModelSetup, LocalModelSource } from '../../server/bonsai/descriptor.js';
import { LocalModelError, type LocalModelHost } from '../../server/bonsai/runtime.js';

/**
 * Bonsai's own `nectovia-connection.json`, copied verbatim from F:\Bonsai-2 on 2026-10-05. Tests
 * read this copy and never the folder itself, and nothing here starts a model or reaches its server.
 */
export const BONSAI_FOLDER = 'F:\\Bonsai-2';
export const BONSAI_DESCRIPTOR = {
  name: 'Bonsai 2 Local',
  status: 'prepared_connection_details_not_a_native_import_format',
  model: 'bonsai-2-27b',
  openaiCompatibleBaseUrl: 'http://127.0.0.1:18082/v1',
  anthropicCompatibleBaseUrl: 'http://127.0.0.1:18082',
  authentication: 'No API key required on the loopback server. If a client requires a nonempty key, use the placeholder bonsai-local.',
  profiles: {
    Gaming: { contextTokens: 16384, inputModalities: ['text'], codexProfile: 'bonsai', reasoningBudget: 2048, outputTokens: 4096 },
    Full: { contextTokens: 131072, inputModalities: ['text', 'image'], codexProfile: 'bonsai-full', defaultReasoningEffort: 'xhigh',
      reasoningBudget: 16384, outputTokens: 32768 },
  },
  mcpServer: { command: 'F:\\Bonsai-2\\mcp-env\\Scripts\\python.exe', args: ['F:\\Bonsai-2\\bonsai_mcp.py'],
    tools: ['bonsai_status', 'bonsai_ask', 'bonsai_delegate'] },
  lifecycle: { startScript: 'F:\\Bonsai-2\\Start-Bonsai.ps1', startModeArgument: '-Mode Gaming or -Mode Full',
    stopScript: 'F:\\Bonsai-2\\Stop-Bonsai.ps1', healthUrl: 'http://127.0.0.1:18082/health', separateFromLocalAI: true },
  integrationBoundary: 'Optional local worker or provider behind Nectovia\'s existing engine and Trust interfaces. Do not replace a cloud default or expand tool authority merely by selecting this model.',
  verification: { gamingTextAndTools: 'passed', full64kTextImagesAndCodex: 'passed_historical_configuration',
    full128kTextImagesAndCodex: 'passed', full128kLongInput: 'passed_96638_token_prompt_three_checkpoint_retrieval_175_33_seconds',
    mcpGamingAndFull: 'passed_5_checks_each_including_inference_and_read_only_subagent', nectoviaInstalledAppSelection: 'not_performed' },
  repositoryReferences: { integrationWorktree: 'F:\\Diomedes\\diomedes-wt\\bonsai-agent-integration',
    integrationThreadId: '01a10483-7356-7f32-b089-f48b279a3ce5',
    note: 'The integration chat reads the current repository contracts; this standalone connection spec is not an authority source.' },
};
export const BONSAI_MODEL = BONSAI_DESCRIPTOR.model;

/**
 * Another model, so nothing passes only because it is Bonsai: other names, another port, other
 * profiles, and scripts named relative to the folder.
 */
export const MEADOW_MODEL = 'meadow-9b';
export function meadowDescriptor(base = 'http://127.0.0.1:18100') {
  return {
    name: 'Meadow Local',
    model: MEADOW_MODEL,
    openaiCompatibleBaseUrl: `${base}/v1`,
    profiles: {
      Quick: { contextTokens: 16384, inputModalities: ['text'], outputTokens: 4096 },
      Deep: { contextTokens: 131072, inputModalities: ['text', 'image'], outputTokens: 32768, defaultReasoningEffort: 'xhigh' },
    },
    lifecycle: { startScript: 'Start-Meadow.ps1', startModeArgument: '-Profile Quick or -Profile Deep',
      stopScript: 'scripts\\Stop-Meadow.ps1', healthUrl: `${base}/health` },
  };
}
export const MEADOW_FOLDER = 'D:\\Models\\Meadow';

/** Turns an accounted test answer into the final-chunk order used by llama.cpp. */
export function localAnswerStream(answer: {
  id: string; model: string; choices: { finish_reason: string; message: Record<string, unknown> }[];
  usage?: unknown; timings?: unknown;
}, progress?: { total: number; cache: number; processed: number; time_ms: number }) {
  const envelope = { id: answer.id, model: answer.model };
  const choice = answer.choices[0];
  const calls = choice.message.tool_calls as Record<string, unknown>[] | undefined;
  const delta = { ...choice.message, ...(calls ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) };
  const chunks = [
    ...(progress ? [{ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }], prompt_progress: progress }] : []),
    { ...envelope, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], timings: answer.timings },
    { ...envelope, choices: [], usage: answer.usage },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A source that answers with one descriptor, checked by the shared parser, the way a folder that
 * passed every check does. `use(null)` is a computer with no folder set; `use(raw)` a new file.
 */
export class FixedLocalModel implements LocalModelSource {
  private setup: LocalModelSetup = { kind: 'none' };
  private generation = 0;
  constructor(raw: unknown | null = BONSAI_DESCRIPTOR, folder = BONSAI_FOLDER) {
    this.use(raw, folder);
  }
  use(raw: unknown | null, folder = BONSAI_FOLDER) {
    this.generation += 1;
    this.setup = raw === null ? { kind: 'none' } : {
      kind: 'ready', folder: { path: folder, source: 'settings' },
      descriptor: parseLocalModelDescriptor(raw, folder), key: `fixture-${this.generation}`,
    };
    return this;
  }
  read(): LocalModelSetup {
    return this.setup;
  }
}

/** Writes a model folder: its descriptor and empty start and stop scripts where it names them. */
export function writeLocalModelFolder(folder: string, raw: Record<string, unknown> & { lifecycle?: Record<string, unknown> }) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'nectovia-connection.json'), JSON.stringify(raw, null, 2));
  for (const key of ['startScript', 'stopScript']) {
    const script = raw.lifecycle?.[key];
    if (typeof script !== 'string') continue;
    const relative = script.replace(/\\/g, '/');
    const target = path.isAbsolute(relative) || /^[A-Za-z]:\//.test(relative) ? relative : path.join(folder, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# A test fixture. It is never run.\n');
  }
  return folder;
}

/**
 * A host that keeps the helper's rules with no process and no network: a status it is told, and
 * an acquire that only starts or switches a profile for an explicit Start.
 */
export function fakeLocalHost(initial: Partial<LocalModelStatus> = {}) {
  const state = {
    status: { state: 'unloaded', installed: true, mode: null, owned: false, detail: 'Not running.', ...initial } as LocalModelStatus,
    starts: [] as string[],
    refuse: null as LocalModelError | null,
  };
  const host: LocalModelHost = {
    inspect: async () => ({ ...state.status }),
    acquire: async (profile, options, descriptor) => {
      const running = state.status.state === 'ready' && state.status.mode === profile.mode;
      if (!running) {
        if (!options?.start) throw new LocalModelError('unloaded', "The local model isn't running. Start it first.");
        if (state.refuse) throw state.refuse;
        state.starts.push(profile.slug);
        state.status = { state: 'ready', installed: true, mode: profile.mode, model: descriptor.model,
          contextTokens: profile.contextTokens, owned: true, detail: `${descriptor.model} ${profile.mode} is ready.` };
      }
      return { status: { ...state.status }, release: async () => {} };
    },
  };
  return { host, state };
}
