#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run the gates while holding the coordination heavy slot.
 *
 *   tsx scripts/gates.ts --role fable --pid 1234 --start <ISO> [--with responsive,connections]
 *
 * The charter asks for the heavy slot around every full suite, not just around
 * packaging, because two suites in one tree share ports, `test-results/` and
 * `node_modules/.vite`. Running them concurrently produces failures that belong
 * to the contention rather than to the code: a run of this suite beside a live
 * probe failed twice, in two different places, and passed alone both times.
 * Remembering to take the slot by hand is exactly the step that gets skipped
 * under release pressure, so the runner takes it itself, waits when another
 * identity holds it, and releases it on every exit path including Ctrl-C.
 *
 * Slot operations shell out to scripts/coordination.ts rather than importing
 * its internals, so this runner acquires the slot through the same validated
 * path a person at the CLI uses, and its journal entries are written by the
 * same code.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);

const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

if (has('help')) {
  process.stdout.write(
    `usage: tsx scripts/gates.ts --role ROLE --pid PID --start ISO [options]\n` +
      `  --with a,b        also run: responsive, connections\n` +
      `  --only a,b        run only these gates (typecheck, unit, build, browser, ...)\n` +
      `  --slot ID         use a slot this identity already holds, and leave it held\n` +
      `  --wait-ms MS      how long to wait for the slot (default 7200000, 2h)\n` +
      `  --poll-ms MS      how often to retry while waiting (default 30000)\n` +
      `  --log FILE        write the combined transcript here\n`,
  );
  process.exit(0);
}

/**
 * Order is load-bearing: tests/native-ui.spec.ts refuses to run against a dist
 * older than client/, so the build must precede any browser gate.
 */
const GATES = [
  { name: 'typecheck', argv: ['node_modules/typescript/bin/tsc', '--noEmit'], optional: false },
  { name: 'unit', argv: ['node_modules/vitest/vitest.mjs', 'run'], optional: false },
  { name: 'build', argv: ['node_modules/vite/bin/vite.js', 'build'], optional: false },
  { name: 'browser', argv: ['node_modules/@playwright/test/cli.js', 'test'], optional: false },
  {
    name: 'responsive',
    argv: [
      'node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'playwright.responsive.config.ts',
    ],
    optional: true,
  },
  {
    name: 'connections',
    argv: [
      'node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'playwright.connections.config.ts',
    ],
    optional: true,
  },
] as const;

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const only = csv(flag('only'));
const alsoRun = new Set(csv(flag('with')));
const selected = only.length
  ? GATES.filter((gate) => only.includes(gate.name))
  : GATES.filter((gate) => !gate.optional || alsoRun.has(gate.name));

if (only.length) {
  const unknown = only.filter((name) => !GATES.some((gate) => gate.name === name));
  if (unknown.length) {
    process.stderr.write(`Unknown gate(s): ${unknown.join(', ')}.\n`);
    process.exit(2);
  }
}
if (!selected.length) {
  process.stderr.write('No gates selected.\n');
  process.exit(2);
}

/** The identity flags are passed straight through to the coordination tool. */
const identity: string[] = [];
for (const name of ['role', 'pid', 'start', 'host', 'worktree', 'root']) {
  const value = flag(name);
  if (value !== undefined) identity.push(`--${name}`, value);
}

const logPath = path.resolve(flag('log') ?? path.join(root, 'test-results', 'gates.log'));
const transcript: string[] = [];

const stripAnsi = (text: string) => text.replace(/\[[0-9;]*[A-Za-z]/g, '');

interface RunResult {
  code: number;
  output: string;
}

/** Stream a child's output to this console and keep a copy for the transcript. */
function run(command: string, args: readonly string[], options: { cwd?: string } = {}) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd: options.cwd ?? root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Capture a child's output without echoing it; used for the JSON slot calls. */
function capture(command: string, args: readonly string[]) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const coordination = (command: string, args: readonly string[]) =>
  capture(process.execPath, [
    '--import',
    'tsx',
    path.join(root, 'scripts', 'coordination.ts'),
    command,
    ...identity,
    ...args,
  ]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The last JSON object a coordination command printed, or null. */
function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function acquireSlot(): Promise<{ slotId: string; ours: boolean }> {
  const preheld = flag('slot');
  // A slot this identity already holds is used as-is and left held, so a longer
  // piece of work can run several gate passes inside one slot.
  if (preheld) return { slotId: preheld, ours: false };

  const waitMs = Number(flag('wait-ms') ?? 7_200_000);
  const pollMs = Number(flag('poll-ms') ?? 30_000);
  const purpose = flag('purpose') ?? `Gates: ${selected.map((gate) => gate.name).join(', ')}`;
  const node = flag('node') ?? 'GATES';
  const deadline = Date.now() + waitMs;
  let announced = '';

  for (;;) {
    const result = await coordination('slot', ['--purpose', purpose, '--node', node]);
    const parsed = parseJson(result.output);
    if (result.code === 0 && parsed?.ok === true) {
      const slot = parsed.slot as { slotId?: string } | undefined;
      if (!slot?.slotId) throw new Error(`The slot was granted without an id: ${result.output}`);
      process.stdout.write(`\n[gates] heavy slot ${slot.slotId} acquired.\n`);
      return { slotId: slot.slotId, ours: true };
    }
    const detail =
      typeof parsed?.detail === 'string' ? parsed.detail : stripAnsi(result.output).trim();
    if (Date.now() >= deadline)
      throw new Error(`The heavy slot did not come free within ${waitMs}ms. ${detail}`);
    // Only re-print when the reason changes, so a long wait stays readable.
    if (detail !== announced) {
      process.stdout.write(`\n[gates] waiting for the heavy slot. ${detail}\n`);
      announced = detail;
    }
    await pause(pollMs);
  }
}

/**
 * The tool's own summary line, verbatim. Counts are never recomposed here: a
 * gate report has to carry the real numbers from the run it describes, and the
 * honest answer when a line cannot be found is to say so and point at the log.
 */
function summarize(name: string, output: string): string {
  const clean = stripAnsi(output);
  const lines = clean.split(/\r?\n/).map((line) => line.trim());
  const pick = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).pop();
  if (name === 'unit') {
    const files = pick(/^Test Files\s+/);
    const tests = pick(/^Tests\s+/);
    return [files, tests].filter(Boolean).join(' | ') || 'no vitest summary line found';
  }
  if (name === 'browser' || name === 'responsive' || name === 'connections') {
    const totals = lines.filter((line) =>
      /^\d+\s+(passed|failed|flaky|skipped|did not run)\b/.test(line),
    );
    return totals.length ? totals.join(' | ') : 'no Playwright summary line found';
  }
  if (name === 'build') return pick(/built in /) ?? 'no vite summary line found';
  return 'exit code only';
}

const results: { name: string; code: number; summary: string }[] = [];
let slotId: string | null = null;
let releaseOnExit = false;

async function releaseSlot(reason: string) {
  if (!slotId || !releaseOnExit) return;
  const held = slotId;
  slotId = null;
  const result = await coordination('unslot', ['--slot', held]);
  const ok = result.code === 0;
  process.stdout.write(
    `\n[gates] heavy slot ${held} ${ok ? 'released' : `COULD NOT BE RELEASED: ${result.output}`} (${reason}).\n`,
  );
}

let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    process.stdout.write(`\n[gates] ${signal} received; releasing the slot before exiting.\n`);
    void releaseSlot(signal).finally(() => process.exit(130));
  });

async function main() {
  const acquired = await acquireSlot();
  slotId = acquired.slotId;
  releaseOnExit = acquired.ours;

  const startedAt = new Date().toISOString();
  transcript.push(`gates started ${startedAt} on slot ${slotId}`);
  try {
    for (const gate of selected) {
      process.stdout.write(`\n[gates] === ${gate.name} ===\n`);
      const result = await run(process.execPath, gate.argv);
      const summary = summarize(gate.name, result.output);
      results.push({ name: gate.name, code: result.code, summary });
      transcript.push(
        `\n===== ${gate.name} (exit ${result.code}) =====\n${stripAnsi(result.output)}`,
      );
      if (result.code !== 0) {
        // Stop at the first failure: the later gates build on the earlier ones,
        // and a report that ran them anyway would describe a tree that never
        // typechecked.
        process.stdout.write(`\n[gates] ${gate.name} failed; stopping here.\n`);
        break;
      }
    }
  } finally {
    await releaseSlot('gates finished');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, transcript.join('\n') + '\n', 'utf8');
  }

  const ran = results.map((entry) => entry.name);
  const skipped = selected.map((gate) => gate.name).filter((name) => !ran.includes(name));
  const failed = results.filter((entry) => entry.code !== 0);

  process.stdout.write(`\n[gates] ===== summary =====\n`);
  for (const entry of results)
    process.stdout.write(
      `  ${entry.code === 0 ? 'PASS' : 'FAIL'}  ${entry.name.padEnd(12)}  ${entry.summary}\n`,
    );
  for (const name of skipped) process.stdout.write(`  SKIP  ${name.padEnd(12)}  not reached\n`);
  process.stdout.write(`  transcript: ${logPath}\n`);
  process.stdout.write(
    failed.length ? `\n[gates] GATE FAILURE\n` : `\n[gates] ALL SELECTED GATES PASSED\n`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async (error: unknown) => {
  process.stderr.write(`\n[gates] ${error instanceof Error ? error.message : String(error)}\n`);
  await releaseSlot('error');
  process.exitCode = 1;
});
