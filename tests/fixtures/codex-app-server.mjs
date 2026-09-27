#!/usr/bin/env node
/**
 * A stand-in Codex app-server for H02: newline-delimited JSON-RPC over stdio,
 * speaking the pinned 0.153.4 shapes `server/integrations.ts` reads. It keeps
 * non-ephemeral threads as files in CODEX_FIXTURE_DIR/threads, so a second
 * process (after a Stop closed the first, or after Diomedes restarted) finds
 * them, as the real app-server finds its saved rollouts.
 *
 * CODEX_FIXTURE_DIR/control.json is read on every request, so a test can change
 * the build between runs:
 *   capabilities: which of "resume", "fork", "steer" this build has (default all).
 *                 A method it lacks is refused the way the app-server refuses an
 *                 unknown method: -32600 "Invalid request: unknown variant …".
 *   hold:         a started turn waits (for a steer, or for the process to end).
 *   forget:       thread ids this build no longer has (resume/fork refuse them).
 *   changes:      the proposal's changes array (default: none).
 *   stream:       text a started turn streams first, in five-character deltas, before it
 *                 completes or holds (H16's trigger-rule watch reads it).
 *   think:         with a turn/start that asks summary "auto": reasoning summary parts
 *                  (a string, or an array of parts) streamed as item/reasoning/summaryTextDelta
 *                  in seven-character deltas before the answer.
 *   ignoreInterrupt: turn/interrupt is never answered and the held turn never ends.
 *   plan:          the account's planType (default "fixture"); changing it changes the account.
 *   signedOut:     account/read answers an API-key account, which is not ChatGPT.
 *   tool:          an item type (for example "fileChange") reported completed before the answer.
 *   delayTurnStart: milliseconds before turn/start is answered and its turn begins. A process
 *                  ended in that time never starts the turn or records its message.
 *   turnMs:        milliseconds a started turn runs before it completes (default 5).
 * Every request is appended to CODEX_FIXTURE_DIR/calls.jsonl for assertions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.env.CODEX_FIXTURE_DIR;
if (!root) {
  process.stderr.write('CODEX_FIXTURE_DIR is required\n');
  process.exit(2);
}
const threadsDir = path.join(root, 'threads');
fs.mkdirSync(threadsDir, { recursive: true });

const control = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'));
  } catch {
    return {};
  }
};
const has = (capability) =>
  (control().capabilities ?? ['resume', 'fork', 'steer']).includes(capability);
const log = (entry) =>
  fs.appendFileSync(
    path.join(root, 'calls.jsonl'),
    `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
  );

const MODEL = 'fixture-codex-model';
const policy = {
  model: MODEL,
  modelProvider: 'openai',
  sandbox: { type: 'readOnly', networkAccess: false },
  approvalPolicy: 'never',
};
/** Threads this process has loaded. A kept one is also on disk. */
const loaded = new Map();
let active = null;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ id, result });
const refuse = (id, message, code = -32600) => {
  send({ id, error: { code, message } });
  return undefined;
};
const notify = (method, params) => send({ method, params });

function save(thread) {
  loaded.set(thread.id, thread);
  if (thread.kept)
    fs.writeFileSync(path.join(threadsDir, `${thread.id}.json`), JSON.stringify(thread));
}
function find(id) {
  if ((control().forget ?? []).includes(id)) return null;
  if (loaded.has(id)) return loaded.get(id);
  try {
    const thread = JSON.parse(fs.readFileSync(path.join(threadsDir, `${id}.json`), 'utf8'));
    loaded.set(id, thread);
    return thread;
  } catch {
    return null;
  }
}
const textOf = (input) =>
  (Array.isArray(input) ? input : [])
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .join('\n');

function complete() {
  const turn = active;
  if (!turn) return;
  active = null;
  const thread = find(turn.threadId) ?? loaded.get(turn.threadId);
  const users = thread.messages.filter((message) => message.role === 'user').length;
  const steered = turn.steered.length ? ` Steered: ${turn.steered.join(' | ')}.` : '';
  const text = JSON.stringify({
    summary: `Fixture answer on ${thread.id} after ${users} user ${users === 1 ? 'turn' : 'turns'}.${steered}`,
    changes: control().changes ?? [],
  });
  thread.messages.push({ role: 'assistant', text });
  save(thread);
  const tool = control().tool;
  if (typeof tool === 'string')
    notify('item/completed', { threadId: thread.id, turnId: turn.turnId, item: { id: 'item_tool', type: tool } });
  notify('item/agentMessage/delta', {
    threadId: thread.id,
    turnId: turn.turnId,
    delta: text.slice(0, 12),
  });
  notify('item/completed', {
    threadId: thread.id,
    turnId: turn.turnId,
    item: { type: 'agentMessage', text },
  });
  notify('turn/completed', {
    threadId: thread.id,
    turn: { id: turn.turnId, status: 'completed', model: MODEL },
  });
}

function beginTurn(params) {
  const thread = find(params.threadId) ?? loaded.get(params.threadId);
  thread.messages.push({ role: 'user', text: textOf(params.input) });
  save(thread);
  const turnId = `turn_${randomUUID().slice(0, 8)}`;
  active = { threadId: thread.id, turnId, steered: [] };
  // Decided when the turn starts: a test that rewrites control.json while this turn streams
  // (for another process's next turn) doesn't release it.
  const hold = control().hold;
  const turnMs = control().turnMs ?? 5;
  const think = params.summary === 'auto' ? control().think : undefined;
  const parts = typeof think === 'string' ? [think] : Array.isArray(think) ? think : [];
  const preamble = control().stream;
  if (parts.length || typeof preamble === 'string') {
    // After the turn/start reply, as the app-server streams: the adapter registers the turn first.
    setTimeout(() => {
      parts.forEach((part, summaryIndex) => {
        notify('item/reasoning/summaryPartAdded', { threadId: thread.id, turnId, itemId: 'rs_1', summaryIndex });
        for (let at = 0; at < part.length; at += 7)
          notify('item/reasoning/summaryTextDelta', {
            threadId: thread.id,
            turnId,
            itemId: 'rs_1',
            summaryIndex,
            delta: part.slice(at, at + 7),
          });
      });
      if (typeof preamble === 'string')
        for (let at = 0; at < preamble.length; at += 5)
          notify('item/agentMessage/delta', { threadId: thread.id, turnId, delta: preamble.slice(at, at + 5) });
      if (!hold) setTimeout(complete, turnMs);
    }, 20);
  } else if (!hold) setTimeout(complete, turnMs);
  return { turn: { id: turnId, status: 'inProgress' } };
}

const handlers = {
  initialize: () => ({ userAgent: 'codex_fixture/0.153.4 (fixture; stdio)' }),
  'account/read': () =>
    control().signedOut
      ? { requiresOpenaiAuth: true, account: { type: 'apiKey' } }
      : { requiresOpenaiAuth: true, account: { type: 'chatgpt', planType: control().plan ?? 'fixture' } },
  'config/read': () => ({ config: { mcp_servers: {} } }),
  'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
  'thread/start': (params) => {
    const thread = {
      id: `thr_${randomUUID().slice(0, 8)}`,
      kept: params.ephemeral === false,
      forkedFrom: null,
      messages: [],
    };
    save(thread);
    return { thread: { id: thread.id }, ...policy };
  },
  'thread/resume': (params, id) => {
    if (typeof params.threadId !== 'string')
      return refuse(id, 'Invalid request: missing field `threadId`');
    const thread = find(params.threadId);
    if (!thread) return refuse(id, `no rollout found for thread id ${params.threadId}`);
    return { thread: { id: thread.id }, ...policy };
  },
  'thread/fork': (params, id) => {
    if (typeof params.threadId !== 'string')
      return refuse(id, 'Invalid request: missing field `threadId`');
    const source = find(params.threadId);
    if (!source) return refuse(id, `no rollout found for thread id ${params.threadId}`);
    const thread = {
      id: `thr_${randomUUID().slice(0, 8)}`,
      kept: true,
      forkedFrom: source.id,
      messages: structuredClone(source.messages),
    };
    save(thread);
    return { thread: { id: thread.id }, ...policy };
  },
  'turn/start': (params, id) => {
    const delay = control().delayTurnStart;
    // A late reply: the caller has sent turn/start and doesn't know the turn id yet.
    if (typeof delay === 'number') {
      setTimeout(() => reply(id, beginTurn(params)), delay);
      return undefined;
    }
    return beginTurn(params);
  },
  'turn/steer': (params, id) => {
    if (typeof params.threadId !== 'string')
      return refuse(id, 'Invalid request: missing field `threadId`');
    if (!active || active.threadId !== params.threadId || active.turnId !== params.expectedTurnId)
      return refuse(id, 'no active turn to steer');
    const text = textOf(params.input);
    active.steered.push(text);
    const thread = loaded.get(active.threadId);
    thread.messages.push({ role: 'user', text, steer: true });
    save(thread);
    setTimeout(complete, 5);
    return { turnId: active.turnId };
  },
  'turn/interrupt': (params, id) => {
    if (!active || active.threadId !== params.threadId || active.turnId !== params.turnId)
      return refuse(id, 'no active turn to interrupt');
    // Never answered: the caller's bounded wait must end the process itself.
    if (control().ignoreInterrupt) return undefined;
    const turn = active;
    active = null;
    setTimeout(
      () =>
        notify('turn/completed', {
          threadId: turn.threadId,
          turn: { id: turn.turnId, status: 'interrupted', model: MODEL },
        }),
      5,
    );
    return {};
  },
};
const CAPABILITY_OF = { 'thread/resume': 'resume', 'thread/fork': 'fork', 'turn/steer': 'steer' };

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== 'string' || message.id === undefined) continue;
    const params = message.params ?? {};
    log({ method: message.method, params });
    const probe = Object.keys(params).length === 0;
    const failure = (probe ? control().probeErrors : control().errors)?.[message.method];
    if (failure === 'exit') process.exit(1);
    if (failure) {
      refuse(message.id, failure.message, failure.code);
      continue;
    }
    const capability = CAPABILITY_OF[message.method];
    const handler = handlers[message.method];
    if (!handler || (capability && !has(capability))) {
      refuse(
        message.id,
        `Invalid request: unknown variant \`${message.method}\`, expected one of \`initialize\`, \`thread/start\``,
      );
      continue;
    }
    const result = handler(params, message.id);
    if (result !== undefined) reply(message.id, result);
  }
});
process.stdin.on('end', () => process.exit(0));
