export interface Configuration {
  environment: 'local' | 'staging' | 'production';
  origins: readonly string[];
  databaseUrl: string;
  /**
   * FUNDING_DATABASE_URL: the login cp_funding (scripts/funding-permissions.sql),
   * used only by the managed gateway's funding repository. Null when it is unset,
   * blank or unreadable; the gateway then refuses every managed call with 503
   * route_unavailable, and nothing else in the Worker reads it.
   */
  fundingDatabaseUrl: string | null;
  /** The customer (Nectovia) WorkOS environment: every /account/* and /managed/* call. */
  identity: WorkOSIdentity;
  /**
   * The staff (Diomedes Systems) WorkOS environment: a second environment, with its
   * own branded sign-in, users and keys, and the only one the Operations app's /ops/*
   * routes accept. STAFF_WORKOS_CLIENT_ID is a var and STAFF_WORKOS_API_KEY a secret;
   * the issuer and token audience are the customer environment's. Null when either is
   * unset, blank or unreadable, or names the customer environment's own client or key:
   * every /ops/* call then answers 503, and customer routes are unaffected.
   */
  staffIdentity: WorkOSIdentity | null;
}

export interface WorkOSIdentity { clientId: string; issuer: string; audience: string; apiKey: string }

/** Which WorkOS environment a route's bearer must come from. */
export type AccountPool = 'customer' | 'staff';

export class ConfigurationError extends Error {
  constructor() { super('Account service configuration is unavailable.'); }
}

/** A Neon connection string for one reviewed login, in the only shape the Worker accepts. */
function neonUrl(value: string, login: RegExp): URL | null {
  let database: URL;
  try { database = new URL(value); } catch { return null; }
  if (database.protocol !== 'postgresql:' || !database.hostname.endsWith('.neon.tech') ||
      !login.test(database.username) || database.password.length < 8 ||
      !/^\/[A-Za-z0-9_-]+$/.test(database.pathname) || database.hash ||
      (database.port !== '' && database.port !== '5432') || database.searchParams.get('sslmode') !== 'require' ||
      [...database.searchParams.keys()].some((key) => !['sslmode','channel_binding'].includes(key)) ||
      [...database.searchParams.keys()].some((key) => database.searchParams.getAll(key).length !== 1)) return null;
  return database;
}

/** A Neon endpoint's pooled and direct hosts name the same database server. */
const endpoint = (url: URL) => url.hostname.replace(/-pooler(?=\.)/, '');

/**
 * The funding login's URL, or null. It must be the same Neon database as
 * DATABASE_URL: the gateway reads the admission and grants there, the usage
 * projection reads the funding rows there, and the spend ceiling counts them there.
 */
function fundingUrl(value: unknown, database: URL): string | null {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\r\n\0]/.test(value)) return null;
  const funding = neonUrl(value, /^cp_funding(?:_[a-z0-9_]+)?$/);
  if (!funding || endpoint(funding) !== endpoint(database) || funding.pathname !== database.pathname) return null;
  return value;
}

const CLIENT_ID = /^client_[A-Za-z0-9_-]{1,120}$/;
const API_KEY = /^sk_(test|live)_[A-Za-z0-9_]{16,256}$/;

/**
 * The staff environment, or null. Never a reason to refuse customer routes, and
 * never the customer environment under another name: a staff pool that shares the
 * customer client or key would let a customer sign-in reach /ops/*.
 */
function staffIdentity(env: Record<string, unknown>, customer: WorkOSIdentity, environment: string): WorkOSIdentity | null {
  const clientId = env.STAFF_WORKOS_CLIENT_ID;
  const apiKey = env.STAFF_WORKOS_API_KEY;
  if (typeof clientId !== 'string' || typeof apiKey !== 'string' || !CLIENT_ID.test(clientId) || !API_KEY.test(apiKey)) return null;
  if (environment !== 'production' && !apiKey.startsWith('sk_test_')) return null;
  if (clientId === customer.clientId || apiKey === customer.apiKey) return null;
  return { clientId, issuer: customer.issuer, audience: customer.audience, apiKey };
}

/** The identity a pool's bearer is verified against. No staff environment refuses /ops/*. */
export function identityFor(config: Configuration, pool: AccountPool): WorkOSIdentity {
  if (pool === 'customer') return config.identity;
  if (!config.staffIdentity) throw new ConfigurationError();
  return config.staffIdentity;
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
    if (!CLIENT_ID.test(clientId) || issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || audience.length > 500 ||
      !API_KEY.test(apiKey)) throw new ConfigurationError();
    if (environment !== 'production' && !apiKey.startsWith('sk_test_')) throw new ConfigurationError();
    const databaseUrl = get('DATABASE_URL');
    const database = neonUrl(databaseUrl, /^cp_runtime(?:_[a-z0-9_]+)?$/);
    if (!database) throw new ConfigurationError();
    // Optional, and never a reason to refuse the account routes: only the gateway reads it.
    const fundingDatabaseUrl = fundingUrl(env.FUNDING_DATABASE_URL, database);
    const identity = { clientId, issuer, audience, apiKey };
    return { environment: environment as Configuration['environment'], origins, databaseUrl, fundingDatabaseUrl, identity,
      staffIdentity: staffIdentity(env, identity, environment) };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof TypeError) throw new ConfigurationError();
    throw error;
  }
}
