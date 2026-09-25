import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claude } from './run.mts';
import { checkPlainWriting, WRITING_STANDARD } from '../../../shared/plain-writing.ts';
import { repairWriting, REWRITE_INSTRUCTIONS } from '../../../server/plain-writing.ts';

// Where the extracted sample businesses and outputs live (git archive origin/main resources/sample-businesses).
const E = process.env.PLAIN_WRITING_EVAL_DIR ?? 'plain-writing-eval';
const dir = join(E, 'out');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const ids = [...new Set(files.map((f) => f.replace(/\.(before|after)\.json$/, '')))].sort();

type Row = Record<string, unknown>;
const rows: Row[] = [];
const repairFile = join(E, 'repairs.json');
const repairs: Record<string, any> = existsSync(repairFile) ? JSON.parse(readFileSync(repairFile, 'utf8')) : {};
const tally = (hits: { rule: string }[]) => hits.reduce<Record<string, number>>((a, h) => ((a[h.rule] = (a[h.rule] ?? 0) + 1), a), {});

for (const id of ids) {
  const b = existsSync(join(dir, `${id}.before.json`)) ? load(`${id}.before.json`) : null;
  const a = existsSync(join(dir, `${id}.after.json`)) ? load(`${id}.after.json`) : null;
  if (!b || !a || b.is_error || a.is_error || !b.result || !a.result) { rows.push({ id, skipped: true }); continue; }
  const hb = checkPlainWriting(b.result);
  const ha = checkPlainWriting(a.result);
  // Repair the after answer once, as the model-API route does: code fixes, then one rewrite call.
  if (!repairs[id]) {
    let call: any = null;
    const out = await repairWriting({
      text: a.result,
      rewrite: async (prompt) => {
        call = await claude(E, prompt, REWRITE_INSTRUCTIONS, 'sonnet', false);
        call.promptBytes = Buffer.byteLength(REWRITE_INSTRUCTIONS + prompt, 'utf8');
        call.replyBytes = Buffer.byteLength(call.result ?? '', 'utf8');
        return call.result ?? '';
      },
    });
    repairs[id] = { text: out.text, record: out.record, call: call && { cost: call.total_cost_usd, usage: call.usage, error: call.is_error, promptBytes: call.promptBytes, replyBytes: call.replyBytes } };
    writeFileSync(repairFile, JSON.stringify(repairs, null, 2));
  }
  // The same pass over the before answer, code fixes only: what the checker alone buys.
  const codeOnlyBefore = await repairWriting({ text: b.result });
  const r = repairs[id];
  const hr = checkPlainWriting(r.text);
  rows.push({
    id, mode: a.mode,
    before: { hits: hb.length, rules: tally(hb), chars: b.result.length, in: b.usage?.input_tokens + b.usage?.cache_creation_input_tokens + b.usage?.cache_read_input_tokens, cost: b.total_cost_usd },
    after: { hits: ha.length, rules: tally(ha), chars: a.result.length, in: a.usage?.input_tokens + a.usage?.cache_creation_input_tokens + a.usage?.cache_read_input_tokens, cost: a.total_cost_usd },
    beforeCodeOnly: { hits: checkPlainWriting(codeOnlyBefore.text).length },
    repaired: { hits: hr.length, rules: tally(hr), fixed: r.record.fixed.length, rewrite: r.record.rewrite && { asked: r.record.rewrite.asked, accepted: r.record.rewrite.accepted, kept: r.record.rewrite.kept.map((k: any) => k.reason) }, call: r.call },
  });
}

const ok = rows.filter((r) => !r.skipped) as any[];
const n = ok.length;
const sum = (f: (r: any) => number) => ok.reduce((s, r) => s + (f(r) || 0), 0);
const any = (f: (r: any) => number) => ok.filter((r) => f(r) > 0).length;
const calls = ok.filter((r) => r.repaired.call);
const agg = (k: 'before' | 'after' | 'repaired') => ok.reduce<Record<string, number>>((acc, r) => { for (const [rule, c] of Object.entries(r[k].rules)) acc[rule] = (acc[rule] ?? 0) + (c as number); return acc; }, {});
const summary = {
  outputs: n,
  skipped: rows.filter((r) => r.skipped).map((r) => r.id),
  standardBytes: Buffer.byteLength(WRITING_STANDARD, 'utf8'),
  standardTokensApprox: Math.round(Buffer.byteLength(WRITING_STANDARD, 'utf8') / 4),
  before: { outputsWithHits: any((r) => r.before.hits), hits: sum((r) => r.before.hits), byRule: agg('before') },
  beforeCodeFixOnly: { outputsWithHits: any((r) => r.beforeCodeOnly.hits), hits: sum((r) => r.beforeCodeOnly.hits) },
  after: { outputsWithHits: any((r) => r.after.hits), hits: sum((r) => r.after.hits), byRule: agg('after') },
  repaired: { outputsWithHits: any((r) => r.repaired.hits), hits: sum((r) => r.repaired.hits), byRule: agg('repaired'), codeFixes: sum((r) => r.repaired.fixed) },
  rewrite: {
    calls: calls.length,
    sentencesAsked: sum((r) => r.repaired.rewrite?.asked ?? 0),
    accepted: sum((r) => r.repaired.rewrite?.accepted ?? 0),
    keptReasons: ok.flatMap((r) => r.repaired.rewrite?.kept ?? []).reduce((a: any, k: string) => ((a[k] = (a[k] ?? 0) + 1), a), {}),
    inputTokens: calls.reduce((s, r) => s + (r.repaired.call.usage?.input_tokens ?? 0) + (r.repaired.call.usage?.cache_creation_input_tokens ?? 0) + (r.repaired.call.usage?.cache_read_input_tokens ?? 0), 0),
    outputTokens: calls.reduce((s, r) => s + (r.repaired.call.usage?.output_tokens ?? 0), 0),
    productPromptBytes: calls.reduce((s, r) => s + (r.repaired.call.promptBytes ?? 0), 0),
    productReplyBytes: calls.reduce((s, r) => s + (r.repaired.call.replyBytes ?? 0), 0),
    costUsd: calls.reduce((s, r) => s + (r.repaired.call.cost ?? 0), 0),
  },
  answerCostUsd: { before: sum((r) => r.before.cost), after: sum((r) => r.after.cost) },
  answerChars: { before: sum((r) => r.before.chars), after: sum((r) => r.after.chars) },
};
writeFileSync(join(E, 'summary.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(ok.map((r) => `${r.id.padEnd(32)} ${String(r.before.hits).padStart(3)} ${String(r.after.hits).padStart(3)} ${String(r.repaired.hits).padStart(3)}`).join('\n'));
