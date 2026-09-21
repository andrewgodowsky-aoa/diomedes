// Local provider process only. Reads synthetic host evidence at the instant of dispatch.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const [root, mode] = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const model = 'claude-test';
const answer = 'Synthetic cafe inventory: caf\u00e9 \ud83d\ude80';
function observe() {
  const projectsDir = path.join(root, 'data', 'projects');
  const projects = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [];
  const runs = [];
  const states = [];
  for (const id of projects) {
    const dir = path.join(projectsDir, id);
    const state = path.join(dir, 'state.json');
    if (fs.existsSync(state)) states.push(JSON.parse(fs.readFileSync(state, 'utf8')));
    const runDir = path.join(dir, 'harness', 'runs');
    if (fs.existsSync(runDir)) {
      for (const name of fs.readdirSync(runDir).filter(n => n.endsWith('.json'))) {
        runs.push(JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')));
      }
    }
  }
  fs.appendFileSync(path.join(root, 'provider-dispatch.jsonl'), JSON.stringify({ runs, states }) + '\n');
}
function finish() {
  emit({ type: 'result', subtype: 'success', is_error: false, result: answer,
    session_id: 'native-fixture', modelUsage: { [model]: {} } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const models = fs.existsSync(path.join(root, 'withdraw-model')) ? [] : [
      { value: model, displayName: 'Local protocol fixture', description: 'No inference' },
    ];
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: { models } } });
  }
  if (message.type !== 'user') return;
  observe();
  emit({ type: 'system', subtype: 'init', session_id: 'native-fixture', model, tools: [], mcp_servers: [] });
  if (mode === 'oversized') { process.stdout.write('x'.repeat(2_000_100)); return; }
  if (mode === 'truncated') { process.stdout.write('{"type":"result"'); process.exit(0); }
  const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } };
  if (mode === 'unicode') {
    const bytes = Buffer.from(JSON.stringify(delta) + '\n');
    const split = bytes.indexOf(Buffer.from('\ud83d\ude80')) + 2;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => { process.stdout.write(bytes.subarray(split)); finish(); }, 20);
    return;
  }
  if (mode === 'stderr') process.stderr.write('synthetic diagnostic\n'.repeat(100_000));
  emit(delta);
  if (mode === 'no-terminal') { process.exit(0); return; }
  if (mode === 'hold') {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, 'release-provider'))) {
        clearInterval(timer);
        emit({ ...delta, event: { ...delta.event, delta: { type: 'text_delta', text: ' stale-tail' } } });
        finish();
      }
    }, 15);
    return;
  }
  finish();
});
