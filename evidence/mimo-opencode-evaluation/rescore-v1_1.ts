// v1.1 re-score, written AFTER the first runs, applied identically to every
// model's saved answers. It corrects one scorer defect only: v1's figure
// tokeniser kept trailing punctuation, so a correct "$61,200," was read as the
// invented figure "61,200,". Nothing else changes: the same source figures,
// the same threshold, and derived arithmetic (e.g. "11.2 points over") still
// counts as a figure not in the source. v1 results remain the primary record.
// Usage: tsx evidence/mimo-opencode-evaluation/rescore-v1_1.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
const SOURCE = new Set(['61,200', '48,500', '39,900', '29.4', '41.2', '30.8', '30', '812', '640', '598', '1,870', '210', '185', '37', '36', '44', '41', '642', '250']);
const figures = (t: string) =>
  (t.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? []).map((f) => f.replace(/[$%]/g, '').replace(/[,.]+$/, ''));
const invented = (t: string) => figures(t).filter((f) => /\d/.test(f) && f.length >= 3 && !SOURCE.has(f));
const dollars = (t: string) => (t.match(/\$\d[\d,]*/g) ?? []).map((f) => f.replace(/[,.]+$/, ''));

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
  const rows = fs.readFileSync(path.join(dir, file), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const tasks = rows.filter((r) => r.kind === 'task');
  if (!tasks.length) continue;
  let accepted = 0;
  const changed: string[] = [];
  for (const r of tasks) {
    const checks = r.checks.map((c: { name: string; pass: boolean | null }) => {
      if (c.pass === null || r.error) return c;
      let pass = c.pass;
      if (c.name === 'no invented figures') pass = invented(r.text).length === 0;
      if (c.name === 'no invented dollar figure') pass = !dollars(r.text).some((f) => f !== '$39,900');
      if (pass !== c.pass) changed.push(`${r.id}:${c.name}:${c.pass}->${pass}`);
      return { ...c, pass };
    });
    if (checks.every((c: { pass: boolean | null }) => c.pass !== false)) accepted += 1;
  }
  console.log(JSON.stringify({ file, v1_1Accepted: `${accepted}/${tasks.length}`, changed }));
}
