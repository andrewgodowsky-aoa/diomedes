// Live runner for the frozen MiMo 2.6 evaluation through the real Diomedes
// OpenCode route: the production OpenCodeAdapter, its isolated server, only
// `opencode-go` enabled, its exact-slug and reported-model checks, its
// read-only scope. Nothing here changes the adapter.
//
// Test-harness behaviour, NOT adapter behaviour: when a call is refused before
// dispatch (MODEL_UNAVAILABLE at model-list, the catalogue race recorded in the
// implementation record) or its local server fails to start (TIMEOUT or
// LAUNCH_FAILED at launch), the harness logs the refusal and tries again, up to
// MAX_ATTEMPTS. Both happen before anything reaches the account. Any other
// error is final and is scored as a failure.
//
// Usage: tsx evidence/mimo-opencode-evaluation/run-eval.ts <out.jsonl> <opencode-go/model> [taskId,...]
// Synthetic material only. Prints and records answer text, timings and the
// route's own sanitised error messages; never environment, headers or auth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE, OPENCODE_VERSION } from '../../server/engines/opencode.js';
import type { TextRequest } from '../../server/engines/contract.js';
import type { RawToolActivity } from '../../shared/adapter-contract.js';
import { EVAL_SET_VERSION, INSTRUCTIONS, PROBES, TASKS, type Outcome } from './eval-set.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, 'synthetic-project');
const EXE =
  process.env.MIMO_EVAL_OPENCODE ??
  'C:/Users/andre/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.14.1-win-x64/node_modules/opencode-ai/bin/opencode.exe';
const MAX_ATTEMPTS = 8;

const [out, model, only] = process.argv.slice(2);
if (!out || !model?.startsWith('opencode-go/')) throw new Error('usage: run-eval.ts <out.jsonl> <opencode-go/model> [ids]');
const wanted = only ? new Set(only.split(',')) : null;
const adapter = new OpenCodeAdapter(EXE, path.resolve(here, '..', '..'));
const write = (row: object) => fs.appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), evalSet: EVAL_SET_VERSION, ...row })}\n`);

interface Call {
  text: string;
  error?: { code: string; stage?: string; message: string };
  attributed?: string;
  attempts: { code: string; stage?: string }[];
  firstDeltaMs?: number;
  totalMs: number;
  deltas: number;
  activity: RawToolActivity[];
}

async function call(
  id: string,
  prompt: string,
  scoped: boolean,
  stopAfterFirstDeltaMs?: number,
): Promise<Call> {
  const attempts: Call['attempts'] = [];
  for (let n = 1; ; n++) {
    const control = new AbortController();
    const activity: RawToolActivity[] = [];
    let deltas = 0;
    let firstDeltaMs: number | undefined;
    const request: TextRequest = {
      projectId: 'mimo-eval',
      threadId: `mimo-eval-${id}`,
      requestId: `${id}-${n}`,
      model,
      accountRoute: OPENCODE_ACCOUNT_ROUTE,
      instructions: INSTRUCTIONS,
      prompt,
      documents: [],
      signal: control.signal,
      ...(scoped ? { readScope: { root: project, web: false } } : {}),
      onDelta: () => {
        deltas += 1;
        if (firstDeltaMs === undefined) {
          firstDeltaMs = Date.now() - started;
          if (stopAfterFirstDeltaMs !== undefined)
            setTimeout(() => control.abort('stop'), stopAfterFirstDeltaMs);
        }
      },
      onToolActivity: (raw) => activity.push(raw),
    };
    // Recorded before dispatch: the exact route, account and model this call asks for.
    write({ kind: 'dispatch', id, attempt: n, engine: 'opencode', accountRoute: request.accountRoute, model, scope: scoped ? 'read' : 'text', opencodeVersion: OPENCODE_VERSION });
    const started = Date.now();
    try {
      const result = await adapter.generate(request);
      return { text: result.text, attributed: result.model, attempts, firstDeltaMs, totalMs: Date.now() - started, deltas, activity };
    } catch (raw) {
      const error = raw as { code?: string; stage?: string; message?: string };
      const e = { code: String(error.code ?? 'UNKNOWN'), stage: error.stage, message: String(error.message ?? raw).slice(0, 300) };
      const retryable =
        (e.code === 'MODEL_UNAVAILABLE' && e.stage === 'model-list') ||
        ((e.code === 'TIMEOUT' || e.code === 'LAUNCH_FAILED') && e.stage === 'launch');
      if (retryable && firstDeltaMs === undefined && n < MAX_ATTEMPTS) {
        attempts.push({ code: e.code, stage: e.stage });
        write({ kind: 'refused-before-dispatch', id, attempt: n, ...e, ms: Date.now() - started });
        continue;
      }
      return { text: '', error: e, attempts, firstDeltaMs, totalMs: Date.now() - started, deltas, activity };
    }
  }
}

const inspection = await adapter.inspect();
write({
  kind: 'catalogue',
  model,
  authentication: inspection.authentication,
  accountRoute: inspection.accountRoute,
  listed: inspection.models.some((m) => m.slug === model),
  entry: inspection.models.find((m) => m.slug === model) ?? null,
  count: inspection.models.length,
});

if (!wanted || wanted.has('stream')) {
  const r = await call('probe-stream', PROBES.stream, false);
  const lines = r.text.trim().split(/\r?\n/);
  write({ kind: 'probe', probe: 'stream', model, ...r, activity: undefined, correct: lines.length === 40 && lines.every((l, i) => l.trim() === String(i + 1)) });
  console.log('stream', r.error?.code ?? 'ok', r.deltas, r.firstDeltaMs, r.totalMs);
}
if (!wanted || wanted.has('stop')) {
  const r = await call('probe-stop', PROBES.stop, false, PROBES.stopAfterFirstDeltaMs);
  const stopAt = r.firstDeltaMs === undefined ? undefined : r.firstDeltaMs + PROBES.stopAfterFirstDeltaMs;
  write({ kind: 'probe', probe: 'stop', model, ...r, text: r.text.slice(0, 200), activity: undefined, settledAfterStopMs: stopAt === undefined ? null : r.totalMs - stopAt, stoppedWithoutCompletion: !!r.error && !r.attributed });
  console.log('stop', r.error?.code ?? 'COMPLETED', r.firstDeltaMs, r.totalMs);
}
for (const task of TASKS) {
  if (wanted && !wanted.has(task.id)) continue;
  const r = await call(task.id, task.prompt, task.scope === 'read');
  const reads = r.activity
    .filter((a) => a.phase === 'started')
    .map((a) => a.summary.replace(/^(Reading|Listing files in|Searching project files for)\s+/, ''));
  const outcome: Outcome = { text: r.text, reads, toolCalls: r.activity.filter((a) => a.phase === 'started').length, error: r.error };
  const checks = task.checks.map((c) => {
    let pass = false;
    try {
      pass = c.pass(outcome);
    } catch {
      pass = false;
    }
    return { name: c.name, pass };
  });
  write({
    kind: 'task',
    id: task.id,
    cls: task.cls,
    model,
    attributed: r.attributed ?? null,
    attributionMatches: r.attributed === model,
    accepted: checks.every((c) => c.pass),
    checks,
    text: r.text,
    error: r.error ?? null,
    refusalsBeforeDispatch: r.attempts,
    firstDeltaMs: r.firstDeltaMs ?? null,
    totalMs: r.totalMs,
    deltas: r.deltas,
    words: r.text.trim() ? r.text.trim().split(/\s+/).length : 0,
    toolCalls: outcome.toolCalls,
    activity: r.activity.map((a) => ({ phase: a.phase, tool: a.tool, summary: a.summary })),
  });
  console.log(task.id, r.error?.code ?? 'ok', checks.filter((c) => c.pass).length + '/' + checks.length, r.totalMs + 'ms');
}
