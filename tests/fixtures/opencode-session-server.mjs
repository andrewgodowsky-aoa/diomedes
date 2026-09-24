// A fixture `opencode serve` for the kept-session route (H04). It speaks the
// subset of the opencode v1.18.4 HTTP API the session transport uses, shaped
// after the documented routes (packages/web/src/content/docs/server.mdx):
// GET /provider, GET /event (SSE), POST /session, GET /session/:id,
// GET /session/status, POST /session/:id/prompt_async, POST /session/:id/abort,
// POST /session/:id/fork and DELETE /session/:id.
//
// Sessions are kept in <XDG_DATA_HOME>/opencode-fixture/sessions.json, the way
// the real tool keeps them under the person's own data folder, so a second
// server process started later finds a session the first one created. Every
// request is appended to requests.log in the working directory.
//
// argv: <port> <mode>. Modes:
//   ok           answers every prompt
//   delayed      answers every prompt after 300 ms, long enough to steer into
//   slow         streams a partial answer, then waits to be aborted
//   stuck-abort  like slow, but an abort leaves the session busy
//   no-fork      has no fork route (404), like a build without one
//   wrong-model  reports a different model than the one requested
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const port = Number(process.argv[2]);
const mode = process.argv[3] || 'ok';
const dataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '.', '.local', 'share');
const storeFile = path.join(dataHome, 'opencode-fixture', 'sessions.json');
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  } catch {
    return { next: 1, sessions: {} };
  }
};
const save = (store) => {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(store));
};
// Unique like the real tool's ids, even after the store is cleared.
const sessionId = (store) => `ses_${String(store.next++).padStart(4, '0')}${randomBytes(3).toString('hex')}`;
const log = (line) => fs.appendFileSync('requests.log', `${line}\n`);
const streams = new Set();
const send = (value) => {
  for (const res of streams) res.write(`data: ${JSON.stringify(value)}\n\n`);
};
const busy = new Map(); // sessionID -> finish(aborted)
let assistantSeq = 0;
const catalogue = {
  connected: ['opencode-go'],
  all: [{ id: 'opencode-go', models: { 'go-model': { id: 'go-model', name: 'Go model' } } }],
};
const body = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

function prompt(sessionID, payload) {
  const store = load();
  const session = store.sessions[sessionID];
  const text = payload.parts?.[0]?.text ?? '';
  let request = text;
  try {
    request = JSON.parse(text).request;
  } catch {
    /* A prompt that is not Diomedes' own envelope is answered as it is. */
  }
  session.messages.push({ role: 'user', text: request });
  save(store);
  const turn = session.messages.filter((message) => message.role === 'user').length;
  const id = `msg_a${String(++assistantSeq).padStart(4, '0')}_${port}`;
  const providerID = 'opencode-go';
  const modelID = mode === 'wrong-model' ? 'other-model' : payload.model?.modelID;
  const info = (extra = {}) => ({
    type: 'message.updated',
    properties: { info: { id, sessionID, role: 'assistant', providerID, modelID, time: { created: 1 }, ...extra } },
  });
  const answer = `answer:${request} (turn ${turn} of ${sessionID})`;
  setTimeout(() => {
    send({ type: 'message.updated', properties: { info: { id: `msg_u${id}`, sessionID, role: 'user' } } });
    send(info());
    send({ type: 'message.part.updated', properties: { part: { id: `part_${id}`, sessionID, messageID: id, type: 'text', text: '' } } });
    if (mode === 'slow' || mode === 'stuck-abort') {
      send({ type: 'message.part.delta', properties: { sessionID, messageID: id, partID: `part_${id}`, field: 'text', delta: 'Partial ' } });
      busy.set(sessionID, () => {
        send(info({ time: { created: 1, completed: 2 }, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }));
        if (mode !== 'stuck-abort') {
          busy.delete(sessionID);
          send({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
        }
      });
      return;
    }
    send({ type: 'message.part.delta', properties: { sessionID, messageID: id, partID: `part_${id}`, field: 'text', delta: answer } });
    const saved = load();
    saved.sessions[sessionID].messages.push({ role: 'assistant', id, text: answer });
    save(saved);
    send(info({ time: { created: 1, completed: 2 }, finish: 'stop' }));
    busy.delete(sessionID);
    send({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
  }, mode === 'delayed' ? 300 : 5);
  busy.set(sessionID, () => {});
}

const server = http.createServer(async (req, res) => {
  if (!(req.headers.authorization || '').startsWith('Basic ')) {
    res.writeHead(401);
    return res.end();
  }
  const url = new URL(req.url, 'http://fixture');
  log(`${req.method} ${url.pathname}`);
  if (url.pathname === '/provider') return json(res, catalogue);
  if (url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    streams.add(res);
    res.on('close', () => streams.delete(res));
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    return;
  }
  if (url.pathname === '/session/status' && req.method === 'GET')
    return json(res, Object.fromEntries([...busy.keys()].map((id) => [id, { type: 'busy' }])));
  if (url.pathname === '/session' && req.method === 'POST') {
    const payload = await body(req);
    const store = load();
    const id = sessionId(store);
    store.sessions[id] = { id, title: payload.title, permission: payload.permission, messages: [] };
    save(store);
    return json(res, { id });
  }
  const match = /^\/session\/([^/]+)(\/[a-z_]+)?$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2] || '';
    const store = load();
    const session = store.sessions[id];
    if (action === '/fork' && mode === 'no-fork') {
      res.writeHead(404);
      return res.end('Not Found');
    }
    if (!session) return json(res, { name: 'NotFoundError', data: { message: `Session not found: ${id}` } }, 404);
    if (action === '' && req.method === 'GET') return json(res, { id, title: session.title });
    if (action === '' && req.method === 'DELETE') {
      delete store.sessions[id];
      save(store);
      return json(res, true);
    }
    if (action === '/prompt_async' && req.method === 'POST') {
      const payload = await body(req);
      res.writeHead(204);
      res.end();
      prompt(id, payload);
      return;
    }
    if (action === '/abort' && req.method === 'POST') {
      const finish = busy.get(id);
      if (finish) finish();
      return json(res, true);
    }
    if (action === '/fork' && req.method === 'POST') {
      await body(req);
      const fork = sessionId(store);
      store.sessions[fork] = { ...structuredClone(session), id: fork, parentID: id };
      save(store);
      return json(res, { id: fork, parentID: id });
    }
  }
  res.writeHead(404);
  res.end('Not Found');
});
server.listen(port, '127.0.0.1');
