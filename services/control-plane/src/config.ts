export interface Configuration {
  environment: 'local' | 'staging' | 'production';
  origins: readonly string[];
  databaseUrl: string;
  identity: { clientId: string; issuer: string; audience: string; apiKey: string };
}

export class ConfigurationError extends Error {
  constructor() { super('Account service configuration is unavailable.'); }
}

/** Unknown/missing configuration refuses the cloud operation, never Personal. */
export function configuration(env: Record<string, unknown>): Configuration {
  const get = (key: string): string => {
    const value = env[key];
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n\0]/.test(value)) throw new ConfigurationError();
    return value;
  };
  try {
    const environment = get('ENVIRONMENT');
    if (!['local', 'staging', 'production'].includes(environment)) throw new ConfigurationError();
    const origins = get('ALLOWED_ORIGINS').split(',');
    if (origins.length > 16 || new Set(origins).size !== origins.length) throw new ConfigurationError();
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== 'https:' && !(environment === 'local' && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
        throw new ConfigurationError();
    }
    const clientId = get('WORKOS_CLIENT_ID');
    const issuer = get('WORKOS_ISSUER');
    const issuerUrl = new URL(issuer);
    const audience = get('WORKOS_TOKEN_AUDIENCE');
    const apiKey = get('WORKOS_API_KEY');
    if (!/^client_[A-Za-z0-9_-]{1,120}$/.test(clientId) || issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || audience.length > 500 ||
      !/^sk_(test|live)_[A-Za-z0-9_]{16,256}$/.test(apiKey)) throw new ConfigurationError();
    if (environment !== 'production' && !apiKey.startsWith('sk_test_')) throw new ConfigurationError();
    const databaseUrl = get('DATABASE_URL');
    const database = new URL(databaseUrl);
    if (database.protocol !== 'postgresql:' || !database.hostname.endsWith('.neon.tech') ||
        !/^cp_runtime(?:_[a-z0-9_]+)?$/.test(database.username) || database.password.length < 8 ||
        !/^\/[A-Za-z0-9_-]+$/.test(database.pathname) || database.hash ||
        (database.port !== '' && database.port !== '5432') || database.searchParams.get('sslmode') !== 'require' ||
        [...database.searchParams.keys()].some((key) => !['sslmode','channel_binding'].includes(key)) ||
        [...database.searchParams.keys()].some((key) => database.searchParams.getAll(key).length !== 1)) throw new ConfigurationError();
    return { environment: environment as Configuration['environment'], origins, databaseUrl, identity: { clientId, issuer, audience, apiKey } };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof TypeError) throw new ConfigurationError();
    throw error;
  }
}
