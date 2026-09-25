import { useCallback, useEffect, useState } from 'react';
import type { CodexSetupView } from '../shared/codex-setup';
import type { Settings } from '../shared/types';
import { api } from './api';
import { Button } from './components';

export function CodexSetup({
  settings,
  save,
  busy = false,
  embedded = false,
  onChecked,
}: {
  settings: Settings;
  save: (settings: Settings) => Promise<void>;
  busy?: boolean;
  embedded?: boolean;
  onChecked?: () => void;
}) {
  const [view, setView] = useState<CodexSetupView | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<CodexSetupView>('/ai/codex', 'GET', undefined, signal);
      if (!signal?.aborted) setView(next);
    } catch (reason) {
      if (!signal?.aborted)
        setError(reason instanceof Error ? reason.message : 'Could not read ChatGPT setup.');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (view?.login !== 'waiting' || working) return;
    const controller = new AbortController();
    const timer = setInterval(() => void load(controller.signal), 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [view?.login, working, load]);

  const run = async (action: () => Promise<void>) => {
    if (working || busy) return;
    setWorking(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ChatGPT setup could not complete.');
    } finally {
      setWorking(false);
    }
  };
  const check = () =>
    run(async () => {
      if (!settings.onboarding.discoveryConsentAt)
        await save({
          ...settings,
          onboarding: { ...settings.onboarding, discoveryConsentAt: new Date().toISOString() },
        });
      setView(await api<CodexSetupView>('/ai/codex/check', 'POST', { consent: true }));
      onChecked?.();
    });
  const disabled = busy || working;
  const controls = (
    <>
      {view && (
        <p className="caption">
          {!view.supported
            ? 'This route currently supports Windows.'
            : view.installed
              ? 'Codex is bundled with Nectovia. No separate ChatGPT app or Codex installation is needed.'
              : 'The bundled runtime is missing. Reinstall Nectovia to restore it.'}
        </p>
      )}
      <p className="caption">
        Uses the native Codex account on this computer. Signing in can change that account. ChatGPT
        subscription usage applies to Ask, Plan, and Work in projects.
      </p>
      <p className="caption">
        Check connection reads installed tools, versions, account status and model lists, and
        verifies the read-only boundary. It sends no model prompt.
      </p>
      <div className="actions">
        <Button
          disabled={disabled || !view?.supported || !view.installed}
          onClick={() => void check()}
        >
          Check ChatGPT connection
        </Button>
        {view?.login === 'waiting' ? (
          <>
            {view.authUrl && (
              <a href={view.authUrl} target="_blank" rel="noreferrer">
                Continue to OpenAI
              </a>
            )}
            <Button
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  setView(await api<CodexSetupView>('/ai/codex/cancel', 'POST'));
                })
              }
            >
              Cancel ChatGPT sign-in
            </Button>
          </>
        ) : (
          <Button
            disabled={disabled || !view?.supported || !view.installed}
            onClick={() =>
              void run(async () => {
                setView(await api<CodexSetupView>('/ai/codex/login', 'POST', { consent: true }));
              })
            }
          >
            Sign in to ChatGPT
          </Button>
        )}
      </div>
      {view?.detail && <p role="status">{view.detail}</p>}
      {view?.integration && (
        <p role="status">
          {view.integration.status}: {view.integration.detail}
        </p>
      )}
      {!embedded && (
        <Button
          disabled={disabled || !view?.integration?.available}
          onClick={() =>
            void run(async () => {
              await save({
                ...settings,
                services: { ...settings.services, codex: true, defaultEngine: 'codex' },
              });
            })
          }
        >
          {settings.services?.codex === true && settings.services.defaultEngine === 'codex'
            ? 'ChatGPT selected'
            : 'Use ChatGPT'}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
  return embedded ? (
    <div>{controls}</div>
  ) : (
    <section className="service" aria-label="ChatGPT through Codex">
      <h3>ChatGPT</h3>
      {controls}
    </section>
  );
}
