/** Metadata-only probe. No user message or inference request is sent. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../server/engines/claude.js';
import { OpenCodeAdapter } from '../server/engines/opencode.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes metadata '));
try {
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error('Pass an absolute engine executable path.');
  const engine = process.argv[3] ?? 'claude-code';
  const adapter =
    engine === 'claude-code'
      ? new ClaudeAdapter(file, root)
      : engine === 'opencode'
        ? new OpenCodeAdapter(file, root)
        : engine === 'oh-my-pi'
          ? new (await import('../server/engines/omp.js')).OmpAdapter(file, root)
          : null;
  if (!adapter) throw new Error('Choose claude-code, opencode or oh-my-pi.');
  const result = await adapter.inspect();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
