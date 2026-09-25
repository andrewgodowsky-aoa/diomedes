/**
 * H20: `npm run eval:matrix` — evaluate the production Core headlessly and
 * write the all-route acceptance matrix.
 *
 *   npm run eval:matrix                    writes docs/verification/<date>-route-matrix.{md,json}
 *   npm run eval:matrix -- --out <dir>     writes there instead
 *   npm run eval:matrix -- --only a,b      runs only those scenarios
 *   npm run eval:matrix -- --keep          keeps each scenario's Core folder
 *
 * It exits 1 when any cell reads mismatch or any scenario failed, so a
 * mismatch is never a quiet line in a file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderMatrixMarkdown } from '../server/evaluation/route-matrix.js';
import { matrixFrom, runScenarios } from './eval-matrix/runner.js';
import { REPO } from './eval-matrix/scenarios.js';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = path.resolve(REPO, value('--out') ?? path.join('docs', 'verification'));
const only = value('--only')?.split(',').filter(Boolean);

const results = await runScenarios({ only, keep: args.includes('--keep'), log: (line) => console.log(line) });
const matrix = matrixFrom(results);
const date = matrix.generatedAt.slice(0, 10);
await fs.mkdir(out, { recursive: true });
const base = path.join(out, `${date}-route-matrix`);
await fs.writeFile(`${base}.json`, `${JSON.stringify(matrix, null, 2)}\n`);
await fs.writeFile(`${base}.md`, renderMatrixMarkdown(matrix));
console.log(`\nWrote ${path.relative(REPO, base)}.md and .json`);
console.log(
  Object.entries(matrix.counts)
    .map(([state, count]) => `${state}: ${count}`)
    .join(' · '),
);
for (const item of matrix.mismatches) console.log(`MISMATCH ${item.routeId} · ${item.capability}: ${item.reason}`);
for (const item of matrix.failedScenarios) console.log(`FAILED ${item.id}`);
process.exitCode = matrix.mismatches.length || matrix.failedScenarios.length ? 1 : 0;
