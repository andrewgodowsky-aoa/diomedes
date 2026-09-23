/**
 * No company Google credential can reach a customer build. The browser client
 * never imports the Vertex route, Google's auth library or anything that reads
 * Application Default Credentials; the repository carries no Google key or
 * token; and the Vertex connection record holds identifiers only. The desktop
 * server does carry the founder route's code, which reads the ADC file of the
 * computer it runs on and nothing else.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { vertexConnectionSchema } from '../server/engines/google-vertex.js';

const root = path.resolve(__dirname, '..');

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...(await sources(full)));
    } else if (/\.(tsx?|jsx?|mjs|cjs|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('customer builds carry no company Google credential', () => {
  test('the browser client imports neither the Vertex route nor Google auth, and names no ADC file', async () => {
    const files = await sources(path.join(root, 'client'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      expect(text, file).not.toMatch(/@ai-sdk\/google-vertex|google-auth-library|application_default_credentials|GOOGLE_APPLICATION_CREDENTIALS/);
      expect(text, file).not.toMatch(/from ['"][./]*server\/engines\/google-vertex/);
    }
  });

  test('no Google key, service-account key or access token is tracked in the repository', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file && !file.startsWith('tests/') && !file.startsWith('licenses/') && !/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|zip|exe|pdf|webm|mp4)$/i.test(file));
    const hits: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        text = require('node:fs').readFileSync(path.join(root, file), 'utf8') as string;
      } catch {
        continue;
      }
      if (/"type":\s*"service_account"[\s\S]{0,400}"private_key"|-----BEGIN (RSA )?PRIVATE KEY-----|\bya29\.[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}\b|"refresh_token":\s*"1\/\//.test(text))
        hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  test('the saved Vertex connection admits identifiers only: no token or key field exists', () => {
    const shape = vertexConnectionSchema.innerType?.() ?? vertexConnectionSchema;
    const serialized = JSON.stringify(Object.keys((shape as { shape: Record<string, unknown> }).shape));
    expect(serialized).not.toMatch(/token|secret|private|key"/i);
    const credential = (shape as { shape: { credential: { shape: Record<string, unknown> } } }).shape.credential.shape;
    expect(Object.keys(credential).sort()).toEqual(['expiresAt', 'fingerprint', 'kind', 'namedBy', 'principal', 'quotaProject', 'savedAt', 'source']);
  });
});
