import { WorkOSIdentityVerifier } from '../../src/identity-workos.js';
import { AccountError } from '../../src/errors.js';
import { readBytes } from '../../src/crypto.js';

/** Local benchmark harness, never the deployed entry point. Outbound provider
 * calls are replaced by bounded HTTP fixtures; real Web Crypto still executes. */
export default {
  async fetch(request: Request) {
    const fixture = JSON.parse(new TextDecoder().decode(await readBytes(request, 32768))) as {
      token: string; key: JsonWebKey & { kid: string }; expiresAt: string;
    };
    let providerRequests = 0;
    const provider: typeof fetch = async (input) => {
      providerRequests++;
      const url = String(input);
      if (url === 'https://api.workos.com/sso/jwks/client_runtime') return Response.json({ keys: [fixture.key] });
      if (url === 'https://api.workos.com/user_management/users/user_runtime/sessions?limit=100')
        return Response.json({ data: [{ id: 'session_runtime', user_id: 'user_runtime', status: 'active', expires_at: fixture.expiresAt, ended_at: null }], list_metadata: { after: null } });
      if (url === 'https://api.workos.com/user_management/users/user_runtime')
        return Response.json({ id: 'user_runtime', email_verified: true, first_name: 'Fixture' });
      throw new Error('Unexpected outbound fixture URL; live calls are prohibited.');
    };
    const verifier = new WorkOSIdentityVerifier({ clientId: 'client_runtime', issuer: 'https://api.workos.com',
      audience: 'diomedes-control-plane', apiKey: 'sk_test_offline_runtime_fixture', fetch: provider });
    try {
      const proof = await verifier.verify(fixture.token);
      return Response.json({ subject: proof.subject, providerRequests, runtime: 'workerd', provider: 'offline-fixture' });
    } catch (error) {
      if (error instanceof AccountError) return Response.json({ status: error.status }, { status: error.status });
      throw error;
    }
  },
};
