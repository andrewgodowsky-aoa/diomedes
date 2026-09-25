/**
 * The managed inference gateway (contract `nectovia-managed/1`,
 * docs/implementation/2026-09-25-managed-inference-gateway.md).
 *
 * A paying customer's bot calls a model on the company's provider account
 * through `POST /managed/v1/responses`, and the organization's credit is
 * debited for exactly what the call used. Customers never hold a provider key;
 * this is the only code that sends one.
 *
 * This module is not a general proxy. It forwards only the allowlisted body
 * below, only to the endpoint the resolved route's registry row names, and only
 * with the credential that row names.
 */

// --- the request body allowlist (contract section 1) -----------------------------------------

export type BodyRefusalCode = 'unsupported_field' | 'invalid_body';
export type BodyRefusal = { ok: false; code: BodyRefusalCode; field: string; message: string };

/** A body that passed the allowlist. Fields are exactly the client's; nothing has been added yet. */
export interface ResponsesBody {
  readonly [key: string]: unknown;
  readonly model: string;
  readonly input: readonly Record<string, unknown>[];
  readonly max_output_tokens?: number;
}

class Refusal {
  constructor(readonly code: BodyRefusalCode, readonly field: string, readonly message: string) {}
}
const unsupported = (field: string, message = `Nectovia’s managed model service does not accept ${field}.`): never => {
  throw new Refusal('unsupported_field', field, message);
};
const invalid = (field: string, message: string): never => {
  throw new Refusal('invalid_body', field, message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (base: string, key: string) => (base ? `${base}.${key}` : key);
function only(value: Record<string, unknown>, field: string, allowed: readonly string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(at(field, key));
}
function text(value: unknown, field: string, max = 10_000_000) {
  if (typeof value !== 'string' || value.length > max) invalid(field, `${field} must be text.`);
}

const TOP_LEVEL = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'include',
  'max_output_tokens', 'store', 'stream', 'text'] as const;
const MESSAGE_ROLES = ['developer', 'system', 'user', 'assistant'];
const MESSAGE_PARTS = ['input_text', 'output_text', 'input_image'];
const TOOL_OUTPUT_PARTS = ['input_text', 'input_image'];
const DATA_IMAGE = /^data:image\/[A-Za-z0-9.+-]{1,64};base64,[A-Za-z0-9+/]*={0,2}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOLS = 64;
const MAX_TOOL_BYTES = 16_384;

function part(value: unknown, field: string, allowed: readonly string[]) {
  if (!isObject(value)) return invalid(field, `${field} must be a content part.`);
  if (typeof value.type !== 'string') return invalid(at(field, 'type'), `${at(field, 'type')} must be text.`);
  if (!allowed.includes(value.type)) unsupported(at(field, 'type'), `Nectovia’s managed model service does not accept ${value.type} content (${at(field, 'type')}).`);
  if (value.type === 'input_image') {
    only(value, field, ['type', 'image_url']);
    if (typeof value.image_url !== 'string') return invalid(at(field, 'image_url'), `${at(field, 'image_url')} must be an inline data: image.`);
    if (!DATA_IMAGE.test(value.image_url))
      unsupported(at(field, 'image_url'), `Only inline data: images are accepted, so ${at(field, 'image_url')} was refused; a remote image is never fetched.`);
    return;
  }
  only(value, field, ['type', 'text']);
  text(value.text, at(field, 'text'));
}

function item(value: unknown, field: string) {
  if (!isObject(value)) return invalid(field, `${field} must be an input item.`);
  const type = value.type;
  if (type === undefined || type === 'message') {
    only(value, field, ['type', 'role', 'content']);
    if (typeof value.role !== 'string') return invalid(at(field, 'role'), `${at(field, 'role')} must be text.`);
    if (!MESSAGE_ROLES.includes(value.role))
      unsupported(at(field, 'role'), `Nectovia’s managed model service does not accept a ${value.role} message (${at(field, 'role')}).`);
    if (typeof value.content === 'string') return;
    if (!Array.isArray(value.content)) return invalid(at(field, 'content'), `${at(field, 'content')} must be text or a list of content parts.`);
    value.content.forEach((entry, index) => part(entry, `${field}.content[${index}]`, MESSAGE_PARTS));
    return;
  }
  if (type === 'function_call') {
    only(value, field, ['type', 'call_id', 'name', 'arguments']);
    text(value.call_id, at(field, 'call_id'), 256);
    text(value.name, at(field, 'name'), 128);
    text(value.arguments, at(field, 'arguments'));
    return;
  }
  if (type === 'function_call_output') {
    only(value, field, ['type', 'call_id', 'output']);
    text(value.call_id, at(field, 'call_id'), 256);
    if (typeof value.output === 'string') return;
    if (!Array.isArray(value.output)) return invalid(at(field, 'output'), `${at(field, 'output')} must be text or a list of content parts.`);
    value.output.forEach((entry, index) => part(entry, `${field}.output[${index}]`, TOOL_OUTPUT_PARTS));
    return;
  }
  if (type === 'reasoning') {
    only(value, field, ['type', 'id', 'encrypted_content', 'summary']);
    if (value.id !== undefined) text(value.id, at(field, 'id'), 256);
    if (value.encrypted_content === undefined || value.encrypted_content === null)
      unsupported(at(field, 'encrypted_content'), `Reasoning is carried back only with its encrypted content, and ${at(field, 'encrypted_content')} is missing.`);
    text(value.encrypted_content, at(field, 'encrypted_content'));
    if (value.summary === undefined) return;
    if (!Array.isArray(value.summary)) return invalid(at(field, 'summary'), `${at(field, 'summary')} must be a list.`);
    value.summary.forEach((entry, index) => {
      const name = `${field}.summary[${index}]`;
      if (!isObject(entry)) return invalid(name, `${name} must be a summary part.`);
      only(entry, name, ['type', 'text']);
      if (entry.type !== 'summary_text') unsupported(at(name, 'type'));
      text(entry.text, at(name, 'text'));
    });
    return;
  }
  if (typeof type === 'string')
    unsupported(at(field, 'type'), `Nectovia’s managed model service does not accept a ${type} item (${at(field, 'type')}).`);
  invalid(at(field, 'type'), `${at(field, 'type')} must be text.`);
}

function tools(value: unknown): Set<string> {
  const names = new Set<string>();
  if (value === undefined) return names;
  if (!Array.isArray(value)) return invalid('tools', 'tools must be a list.');
  if (value.length > MAX_TOOLS) invalid('tools', `At most ${MAX_TOOLS} tools can be offered in one request.`);
  const encoder = new TextEncoder();
  value.forEach((tool, index) => {
    const field = `tools[${index}]`;
    if (!isObject(tool)) return invalid(field, `${field} must be a tool.`);
    if (tool.type !== 'function') {
      if (typeof tool.type === 'string')
        unsupported(at(field, 'type'), `Only function tools can be offered; ${at(field, 'type')} names the built-in tool ${tool.type}.`);
      invalid(at(field, 'type'), `${at(field, 'type')} must be function.`);
    }
    only(tool, field, ['type', 'name', 'description', 'parameters', 'strict']);
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name))
      invalid(at(field, 'name'), `${at(field, 'name')} must be a function name of letters, digits, _ or -.`);
    if (names.has(tool.name as string)) invalid(at(field, 'name'), `${at(field, 'name')} repeats a tool name.`);
    names.add(tool.name as string);
    if (tool.description !== undefined) text(tool.description, at(field, 'description'));
    if (!isObject(tool.parameters)) invalid(at(field, 'parameters'), `${at(field, 'parameters')} must be a JSON schema object.`);
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') invalid(at(field, 'strict'), `${at(field, 'strict')} must be true or false.`);
    if (encoder.encode(JSON.stringify(tool)).byteLength > MAX_TOOL_BYTES)
      invalid(field, `Each tool must be at most 16 KB when serialized, and ${field} is larger.`);
  });
  return names;
}

function validate(value: unknown): ResponsesBody {
  if (!isObject(value)) return invalid('body', 'The request body must be a JSON object.');
  only(value, '', TOP_LEVEL);
  if (typeof value.model !== 'string' || !value.model || value.model.length > 200) invalid('model', 'model must name the model the tier resolves to.');
  if (!Array.isArray(value.input) || value.input.length === 0) invalid('input', 'input must be a non-empty list of items.');
  (value.input as unknown[]).forEach((entry, index) => item(entry, `input[${index}]`));
  if (value.instructions !== undefined) text(value.instructions, 'instructions');
  const offered = tools(value.tools);
  const choice = value.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) unsupported('tool_choice', `tool_choice ${choice} is not accepted; use auto, none, required or a listed function.`);
    } else if (isObject(choice)) {
      if (choice.type !== 'function') unsupported('tool_choice.type', 'tool_choice can only name a listed function.');
      only(choice, 'tool_choice', ['type', 'name']);
      if (typeof choice.name !== 'string' || !offered.has(choice.name)) invalid('tool_choice.name', 'tool_choice.name must name a function listed in tools.');
    } else invalid('tool_choice', 'tool_choice must be auto, none, required or a listed function.');
  }
  if (value.parallel_tool_calls !== undefined) {
    if (typeof value.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls', 'parallel_tool_calls must be false.');
    if (value.parallel_tool_calls) unsupported('parallel_tool_calls', 'parallel_tool_calls must be false; one tool call is made at a time.');
  }
  if (value.reasoning !== undefined) {
    const reasoning = value.reasoning;
    if (!isObject(reasoning)) return invalid('reasoning', 'reasoning must be an object.');
    only(reasoning, 'reasoning', ['effort', 'summary']);
    if (typeof reasoning.effort !== 'string') invalid('reasoning.effort', 'reasoning.effort must be low, medium or high.');
    if (!['low', 'medium', 'high'].includes(reasoning.effort as string))
      unsupported('reasoning.effort', `reasoning.effort ${String(reasoning.effort)} is not accepted; use low, medium or high.`);
    if ('summary' in reasoning && reasoning.summary !== null) unsupported('reasoning.summary', 'reasoning.summary is not accepted; leave it out or null.');
  }
  if (value.include !== undefined) {
    if (!Array.isArray(value.include)) invalid('include', 'include must be a list.');
    if ((value.include as unknown[]).length !== 1 || (value.include as unknown[])[0] !== 'reasoning.encrypted_content')
      unsupported('include', 'include may only ask for reasoning.encrypted_content.');
  }
  if (value.max_output_tokens !== undefined &&
      (typeof value.max_output_tokens !== 'number' || !Number.isSafeInteger(value.max_output_tokens) || value.max_output_tokens < 1))
    invalid('max_output_tokens', 'max_output_tokens must be a whole number of at least 1.');
  if (value.store !== undefined) {
    if (typeof value.store !== 'boolean') invalid('store', 'store must be false.');
    if (value.store) unsupported('store', 'store must be false; Nectovia never asks the provider to keep a conversation.');
  }
  if (value.stream !== undefined) {
    if (typeof value.stream !== 'boolean') invalid('stream', 'stream must be true.');
    if (!value.stream) unsupported('stream', 'stream must be true; the managed model service only streams.');
  }
  if (value.text !== undefined) {
    const output = value.text;
    if (!isObject(output)) return invalid('text', 'text must be an object.');
    only(output, 'text', ['format']);
    const format = output.format;
    if (!isObject(format)) return invalid('text.format', 'text.format must be an object.');
    if (format.type === 'text') only(format, 'text.format', ['type']);
    else if (format.type === 'json_schema') {
      only(format, 'text.format', ['type', 'name', 'schema', 'strict']);
      if (typeof format.name !== 'string' || !TOOL_NAME.test(format.name)) invalid('text.format.name', 'text.format.name must be a short name of letters, digits, _ or -.');
      if (!isObject(format.schema)) invalid('text.format.schema', 'text.format.schema must be a JSON schema object.');
      if (format.strict !== undefined && typeof format.strict !== 'boolean') invalid('text.format.strict', 'text.format.strict must be true or false.');
    } else if (typeof format.type === 'string') unsupported('text.format.type', `text.format.type ${format.type} is not accepted; use text or json_schema.`);
    else invalid('text.format.type', 'text.format.type must be text or json_schema.');
  }
  return value as unknown as ResponsesBody;
}

/** Check a parsed request body against the allowlist. The first thing outside it is named. */
export function validateResponsesBody(value: unknown): { ok: true; body: ResponsesBody } | BodyRefusal {
  try {
    return { ok: true, body: validate(value) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, field: error.field, message: error.message };
    throw error;
  }
}

/** JSON with every object's keys sorted, so one body always has one digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
