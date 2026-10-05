import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The app names no local model (DIO-201, the reskin brief's Local model option). Its name, its
 * profiles, their levels and sizes, and whether it runs all come from the host: the integration
 * status and that route's catalogue. Nothing under client/ may spell the first one's name, not
 * in copy, an identifier or an import path, and nothing there calls its loopback server.
 */
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(tsx?|css|html)$/.test(entry.name) ? [full] : [];
  });
}

describe('the client names no local model', () => {
  it('has no file under client/ that names it or calls its server', () => {
    const hits = files(path.resolve('client'))
      .filter((file) => /bonsai|:18082/i.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(process.cwd(), file));
    expect(hits).toEqual([]);
  });
});
