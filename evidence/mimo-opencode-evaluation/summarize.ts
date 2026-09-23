// Summarises the run files into per-model metrics. Pure: reads runs/*.jsonl.
// Usage: tsx evidence/mimo-opencode-evaluation/summarize.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
type Row = Record<string, any>;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
  const rows: Row[] = fs
    .readFileSync(path.join(dir, file), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const tasks = rows.filter((r) => r.kind === 'task');
  if (!tasks.length) continue;
  const byClass: Record<string, string> = {};
  for (const cls of ['A', 'B', 'C', 'D', 'E']) {
    const t = tasks.filter((r) => r.cls === cls);
    if (t.length) byClass[cls] = `${t.filter((r) => r.accepted).length}/${t.length}`;
  }
  const checks = tasks.flatMap((r) => r.checks.filter((c: Row) => c.pass !== null));
  const refusals = rows.filter((r) => r.kind === 'refused-before-dispatch');
  const probes = Object.fromEntries(rows.filter((r) => r.kind === 'probe').map((r) => [r.probe, r]));
  const tokens = tasks.map((r) => r.opencodeReported?.tokens).filter(Boolean);
  const summary = {
    file,
    routeBuild: tasks[0].routeBuild,
    textSteps: tasks[0].textSteps ?? null,
    accepted: `${tasks.filter((r) => r.accepted).length}/${tasks.length}`,
    byClass,
    checksPassed: `${checks.filter((c: Row) => c.pass).length}/${checks.length}`,
    failedChecks: tasks.flatMap((r) => r.checks.filter((c: Row) => c.pass === false).map((c: Row) => `${r.id}:${c.name}`)),
    errors: tasks.filter((r) => r.error).map((r) => `${r.id}:${r.error.code}`),
    attribution:
      tasks[0].attributionMatches === undefined
        ? 'n/a (not the Diomedes route)'
        : `${tasks.filter((r) => r.attributionMatches).length}/${tasks.filter((r) => !r.error).length} exact`,
    opencodeReportedModel: [...new Set(tasks.map((r) => r.opencodeReported?.model).filter(Boolean))],
    refusedBeforeDispatch: refusals.reduce((m: Row, r) => ({ ...m, [`${r.code}@${r.stage}`]: (m[`${r.code}@${r.stage}`] ?? 0) + 1 }), {}),
    medianFirstDeltaMs: median(tasks.map((r) => r.firstDeltaMs)),
    medianTotalMs: median(tasks.map((r) => r.totalMs)),
    medianWords: median(tasks.map((r) => r.words)),
    toolCallsOnReadTasks: tasks.filter((r) => r.toolCalls !== undefined && ['B', 'C', 'D'].includes(r.cls)).map((r) => `${r.id}:${r.toolCalls}`).join(' '),
    medianOutputTokens: median(tokens.map((t: Row) => t.output)),
    medianReasoningTokens: median(tokens.map((t: Row) => t.reasoning)),
    stream: probes.stream
      ? { correct: probes.stream.correct, deltas: probes.stream.deltas, firstDeltaMs: probes.stream.firstDeltaMs, totalMs: probes.stream.totalMs, error: probes.stream.error?.code ?? null }
      : null,
    stop: probes.stop
      ? { stopped: probes.stop.stoppedWithoutCompletion, code: probes.stop.error?.code ?? 'COMPLETED', settledAfterStopMs: probes.stop.settledAfterStopMs }
      : null,
  };
  console.log(JSON.stringify(summary));
}
