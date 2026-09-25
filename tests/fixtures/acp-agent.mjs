#!/usr/bin/env node
/**
 * A fixture ACP agent (H05): a real child process speaking ACP v1 JSON-RPC over
 * stdio, for the kept ACP conversation tests. It keeps its sessions on disk in
 * its working folder, so a second process — the next turn, or the first turn
 * after a Diomedes restart — can `session/load` one, replaying its history.
 *
 * Behaviour is chosen by environment, set by the test's launcher:
 *   ACP_FIXTURE_LOAD=0      do not advertise loadSession
 *   ACP_FIXTURE_CANCEL=ignore  never answer session/cancel (the process must be ended)
 *   ACP_FIXTURE_LOG=<file>  append every received method, one per line
 * and per prompt by the request text: `hang` waits for a cancel, `plan` presents
 * a plan with cursor/create_plan, `fetch` asks permission for a web fetch,
 * `edit` asks permission for a file edit; anything else is answered with the
 * number of earlier turns this session holds.
 *
 * Both Cursor's (`models.availableModels`) and Devin's (`configOptions`) session
 * shapes are returned, so each adapter reads its own.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const store = path.join(process.cwd(), '.acp-fixture-sessions');
const loadSession = process.env.ACP_FIXTURE_LOAD !== '0';
const ignoreCancel = process.env.ACP_FIXTURE_CANCEL === 'ignore';
const log = process.env.ACP_FIXTURE_LOG;
const model = process.env.ACP_FIXTURE_MODEL || 'fixture-model';

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const reply = (id, result) => send({ id, result });
const update = (sessionId, value) =>
  send({ method: 'session/update', params: { sessionId, update: value } });
const file = (id) => path.join(store, `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);
const read = (id) => {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return null;
  }
};
const write = (id, session) => {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify(session));
};
const sessionShape = (sessionId) => ({
  ...(sessionId ? { sessionId } : {}),
  models: { currentModelId: model, availableModels: [{ modelId: model, name: 'Fixture' }] },
  modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] },
  configOptions: [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [{ value: model, name: 'Fixture' }],
    },
  ],
});
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
let running = null;

async function prompt(frame) {
  const { sessionId } = frame.params;
  const session = read(sessionId);
  if (!session) return send({ id: frame.id, error: { code: -32002, message: 'Session not found' } });
  const envelope = JSON.parse(frame.params.prompt[0].text);
  const request = String(envelope.input?.request ?? '');
  running = { id: frame.id, sessionId };
  const finish = (text) => {
    if (running?.id !== frame.id) return;
    running = null;
    say(sessionId, text);
    session.history.push({ user: request, agent: text });
    write(sessionId, session);
    reply(frame.id, { stopReason: 'end_turn' });
  };
  if (request.includes('hang')) {
    say(sessionId, 'Working on it');
    return; // answered by session/cancel, or never.
  }
  if (request.includes('plan')) {
    const answer = await ask('cursor/create_plan', {
      sessionId,
      title: 'Outline the report in three sections',
      plan: '1. Scope 2. Findings 3. Next steps',
    });
    if (answer.outcome?.outcome === 'accepted') {
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [{ content: 'Scope', priority: 'high', status: 'in_progress' }],
      });
      return finish('plan accepted; outlined');
    }
    return finish(`plan ${answer.outcome?.outcome ?? 'unknown'}`);
  }
  if (request.includes('fetch') || request.includes('edit')) {
    const kind = request.includes('fetch') ? 'fetch' : 'edit';
    const toolCall = {
      toolCallId: `call-${kind}`,
      title: kind === 'fetch' ? 'Open https://example.com/status' : 'Edit Notes.md',
      kind,
      status: 'pending',
      rawInput: kind === 'fetch' ? { url: 'https://example.com/status' } : { path: 'Notes.md' },
    };
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (answer.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow') {
      update(sessionId, { sessionUpdate: 'tool_call', ...toolCall, status: 'in_progress' });
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: toolCall.toolCallId,
        status: 'completed',
        rawOutput: { status: 200 },
      });
      return finish(`${kind} allowed and done`);
    }
    return finish(`${kind} ${answer.outcome?.outcome === 'selected' ? answer.outcome.optionId : answer.outcome?.outcome}`);
  }
  finish(`answer after ${session.history.length} earlier turns`);
}

function handle(frame) {
  if (frame.method && log) fs.appendFileSync(log, `${frame.method}\n`);
  if (frame.method === undefined) {
    const resolve = waiting.get(frame.id);
    waiting.delete(frame.id);
    resolve?.(frame.result ?? {});
    return;
  }
  switch (frame.method) {
    case 'initialize':
      return reply(frame.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession, promptCapabilities: { image: false } },
        authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }],
      });
    case 'authenticate':
      return reply(frame.id, {});
    case 'session/new': {
      const sessionId = `s-${randomUUID()}`;
      write(sessionId, { history: [] });
      return reply(frame.id, sessionShape(sessionId));
    }
    case 'session/load': {
      if (!loadSession)
        return send({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
      const session = read(frame.params.sessionId);
      if (!session)
        return send({ id: frame.id, error: { code: -32002, message: 'Resource not found' } });
      for (const turn of session.history) {
        update(frame.params.sessionId, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: turn.user },
        });
        say(frame.params.sessionId, turn.agent);
      }
      return reply(frame.id, sessionShape());
    }
    case 'session/set_mode':
      update(frame.params.sessionId, {
        sessionUpdate: 'current_mode_update',
        currentModeId: frame.params.modeId,
      });
      return reply(frame.id, {});
    case 'session/set_model':
      return reply(frame.id, {});
    case 'session/prompt':
      return void prompt(frame);
    case 'session/cancel':
      if (ignoreCancel || !running) return;
      reply(running.id, { stopReason: 'cancelled' });
      running = null;
      return;
    default:
      if (frame.id !== undefined)
        send({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
