// A real loopback SSE response: accepts the prompt, emits text, then drops before terminal.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const [root, port] = process.argv.slice(2);
let stream;
const send = event => stream.write('data: ' + JSON.stringify(event) + '\n\n');
const trace = event => fs.appendFileSync(path.join(root, 'sse-trace.jsonl'), JSON.stringify(event) + '\n');
const server = http.createServer(async (req, res) => {
  if (!req.headers.authorization?.startsWith('Basic ')) { res.writeHead(401); res.end(); return; }
  if (req.url === '/provider') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ connected: ['opencode-go'], all: [{ id: 'opencode-go', models: {
      'fixture-model': { id: 'fixture-model', name: 'Local protocol fixture' },
    } }] })); return;
  }
  if (req.url === '/session' && req.method === 'POST') {
    for await (const _chunk of req) { /* consume request */ }
    res.setHeader('content-type', 'application/json'); res.end('{"id":"local-session"}'); return;
  }
  if (req.url === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); stream = res;
    send({ type: 'server.connected', properties: {} }); return;
  }
  if (req.url === '/session/local-session/prompt_async') {
    for await (const _chunk of req) { /* consume request */ }
    trace({ event: 'prompt-accepted', status: 204 });
    res.writeHead(204); res.end();
    setTimeout(() => {
      send({ type: 'message.updated', properties: { info: { id: 'assistant-1', sessionID: 'local-session',
        role: 'assistant', providerID: 'opencode-go', modelID: 'fixture-model', time: { created: 1 } } } });
      // opencode 1.18.4 announces a part, with its type, before streaming its deltas.
      send({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'local-session',
        messageID: 'assistant-1', type: 'text', text: '' } } });
      send({ type: 'message.part.delta', properties: { sessionID: 'local-session', messageID: 'assistant-1',
        partID: 'part-1', field: 'text', delta: 'Partial fixture answer' } });
      trace({ event: 'partial-output' });
      setTimeout(() => { trace({ event: 'connection-drop', terminalSent: false }); stream.destroy(); }, 40);
    }, 20); return;
  }
  if (req.url === '/session/local-session/abort' || req.url === '/session/local-session') {
    trace({ event: req.method === 'DELETE' ? 'delete' : 'abort' }); res.end('true'); return;
  }
  res.writeHead(404); res.end();
});
server.listen(Number(port), '127.0.0.1');
