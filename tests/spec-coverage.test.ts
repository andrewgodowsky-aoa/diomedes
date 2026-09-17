import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every Playwright config names its specs explicitly, so a spec file that no
 * config names is never run: it sits in tests/ looking like coverage and
 * reports nothing, and the suite stays green because it was never asked. Two
 * specs written in worktrees reached this tree that way.
 *
 * The configs are read as text rather than imported. Evaluating
 * playwright.config.ts spawns the dev-server guard, calls process.exit when a
 * port is held and writes a fixture tree under test-results/; the other two
 * configs spread it, so importing any of them does all three. None of that
 * belongs in a unit test, and a config that killed the runner would take the
 * rest of the suite with it.
 */
const CONFIGS = [
  'playwright.config.ts',
  'playwright.responsive.config.ts',
  'playwright.connections.config.ts',
] as const;

/**
 * Pull the quoted entries out of a config's `testMatch` array literal. Every
 * failure here throws rather than returning an empty list: a guard that
 * silently matched nothing would report full coverage for a tree it could not
 * read, which is the exact failure it exists to catch.
 */
function readTestMatch(configFile: string): string[] {
  const source = fs.readFileSync(path.join(root, configFile), 'utf8');
  const key = source.indexOf('testMatch:');
  if (key === -1)
    throw new Error(`${configFile} sets no testMatch, so which specs it runs cannot be read here.`);
  const open = source.indexOf('[', key);
  if (open === -1)
    throw new Error(`${configFile} does not give testMatch an array literal this guard can read.`);
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`${configFile}'s testMatch array is never closed.`);
  const entries = [...source.slice(open, close).matchAll(/['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  if (entries.length === 0) throw new Error(`${configFile}'s testMatch names no spec at all.`);
  return entries;
}

const specsOnDisk = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.spec.ts'))
  .sort();

const registered = new Map<string, string[]>();
for (const config of CONFIGS)
  for (const entry of readTestMatch(config)) {
    const owners = registered.get(entry) ?? [];
    owners.push(config);
    registered.set(entry, owners);
  }

describe('Playwright spec coverage', () => {
  it('finds spec files to check', () => {
    // A tests/ directory that suddenly holds no specs would make every
    // assertion below vacuously true.
    expect(specsOnDisk.length).toBeGreaterThan(0);
  });

  it('runs every spec file in the tree', () => {
    const unregistered = specsOnDisk.filter((spec) => !registered.has(spec));
    expect(
      unregistered,
      `${unregistered.join(', ')} is in tests/ but no Playwright config names it, so it never runs. ` +
        `Add it to one config's testMatch, or delete it.`,
    ).toEqual([]);
  });

  it('names no spec that is missing from the tree', () => {
    const missing = [...registered.keys()].filter((entry) => !specsOnDisk.includes(entry));
    expect(
      missing,
      `${missing.join(', ')} is named by a Playwright config but is not a file in tests/.`,
    ).toEqual([]);
  });

  it('runs each spec under exactly one config', () => {
    // The configs start their own servers on their own ports. A spec claimed by
    // two of them runs twice against different fixtures, and which result is
    // authoritative stops being obvious.
    const shared = [...registered.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([spec, owners]) => `${spec} (${owners.join(' and ')})`);
    expect(shared, `Named by more than one config: ${shared.join('; ')}.`).toEqual([]);
  });
});
