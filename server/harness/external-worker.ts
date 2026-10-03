/**
 * An H14 worker on the person's own installed coding tool (subscription-aware orchestration S2).
 *
 * The worker is an ordinary child run driven by `NativeAgent`. Its one model step is the
 * durable record of the engine turn: a throw inside it parks the run as uncertain and the
 * turn is never sent again, a completed step replays without calling the engine, and Stop
 * cancels through the step's signal. This module only supplies the `ModelAdapter`.
 *
 * - The engine runs with its tools off and answers with text. A change it proposes is text the
 *   lead may turn into its own proposal; the worker never writes.
 * - Each check that can refuse without sending (sign-in, model, account route, the worker's
 *   documents, the context size) runs in `validatePrepared`, which the agent calls before the
 *   model step, so a refusal fails the child cleanly instead of parking it.
 * - Nothing here touches a spend ledger: the person's own subscription pays for the turn and no
 *   Nectovia credit is held or debited for it.
 * - One worker turn per engine account at a time, across every project in this process.
 */
import { createHash } from 'node:crypto';
import type { AdapterCapabilities, ModelRequest, ModelResult, PortableMessage } from '../../shared/harness.js';
import type { ExternalWorkerRoute } from '../../shared/team-delegation.js';
import type { ModelAdapter, ModelInspection } from './native-agent.js';
import { HarnessError } from './policy.js';
import { routeContractFor } from './route-contract.js';

/** What one engine admitted for a worker: its proven build, the model and the account route. */
export interface ExternalWorkerAdmission {
  readonly route: ExternalWorkerRoute;
  readonly model: string;
  readonly accountRoute: string;
  readonly version: string;
  /**
   * A finer account identity checked again at dispatch, where the engine reports one (Codex's
   * hashed ChatGPT account). Absent where the adapter checks its own account at send time.
   */
  readonly accountDigest?: string;
  /** The admitted installation, for an engine the host runs from a discovered program. */
  readonly location?: string;
}

/** One tools-off text turn. */
export interface ExternalWorkerTurn {
  readonly projectId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly documents: { path: string; text: string }[];
  readonly instructions: string;
  readonly effort?: string;
  readonly signal: AbortSignal;
}

export interface ExternalWorkerReply {
  readonly text: string;
  readonly model: string | null;
  readonly version: string;
  readonly threadId?: string | null;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } | null;
}

/**
 * The host's engines, as a worker reaches them. `admit` refuses by throwing, before anything is
 * sent. `send` runs one turn and never retries.
 */
export interface ExternalWorkerPort {
  admit(
    route: ExternalWorkerRoute,
    input: { readonly projectId: string; readonly model: string | null; readonly accountRoute: string | null },
    signal?: AbortSignal,
  ): Promise<ExternalWorkerAdmission>;
  send(route: ExternalWorkerRoute, admission: ExternalWorkerAdmission, turn: ExternalWorkerTurn): Promise<ExternalWorkerReply>;
}

/** The context one worker turn may carry, the same limit a conversation turn has. */
export const EXTERNAL_WORKER_CONTEXT_BYTES = 160_000;
/** The longest answer a lead takes from an external worker. A longer one is kept as evidence and refused. */
export const EXTERNAL_WORKER_ANSWER_CHARS = 48_000;
/** How long an admission is reused between the checks around one model step. */
const ADMISSION_REUSE_MS = 30_000;
const ADAPTER_PROTOCOL = 'external-worker-turn/1';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** One worker turn per engine account at a time: a second waits for the first to end. */
export class ExternalWorkerGate {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = prior.then(() => mine);
    this.tails.set(key, tail);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new HarnessError('cancelled', 'The worker was stopped while it waited.'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        void prior.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return await task();
    } finally {
      release();
      // The entry goes only once every turn queued up to this one has ended: a turn stopped while
      // it waited must not let the next one run beside the turn still in flight.
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
  }

  /** Whether a turn holds or waits for this account, for tests and status only. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}

/** The worker's portable messages as one prompt. A first turn is the lead's task alone. */
export function workerPrompt(messages: readonly PortableMessage[]): string {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].text ?? '';
  return messages
    .map((message) => {
      if (!message.text) return '';
      if (message.role === 'user') return `Task:\n${message.text}`;
      if (message.role === 'assistant') return `Your earlier answer:\n${message.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Bytes a turn sends, measured the way the engines' own context check measures them. */
export function workerContextBytes(prompt: string, documents: readonly { path: string; text: string }[], instructions: string): number {
  return Buffer.byteLength(JSON.stringify({ request: prompt, documents }), 'utf8') + Buffer.byteLength(instructions, 'utf8');
}

export interface ExternalWorkerSpec {
  readonly route: ExternalWorkerRoute;
  readonly projectId: string;
  readonly runId: string;
  /** The model and account route the child was admitted with; the engine must still report them. */
  readonly model: string | null;
  readonly accountRoute: string | null;
  /** The account identity the child was admitted under, where the engine reports one. */
  readonly accountDigest?: string | null;
  readonly instructions: string;
  readonly effort?: string | null;
  /** The worker's files, read and checked against cloud sharing by the host. Throws to refuse. */
  readonly documents: () => Promise<{ path: string; text: string }[]>;
  readonly stop: AbortSignal;
  readonly gate: ExternalWorkerGate;
  /** For tests: the clock admission reuse is measured by. */
  readonly now?: () => number;
}

/**
 * The adapter one external worker child is driven with. Its descriptor comes from the route's
 * registered contract, so a refused admission still builds an adapter: the refusal surfaces in
 * `validatePrepared` and fails the child before any step goes out.
 */
export async function externalWorkerAdapter(port: ExternalWorkerPort, spec: ExternalWorkerSpec): Promise<ModelAdapter> {
  const now = spec.now ?? Date.now;
  const contract = routeContractFor(spec.route);
  let admission: { value: ExternalWorkerAdmission; at: number } | null = null;
  let refusal: unknown = null;
  const admit = async (signal?: AbortSignal) => {
    const value = await port.admit(spec.route, { projectId: spec.projectId, model: spec.model, accountRoute: spec.accountRoute }, signal);
    if ((spec.model !== null && value.model !== spec.model) || (spec.accountRoute !== null && value.accountRoute !== spec.accountRoute))
      throw new HarnessError(
        'external_worker_changed',
        `${routeName(spec.route)} is set up differently from when this worker was admitted. Check it in AI setup, then retry.`,
      );
    // Another account on the same route: the engine's own reading of who is signed in moved.
    if (spec.accountDigest && value.accountDigest !== spec.accountDigest)
      throw new HarnessError(
        'external_worker_changed',
        `A different account is signed in to ${routeName(spec.route)} than when this worker was admitted, so its turn wasn't sent. Retry to send it under the account signed in now.`,
      );
    admission = { value, at: now() };
    return value;
  };
  try {
    await admit(spec.stop);
  } catch (error) {
    refusal = error;
  }
  const version = (admission as { value: ExternalWorkerAdmission } | null)?.value.version || contract.engine.version;
  // What validatePrepared read for the request it checked, so the step sends exactly that.
  let prepared: { key: string; documents: { path: string; text: string }[]; prompt: string } | null = null;

  const check = async (request: ModelRequest) => {
    if (refusal) throw refusal;
    if (request.tools.length)
      throw new HarnessError('external_worker_tools', "An external worker runs with its tools off, so it can't be offered any.");
    const current = admission as { value: ExternalWorkerAdmission; at: number } | null;
    if (!current || now() - current.at > ADMISSION_REUSE_MS) await admit(spec.stop);
    const key = sha256(JSON.stringify(request.messages));
    if (prepared?.key === key) return;
    const documents = await spec.documents();
    const prompt = workerPrompt(request.messages);
    if (workerContextBytes(prompt, documents, spec.instructions) > EXTERNAL_WORKER_CONTEXT_BYTES)
      throw new HarnessError(
        'external_worker_context',
        `This task and its files come to more than ${EXTERNAL_WORKER_CONTEXT_BYTES / 1000} KB, which one ${routeName(spec.route)} turn can't take. Give the worker fewer files.`,
      );
    prepared = { key, documents, prompt };
  };

  return {
    id: spec.route,
    version,
    destination: 'external',
    contract,
    capabilities: (): AdapterCapabilities => ({
      engineId: spec.route,
      engineVersion: version,
      protocolVersion: ADAPTER_PROTOCOL,
      modelCalls: 'observed',
      toolCalls: 'unsupported',
      filesystemWrites: 'unsupported',
      networkEgress: 'observed',
      approvals: 'unsupported',
      resumability: 'unsupported',
      cancellability: 'observed',
      checkpointGranularity: 'turn',
      notes: [
        'One text turn on the person\'s own installed coding tool with its tools off. The engine keeps its own model calls; Diomedes records the turn and its reported model.',
        'The person\'s own subscription pays for the turn. No Nectovia credit is held or debited.',
      ],
    }),
    validatePrepared: check,
    async complete(request, signal): Promise<ModelResult> {
      const callSignal = AbortSignal.any([signal, spec.stop]);
      callSignal.throwIfAborted();
      const key = sha256(JSON.stringify(request.messages));
      const turn = prepared?.key === key ? prepared : null;
      if (!turn) throw new HarnessError('external_worker_unprepared', 'This worker turn was not checked before sending.');
      const value = (admission as { value: ExternalWorkerAdmission } | null)?.value;
      if (!value) throw new HarnessError('external_worker_unadmitted', 'This worker was not admitted.');
      const requestId = `${spec.runId}-${key.slice(0, 16)}`;
      const reply = await spec.gate.run(`${spec.route}:${value.accountDigest ?? value.accountRoute}`, callSignal, () =>
        port.send(spec.route, value, {
          projectId: spec.projectId,
          threadId: `team-worker-${spec.runId}`,
          requestId,
          prompt: turn.prompt,
          documents: turn.documents,
          instructions: spec.instructions,
          ...(typeof spec.effort === 'string' ? { effort: spec.effort } : {}),
          signal: callSignal,
        }),
      );
      callSignal.throwIfAborted();
      if (typeof reply.text !== 'string' || !reply.text.trim())
        throw new HarnessError('external_worker_empty', `${routeName(spec.route)} returned no answer.`);
      return {
        response: { type: 'final', text: reply.text },
        transcript: {
          providerId: spec.route,
          modelId: reply.model,
          lineageId: spec.runId,
          opaqueRef: reply.threadId ?? requestId,
          prefixHash: sha256(JSON.stringify({ prompt: turn.prompt, documents: turn.documents, instructions: spec.instructions })),
        },
        usage: reply.usage
          ? {
              ...(typeof reply.usage.inputTokens === 'number' ? { inputTokens: reply.usage.inputTokens } : {}),
              ...(typeof reply.usage.outputTokens === 'number' ? { outputTokens: reply.usage.outputTokens } : {}),
            }
          : null,
      };
    },
    // The answer is kept as evidence either way; one longer than a lead takes is refused, not cut.
    async inspect(_request, text): Promise<ModelInspection> {
      if (text.length > EXTERNAL_WORKER_ANSWER_CHARS)
        return {
          action: 'refuse',
          message: `${routeName(spec.route)} answered with more than ${EXTERNAL_WORKER_ANSWER_CHARS.toLocaleString('en-US')} characters, so the lead didn't take it. Ask for a shorter answer.`,
          rules: [],
        };
      return { action: 'verified', message: 'The answer fits what a lead takes from a worker.', rules: [] };
    },
  };
}

/** The engine's name as the AI setup screen shows it. */
export function routeName(route: ExternalWorkerRoute): string {
  return route === 'claude-code' ? 'Claude Code' : route === 'codex' ? 'Codex' : 'OpenCode';
}
