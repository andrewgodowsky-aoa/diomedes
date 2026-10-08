/** Worker-compatible provider bindings. Only approved connection identities construct URLs. */
import { z } from 'zod';
import {
  bindingProblems, providerConnectionSchema, type CatalogRoute, type ModelBinding, type ProviderConnection,
} from '../../../shared/routing-policy.js';
import { ROUTE_CHECKS_SCOPE_KEY } from '../../../shared/gateway-route-checks.js';
import { BindingError, canonicalJson, normalizeProviderResponse, type NativeCheckpoint } from './managed-normalization.js';
import type { ResponsesBody } from './managed-inference.js';
import { MANAGED_PROVIDERS } from './managed-providers.js';
import { readBytes } from './crypto.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const encoder = new TextEncoder();

export function approvedConnections(env: Readonly<Record<string, unknown>>): ProviderConnection[] {
  const raw = env.MANAGED_CONNECTIONS;
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string' || raw.length > 262_144) throw new BindingError('connections_invalid', 'The approved connection configuration is invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new BindingError('connections_invalid', 'The approved connection configuration is invalid.'); }
  const result = z.array(providerConnectionSchema).max(100).safeParse(parsed);
  if (!result.success || new Set(result.data.map(c => c.id)).size !== result.data.length)
    throw new BindingError('connections_invalid', 'The approved connection configuration is invalid.');
  return result.data;
}

/** Operations receives this projection; secrets and arbitrary destination fields are never editable. */
export function connectionView(connection: ProviderConnection, env: Readonly<Record<string, unknown>>) {
  const { secretRef: _secretRef, ...publicFields } = connection;
  return { ...publicFields, credentialConfigured: connectionCredential(connection, env) !== null };
}
export function connectionCredential(connection: ProviderConnection, env: Readonly<Record<string, unknown>>): string | null {
  const secret = env[connection.secretRef];
  return typeof secret === 'string' && secret.length > 0 && secret.length <= 8192 && /^[\x21-\x7e]+$/.test(secret) ? secret : null;
}

/** Discovery is metadata only and never evidence of quota, task quality or privacy. */
export async function discoverConnectionModels(connection: ProviderConnection, env: Readonly<Record<string, unknown>>, transport: typeof fetch = globalThis.fetch) {
  if (connection.provider === 'aws-bedrock') return { source: 'approved-profiles', models: connection.allowedProfiles, note: 'Compatibility and access still require evidence for this account.' };
  if (connection.provider === 'azure-openai') return { source: 'approved-deployments', models: connection.deployments, note: 'Use the approved Azure deployment identity and its qualified model version.' };
  if (connection.provider === 'google-vertex') return { source: 'manual', models: [], note: 'Register the exact publisher model/version for this project and location with access and privacy evidence.' };
  const credential = connectionCredential(connection, env);
  if (!credential) throw new BindingError('credential_unavailable', 'The approved connection credential is unavailable.');
  const host = connection.ingress === 'global' ? 'openrouter.ai' : `${connection.ingress}.openrouter.ai`;
  const response = await transport(`https://${host}/api/v1/models`, { headers: { authorization: `Bearer ${credential}` }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new BindingError('discovery_unavailable', 'The provider model catalogue is unavailable. Manual registration remains available.');
  const data = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, 2_000_000))));
  const models = array(data.data).map(m => text(object(m).id)).filter(id => /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/.test(id) && !id.startsWith('openrouter/')).slice(0, 1000);
  return { source: 'provider-catalogue', models, note: 'Catalogue presence does not qualify a downstream endpoint for this account.' };
}

export function providerEndpoint(route: CatalogRoute, connection: ProviderConnection): string {
  const problems = bindingProblems(route, connection);
  if (problems.length) throw new BindingError(problems[0].code, problems[0].message);
  const b = route.binding!;
  if (connection.provider === 'aws-bedrock') {
    if (connection.endpointFamily === 'mantle') {
      const base = `https://bedrock-mantle.${connection.region}.api.aws`;
      return b.protocol === 'messages' ? `${base}/anthropic/v1/messages`
        : `${base}/v1/${b.protocol === 'responses' ? 'responses' : 'chat/completions'}`;
    }
    const base = `https://bedrock-runtime.${connection.region}.amazonaws.com`;
    if (b.protocol === 'responses' || b.protocol === 'chat-completions')
      return `${base}/openai/v1/${b.protocol === 'responses' ? 'responses' : 'chat/completions'}`;
    return `${base}/model/${encodeURIComponent(route.model)}/${b.protocol === 'converse' ? 'converse-stream' : 'invoke-with-response-stream'}`;
  }
  if (connection.provider === 'azure-openai') {
    // Claude on Foundry is served only at the Anthropic path of the services host; bindingProblems checked both.
    const base = `https://${connection.resource}.${connection.host ?? 'openai.azure.com'}`;
    return b.protocol === 'messages' ? `${base}/anthropic/v1/messages`
      : `${base}/openai/v1/${b.protocol === 'responses' ? 'responses' : 'chat/completions'}`;
  }
  if (connection.provider === 'google-vertex') {
    const host = connection.location === 'global' ? 'aiplatform.googleapis.com' : `${connection.location}-aiplatform.googleapis.com`;
    const action = b.protocol === 'messages' ? 'streamRawPredict' : 'streamGenerateContent?alt=sse';
    return `https://${host}/v1/projects/${connection.project}/locations/${connection.location}/publishers/${connection.publisher}/models/${encodeURIComponent(route.model)}:${action}`;
  }
  const host = connection.ingress === 'global' ? 'openrouter.ai' : `${connection.ingress}.openrouter.ai`;
  return `https://${host}/api/v1/chat/completions`;
}

/** Summary support belongs to the reviewed endpoint, not just the model name. */
export function supportsReasoningSummaries(route: CatalogRoute, connection: ProviderConnection): boolean {
  return MANAGED_PROVIDERS.some(registry => registry.reasoningSummaries === true &&
    registry.provider === route.provider && registry.model === route.model &&
    providerEndpoint(route, connection) === registry.endpoint);
}

interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown; callId?: string; tool?: { id: string; name: string; arguments: string }; native?: Obj[]; nativeTools?: NativeCheckpoint['tools'] }
function portableMessages(body: ResponsesBody, protocol: ModelBinding['protocol']): Message[] {
  const messages: Message[] = [];
  if (typeof body.instructions === 'string') messages.push({ role: 'system', content: body.instructions });
  for (const item of body.input) {
    if (item.type === 'reasoning') {
      const checkpoint = item.managedCheckpoint as NativeCheckpoint | undefined;
      if (!checkpoint || checkpoint.protocol !== protocol) throw new BindingError('nonportable_continuation', `The ${protocol} binding cannot replay a Responses-native reasoning item. Resume from a portable checkpoint.`);
      const mirrors: Message[] = [ ...(checkpoint.answer ? [{ role: 'assistant' as const, content: checkpoint.answer }] : []),
        ...checkpoint.tools.map(t => ({ role: 'assistant' as const, content: '', tool: t })) ];
      const canonical = (m: Message) => canonicalJson(m.tool ? ['tool', m.tool.id, m.tool.name, toolArguments(m.tool.arguments)]
        : ['text', parts(m.content).map(p => text(p.text)).join('')]);
      if (messages.length < mirrors.length || mirrors.some((m, i) => canonical(m) !== canonical(messages[messages.length - mirrors.length + i])))
        throw new BindingError('native_checkpoint_mismatch', 'The native checkpoint does not match the preceding assistant output. Resume from a portable checkpoint.');
      messages.splice(messages.length - mirrors.length, mirrors.length, { role: 'assistant', content: '', native: checkpoint.parts, nativeTools: checkpoint.tools });
      continue;
    }
    if (item.type === 'function_call') {
      messages.push({ role: 'assistant', content: '', tool: { id: text(item.call_id), name: text(item.name), arguments: text(item.arguments) } });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', content: item.output, callId: text(item.call_id) });
    } else {
      const role = item.role === 'developer' || item.role === 'system' ? 'system' : item.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new BindingError('invalid_message', 'This message role is not supported.');
      messages.push({ role, content: item.content });
    }
  }
  return messages;
}
function parts(content: unknown): Obj[] {
  return typeof content === 'string' ? [{ type: 'input_text', text: content }] : array(content).map(object);
}
function inlineImage(part: Obj) {
  const found = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(text(part.image_url));
  if (!found) throw new BindingError('invalid_image', 'Only a validated inline image can be sent.');
  return { mimeType: found[1], data: found[2] };
}
const functions = (body: ResponsesBody) => array(body.tools).map(object);
function toolArguments(value: string): Obj {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new BindingError('invalid_tool_history', 'Tool history contains invalid JSON.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BindingError('invalid_tool_history', 'Tool arguments must be an object.');
  return object(parsed);
}
function chosenTool(body: ResponsesBody): string | null { return text(object(body.tool_choice).name) || null; }
function reasoning(body: ResponsesBody) { return text(object(body.reasoning).effort); }

function configuredReasoning(binding: ModelBinding, body: ResponsesBody): Obj {
  const config = binding.reasoning;
  if (!config) return {};
  const requested = reasoning(body) || 'low';
  if (requested !== 'low' && requested !== 'medium' && requested !== 'high')
    throw new BindingError('reasoning_unsupported', 'This binding has no qualified configuration for that reasoning effort.');
  if (config.kind === 'anthropic-budget' || config.kind === 'anthropic-adaptive') {
    if (chosenTool(body) || body.tool_choice === 'required')
      throw new BindingError('reasoning_unsupported', 'This thinking mode does not support a forced tool choice.');
    if (config.kind === 'anthropic-adaptive')
      return { thinking: { type: 'adaptive' }, output_config: { effort: config.levels[requested] } };
    const budget = config.levels[requested];
    if (budget >= body.max_output_tokens!) throw new BindingError('reasoning_unsupported', 'The qualified thinking budget must fit below the output bound.');
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  if (config.kind === 'nova') return { reasoningConfig: { type: 'enabled', maxReasoningEffort: config.levels[requested] } };
  if (config.kind === 'gemini-level') return { thinkingLevel: config.levels[requested], includeThoughts: false };
  const budget = config.levels[requested];
  if (budget >= body.max_output_tokens!) throw new BindingError('reasoning_unsupported', 'The qualified thinking budget must fit below the output bound.');
  return { thinkingBudget: budget, includeThoughts: false };
}

/** Serialize from the gateway's allowlisted input, never copy arbitrary provider options. */
export function providerBody(route: CatalogRoute, connection: ProviderConnection, body: ResponsesBody): string {
  providerEndpoint(route, connection);
  const b = route.binding!;
  const model = connection.provider === 'azure-openai' ? b.deployment! : route.model;
  const max = body.max_output_tokens;
  if (!Number.isSafeInteger(max) || !max || max > b.capabilities.outputTokens) throw new BindingError('output_limit', 'A bounded supported output limit is required.');
  if (b.protocol === 'responses') return JSON.stringify({ ...body, model, store: false, stream: true, max_output_tokens: max, parallel_tool_calls: false });
  if (object(body.text).format && object(object(body.text).format).type !== 'text')
    throw new BindingError('unsupported_format', 'This binding does not support the requested structured response format.');
  const messages = portableMessages(body, b.protocol);
  const tools = functions(body); const chosen = chosenTool(body); const effort = reasoning(body);
  if (effort && !b.capabilities.reasoning) throw new BindingError('reasoning_unsupported', 'This route does not support the requested reasoning option.');
  const thinking = configuredReasoning(b, body);
  let outgoing: Obj;
  if (b.protocol === 'chat-completions') {
    outgoing = {
      model, stream: true, stream_options: { include_usage: true }, max_completion_tokens: max,
      messages: messages.map(m => m.tool ? { role: 'assistant', content: null, tool_calls: [{ id: m.tool.id, type: 'function', function: { name: m.tool.name, arguments: m.tool.arguments } }] }
        : m.role === 'tool' ? { role: 'tool', tool_call_id: m.callId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
          : { role: m.role, content: typeof m.content === 'string' ? m.content : parts(m.content).map(p => p.type === 'input_image'
            ? { type: 'image_url', image_url: { url: p.image_url, ...(p.detail ? { detail: p.detail } : {}) } }
            : { type: 'text', text: text(p.text) }) }),
      ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) } })),
        parallel_tool_calls: false, tool_choice: chosen ? { type: 'function', function: { name: chosen } } : body.tool_choice ?? 'auto' } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    if (connection.provider === 'openrouter') {
      outgoing.max_tokens = max; delete outgoing.max_completion_tokens;
      outgoing.plugins = []; outgoing.transforms = [];
      const bands = [b.price, ...b.price.longContext];
      // Prices in this API are USD per million tokens; our records are micro-USD per million.
      outgoing.provider = { only: [b.upstreamEndpoint], order: [b.upstreamEndpoint], allow_fallbacks: false,
        require_parameters: true, data_collection: 'deny', zdr: b.privacy?.zeroRetention === true,
        max_price: { prompt: Math.max(...bands.map(p => p.inputMicroUsdPerMillion)) / 1_000_000,
          completion: Math.max(...bands.flatMap(p => [p.outputMicroUsdPerMillion, p.reasoningMicroUsdPerMillion])) / 1_000_000 } };
    }
    // Bedrock's Chat Completions keeps no completions and documents no store field, so none is sent there.
    else if (connection.provider !== 'aws-bedrock') outgoing.store = false;
  } else if (b.protocol === 'messages') {
    outgoing = {
      stream: true, max_tokens: max,
      system: messages.filter(m => m.role === 'system').flatMap(m => parts(m.content).map(p => ({ type: 'text', text: text(p.text) }))),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.native ?? (m.tool ? [{ type: 'tool_use', id: m.tool.id, name: m.tool.name, input: toolArguments(m.tool.arguments) }]
          : m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: m.callId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
            : parts(m.content).map(p => p.type === 'input_image' ? { type: 'image', source: { type: 'base64', media_type: inlineImage(p).mimeType, data: inlineImage(p).data } }
              : { type: 'text', text: text(p.text) })) })),
      ...thinking,
      ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        tool_choice: chosen ? { type: 'tool', name: chosen, disable_parallel_tool_use: true }
          : { type: body.tool_choice === 'required' ? 'any' : body.tool_choice === 'none' ? 'none' : 'auto', disable_parallel_tool_use: true } } : {}),
    };
    if (connection.provider === 'google-vertex') outgoing.anthropic_version = 'vertex-2023-10-16';
    else if (connection.provider === 'aws-bedrock' && connection.endpointFamily === 'runtime') { outgoing.anthropic_version = 'bedrock-2023-05-31'; delete outgoing.stream; }
    else outgoing.model = model;
  } else if (b.protocol === 'converse') {
    outgoing = {
      system: messages.filter(m => m.role === 'system').flatMap(m => parts(m.content).map(p => ({ text: text(p.text) }))),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content:
        m.native ?? (m.tool ? [{ toolUse: { toolUseId: m.tool.id, name: m.tool.name, input: toolArguments(m.tool.arguments) } }]
          : m.role === 'tool' ? [{ toolResult: { toolUseId: m.callId, content: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] } }]
            : parts(m.content).map(p => p.type === 'input_image' ? { image: { format: inlineImage(p).mimeType.slice(6), source: { bytes: inlineImage(p).data } } } : { text: text(p.text) })) })),
      inferenceConfig: { maxTokens: max },
      ...(b.reasoning ? { additionalModelRequestFields: thinking } : {}),
      ...(tools.length && body.tool_choice !== 'none' ? { toolConfig: { tools: tools.map(t => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })),
        toolChoice: chosen ? { tool: { name: chosen } } : body.tool_choice === 'required' ? { any: {} } : { auto: {} } } } : {}),
    };
  } else {
    const callNames = new Map(messages.flatMap(m => m.tool ? [[m.tool.id, m.tool.name] as const] : (m.nativeTools ?? []).map(t => [t.id, t.name] as const)));
    outgoing = {
      systemInstruction: { parts: messages.filter(m => m.role === 'system').flatMap(m => parts(m.content).map(p => ({ text: text(p.text) }))) },
      contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts:
        m.native ?? (m.tool ? [{ functionCall: { name: m.tool.name, args: toolArguments(m.tool.arguments) } }]
          : m.role === 'tool' ? [{ functionResponse: { name: callNames.get(m.callId ?? '') ?? '', response: { result: m.content } } }]
            : parts(m.content).map(p => p.type === 'input_image' ? { inlineData: inlineImage(p) } : { text: text(p.text) })) })),
      generationConfig: { maxOutputTokens: max, ...(b.reasoning ? { thinkingConfig: thinking } : {}) },
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        toolConfig: { functionCallingConfig: { mode: chosen || body.tool_choice === 'required' ? 'ANY' : body.tool_choice === 'none' ? 'NONE' : 'AUTO', ...(chosen ? { allowedFunctionNames: [chosen] } : {}) } } } : {}),
    };
    if (messages.some(m => m.role === 'tool' && !callNames.has(m.callId ?? '')))
      throw new BindingError('invalid_tool_history', 'The Vertex tool result has no matching call in portable history.');
  }
  const serialized = JSON.stringify(outgoing);
  if (encoder.encode(serialized).byteLength > 524_288) throw new BindingError('request_too_large', 'The serialized provider request exceeds its bound.');
  return serialized;
}

export interface BoundProviderCall {
  route: CatalogRoute; connection: ProviderConnection; credential: string; body: ResponsesBody; signal: AbortSignal;
  scopeKey: string;
}
const nativePrefix = 'nectovia-native-v1:';
/** The route id is only a dispatch hint. AES-GCM authenticates the full binding and its credential. */
export function nativeRouteId(value: string): string | null {
  if (!value.startsWith(nativePrefix)) return null;
  const rest = value.slice(nativePrefix.length); return rest.slice(0, rest.lastIndexOf(':')) || null;
}
async function continuationCodec(call: BoundProviderCall) {
  // An account's own scope, or the Operations route checks' scope, which names no account.
  if (call.scopeKey !== ROUTE_CHECKS_SCOPE_KEY && !/^(organization|individual):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(call.scopeKey))
    throw new BindingError('account_scope_required', 'A native checkpoint requires its authenticated account scope.');
  const b = call.route.binding!;
  const identity = encoder.encode(JSON.stringify([call.scopeKey, call.route.id, call.connection.id, call.connection.revision, call.route.model,
    b.modelVersion, b.protocol, b.deployment, b.upstreamEndpoint]));
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`nectovia-native-v1\0${call.credential}`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const seal = async (value: NativeCheckpoint) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: identity }, key, encoder.encode(JSON.stringify(value))));
    let binary = ''; for (const byte of [...iv, ...encrypted]) binary += String.fromCharCode(byte);
    return `${nativePrefix}${call.route.id}:${btoa(binary)}`;
  };
  const open = async (value: string): Promise<NativeCheckpoint> => {
    if (nativeRouteId(value) !== call.route.id) throw new BindingError('nonportable_continuation', 'This native checkpoint belongs to another route. Resume from portable history.');
    try {
      const encoded = value.slice(nativePrefix.length + call.route.id.length + 1);
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: identity }, key, bytes.slice(12));
      const checkpoint = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)) as NativeCheckpoint;
      if (checkpoint.protocol !== b.protocol || !Array.isArray(checkpoint.parts) || !Array.isArray(checkpoint.tools) || typeof checkpoint.answer !== 'string') throw new Error('invalid');
      return checkpoint;
    } catch { throw new BindingError('nonportable_continuation', 'The native checkpoint no longer matches the approved binding or credential. Resume from portable history.'); }
  };
  return { seal, open };
}
export async function prepareManagedProvider(call: BoundProviderCall) {
  const codec = await continuationCodec(call);
  const input = [];
  for (const item of call.body.input) {
    if (item.type !== 'reasoning') { input.push(item); continue; }
    const checkpoint = await codec.open(text(item.encrypted_content));
    if (call.route.binding!.protocol === 'responses') input.push(...checkpoint.parts);
    else input.push({ ...item, managedCheckpoint: checkpoint });
  }
  return { body: { ...call.body, input }, seal: codec.seal };
}
/** One request, redirects forbidden, no SDK/internal retry, then the shared Responses stream. */
export async function callManagedProvider(call: BoundProviderCall, transport: typeof globalThis.fetch = globalThis.fetch): Promise<Response> {
  // Parse the connection again at the secret-bearing boundary, even if a caller skipped configuration validation.
  const connection = providerConnectionSchema.parse(call.connection);
  const endpoint = providerEndpoint(call.route, connection);
  const prepared = await prepareManagedProvider(call);
  const serialized = providerBody(call.route, connection, prepared.body);
  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  if (!call.credential || call.credential.length > 8192 || !/^[\x21-\x7e]+$/.test(call.credential))
    throw new BindingError('credential_unavailable', 'The provider credential is missing or invalid.');
  const vertexKey = connection.provider === 'google-vertex' && connection.secretRef === 'VERTEX_API_KEY';
  if (connection.provider === 'azure-openai')
    headers.set(call.route.binding!.protocol === 'messages' ? 'x-api-key' : 'api-key', call.credential);
  else if (connection.provider === 'aws-bedrock' && connection.endpointFamily === 'mantle' && call.route.binding!.protocol === 'messages')
    headers.set('x-api-key', call.credential);
  // A key is a header, never part of the URL, so it stays out of logs; it bills the project that owns it.
  else if (vertexKey) headers.set('x-goog-api-key', call.credential);
  else headers.set('authorization', `Bearer ${call.credential}`);
  if (connection.provider === 'google-vertex' && !vertexKey) headers.set('x-goog-user-project', connection.project);
  if (connection.provider === 'openrouter') headers.set('X-OpenRouter-Metadata', 'enabled');
  if (connection.provider === 'aws-bedrock' && connection.endpointFamily === 'runtime' && ['converse', 'messages'].includes(call.route.binding!.protocol))
    headers.set('accept', 'application/vnd.amazon.eventstream');
  if (call.route.binding!.protocol === 'messages' &&
      ((connection.provider === 'aws-bedrock' && connection.endpointFamily === 'mantle') || connection.provider === 'azure-openai'))
    headers.set('anthropic-version', '2023-06-01');
  const abort = new AbortController(), onAbort = () => abort.abort(call.signal.reason);
  if (call.signal.aborted) onAbort(); else call.signal.addEventListener('abort', onAbort, { once: true });
  const complete = () => call.signal.removeEventListener('abort', onAbort);
  let response: Response;
  try { response = await transport(endpoint, { method: 'POST', body: serialized, headers, signal: abort.signal, redirect: 'manual' }); }
  catch (error) { complete(); throw error; }
  if (!response.ok) { complete(); return response; }
  const requestId = ['x-amzn-requestid', 'x-request-id', 'request-id', 'apim-request-id', 'x-goog-request-id'].map(h => response.headers.get(h)).find(Boolean) ?? null;
  return normalizeProviderResponse(response, {
    protocol: call.route.binding!.protocol, model: call.route.model,
    upstreamEndpoint: connection.provider === 'openrouter' ? call.route.binding!.upstreamEndpoint : null,
    upstreamName: connection.provider === 'openrouter' ? connection.endpointNames[call.route.binding!.upstreamEndpoint!] : undefined,
    requestId, awsBinary: connection.provider === 'aws-bedrock' && connection.endpointFamily === 'runtime' && ['converse', 'messages'].includes(call.route.binding!.protocol),
    servedModels: [call.route.model, call.route.binding!.modelVersion, ...(call.route.binding!.deployment ? [call.route.binding!.deployment] : [])],
    seal: prepared.seal,
    cancel: () => abort.abort(), complete,
  });
}
