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
  /** Why a staff value that was set is refused. Names only; absent when nothing staff is set. */
  staffProblem?: SettingProblem;
  /** Why a FUNDING_DATABASE_URL that was set is refused. A rule name only. */
  fundingProblem?: string;
}

/**
 * Which setting failed and which rule it broke, for the Worker's logs. Never a value:
 * the owner reads these to fix a secret nobody can read back.
 */
export interface SettingProblem { setting: string; rule: string }

export interface WorkOSIdentity { clientId: string; issuer: string; audience: string; apiKey: string }

/** Which WorkOS environment a route's bearer must come from. */
export type AccountPool = 'customer' | 'staff';

export class ConfigurationError extends Error {
  constructor(readonly problem?: SettingProblem) { super('Account service configuration is unavailable.'); }
}

/** A setting's value is text with nothing around it; the rule it breaks otherwise. */
function textProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return 'missing';
  if (value !== value.trim() || /[\r\n\0]/.test(value)) return 'whitespace';
  return null;
}

/**
 * A Neon connection string for one reviewed login, in the only shape the Worker accepts,
 * or the first rule it breaks.
 */
function neonUrl(value: string, login: RegExp): URL | string {
  let database: URL;
  try { database = new URL(value); } catch { return 'not-a-url'; }
  if (database.protocol !== 'postgresql:') return 'scheme';
  if (!database.hostname.endsWith('.neon.tech')) return 'host';
  if (!login.test(database.username)) return 'login';
  if (database.password.length < 8) return 'password-length';
  if (!/^\/[A-Za-z0-9_-]+$/.test(database.pathname)) return 'database-path';
  if (database.hash) return 'fragment';
  if (database.port !== '' && database.port !== '5432') return 'port';
  if (database.searchParams.get('sslmode') !== 'require') return 'sslmode';
  if ([...database.searchParams.keys()].some((key) => !['sslmode','channel_binding'].includes(key)) ||
      [...database.searchParams.keys()].some((key) => database.searchParams.getAll(key).length !== 1)) return 'parameters';
  return database;
}

/** A Neon endpoint's pooled and direct hosts name the same database server. */
const endpoint = (url: URL) => url.hostname.replace(/-pooler(?=\.)/, '');

/**
 * The funding login's URL, or null. It must be the same Neon database as
 * DATABASE_URL: the gateway reads the admission and grants there, the usage
 * projection reads the funding rows there, and the spend ceiling counts them there.
 */
function fundingUrl(value: unknown, database: URL): { url: string | null; problem?: string } {
  if (typeof value !== 'string' || !value.trim()) return { url: null };
  const text = textProblem(value);
  if (text) return { url: null, problem: text };
  const funding = neonUrl(value, /^cp_funding(?:_[a-z0-9_]+)?$/);
  if (typeof funding === 'string') return { url: null, problem: funding };
  if (endpoint(funding) !== endpoint(database) || funding.pathname !== database.pathname) return { url: null, problem: 'other-database' };
  return { url: value };
}

const CLIENT_ID = /^client_[A-Za-z0-9_-]{1,120}$/;
const API_KEY = /^sk_(test|live)_[A-Za-z0-9_]{16,256}$/;

/**
 * The staff environment, or null. Never a reason to refuse customer routes, and
 * never the customer environment under another name: a staff pool that shares the
 * customer client or key would let a customer sign-in reach /ops/*.
 */
function staffIdentity(env: Record<string, unknown>, customer: WorkOSIdentity, environment: string):
  { identity: WorkOSIdentity | null; problem?: SettingProblem } {
  const clientId = env.STAFF_WORKOS_CLIENT_ID;
  const apiKey = env.STAFF_WORKOS_API_KEY;
  const refuse = (setting: string, rule: string) => ({ identity: null, problem: { setting, rule } });
  const clientText = textProblem(clientId);
  const keyText = textProblem(apiKey);
  if (clientText === 'missing' && keyText === 'missing') return { identity: null };
  if (clientText) return refuse('STAFF_WORKOS_CLIENT_ID', clientText);
  if (keyText) return refuse('STAFF_WORKOS_API_KEY', keyText);
  if (!CLIENT_ID.test(clientId as string)) return refuse('STAFF_WORKOS_CLIENT_ID', 'format');
  if (!API_KEY.test(apiKey as string)) return refuse('STAFF_WORKOS_API_KEY', 'format');
  if (environment !== 'production' && !(apiKey as string).startsWith('sk_test_')) return refuse('STAFF_WORKOS_API_KEY', 'test-key-required');
  if (clientId === customer.clientId) return refuse('STAFF_WORKOS_CLIENT_ID', 'same-as-customer');
  if (apiKey === customer.apiKey) return refuse('STAFF_WORKOS_API_KEY', 'same-as-customer');
  return { identity: { clientId: clientId as string, issuer: customer.issuer, audience: customer.audience, apiKey: apiKey as string } };
}

/** The identity a pool's bearer is verified against. No staff environment refuses /ops/*. */
export function identityFor(config: Configuration, pool: AccountPool): WorkOSIdentity {
  if (pool === 'customer') return config.identity;
  if (!config.staffIdentity) throw new ConfigurationError(config.staffProblem ?? { setting: 'STAFF_WORKOS_CLIENT_ID', rule: 'not-set' });
  return config.staffIdentity;
}

/** Unknown/missing configuration refuses the cloud operation, never Personal. */
export function configuration(env: Record<string, unknown>): Configuration {
  let setting = 'ENVIRONMENT';
  const refuse = (rule: string) => new ConfigurationError({ setting, rule });
  const get = (key: string): string => {
    setting = key;
    const problem = textProblem(env[key]);
    if (problem) throw refuse(problem);
    return env[key] as string;
  };
  try {
    const environment = get('ENVIRONMENT');
    if (!['local', 'staging', 'production'].includes(environment)) throw refuse('value');
    const origins = get('ALLOWED_ORIGINS').split(',');
    if (origins.length > 16 || new Set(origins).size !== origins.length) throw refuse('list');
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== 'https:' && !(environment === 'local' && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
        throw refuse('origin');
    }
    const clientId = get('WORKOS_CLIENT_ID');
    if (!CLIENT_ID.test(clientId)) throw refuse('format');
    const issuer = get('WORKOS_ISSUER');
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) throw refuse('format');
    const audience = get('WORKOS_TOKEN_AUDIENCE');
    if (audience.length > 500) throw refuse('length');
    const apiKey = get('WORKOS_API_KEY');
    if (!API_KEY.test(apiKey)) throw refuse('format');
    if (environment !== 'production' && !apiKey.startsWith('sk_test_')) throw refuse('test-key-required');
    const databaseUrl = get('DATABASE_URL');
    const database = neonUrl(databaseUrl, /^cp_runtime(?:_[a-z0-9_]+)?$/);
    if (typeof database === 'string') throw refuse(database);
    // Optional, and never a reason to refuse the account routes: only the gateway reads it.
    const funding = fundingUrl(env.FUNDING_DATABASE_URL, database);
    const identity = { clientId, issuer, audience, apiKey };
    const staff = staffIdentity(env, identity, environment);
    return { environment: environment as Configuration['environment'], origins, databaseUrl, fundingDatabaseUrl: funding.url, identity,
      staffIdentity: staff.identity,
      ...(staff.problem ? { staffProblem: staff.problem } : {}),
      ...(funding.problem ? { fundingProblem: funding.problem } : {}) };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof TypeError) throw refuse('not-a-url');
    throw error;
  }
}
