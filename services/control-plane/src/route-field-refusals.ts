/**
 * Field-named refusals for saving a route (DIO-198 item 3). POST /ops/routes refuses a route body
 * that fails `saveRouteInput` or `modelBindingSchema` with one plain sentence per failing field, and
 * carries the failing paths as `fields` beside `error` so the Operations app can mark each one.
 *
 * A path is relative to the request body and joins the schema's issue path with dots, array members
 * by their index: `binding.price.inputMicroUsdPerMillion`, `binding.privacy.ingressCountries.0`, `id`.
 * A refusal that spans fields names the one to change (`binding.price.validUntil` when the price
 * expires before it was observed). A refusal about no field (a stale editor, a missing permission)
 * carries `fields: []`; the Worker adds that for every POST /ops/routes refusal that names none.
 */
import type { z } from 'zod';
import { AccountError } from './errors.js';
import type { CatalogRoute, ProviderConnection } from '../../../shared/routing-policy.js';

type Issue = z.core.$ZodIssue;

/** Sentences one refusal spells out; `fields` still lists every failing field, up to FIELD_LIMIT. */
const SENTENCE_LIMIT = 5;
const FIELD_LIMIT = 50;
/** A list of accepted values longer than this is not spelled out in the sentence. */
const VALUES_LIMIT = 8;

const KINDS: Readonly<Record<string, string>> = {
  string: 'text', number: 'a number', int: 'a whole number', bigint: 'a whole number', boolean: 'true or false',
  object: 'an object', array: 'a list', date: 'a date',
};

/** The request body path of a schema issue: `binding.privacy.ingressCountries.0`. Empty for the body itself. */
export function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((part) => String(part)).join('.');
}

function grouped(value: unknown): string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(value);
}

/** The value the body holds at a path, or undefined when the path is absent. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const part of path) {
    if (value === null || typeof value !== 'object' || typeof part === 'symbol') return undefined;
    if (!Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

/** The schema refinements that span fields, by the sentence the shared schema adds, with the field to change. */
const CROSS_FIELD: Readonly<Record<string, (at: string) => { field: string; sentence: string }>> = {
  'Price expiry must follow observation.': (at) =>
    ({ field: `${at}.validUntil`, sentence: `${at}.validUntil must be after ${at}.observedAt.` }),
  'Price thresholds must be distinct.': (at) =>
    ({ field: `${at}.longContext`, sentence: `${at}.longContext repeats an aboveInputTokens threshold. Each band needs its own.` }),
};

/** One plain sentence per field an issue names. Most issues name one; an unknown key names each key. */
export function issueSentences(issue: Issue, input: unknown): { field: string; sentence: string }[] {
  const field = fieldPath(issue.path);
  const name = field || 'The route';
  const one = (sentence: string) => [{ field, sentence }];
  const missing = issue.path.length > 0 && valueAt(input, issue.path) === undefined;
  switch (issue.code) {
    case 'unrecognized_keys':
      return issue.keys.map((key) => {
        const unknown = fieldPath([...issue.path, key]);
        return { field: unknown, sentence: `${unknown} is not a field a route accepts.` };
      });
    case 'invalid_type':
      if (missing) return one(`${name} is required.`);
      return one(`${name} must be ${KINDS[issue.expected] ?? issue.expected}.`);
    case 'invalid_value':
      if (missing) return one(`${name} is required.`);
      return one(issue.values.length <= VALUES_LIMIT
        ? `${name} must be one of ${issue.values.map((value) => String(value)).join(', ')}.`
        : `${name} is not an accepted value.`);
    case 'invalid_union': {
      if (missing) return one(`${name} is required.`);
      const options = (issue as { options?: unknown }).options;
      return one(Array.isArray(options) && options.length && options.length <= VALUES_LIMIT
        ? `${name} must be one of ${options.map((value) => String(value)).join(', ')}.`
        : `${name} does not match any accepted form.`);
    }
    case 'too_small': {
      const least = grouped(issue.minimum);
      if (issue.origin === 'string') return one(Number(issue.minimum) <= 1 ? `${name} is required.` : `${name} needs at least ${least} characters.`);
      if (issue.origin === 'array' || issue.origin === 'set')
        return one(Number(issue.minimum) <= 1 ? `${name} needs at least one entry.` : `${name} needs at least ${least} entries.`);
      return one(issue.inclusive === false ? `${name} must be more than ${least}.` : `${name} must be at least ${least}.`);
    }
    case 'too_big': {
      const most = grouped(issue.maximum);
      if (issue.origin === 'string') return one(`${name} can be at most ${most} characters.`);
      if (issue.origin === 'array' || issue.origin === 'set') return one(`${name} can have at most ${most} entries.`);
      return one(issue.inclusive === false ? `${name} must be less than ${most}.` : `${name} must be at most ${most}.`);
    }
    case 'invalid_format':
      return one(issue.format === 'datetime'
        ? `${name} must be a UTC date and time, such as 2026-10-05T12:00:00Z.`
        : `${name} is not in the accepted format.`);
    case 'not_multiple_of':
      return one(`${name} must be a multiple of ${grouped(issue.divisor)}.`);
    case 'custom': {
      const known = CROSS_FIELD[issue.message];
      if (known && field) return [known(field)];
      return one(`${name} is not valid. ${issue.message}`);
    }
    default:
      return one(`${name} is not valid.`);
  }
}

/**
 * The 422 for a route body the schema refused: one sentence for each failing field, at most five,
 * then a count of the rest, with every failing field in `fields`. Keeps the status the Worker has
 * always answered for a body that fails its schema.
 */
export function routeInputRefusal(issues: readonly Issue[], input: unknown): AccountError {
  const named = new Map<string, string>();
  for (const issue of issues)
    for (const { field, sentence } of issueSentences(issue, input)) if (!named.has(field)) named.set(field, sentence);
  const sentences = [...named.values()];
  const shown = sentences.slice(0, SENTENCE_LIMIT);
  const rest = sentences.length - shown.length;
  if (rest > 0) shown.push(rest === 1 ? 'One more field needs fixing.' : `${rest} more fields need fixing.`);
  const fields = [...named.keys()].filter(Boolean).slice(0, FIELD_LIMIT);
  return new AccountError(422, shown.join(' ') || 'The route is not valid.', undefined, fields);
}

const has = (list: readonly string[], value: string | null | undefined) => value !== null && value !== undefined && list.includes(value);

/**
 * The fields behind each rule `bindingProblems` enforces, keyed by its sentence. A rule that spans
 * fields names the binding field to change: a protocol the connection does not allow is
 * `binding.protocol`, a profile the connection does not list is `model`.
 */
const BINDING_RULES: Readonly<Record<string, (route: CatalogRoute, connection: ProviderConnection) => string[]>> = {
  'The model binding does not match the approved connection revision.': (route, connection) => [
    ...(route.binding?.connectionId !== connection.id ? ['binding.connectionId'] : []),
    ...(route.binding?.connectionRevision !== connection.revision ? ['binding.connectionRevision'] : []),
    ...(route.provider !== connection.provider ? ['provider'] : []),
  ],
  'The provider connection is disabled.': () => ['binding.connectionId'],
  'The reasoning configuration does not match this protocol and capability.': () => ['binding.reasoning'],
  'This protocol requires a qualified model-specific reasoning configuration.': () => ['binding.reasoning'],
  'This AWS profile has not been approved on this connection.': () => ['model'],
  'This AWS model has no approved compatibility evidence for the selected API.': () => ['binding.protocol'],
  'This AWS protocol is not supported.': () => ['binding.protocol'],
  'AWS Messages requires an Anthropic model.': () => ['binding.protocol'],
  'Converse requires the Bedrock runtime endpoint.': () => ['binding.protocol'],
  'The Azure deployment or API protocol is not approved.': (route, connection) => [
    ...(!['responses', 'chat-completions', 'messages'].includes(route.binding?.protocol ?? '') ? ['binding.protocol'] : []),
    ...(connection.provider === 'azure-openai' && !has(connection.deployments, route.binding?.deployment) ? ['binding.deployment'] : []),
  ],
  'Azure Messages requires a Claude model on the Foundry services host.': () => ['binding.protocol'],
  'The Vertex publisher, model or request format is invalid.': (route, connection) => [
    ...(connection.provider === 'google-vertex' &&
      route.binding?.protocol !== (connection.publisher === 'google' ? 'generate-content' : 'messages') ? ['binding.protocol'] : []),
    ...(!/^[A-Za-z0-9][A-Za-z0-9@._-]{0,199}$/.test(route.model) ? ['model'] : []),
  ],
  'A Vertex API key reaches Google models only. Use an access token for partner models.': () => ['binding.connectionId'],
  'OpenRouter requires an exact approved downstream endpoint and Chat Completions binding.': (route, connection) => {
    const endpoint = route.binding?.upstreamEndpoint ?? null;
    return [
      ...(route.binding?.protocol !== 'chat-completions' ? ['binding.protocol'] : []),
      ...(connection.provider === 'openrouter' && (!endpoint || !endpoint.includes('/') ||
        !connection.allowedEndpoints.includes(endpoint) || !connection.endpointNames[endpoint]) ? ['binding.upstreamEndpoint'] : []),
      ...(!/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/.test(route.model) || route.model.startsWith('openrouter/') ? ['model'] : []),
    ];
  },
};

/** The sentences `bindingProblems` can answer, so a test can hold this table to the shared rules. */
export const BINDING_RULE_SENTENCES: readonly string[] = Object.keys(BINDING_RULES);

/** The fields a `bindingProblems` sentence names for this route; the whole binding when the rule is new. */
export function bindingProblemFields(message: string, route: CatalogRoute, connection: ProviderConnection): string[] {
  const fields = BINDING_RULES[message]?.(route, connection) ?? [];
  return fields.length ? fields : ['binding'];
}
