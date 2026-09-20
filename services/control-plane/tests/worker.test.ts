import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../src/worker.js';
import { validEnv, setup } from './support/fixtures.js';

function request(path = '/account/session', init: RequestInit = {}) {
  return new Request(`http://127.0.0.1:8791${path}`, { ...init,
    headers: { origin: 'http://127.0.0.1:8791', authorization: 'Bearer alice', ...init.headers } });
}

describe('actual Fetch API failure boundaries', () => {
  it('fails a cold start with missing configuration before creating adapters', async () => {
    const create = vi.fn();
    const handler = createHandler(create);
    const response = await handler(request(), {});
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('DATABASE_URL');
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects origins, malformed bearer, query credentials and extra fields', async () => {
    const { accounts } = setup();
    const handler = createHandler(() => accounts);
    expect((await handler(request('/account/session', { headers: { origin: 'https://evil.example' } }), validEnv)).status).toBe(403);
    expect((await handler(request('/account/session', { headers: { authorization: '', cookie: 'session=alice' } }), validEnv)).status).toBe(401);
    expect((await handler(request('/account/session?token=alice'), validEnv)).status).toBe(422);
    expect((await handler(request('/account/organizations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'One', role: 'owner' }) }), validEnv)).status).toBe(422);
  });
  it('maps unavailable database/quota to refusal without exposing driver secrets', async () => {
    const { accounts, repository } = setup();
    vi.spyOn(repository, 'transaction').mockRejectedValue(Object.assign(new Error('postgresql://secret:secret@private/database'), { code: '53300' }));
    const response = await createHandler(() => accounts)(request(), validEnv);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toMatch(/secret|private|postgresql/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('runs account routes and refuses replay after session revocation', async () => {
    const handler = createHandler(() => setup().accounts);
    const response = await handler(request('/account/organizations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'One' }) }), validEnv);
    expect(response.status).toBe(201);
    const { accounts } = setup();
    const stable = createHandler(() => accounts);
    expect((await stable(request('/account/session/revoke', { method: 'POST' }), validEnv)).status).toBe(204);
    expect((await stable(request(), validEnv)).status).toBe(401);
  });
  it('refuses streamed oversized input before effects and handles preflight exactly', async () => {
    const { accounts, repository } = setup();
    const handler = createHandler(() => accounts);
    const tooLarge = new Request('http://127.0.0.1:8791/account/organizations', {
      method: 'POST', headers: { origin: 'http://127.0.0.1:8791', authorization: 'Bearer alice', 'content-type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); controller.close(); } }),
      duplex: 'half',
    } as RequestInit);
    expect((await handler(tooLarge, validEnv)).status).toBe(413);
    expect(repository.snapshot().persons).toEqual([]);
    expect((await handler(request('/account/session', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } }), validEnv)).status).toBe(204);
    expect((await handler(request('/account/session', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-person-id' } }), validEnv)).status).toBe(403);
  });
});
