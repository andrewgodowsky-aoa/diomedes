/**
 * The host's engines as H14 external workers reach them (subscription-aware orchestration S2).
 *
 * Claude Code and OpenCode run through `EngineService`: the same discovery, sign-in, model and
 * account-route checks a conversation turn runs, then one call to the engine's own adapter with
 * its tools off. Codex runs through `askCodex` on a fresh, guarded thread: its ChatGPT account is
 * read at admission and checked again just before the turn is sent.
 *
 * Every engine here is the person's own installed program, signed in through its provider's own
 * flow. Nothing here holds a credential, opens a consumer chat session or debits Nectovia credits.
 */
import { CODEX_ACCOUNT_ROUTE } from './engines/codex-session.js';
import type { EngineService } from './engines/service.js';
import { routeName, type ExternalWorkerPort } from './harness/external-worker.js';
import { HarnessError } from './harness/policy.js';
import type { askCodex as AskCodex } from './integrations.js';

export interface CodexWorkerDeps {
  /** A fresh app-server's build and ChatGPT account route; refuses any other sign-in. */
  admission(): Promise<{ accountRoute: string; version: string }>;
  ask: typeof AskCodex;
}

export function engineWorkerPort(
  engines: Pick<EngineService, 'admitWorkerTurn' | 'workerTurn'>,
  codex: CodexWorkerDeps | null,
  services: () => Record<string, unknown> | undefined,
): ExternalWorkerPort {
  return {
    async admit(route, input, signal) {
      const name = routeName(route);
      if (!input.model) throw new HarnessError('external_worker_model', `Choose a model for ${name} in AI setup first.`);
      if (route === 'codex') {
        if (!codex) throw new HarnessError('external_worker_unavailable', `${name} can't work for a team on this computer.`);
        const saved = services()?.codexAccountRoute;
        const accountRoute = typeof saved === 'string' ? saved : CODEX_ACCOUNT_ROUTE;
        if (input.accountRoute !== null && input.accountRoute !== accountRoute)
          throw new HarnessError('external_worker_changed', `The ${name} sign-in changed. Set it up again in AI setup.`);
        signal?.throwIfAborted();
        const admitted = await codex.admission();
        return { route, model: input.model, accountRoute, version: admitted.version, accountDigest: admitted.accountRoute };
      }
      if (!input.accountRoute) throw new HarnessError('external_worker_account', `Set up ${name} in AI setup first.`);
      const admitted = await engines.admitWorkerTurn(route, { model: input.model, accountRoute: input.accountRoute }, signal);
      return {
        route,
        model: admitted.model,
        accountRoute: admitted.accountRoute,
        version: admitted.version,
        location: admitted.location,
      };
    },
    async send(route, admission, turn) {
      if (route === 'codex') {
        if (!codex || !admission.accountDigest)
          throw new HarnessError('external_worker_unavailable', 'This Codex worker has no admitted ChatGPT account.');
        const result = await codex.ask({
          prompt: turn.prompt,
          documents: turn.documents,
          signal: turn.signal,
          model: admission.model,
          instructions: turn.instructions,
          ...(turn.effort ? { effort: turn.effort } : {}),
          // A guarded dispatch: a fresh thread, no read scope and no team tools, sent only while the
          // ChatGPT account is still the one this worker was admitted under.
          beforeDispatch: async (identity) => {
            if (identity.accountRoute !== admission.accountDigest)
              throw new HarnessError('egress_denied', 'The ChatGPT account on this computer changed after this worker was admitted.');
          },
        });
        return {
          text: result.text,
          model: result.model ?? null,
          version: result.version ?? admission.version,
          threadId: result.threadId ?? null,
          usage: null,
        };
      }
      if (!admission.location) throw new HarnessError('external_worker_unadmitted', 'This worker has no admitted installation.');
      const result = await engines.workerTurn(
        route,
        {
          engine: route,
          location: admission.location,
          version: admission.version,
          model: admission.model,
          accountRoute: admission.accountRoute,
        },
        {
          projectId: turn.projectId,
          threadId: turn.threadId,
          requestId: turn.requestId,
          prompt: turn.prompt,
          documents: turn.documents,
          instructions: turn.instructions,
          ...(turn.effort ? { effort: turn.effort } : {}),
          signal: turn.signal,
        },
      );
      return { text: result.text, model: result.model ?? null, version: result.version, threadId: null, usage: null };
    },
  };
}
