/**
 * The Jev acceptance ledger, pinned to what it actually says.
 *
 * `docs/product/evaluation/ACCEPTANCE_COVERAGE.md` is an acceptance record: it
 * claims, case by case, that a named test at a named line asserts a required
 * behaviour. A record like that is only worth the checks around it, because the
 * way it fails is silent — a row drifts, a cited file is renamed, a verdict is
 * changed without the header being recounted, and the document goes on reading
 * like a proof.
 *
 * So this file reads the table off disk and holds it to the four things a
 * reviewer would otherwise have to check by hand: that all eighty cases are
 * present exactly once, that every cited file exists, that no row leaves its
 * evidence blank, and that the split in the header is the split in the table.
 *
 * Nothing here is hardcoded from the document. Every row is parsed, so editing
 * the markdown is what changes the test's inputs.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LEDGER = path.join(REPO_ROOT, 'docs', 'product', 'evaluation', 'ACCEPTANCE_COVERAGE.md');

const VERDICTS = ['COVERED', 'GAP', 'GATED', 'OUT-OF-SCOPE'] as const;
type Verdict = (typeof VERDICTS)[number];

interface Row {
  readonly id: string;
  readonly summary: string;
  readonly verdict: Verdict;
  readonly evidence: string;
}

const markdown = readFileSync(LEDGER, 'utf8');

/**
 * One row per `| Jnn | ... |` line. Cells are split on the pipe, which is why
 * the document may not use one inside a cell, and the row is refused here if it
 * does not carry exactly four.
 */
function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*J\d\d\s*\|/.test(line)) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());
    expect(cells, `row does not have four cells: ${line}`).toHaveLength(4);
    rows.push({
      id: cells[0]!,
      summary: cells[1]!,
      verdict: cells[2]! as Verdict,
      evidence: cells[3]!,
    });
  }
  return rows;
}

/** The header's own claim, e.g. "Split: 32 COVERED, 42 GAP, 5 GATED, 1 OUT-OF-SCOPE." */
function parseStatedSplit(text: string): Record<Verdict, number> {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => /\*\*Split:/.test(candidate));
  expect(line, 'the header states no split').toBeDefined();
  const stated = {} as Record<Verdict, number>;
  for (const verdict of VERDICTS) {
    const found = new RegExp(`(\\d+)\\s+${verdict}\\b`).exec(line!);
    expect(found, `the header states no count for ${verdict}`).not.toBeNull();
    stated[verdict] = Number(found![1]);
  }
  return stated;
}

const rows = parseRows(markdown);

/** `tests/x.test.ts:203` at the head of an evidence cell, backticks stripped. */
const citedFile = (evidence: string): string | null => {
  const found = /^`?(tests\/[A-Za-z0-9._/-]+\.test\.ts):(\d+)`?/.exec(evidence);
  return found ? found[1]! : null;
};

describe('the ledger is readable at all', () => {
  test('the file exists where the implementation report points', () => {
    expect(existsSync(LEDGER)).toBe(true);
  });

  test('it names the branch and the commit it was measured at', () => {
    expect(markdown).toMatch(/\*\*Branch:\*\*\s*`feature\/jev-evaluation-20260919`/);
    expect(markdown).toMatch(/\*\*Commit:\*\*\s*`[0-9a-f]{40}`/);
    expect(markdown).toMatch(/\*\*Date:\*\*\s*2026-09-19/);
  });
});

describe('every case the failure matrix defines', () => {
  test('there are exactly eighty rows', () => {
    expect(rows).toHaveLength(80);
  });

  test('J01 to J80 each appear exactly once, and nothing else does', () => {
    const expected = Array.from({ length: 80 }, (_, i) => `J${String(i + 1).padStart(2, '0')}`);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(expected);
  });

  test('every row carries one of the four verdicts', () => {
    for (const row of rows)
      expect(VERDICTS, `${row.id} has verdict ${row.verdict}`).toContain(row.verdict);
  });

  test('every row says what the case is, briefly', () => {
    for (const row of rows) expect(row.summary.length, row.id).toBeGreaterThan(8);
  });
});

describe('the evidence each row offers', () => {
  test('is never empty', () => {
    for (const row of rows) {
      expect(row.evidence.length, `${row.id} has no evidence`).toBeGreaterThan(20);
      expect(row.evidence, `${row.id} evidence is a placeholder`).not.toMatch(/^(todo|tbd|n\/a)/i);
    }
  });

  test('cites a test file that exists on disk for every COVERED row', () => {
    const covered = rows.filter((row) => row.verdict === 'COVERED');
    expect(covered.length).toBeGreaterThan(0);
    for (const row of covered) {
      const file = citedFile(row.evidence);
      expect(file, `${row.id} does not open with tests/<file>.test.ts:<line>`).not.toBeNull();
      expect(existsSync(path.join(REPO_ROOT, file!)), `${row.id} cites a missing ${file}`).toBe(
        true,
      );
    }
  });

  test('cites a line inside that file, and says what it asserts', () => {
    for (const row of rows.filter((entry) => entry.verdict === 'COVERED')) {
      const found = /^`?(tests\/[A-Za-z0-9._/-]+\.test\.ts):(\d+)`?/.exec(row.evidence)!;
      const lines = readFileSync(path.join(REPO_ROOT, found[1]!), 'utf8').split(/\r?\n/);
      const line = Number(found[2]!);
      expect(line, `${row.id} cites line ${line}`).toBeGreaterThan(0);
      expect(lines.length, `${row.id} cites past the end of ${found[1]}`).toBeGreaterThanOrEqual(
        line,
      );
      // The cited line is where the test is declared, not a line inside one.
      expect(lines[line - 1], `${row.id} does not cite a test declaration`).toMatch(
        /^\s*(test|it)(\.each)?\(/,
      );
      // A citation alone is not evidence: the clause after it says what holds.
      expect(row.evidence, `${row.id} cites without a clause`).toContain(' — ');
    }
  });

  test('names a home and a requirement for every GAP row', () => {
    for (const row of rows.filter((entry) => entry.verdict === 'GAP')) {
      expect(row.evidence, `${row.id} names no file`).toMatch(/`tests\/[A-Za-z0-9._/-]+\.ts`?/);
      expect(row.evidence, `${row.id} says nothing about what the test must show`).toMatch(
        /must show/i,
      );
    }
  });

  test('names the exact gate for every GATED row', () => {
    for (const row of rows.filter((entry) => entry.verdict === 'GATED'))
      expect(row.evidence, `${row.id} names no gate`).toMatch(/^Gate:/);
  });

  test('says why for every OUT-OF-SCOPE row', () => {
    for (const row of rows.filter((entry) => entry.verdict === 'OUT-OF-SCOPE'))
      expect(row.evidence, `${row.id} gives no reason`).toMatch(/does not exist|no referent/i);
  });
});

describe('the header counts what the table holds', () => {
  test('the stated split is the measured split', () => {
    const stated = parseStatedSplit(markdown);
    for (const verdict of VERDICTS)
      expect(rows.filter((row) => row.verdict === verdict), verdict).toHaveLength(stated[verdict]);
  });

  test('the stated split adds up to eighty', () => {
    const stated = parseStatedSplit(markdown);
    expect(VERDICTS.reduce((total, verdict) => total + stated[verdict], 0)).toBe(80);
  });
});
