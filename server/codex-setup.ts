import fs from 'node:fs/promises';
import type { CodexSetupView } from '../shared/codex-setup.js';
import type { IntegrationStatus } from '../shared/types.js';
import {
  CODEX_EXECUTABLE,
  createCodexLoginClient,
  getIntegrationStatuses,
  type NativeRpc,
} from './integrations.js';
import { ApiError } from './paths.js';

interface Dependencies {
  supported: boolean;
  installed: () => Promise<boolean>;
  createClient: () => Promise<NativeRpc>;
  inspect: () => Promise<IntegrationStatus>;
  timeoutMs: number;
}

/** Account OAuth only. No thread, prompt, API key, credential copy or automatic enable. */
export class CodexSetup {
  private readonly deps: Dependencies;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private current: {
    client: NativeRpc;
    id: string;
    unsubscribe: () => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private state: Omit<CodexSetupView, 'supported' | 'installed'> = {
    login: 'idle',
    authUrl: null,
    detail: '',
    integration: null,
  };

  constructor(overrides: Partial<Dependencies> = {}) {
    this.deps = {
      supported: process.platform === 'win32',
      installed: async () => {
        try {
          return (await fs.stat(CODEX_EXECUTABLE)).isFile();
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
          throw error;
        }
      },
      createClient: createCodexLoginClient,
      inspect: async () => {
        const status = (await getIntegrationStatuses({ refresh: true })).find(
          (item) => item.id === 'codex',
        );
        if (!status) throw new ApiError(503, 'ChatGPT connection status is unavailable.');
        return status;
      },
      timeoutMs: 600_000,
      ...overrides,
    };
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.then(action);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async view(): Promise<CodexSetupView> {
    return {
      ...this.state,
      supported: this.deps.supported,
      installed: await this.deps.installed(),
    };
  }

  /** The desktop may open only this active runtime-issued login URL, never a host-wide exception. */
  allowsReference(destination: string): boolean {
    return !this.closed && this.current !== null && this.state.authUrl === destination;
  }

  private async ready(consent: boolean) {
    if (this.closed) throw new ApiError(503, 'The app is closing.');
    if (!consent) throw new ApiError(400, 'Confirm checking or signing in to ChatGPT.');
    if (!this.deps.supported)
      throw new ApiError(400, 'ChatGPT through Codex is supported on Windows.');
    if (!(await this.deps.installed()))
      throw new ApiError(
        503,
        'The bundled Codex runtime is missing. Reinstall Nectovia to restore it.',
      );
  }

  check(consent: boolean) {
    return this.exclusive(async () => {
      await this.ready(consent);
      this.state.integration = await this.deps.inspect();
      return this.view();
    });
  }

  start(consent: boolean) {
    return this.exclusive(async () => {
      await this.ready(consent);
      if (this.current) return this.view();
      const client = await this.deps.createClient();
      const unsubscribe = client.onNotification((method, params) => {
        if (method !== 'account/login/completed') return;
        void this.exclusive(async () => {
          if (!this.current || this.current.client !== client || params.loginId !== this.current.id)
            return;
          await this.dispose(false);
          this.state.login = params.success === true ? 'finished' : 'failed';
          this.state.detail =
            params.success === true
              ? 'Sign-in finished. Check the connection to verify the account and read-only boundary.'
              : 'ChatGPT sign-in did not complete. Try signing in again.';
          // A native login notification is not proof that this route can execute.
          this.state.integration = null;
        }).catch(() => {
          this.state.login = 'failed';
          this.state.detail =
            'The sign-in process could not close. Restart Nectovia before trying again.';
        });
      });
      try {
        const result = (await client.request('account/login/start', { type: 'chatgpt' })) as Record<
          string,
          unknown
        >;
        const url = new URL(typeof result.authUrl === 'string' ? result.authUrl : '');
        if (
          result.type !== 'chatgpt' ||
          typeof result.loginId !== 'string' ||
          !result.loginId ||
          url.origin !== 'https://auth.openai.com' ||
          url.username ||
          url.password ||
          url.pathname !== '/oauth/authorize'
        )
          throw new ApiError(502, 'The runtime returned an unsupported ChatGPT sign-in response.');
        const timer = setTimeout(() => {
          void this.exclusive(async () => {
            if (this.current?.client !== client) return;
            await this.dispose(true);
            this.state.login = 'cancelled';
            this.state.detail = 'ChatGPT sign-in expired. Start again to get a new link.';
          }).catch(() => {
            this.state.login = 'failed';
            this.state.detail =
              'The sign-in process could not close. Restart Nectovia before trying again.';
          });
        }, this.deps.timeoutMs);
        timer.unref();
        this.current = { client, id: result.loginId, unsubscribe, timer };
        this.state = {
          login: 'waiting',
          authUrl: url.href,
          detail: 'Finish signing in on OpenAI, then check the connection here.',
          integration: null,
        };
        return this.view();
      } catch (error) {
        unsubscribe();
        await client.close();
        throw error;
      }
    });
  }

  private async dispose(cancel: boolean) {
    const held = this.current;
    if (!held) return;
    this.current = null;
    this.state.authUrl = null;
    clearTimeout(held.timer);
    held.unsubscribe();
    try {
      if (cancel) await held.client.request('account/login/cancel', { loginId: held.id });
    } finally {
      await held.client.close();
    }
  }

  cancel() {
    return this.exclusive(async () => {
      await this.dispose(true);
      this.state.login = 'cancelled';
      this.state.detail = 'Sign-in cancelled.';
      return this.view();
    });
  }

  close() {
    this.closed = true;
    return this.exclusive(() => this.dispose(true));
  }
}
