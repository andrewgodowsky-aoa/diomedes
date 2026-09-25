import { afterAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  MARKER,
  assertSafeTarget,
  defaultRoot,
  guardedLocations,
  parseResetArgs,
  resetBusiness,
  treeDigest,
} from '../scripts/sample-businesses/reset.js';
import {
  BUSINESSES,
  REPO_ROOT,
  SUITE_ROOT,
  checkBusiness,
  lintWorkspace,
  parsePlanted,
} from '../scripts/sample-businesses/suite.js';
import { Workspace, parseCsv } from '../scripts/sample-businesses/workspace.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-businesses-test-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const dir = path.join(scratch, `${name}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** A private copy of one business, so a test can damage it. */
function copyBusiness(slug: string) {
  const suite = fresh('suite');
  fs.cpSync(path.join(SUITE_ROOT, slug), path.join(suite, slug), { recursive: true });
  const file = (rel: string) => path.join(suite, slug, 'workspace', ...rel.split('/'));
  const edit = (rel: string, from: string, to: string) => {
    const text = fs.readFileSync(file(rel), 'utf8');
    expect(text).toContain(from);
    fs.writeFileSync(file(rel), text.replace(from, to));
  };
  return { suite, file, edit };
}

describe('sample business data', () => {
  test.each(BUSINESSES.map((b) => b.slug))(
    '%s: every planted problem is recomputed from the files and matches planted.md',
    (slug) => {
      const report = checkBusiness(slug);
      expect(report.errors).toEqual([]);
      expect(report.findings.length).toBeGreaterThanOrEqual(5);
      expect(report.findings.map((f) => f.id).sort()).toEqual(
        report.planted.map((p) => p.id).sort(),
      );
    },
  );

  test('the bakery crosses exactly once, in W38, and keeps the capture export byte for byte', () => {
    const report = checkBusiness('juniper-street-bakery');
    expect(
      report.findings.filter((f) => f.id.startsWith('pumpkin-crosses-')).map((f) => f.id),
    ).toEqual(['pumpkin-crosses-croissants-w38']);
    const pos = fs.readFileSync(
      path.join(SUITE_ROOT, 'juniper-street-bakery/workspace/exports/pos-weekly-summary.txt'),
    );
    expect(crypto.createHash('sha256').update(pos).digest('hex')).toBe(
      'caacbc809b90671db5cd4c31e29f27df3936d04fdbe9b3b09c63bf0424e37b18',
    );
  });

  test('a delivery counted in full removes a planted problem and breaks the site Lookback total', () => {
    const { suite, edit } = copyBusiness('larch-and-lantern-wine');
    edit(
      'receiving/receiving-log-2026-06-23-to-09-17.csv',
      '30418,4,FL-103,4,',
      '30418,4,FL-103,5,',
    );
    const errors = checkBusiness('larch-and-lantern-wine', suite).errors.join('\n');
    expect(errors).toContain('planted but no longer in the files: short-30418-line-4');
    expect(errors).toContain(
      "the site's wine Lookback is 7 items and $1,230.00; the files give 6 items and $1074.00",
    );
  });

  test('an accidental discrepancy is caught even though nobody planted it', () => {
    const { suite, edit } = copyBusiness('brandt-and-rowe-remodeling');
    edit(
      'delivery-tickets/ridgeline-58701.csv',
      '1,2x10x16 SPF joist,24,',
      '1,2x10x16 SPF joist,23,',
    );
    const errors = checkBusiness('brandt-and-rowe-remodeling', suite).errors.join('\n');
    expect(errors).toContain('not planted, but the files show it: short-ridgeline-58701-line-1');
  });

  test('moving the crossing week fails the bakery check', () => {
    const { suite, edit } = copyBusiness('juniper-street-bakery');
    edit(
      'sales/weekly-sales-2026-W30-to-W38.csv',
      '2026-W37,2026-09-07,Pumpkin loaf slice,173,3.75,648.75,0.90,493.05',
      '2026-W37,2026-09-07,Pumpkin loaf slice,250,3.75,937.50,0.90,712.50',
    );
    const errors = checkBusiness('juniper-street-bakery', suite).errors.join('\n');
    expect(errors).toContain('not planted, but the files show it: pumpkin-crosses-croissants-w37');
    expect(errors).toContain('planted but no longer in the files: pumpkin-crosses-croissants-w38');
    expect(errors).toContain('2026-W37: pumpkin 412, the item rows say 489');
  });

  test('a changed amount in planted.md is reported against the files', () => {
    const { suite } = copyBusiness('quarry-hill-cabinetworks');
    const planted = path.join(suite, 'quarry-hill-cabinetworks', 'planted.md');
    fs.writeFileSync(
      planted,
      fs.readFileSync(planted, 'utf8').replace('| row 9 | 11 sheets |', '| row 9 | 12 sheets |'),
    );
    expect(checkBusiness('quarry-hill-cabinetworks', suite).errors).toContain(
      'walnut-ply-3-4-on-hand: planted.md says amount "12 sheets", the files give "11 sheets"',
    );
  });

  test('workspace lint refuses PDFs, real-looking phones and emails, vendor names and CRLF', () => {
    const dir = fresh('lint');
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      '> FICTIONAL SAMPLE DATA.\n\nCall 919-867-5309 or 919-555-0123, or mail owner@realshop.com.\n',
    );
    fs.writeFileSync(
      path.join(dir, 'notes.md'),
      '> FICTIONAL SAMPLE DATA.\r\nAsked ChatGPT about it.\n',
    );
    fs.writeFileSync(path.join(dir, 'invoice.pdf'), '%PDF-1.4');
    const errors = lintWorkspace(new Workspace(dir)).join('\n');
    expect(errors).toContain('invoice.pdf: only .md, .csv and .txt files');
    expect(errors).toContain('phone 867-5309 is outside');
    expect(errors).not.toContain('phone 555-0123');
    expect(errors).toContain('email owner@realshop.com is not on example.com');
    expect(errors).toContain('notes.md: CRLF line endings');
    expect(errors).toContain('notes.md: names "ChatGPT"');
  });

  test('parsers: planted tables and quoted CSV cells', () => {
    const planted = parsePlanted(
      '# x\n\n| id | problem | file | where | amount |\n|---|---|---|---|---|\n| a | b | `c.csv` | row 2 | 1.00 |\n\nafter',
    );
    expect(planted).toEqual([
      { id: 'a', problem: 'b', file: 'c.csv', where: 'row 2', amount: '1.00' },
    ]);
    const { rows } = parseCsv('a,b\n"x, y",2\n"say ""hi""",3\n');
    expect(rows.map((r) => [r.a, r.b, r._row])).toEqual([
      ['x, y', '2', 2],
      ['say "hi"', '3', 3],
    ]);
    expect(() => parseCsv('a,b\n1\n')).toThrow('row 2 has 1 cells');
  });
});

describe('sample business reset', () => {
  const guarded = [REPO_ROOT];

  test('writes the workspace byte for byte with empty data and profile, and is idempotent', async () => {
    const root = fresh('root');
    const first = await resetBusiness('kestrel-row-auto', { root, guarded });
    expect(first.project).toBe(
      path.join(root, 'kestrel-row-auto', 'projects', 'Kestrel Row Auto Repair'),
    );
    expect(treeDigest(first.project)).toEqual(
      treeDigest(path.join(SUITE_ROOT, 'kestrel-row-auto', 'workspace')),
    );
    expect(fs.readdirSync(first.dataDir)).toEqual([]);
    expect(fs.readdirSync(first.profileDir)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'kestrel-row-auto', 'env.ps1'), 'utf8')).toContain(
      `$env:DIOMEDES_DATA_DIR = '${first.dataDir}'`,
    );
    const before = treeDigest(first.target);
    // Whatever the app recorded since is gone after the next reset.
    fs.writeFileSync(path.join(first.dataDir, 'registry.json'), '[]');
    fs.writeFileSync(path.join(first.project, 'stray.md'), 'x');
    const second = await resetBusiness('kestrel-row-auto', { root, guarded });
    expect(second.sha256).toBe(first.sha256);
    expect(treeDigest(second.target)).toEqual(before);
    expect(fs.readdirSync(second.dataDir)).toEqual([]);
  });

  test('refuses a folder it did not write, and leaves it alone', async () => {
    const root = fresh('root');
    const mine = path.join(root, 'juniper-street-bakery');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(mine, 'keep.txt'), 'real work');
    await expect(resetBusiness('juniper-street-bakery', { root, guarded })).rejects.toThrow(
      `no ${MARKER}`,
    );
    expect(fs.readFileSync(path.join(mine, 'keep.txt'), 'utf8')).toBe('real work');
  });

  test('refuses guarded locations: the repository, real app data and registered projects', async () => {
    await expect(
      resetBusiness('juniper-street-bakery', {
        root: path.join(REPO_ROOT, 'tmp', 'samples'),
        guarded,
      }),
    ).rejects.toThrow('overlaps');
    const appdata = fresh('appdata');
    const realProject = fresh('real-project');
    fs.mkdirSync(path.join(appdata, 'Diomedes', 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(appdata, 'Diomedes', 'data', 'registry.json'),
      JSON.stringify([{ id: 'p1', folder: realProject }]),
    );
    const env = { APPDATA: appdata, LOCALAPPDATA: fresh('local'), USERPROFILE: os.homedir() };
    const guard = guardedLocations(env);
    expect(guard).toContain(realProject);
    expect(() => assertSafeTarget(path.join(appdata, 'Diomedes', 'samples', 'x'), guard)).toThrow(
      'overlaps',
    );
    expect(() => assertSafeTarget(path.join(realProject, 'x'), guard)).toThrow('overlaps');
    expect(() => assertSafeTarget(path.dirname(realProject), guard)).toThrow('overlaps');
    expect(() => assertSafeTarget(os.homedir(), guard)).toThrow('home folder');
    expect(() => assertSafeTarget(path.join(fresh('elsewhere'), 'x'), guard)).not.toThrow();
    expect(defaultRoot({ DIOMEDES_SAMPLES_DIR: 'Z:/samples' })).toBe(path.resolve('Z:/samples'));
    expect(defaultRoot({ LOCALAPPDATA: 'C:/Local' })).toBe(
      path.join('C:/Local', 'nectovia-sample-businesses'),
    );
  });

  test('refuses to delete through a junction, and the junction target survives', async () => {
    const root = fresh('root');
    const r = await resetBusiness('quarry-hill-cabinetworks', { root, guarded });
    const outside = fresh('outside');
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
    fs.symlinkSync(outside, path.join(r.dataDir, 'linked'), 'junction');
    await expect(resetBusiness('quarry-hill-cabinetworks', { root, guarded })).rejects.toThrow(
      'link or junction',
    );
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep');
    fs.unlinkSync(path.join(r.dataDir, 'linked'));
  });

  test('refuses while a running app holds the sample data folder', async () => {
    const root = fresh('root');
    const r = await resetBusiness('brandt-and-rowe-remodeling', { root, guarded });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      fs.writeFileSync(
        path.join(r.dataDir, 'service.lock'),
        JSON.stringify({ pid: process.pid, port }),
      );
      await expect(resetBusiness('brandt-and-rowe-remodeling', { root, guarded })).rejects.toThrow(
        'is running on',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    // Once the app is gone the same folder resets normally.
    fs.writeFileSync(
      path.join(r.dataDir, 'service.lock'),
      JSON.stringify({ pid: 2 ** 30, port: 1 }),
    );
    await expect(
      resetBusiness('brandt-and-rowe-remodeling', { root, guarded }),
    ).resolves.toMatchObject({ slug: 'brandt-and-rowe-remodeling' });
  });

  test('reads its arguments with or without --root', () => {
    const env = { LOCALAPPDATA: 'C:/Local' };
    expect(parseResetArgs(['all'], env)).toEqual({
      root: path.join('C:/Local', 'nectovia-sample-businesses'),
      slugs: ['all'],
    });
    expect(
      parseResetArgs(['kestrel-row-auto', '--root', 'D:/s', 'quarry-hill-cabinetworks'], env),
    ).toEqual({
      root: path.resolve('D:/s'),
      slugs: ['kestrel-row-auto', 'quarry-hill-cabinetworks'],
    });
    expect(() => parseResetArgs(['all', '--root'], env)).toThrow('--root needs a folder');
  });

  test('refuses an unknown business', async () => {
    await expect(resetBusiness('no-such-shop', { root: fresh('root'), guarded })).rejects.toThrow(
      'Unknown sample business',
    );
  });
});
