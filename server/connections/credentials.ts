import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HarnessError } from '../harness/policy.js';

/** Capability-shaped seam for Trust. No caller can read a token or a signing key. */
export interface ConnectionCredentials {
  verify(
    connectionId: string,
    body: string,
    timestamp: string,
    signature: string,
  ): Promise<boolean>;
  assertSafe(value: unknown): void;
}

/** Ephemeral synthetic subscription key. Never installed in the production host. */
export function fixtureCredentials(connectionId: string, secret = randomBytes(32).toString('hex')) {
  const sign = (body: string, timestamp: string) =>
    createHmac('sha256', secret)
      .update(body + timestamp, 'utf8')
      .digest('base64');
  const credentials: ConnectionCredentials = {
    async verify(id, body, timestamp, signature) {
      if (id !== connectionId || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
      return timingSafeEqual(
        Buffer.from(sign(body, timestamp), 'base64'),
        Buffer.from(signature, 'base64'),
      );
    },
    assertSafe(value) {
      const visit = (item: unknown): void => {
        if (typeof item === 'string' && item.includes(secret))
          throw new HarnessError(
            'secret_rejected',
            'Sensitive data was refused at the connection boundary.',
          );
        if (Array.isArray(item)) item.forEach(visit);
        else if (item && typeof item === 'object')
          for (const [key, child] of Object.entries(item)) {
            if (
              /^(authorization|clientSecret|accessToken|refreshToken|privateKey|apiKey)$/i.test(key)
            )
              throw new HarnessError(
                'secret_rejected',
                'Credential-shaped data is not ordinary connection state.',
              );
            visit(child);
          }
      };
      visit(value);
    },
  };
  return { credentials, sign };
}
