import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { loadProductKnowledge } from '../server/readiness/product-knowledge.js';
import packageInfo from '../package.json' with { type: 'json' };

test('a Windows-style Git checkout preserves indexed product knowledge bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-knowledge-checkout-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'core.autocrlf=true', ...args], {
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, GIT_INDEX_FILE: path.join(root, 'fixture.index') },
    });
  try {
    git('init', '--quiet');
    await fs.copyFile(path.resolve('.gitattributes'), path.join(root, '.gitattributes'));
    await fs.cp(
      path.resolve('resources/product-knowledge'),
      path.join(root, 'resources/product-knowledge'),
      { recursive: true },
    );
    git('add', '.gitattributes', 'resources/product-knowledge');
    await fs.mkdir(path.join(root, 'checkout'));
    git('checkout-index', '--all', '--prefix=checkout/');
    const knowledge = await loadProductKnowledge({
      root: path.join(root, 'checkout/resources/product-knowledge'),
      buildVersion: packageInfo.version,
    });
    expect(knowledge.conflicts).toEqual([]);
    expect(knowledge.resources).toHaveLength(1);
    expect(knowledge.resources[0].resource.workflows.length).toBeGreaterThan(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
