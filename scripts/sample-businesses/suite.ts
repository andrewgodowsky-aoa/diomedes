import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAuto } from './checks/auto.js';
import { checkBakery } from './checks/bakery.js';
import { checkRemodel } from './checks/remodel.js';
import { checkWine } from './checks/wine.js';
import { checkWood } from './checks/wood.js';
import { Workspace, type CheckResult, type Finding } from './workspace.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SUITE_ROOT = path.join(REPO_ROOT, 'resources', 'sample-businesses');

export type Business = { slug: string; name: string; check: (ws: Workspace) => CheckResult };

/** The five businesses. `name` is the project folder a reset writes. */
export const BUSINESSES: Business[] = [
  { slug: 'juniper-street-bakery', name: 'Juniper Street Bakery', check: checkBakery },
  { slug: 'larch-and-lantern-wine', name: 'Larch & Lantern Wine Shop', check: checkWine },
  { slug: 'brandt-and-rowe-remodeling', name: 'Brandt & Rowe Remodeling', check: checkRemodel },
  { slug: 'kestrel-row-auto', name: 'Kestrel Row Auto Repair', check: checkAuto },
  { slug: 'quarry-hill-cabinetworks', name: 'Quarry Hill Cabinetworks', check: checkWood },
];

export function business(slug: string): Business {
  const b = BUSINESSES.find((x) => x.slug === slug);
  if (!b)
    throw new Error(
      `Unknown sample business "${slug}". Choose one of: ${BUSINESSES.map((x) => x.slug).join(', ')}, or all.`,
    );
  return b;
}

/** File types the app reads as text. The suite ships nothing else. */
const ALLOWED = new Set(['.md', '.csv', '.txt']);
/** AI vendors, products and model names. Sample businesses name none of them. */
const VENDORS =
  /\b(claude|anthropic|openai|chatgpt|gpt|gemini|codex|sonnet|opus|haiku|copilot|llama|mistral|deepseek|grok|bedrock|fable)\b/i;

/** Rules every workspace follows, whatever the business. */
export function lintWorkspace(ws: Workspace): string[] {
  const errors: string[] = [];
  if (!ws.exists('README.md') || !ws.text('README.md').includes('FICTIONAL SAMPLE DATA'))
    errors.push('README.md must exist and say FICTIONAL SAMPLE DATA');
  for (const file of ws.list()) {
    if (!ALLOWED.has(path.extname(file))) {
      errors.push(`${file}: only .md, .csv and .txt files belong in a sample workspace`);
      continue;
    }
    const text = ws.text(file);
    if (text.includes('\r')) errors.push(`${file}: CRLF line endings`);
    const vendor = VENDORS.exec(text);
    if (vendor)
      errors.push(`${file}: names "${vendor[0]}"; sample data names no AI vendor or model`);
    for (const phone of text.match(/\b\d{3}-\d{4}\b/g) ?? [])
      if (!/^555-01\d\d$/.test(phone))
        errors.push(`${file}: phone ${phone} is outside 555-0100 to 555-0199`);
    for (const email of (text.match(/[\w.+-]+@[\w.-]+/g) ?? []).map((e) => e.replace(/\.+$/, '')))
      if (!/@([a-z0-9-]+\.)*example\.com$/i.test(email))
        errors.push(`${file}: email ${email} is not on example.com`);
    if (file.endsWith('.md') && !text.includes('FICTIONAL SAMPLE DATA'))
      errors.push(`${file}: Markdown files open with the FICTIONAL SAMPLE DATA notice`);
  }
  return errors;
}

/** The machine-readable table in a business's planted.md. */
export function parsePlanted(markdown: string): Finding[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^\|\s*id\s*\|\s*problem\s*\|\s*file\s*\|\s*where\s*\|\s*amount\s*\|\s*$/.test(l),
  );
  if (start < 0)
    throw new Error('planted.md has no "| id | problem | file | where | amount |" table');
  const out: Finding[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim().replace(/^`|`$/g, ''));
    if (cells.length !== 5) throw new Error(`planted.md: a row needs five cells: ${line}`);
    const [id, problem, file, where, amount] = cells;
    out.push({ id, problem, file, where, amount });
  }
  return out;
}

export type Report = { slug: string; findings: Finding[]; planted: Finding[]; errors: string[] };

/** Recompute every planted problem from the raw files and compare with planted.md. */
export function checkBusiness(slug: string, suiteRoot = SUITE_ROOT): Report {
  const b = business(slug);
  const dir = path.join(suiteRoot, slug);
  const errors: string[] = [];
  for (const doc of ['README.md', 'planted.md', 'scenarios.md'])
    if (!fs.existsSync(path.join(dir, doc))) errors.push(`${doc} is missing`);
  const readme = path.join(dir, 'README.md');
  if (fs.existsSync(readme) && !/fictional/i.test(fs.readFileSync(readme, 'utf8')))
    errors.push('README.md must say the business is fictional');
  const ws = new Workspace(path.join(dir, 'workspace'));
  errors.push(...lintWorkspace(ws));
  let findings: Finding[] = [];
  try {
    const result = b.check(ws);
    findings = result.findings;
    errors.push(...result.errors);
  } catch (error) {
    errors.push(`check failed: ${(error as Error).message}`);
  }
  let planted: Finding[] = [];
  try {
    planted = parsePlanted(fs.readFileSync(path.join(dir, 'planted.md'), 'utf8'));
  } catch (error) {
    errors.push((error as Error).message);
  }
  const ids = new Set(findings.map((f) => f.id));
  if (ids.size !== findings.length) errors.push('two computed findings share an id');
  for (const f of findings) {
    const p = planted.find((x) => x.id === f.id);
    if (!p)
      errors.push(
        `not planted, but the files show it: ${f.id} (${f.file}, ${f.where}, ${f.amount})`,
      );
    else
      for (const k of ['file', 'where', 'amount'] as const)
        if (p[k] !== f[k])
          errors.push(`${f.id}: planted.md says ${k} "${p[k]}", the files give "${f[k]}"`);
  }
  for (const p of planted)
    if (!ids.has(p.id)) errors.push(`planted but no longer in the files: ${p.id}`);
  for (const p of planted) if (!ws.exists(p.file)) errors.push(`${p.id}: ${p.file} does not exist`);
  return { slug, findings, planted, errors };
}

/** The computed findings as a planted.md table, for writing or reviewing planted.md. */
export function plantedTable(findings: Finding[]): string {
  return [
    '| id | problem | file | where | amount |',
    '|---|---|---|---|---|',
    ...findings.map(
      (f) => `| ${f.id} | ${f.problem ?? ''} | \`${f.file}\` | ${f.where} | ${f.amount} |`,
    ),
  ].join('\n');
}
