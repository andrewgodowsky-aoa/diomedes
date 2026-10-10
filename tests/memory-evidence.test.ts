import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const evidence = fileURLToPath(new URL('../evidence/memory-context-w00/', import.meta.url));

it('keeps generated token environment names out of archived W00 logs', async () => {
  const logs = (await readdir(evidence)).filter((name) => name.endsWith('.log')).sort();
  const unsanitized: string[] = [];
  for (const name of logs) {
    const text = await readFile(join(evidence, name), 'utf8');
    for (const match of text.matchAll(/"tokenEnv"\s*:\s*"([^"\r\n]*)"/g)) {
      // This public metadata is derived from slotId, not the credential held in
      // that environment variable. Keep the slot and all test evidence intact.
      if (match[1] !== '[derived from slotId]') {
        const line = text.slice(0, match.index).split('\n').length;
        unsanitized.push(`${name}:${line}`);
      }
    }
  }
  expect(logs.length).toBeGreaterThan(0);
  // Report locations only: even a future accidental credential must not be
  // copied into an assertion diff or another evidence log.
  expect(unsanitized, 'Replace generated tokenEnv metadata with [derived from slotId] before archiving W00 logs').toEqual([]);
});
