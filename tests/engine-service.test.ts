import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { ExternalEngine, IntegrationStatus } from '../shared/types.js';
import type { TextEngineAdapter } from '../server/engines/contract.js';
const installed: IntegrationStatus = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Found',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  installedVersion: '2.1.252',
  location: 'tool.exe',
  disclosure: [],
};
const model = {
  slug: 'sonnet',
  name: 'Sonnet',
  description: '',
  efforts: [],
  defaultEffort: null,
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(
  auth: 'signed-in' | 'unknown' = 'signed-in',
  engine: ExternalEngine = 'claude-code',
) {
  const accountRoute = engine === 'cursor' ? 'cursor:cursor-account' : 'claude-code:claude.ai';
  const version = TESTED_VERSIONS[engine];
  const inspect = vi.fn(async () => ({
    authentication: auth,
    accountRoute,
    models: [model],
    detail: 'Checked',
  }));
  const generate = vi.fn<TextEngineAdapter['generate']>(async (input) => ({
    ...input,
    text: 'Answer',
    version,
  }));
  const discover = vi.fn<() => Promise<IntegrationStatus[]>>(async () => [
    { ...installed, id: engine, installedVersion: version },
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-setup-'));
  roots.push(root);
  const service = new EngineService(root, {
    discover,
    version: async () => version,
    adapter: () => ({ id: engine, inspect, generate }),
  });
  return { service, inspect, generate, discover };
}
describe('AI setup readiness and dispatch', () => {
  it('does no discovery at creation or when reading cached state', () => {
    const { service, discover, inspect } = fixture();
    expect(service.status()[0].installation).toBe('not-checked');
    expect(service.status().map((row) => row.engine)).toEqual([
      'claude-code',
      'opencode',
      'oh-my-pi',
      'cursor',
    ]);
    expect(discover).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
  it('requires disclosure consent and only reports installation on discovery', async () => {
    const { service, inspect } = fixture();
    await expect(service.discover(false)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await service.discover(true);
    expect(service.status()[0]).toMatchObject({
      installation: 'found',
      compatibility: 'supported',
      authentication: 'unknown',
    });
    expect(inspect).not.toHaveBeenCalled();
  });
  it('discovers, checks and dispatches Cursor through the same account and identity guards', async () => {
    const { service, generate } = fixture('signed-in', 'cursor');
    await service.discover(true);
    await service.check('cursor');
    expect(service.selection('cursor', 'sonnet')).toEqual({
      engine: 'cursor',
      model: 'sonnet',
      accountRoute: 'cursor:cursor-account',
    });
    const input = {
      projectId: 'p',
      threadId: 't',
      requestId: 'r',
      model: 'sonnet',
      accountRoute: 'cursor:cursor-account',
      prompt: 'Question',
      instructions: '',
      documents: [],
    };
    await expect(service.generate('cursor', input)).resolves.toMatchObject({
      text: 'Answer',
      version: '2026.08.11',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(service.integration('cursor', false)).toMatchObject({
      available: true,
      enabled: false,
    });
    expect(service.integration('cursor', false).disclosure.join(' ')).toContain('denies tools');
    await expect(
      service.generate('cursor', { ...input, accountRoute: 'cursor:api' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('does not mistake unknown authentication for usable models', async () => {
    const { service } = fixture('unknown');
    await service.discover(true);
    await service.check('claude-code');
    expect(() => service.selection('claude-code', 'sonnet')).toThrow(/sign-in/i);
  });
  it('rejects unsupported executables before starting a protocol', async () => {
    const { service, discover, inspect } = fixture();
    discover.mockResolvedValue([{ ...installed, installedVersion: '1.0.0' }]);
    await service.discover(true);
    await expect(service.check('claude-code')).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
    expect(inspect).not.toHaveBeenCalled();
  });
  it('keeps installation, readiness and user enablement separate', async () => {
    const { service } = fixture();
    await service.discover(true);
    await service.check('claude-code');
    expect(service.selection('claude-code', 'sonnet')).toEqual({
      engine: 'claude-code',
      model: 'sonnet',
      accountRoute: 'claude-code:claude.ai',
    });
    expect(service.integration('claude-code', false)).toMatchObject({
      available: true,
      enabled: false,
    });
  });
  it('rejects a withdrawn model without falling back or sending', async () => {
    const { service, generate } = fixture();
    await service.discover(true);
    await service.check('claude-code');
    await expect(
      service.generate('claude-code', {
        projectId: 'p',
        threadId: 't',
        requestId: 'r',
        model: 'removed',
        accountRoute: 'claude-code:claude.ai',
        prompt: 'x',
        documents: [],
        instructions: 'x',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(generate).not.toHaveBeenCalled();
  });
  it('rechecks installation before dispatch after a tool is removed', async () => {
    const { service, discover, generate } = fixture();
    await service.discover(true);
    await service.check('claude-code');
    discover.mockResolvedValue([]);
    await expect(
      service.generate('claude-code', {
        projectId: 'p',
        threadId: 't',
        requestId: 'r',
        model: 'sonnet',
        accountRoute: 'claude-code:claude.ai',
        prompt: 'x',
        documents: [],
        instructions: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    expect(generate).not.toHaveBeenCalled();
  });
  it('rejects a response associated with a different logical request', async () => {
    const { service, generate } = fixture();
    generate.mockImplementation(async (input) => ({
      ...input,
      requestId: 'wrong',
      text: 'Answer',
      version: '2.1.252',
    }));
    await expect(
      service.generate('claude-code', {
        projectId: 'p',
        threadId: 't',
        requestId: 'r',
        model: 'sonnet',
        accountRoute: 'claude-code:claude.ai',
        prompt: 'x',
        documents: [],
        instructions: 'x',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });
  it('refuses duplicate dispatch and drops a late answer after cancellation', async () => {
    const { service, generate } = fixture();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    generate.mockImplementation(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...input, text: 'Late', version: '2.1.252' };
    });
    const input = {
      projectId: 'p',
      threadId: 't',
      requestId: 'r',
      model: 'sonnet',
      accountRoute: 'claude-code:claude.ai',
      prompt: 'x',
      documents: [],
      instructions: 'x',
      signal: controller.signal,
    };
    const pending = service.generate('claude-code', input);
    await expect.poll(() => generate.mock.calls.length).toBe(1);
    await expect(service.generate('claude-code', input)).rejects.toMatchObject({
      code: 'REQUEST_ACTIVE',
    });
    controller.abort();
    release!();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
