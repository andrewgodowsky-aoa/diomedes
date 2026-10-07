import { describe, expect, it } from 'vitest';
import { DeveloperKeyService, DeveloperKeyVerifier, type DeveloperKeyRow, type DeveloperKeyStore } from '../src/developer-keys.js';
import { digest } from '../src/crypto.js';
import { createHandler } from '../src/worker.js';
import { setup, validEnv } from './support/fixtures.js';

const at = Date.parse('2026-10-07T00:00:00Z');
const actor = { person: { id: 'person_a', name: 'Alice' }, mapping: { issuer: 'https://identity.example', subject: 'user_a', identityGeneration: 0 } };
function fixture() {
  const rows: DeveloperKeyRow[] = [];
  const store: DeveloperKeyStore = {
    async insert(row) { rows.push(row); },
    async list(personId) { return rows.filter(row => row.personId === personId); },
    async revoke(personId, id, when) { const row = rows.find(row => row.id === id && row.personId === personId); if (row) row.revokedAt ??= when; return !!row; },
    async find(hash) { return rows.find(row => row.hash === hash) ?? null; },
  };
  const service = new DeveloperKeyService(store, async () => ({ actor, scope: { kind: 'individual', id: 'individual_a' } }), () => at);
  return { service, store, rows };
}
describe('customer developer keys', () => {
  it('keeps browser calls, staff credentials and free usage classes outside the developer gateway', async () => {
    const handler = createHandler(() => setup().accounts);
    const invoke = (headers: Record<string, string>, enabled = true) => handler(new Request('http://127.0.0.1:8791/developer/v1/responses', { method: 'POST', headers: {
      authorization: `Bearer ndk_${'a'.repeat(43)}`, 'X-Nectovia-Scope-Kind': 'individual', 'X-Nectovia-Account': 'individual_a', ...headers,
    } }), { ...validEnv, DEVELOPER_API_ENABLED: enabled ? '1' : '0' });
    expect((await invoke({}, false)).status).toBe(503);
    expect((await invoke({ origin: 'https://nectovia.diomedes.net' })).status).toBe(403);
    expect((await invoke({ authorization: `Bearer nsk_${'a'.repeat(43)}` })).status).toBe(401);
    expect((await invoke({ 'X-Nectovia-Usage-Class': 'included-chat' })).status).toBe(422);
    expect((await invoke({ 'X-Nectovia-Organization': 'org_b' })).status).toBe(422);
  });
  it('returns the random credential once and stores only a hash, bound to the verified person and scope', async () => {
    const { service, rows } = fixture();
    const result = await service.create('session', { name: 'My integration', organizationId: null, expiresInDays: 30 });
    expect(result.secret).toMatch(/^ndk_[A-Za-z0-9_-]{43}$/);
    expect(rows[0].hash).toBe(await digest(result.secret));
    expect(rows[0]).toMatchObject({ personId: 'person_a', subject: 'user_a', scope: { kind: 'individual', id: 'individual_a' } });
    expect(JSON.stringify(await service.list('session'))).not.toContain(result.secret);
    expect(JSON.stringify(await service.list('session'))).not.toContain(rows[0].hash);
  });
  it('rechecks revocation on every authentication and never accepts a staff key', async () => {
    const { service, store } = fixture();
    const key = await service.create('session', { name: 'Job', organizationId: null, expiresInDays: 1 });
    const verifier = new DeveloperKeyVerifier(store, actor.mapping.issuer, key.key.scope, () => at);
    expect(await verifier.verify(key.secret)).toMatchObject({ subject: 'user_a', sessionId: key.key.id });
    await service.revoke('session', key.key.id);
    await expect(verifier.verify(key.secret)).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify('nsk_' + 'a'.repeat(43))).rejects.toMatchObject({ status: 401 });
  });
  it('rejects expired keys and keys presented for another billing scope or identity issuer', async () => {
    const { service, store } = fixture();
    const key = await service.create('session', { name: 'Job', organizationId: null, expiresInDays: 1 });
    await expect(new DeveloperKeyVerifier(store, actor.mapping.issuer, { kind: 'organization', id: 'org_b' }, () => at).verify(key.secret)).rejects.toMatchObject({ status: 401 });
    await expect(new DeveloperKeyVerifier(store, 'https://other.example', key.key.scope, () => at).verify(key.secret)).rejects.toMatchObject({ status: 401 });
    await expect(new DeveloperKeyVerifier(store, actor.mapping.issuer, key.key.scope, () => at + 86_400_000).verify(key.secret)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects invalid lifetimes and extra privilege fields before storing a key', async () => {
    const { service, rows } = fixture();
    for (const input of [{ name: 'x', organizationId: null, expiresInDays: 0 }, { name: 'x', organizationId: null, expiresInDays: 366 }, { name: 'x', organizationId: null, expiresInDays: 30, staff: true }])
      await expect(service.create('session', input)).rejects.toMatchObject({ status: 422 });
    expect(rows).toEqual([]);
  });
});
