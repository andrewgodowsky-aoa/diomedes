// Codex-direct baseline for the frozen set: GPT-5.6 Sol through the Codex CLI
// on Andrew's ChatGPT subscription (read-only sandbox, synthetic project as the
// workspace). A DIFFERENT route and tool contract from the Diomedes OpenCode
// route: Codex reads with its own shell tools, and its tool calls are not
// visible here, so read-evidence checks are recorded as not applicable rather
// than failed. Answer text is scored with the same fixed checks.
//
// Usage: tsx evidence/mimo-opencode-evaluation/run-codex-baseline.ts <out.jsonl> <codex-model> [effort] [ids]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EVAL_SET_VERSION, INSTRUCTIONS, TASKS, type Outcome } from './eval-set.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, 'synthetic-project');
const helper = path.join(os.homedir(), '.claude', 'scripts', 'ask-codex.ps1');
const [out, model, effort, only] = process.argv.slice(2);
if (!out || !model) throw new Error('usage: run-codex-baseline.ts <out.jsonl> <model> [effort] [ids]');
const wanted = only ? new Set(only.split(',')) : null;
const READ_EVIDENCE = new Set(['read the report', 'read both files', '<=4 tool calls']);

for (const task of TASKS) {
  if (wanted && !wanted.has(task.id)) continue;
  const scopeNote =
    task.scope === 'text'
      ? 'Answer from this message alone. Do not read or list any files and do not run commands.'
      : 'You may read files in the current folder only. Do not modify anything.';
  const prompt = `${INSTRUCTIONS}\n${scopeNote}\n\n${task.prompt}`;
  const promptFile = path.join(os.tmpdir(), `mimo-eval-codex-${process.pid}-${task.id}.txt`);
  fs.writeFileSync(promptFile, prompt);
  const started = Date.now();
  const args = [
    '-NoProfile',
    '-Command',
    `& '${helper}' -Model ${model} -Mode ask -Workspace '${project}'${effort ? ` -Effort ${effort}` : ''} -Prompt (Get-Content -Raw '${promptFile}')`,
  ];
  const run = spawnSync('pwsh', args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  fs.rmSync(promptFile, { force: true });
  const totalMs = Date.now() - started;
  // The helper ends with the final message after this marker; the transcript before it is not the answer.
  const marker = '[ask-codex] --- final message ---';
  const stdout = run.stdout ?? '';
  const text = stdout.includes(marker) ? stdout.slice(stdout.lastIndexOf(marker) + marker.length).trim() : '';
  const tokensUsed = stdout.match(/tokens used\s*([\d,]+)/)?.[1]?.replace(/,/g, '') ?? null;
  const error = run.status === 0 ? undefined : { code: `EXIT_${run.status}`, message: (run.stderr ?? '').slice(-300) };
  const outcome: Outcome = { text, reads: [], toolCalls: 0, error };
  const checks = task.checks.map((c) => {
    if (task.scope === 'read' && READ_EVIDENCE.has(c.name)) return { name: c.name, pass: null as boolean | null };
    let pass = false;
    try {
      pass = c.pass(outcome);
    } catch {
      pass = false;
    }
    return { name: c.name, pass };
  });
  fs.appendFileSync(
    out,
    `${JSON.stringify({
      at: new Date().toISOString(),
      evalSet: EVAL_SET_VERSION,
      routeBuild: `codex-direct (${model}${effort ? `, effort ${effort}` : ''}, read-only sandbox); not the Diomedes route`,
      kind: 'task',
      id: task.id,
      cls: task.cls,
      model,
      accepted: checks.every((c) => c.pass !== false),
      checks,
      text,
      error: error ?? null,
      totalMs,
      codexReportedTokens: tokensUsed === null ? null : Number(tokensUsed),
      words: text ? text.split(/\s+/).length : 0,
    })}\n`,
  );
  console.log(task.id, error?.code ?? 'ok', `${checks.filter((c) => c.pass).length}/${checks.filter((c) => c.pass !== null).length}`, `${totalMs}ms`);
}
