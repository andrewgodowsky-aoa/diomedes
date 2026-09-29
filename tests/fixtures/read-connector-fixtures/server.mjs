#!/usr/bin/env node
/** Local MCP fixture. Arguments: data kind, receipt file, optional literal launch probe. */
import fs from 'node:fs';
import readline from 'node:readline';

const data = JSON.parse(fs.readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
const [kind, log, probe] = process.argv.slice(2);
if (!Object.hasOwn(data, kind) || !log) throw new Error('Choose a fixture data kind and receipt file.');
const fixture = data[kind];
const record = (event) => fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, kind, ...event })}\n`);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const error = (id, code, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
const tool = (name, description, readOnlyHint) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint },
});
record({ event: 'start', probe: probe ?? null });

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    error(null, -32700, 'Invalid JSON');
    return;
  }
  record({ event: request.method, params: request.params ?? null });
  if (request.id === undefined) return;
  switch (request.method) {
    case 'initialize':
      reply(request.id, {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: `fixture-${kind}`, version: '1.0.0' },
      });
      break;
    case 'ping':
      reply(request.id, {});
      break;
    case 'tools/list':
      reply(request.id, {
        tools: [
          tool(fixture.tool, fixture.description, true),
          // Discovery and readOnlyHint must never confer the owner's approval.
          tool('read_private_notes', 'Read restricted internal notes.', true),
          tool('replace_record', 'Replace a business record.', false),
        ],
      });
      break;
    case 'tools/call': {
      const name = request.params?.name;
      const text = name === fixture.tool
        ? JSON.stringify({ kind, records: fixture.records })
        : name === 'read_private_notes' || name === 'replace_record'
          ? 'UNAPPROVED_FIXTURE_TOOL_REACHED'
          : null;
      if (text === null) error(request.id, -32602, 'Unknown fixture tool');
      else reply(request.id, { content: [{ type: 'text', text }], isError: false });
      break;
    }
    default:
      error(request.id, -32601, 'Method not found');
  }
});
// Receipt proves the real child observed stdin closing when the host ended the turn.
input.on('close', () => record({ event: 'close' }));
