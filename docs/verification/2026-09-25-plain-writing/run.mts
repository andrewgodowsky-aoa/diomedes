// Plain-writing before/after: each sample-business request, answered once without and once with
// the writing standard, through the Claude Code CLI (Andrew's existing subscription), read-only.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerInstructions } from '../../../server/answer-format.ts';
import { WRITING_STANDARD } from '../../../shared/plain-writing.ts';

// Where the extracted sample businesses and outputs live (git archive origin/main resources/sample-businesses).
const E = process.env.PLAIN_WRITING_EVAL_DIR ?? 'plain-writing-eval';
const BIZ = ['brandt-and-rowe-remodeling', 'juniper-street-bakery', 'kestrel-row-auto', 'larch-and-lantern-wine', 'quarry-hill-cabinetworks'];
type Scenario = { id: string; biz: string; title: string; feature: string; request: string; mode: 'ask' | 'plan' | 'auto' };

export function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const biz of BIZ) {
    const md = readFileSync(join(E, 'resources/sample-businesses', biz, 'scenarios.md'), 'utf8').replace(/\r/g, '');
    for (const block of md.split(/^## /m).slice(1)) {
      const head = /^(\d+)\.\s+(.*)$/m.exec(block);
      if (!head) continue;
      const feature = /\*\*Feature:\*\*\s*(.*)/.exec(block)?.[1] ?? '';
      const quote = [];
      let started = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('>')) { started = true; quote.push(line.replace(/^>\s?/, '')); }
        else if (started) break;
      }
      const mode = /Plan mode/i.test(feature) ? 'plan' : /Build mode/i.test(feature) ? 'auto' : 'ask';
      out.push({ id: `${biz}-${head[1]}`, biz, title: head[2], feature, request: quote.join(' ').trim(), mode });
    }
  }
  return out;
}

function claude(cwd: string, prompt: string, system: string, model: string, tools: boolean): Promise<any> {
  const sysFile = join(E, `sys-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(sysFile, system);
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--setting-sources', '', '--append-system-prompt-file', sysFile, '--max-turns', tools ? '25' : '1'];
  if (tools) args.push('--allowedTools', 'Read', 'Grep', 'Glob', '--disallowedTools', 'Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task');
  else args.push('--disallowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task');
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      try { resolve(JSON.parse(out)); } catch { resolve({ is_error: true, result: '', code, err: err.slice(0, 500), out: out.slice(0, 500) }); }
    });
  });
}
export { claude };

async function main() {
  const list = scenarios();
  console.log(`${list.length} scenarios`);
  const dir = join(E, 'out');
  mkdirSync(dir, { recursive: true });
  const jobs: (() => Promise<void>)[] = [];
  for (const s of list)
    for (const arm of ['before', 'after'] as const) {
      const file = join(dir, `${s.id}.${arm}.json`);
      if (existsSync(file) && !JSON.parse(readFileSync(file, 'utf8')).is_error) continue;
      const base = `You are Nectovia, answering the owner of this business. The business's files are in the current folder: read them to answer. Do not change any file; describe any change you would make.\n\n${answerInstructions(s.mode)}`;
      const system = arm === 'after' ? `${WRITING_STANDARD}\n\n${base}` : base;
      jobs.push(async () => {
        const started = Date.now();
        const r = await claude(join(E, 'resources/sample-businesses', s.biz, 'workspace'), s.request, system, 'sonnet', true);
        writeFileSync(file, JSON.stringify({ ...s, arm, ms: Date.now() - started, ...r }, null, 2));
        console.log(`${s.id} ${arm} ${r.is_error ? 'ERROR' : 'ok'} ${Math.round((Date.now() - started) / 1000)}s`);
      });
    }
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < jobs.length) await jobs[i++]!(); }));
}
if (process.argv[2] === 'run') await main();
