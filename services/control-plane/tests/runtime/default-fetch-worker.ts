import { WorkOSIdentityVerifier } from '../../src/identity-workos.js';
import { AccountError } from '../../src/errors.js';
import { readBytes } from '../../src/crypto.js';

/** Local regression harness, never the deployed entry point. The verifier keeps
 * its DEFAULT fetch: no fetch or now is passed and the global is never touched,
 * so workerd's own fetch runs exactly as in production. Provider answers come
 * from the smoke's outbound interceptor at the runtime boundary. */
export default {
  async fetch(request: Request) {
    const fixture = JSON.parse(new TextDecoder().decode(await readBytes(request, 32768))) as {
      token: string; clientId: string;
    };
    const verifier = new WorkOSIdentityVerifier({ clientId: fixture.clientId, issuer: 'https://api.workos.com',
      audience: 'diomedes-control-plane', apiKey: 'sk_test_offline_default_fetch_fixture' });
    try {
      const proof = await verifier.verify(fixture.token);
      return Response.json({ subject: proof.subject, runtime: 'workerd', provider: 'intercepted-outbound' });
    } catch (error) {
      if (error instanceof AccountError) return Response.json({ status: error.status }, { status: error.status });
      throw error;
    }
  },
};
