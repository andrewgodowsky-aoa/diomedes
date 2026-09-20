import { AccountService } from '../../src/account-service.js';
import { MemoryRepository } from './memory.js';
import type { IdentityVerifier } from '../../src/domain.js';

export const validEnv = {
  ENVIRONMENT: 'local', ALLOWED_ORIGINS: 'http://127.0.0.1:8791',
  WORKOS_CLIENT_ID: 'client_fixture', WORKOS_ISSUER: 'https://api.workos.com',
  WORKOS_TOKEN_AUDIENCE: 'diomedes-control-plane',
  WORKOS_API_KEY: 'sk_test_fixture_only_no_service_calls',
  DATABASE_URL: 'postgresql://cp_runtime:fixture_password@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=require',
};
export const now = Date.parse('2026-09-20T00:00:00Z');
export const verifier: IdentityVerifier = {
  issuer: 'https://api.workos.com',
  async verify(token) {
    return { issuer: this.issuer, subject: `user_${token}`, sessionId: `session_${token}`,
      displayName: 'Same display name', emailVerified: true,
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      verifiedAt: new Date(now).toISOString() };
  },
};
export const setup = () => {
  const repository = new MemoryRepository();
  const accounts = new AccountService(repository, verifier, { now: () => now });
  return { repository, accounts };
};
