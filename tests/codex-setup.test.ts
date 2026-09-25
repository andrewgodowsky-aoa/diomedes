import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexSetup } from '../server/codex-setup';
import type { NativeRpc } from '../server/integrations';
import type { IntegrationStatus } from '../shared/types';

const services: CodexSetup[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
function fixture(options: { response?: unknown; installed?: boolean; supported?: boolean } = {}) {
  let notify: (method: string, params: Record<string, unknown>) => void = () => {};
  const request = vi.fn(async (method: string) =>
    method === 'account/login/start'
      ? (options.response ?? {
          type: 'chatgpt',
          loginId: 'login-1',
          authUrl: 'https://auth.openai.com/oauth/authorize?state=example',
        })
      : {},
  );
  const close = vi.fn(async () => {});
  const client: NativeRpc = {
    request,
    close,
    notify: () => {},
    onNotification: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const createClient = vi.fn(async () => client);
  const inspect = vi.fn(
    async () =>
      ({ id: 'codex', available: true, signIn: 'signed-in', status: 'Ready' }) as IntegrationStatus,
  );
  const service = new CodexSetup({
    supported: options.supported ?? true,
    installed: async () => options.installed ?? true,
    createClient,
    inspect,
  });
  services.push(service);
  return {
    service,
    request,
    close,
    createClient,
    inspect,
    notify: (params: Record<string, unknown>) => notify('account/login/completed', params),
  };
}

describe('bundled Codex account setup', () => {
  it('reads installation passively, without starting a runtime or checking credentials', async () => {
    const f = fixture();
    expect(await f.service.view()).toMatchObject({
      installed: true,
      login: 'idle',
      integration: null,
    });
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it('requires explicit consent, an installed runtime and a supported platform', async () => {
    const noConsent = fixture();
    await expect(noConsent.service.start(false)).rejects.toMatchObject({ status: 400 });
    await expect(noConsent.service.check(false)).rejects.toMatchObject({ status: 400 });
    expect(noConsent.createClient).not.toHaveBeenCalled();
    const missing = fixture({ installed: false });
    await expect(missing.service.start(true)).rejects.toMatchObject({ status: 503 });
    const unsupported = fixture({ supported: false });
    await expect(unsupported.service.start(true)).rejects.toMatchObject({ status: 400 });
    expect(missing.createClient).not.toHaveBeenCalled();
    expect(unsupported.createClient).not.toHaveBeenCalled();
  });
  it('starts one native ChatGPT login even for concurrent requests, never a prompt', async () => {
    const f = fixture();
    const views = await Promise.all([f.service.start(true), f.service.start(true)]);
    expect(views.every((view) => view.login === 'waiting')).toBe(true);
    expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.service.allowsReference(views[0].authUrl!)).toBe(true);
    expect(f.service.allowsReference('https://auth.openai.com/oauth/authorize?state=other')).toBe(false);
    expect(f.request.mock.calls).toEqual([['account/login/start', { type: 'chatgpt' }]]);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each([
    'https://auth.openai.com.evil.test/oauth/authorize',
    'https://auth.openai.com@evil.test/oauth/authorize',
    'http://auth.openai.com/oauth/authorize',
    'https://auth.openai.com/other',
    'file:///C:/Windows/tool.exe',
  ])('refuses a non-OpenAI authorization destination: %s', async (authUrl) => {
    const f = fixture({ response: { type: 'chatgpt', loginId: 'login-1', authUrl } });
    await expect(f.service.start(true)).rejects.toBeInstanceOf(Error);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect((await f.service.view()).authUrl).toBeNull();
  });
  it('ignores a stale completion and never treats OAuth completion as execution readiness', async () => {
    const f = fixture();
    await f.service.start(true);
    f.notify({ loginId: 'old-login', success: true });
    await f.service.check(true);
    expect((await f.service.view()).login).toBe('waiting');
    f.notify({ loginId: 'login-1', success: true });
    await vi.waitFor(async () => expect((await f.service.view()).login).toBe('finished'));
    expect((await f.service.view()).integration).toBeNull();
    expect((await f.service.view()).authUrl).toBeNull();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect((await f.service.check(true)).integration?.available).toBe(true);
  });
  it('cancels only the login it owns and clears the URL on shutdown', async () => {
    const f = fixture();
    await f.service.start(true);
    await f.service.close();
    expect(f.request).toHaveBeenLastCalledWith('account/login/cancel', { loginId: 'login-1' });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect((await f.service.view()).authUrl).toBeNull();
    await expect(f.service.start(true)).rejects.toMatchObject({ status: 503 });
    expect(f.service.allowsReference('https://auth.openai.com/oauth/authorize?state=example')).toBe(false);
  });
});
