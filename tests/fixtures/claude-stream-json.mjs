/**
 * A scripted Claude Code stream-json child: the same script the H03 route tests
 * write inline (tests/h03-thread-session-routes.test.ts), kept here so the H20
 * headless runner reuses it rather than inventing another. It speaks the
 * stream-json control protocol on stdio and records each turn it answers.
 *
 * argv: <session id> <known-sessions file> <turn log> <new|resume>
 * Per message: `[hang]` waits for an interrupt, `[stuck]` never ends, `[slow]`
 * answers after 400 ms; anything else is answered as "Answer to <words>".
 */
import readline from 'node:readline';
import fs from 'node:fs';
const [,, session, known, log, resumed] = process.argv;
const emit = (x) => console.log(JSON.stringify(x));
const sessions = fs.existsSync(known) ? fs.readFileSync(known, 'utf8').split('\n') : [];
if (resumed === 'resume' && !sessions.includes(session)) { console.error('No conversation found'); process.exit(1); }
if (!sessions.includes(session)) fs.appendFileSync(known, session + '\n');
let count = 0, open = null;
const result = (text) => emit({ type: 'result', uuid: session + '-' + process.pid + '-' + count, subtype: 'success', result: text, session_id: session, modelUsage: { 'claude-sonnet-4-6': {} } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (m.request.subtype === 'interrupt' && open === 'hang') { open = null; setTimeout(() => emit({ type: 'result', uuid: session + '-' + process.pid + '-stop-' + count, subtype: 'error_during_execution', is_error: true, session_id: session, errors: ['Request was aborted'] }), 20); }
    return;
  }
  if (m.type !== 'user') return;
  count++;
  const words = JSON.parse(m.message.content).request.split('\n\n[[diomedes')[0];
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, turn: words, resumed }) + '\n');
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  if (words.includes('[hang]')) { open = 'hang'; return; }
  if (words.includes('[stuck]')) { open = 'stuck'; return; }
  if (words.includes('[slow]')) return setTimeout(() => result('Answer to ' + words), 400);
  result('Answer to ' + words);
});
