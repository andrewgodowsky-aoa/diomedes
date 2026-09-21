import { describe, expect, it } from 'vitest';
import { baselineRedact } from '../server/secrets.js';

// The floor under engine CLI output, where Diomedes holds no inventory of what
// is secret. Windows treats a path's case as insignificant, so the floor must.
describe('the redaction floor reads a Windows path the way Windows does', () => {
  it.each([
    ['as Windows writes it', 'C:\\Users\\hostile\\Documents\\notes.md'],
    ['in lower case', 'c:\\users\\hostile\\documents\\notes.md'],
    ['in upper case', 'C:\\USERS\\HOSTILE\\Documents\\notes.md'],
    ['with forward slashes', 'c:/users/hostile/Documents/notes.md'],
  ])('removes the account name from a home path %s', (_label, value) => {
    const out = baselineRedact(`ENOENT: no such file or directory, open '${value}'`);
    expect(out.toLowerCase()).not.toContain('hostile');
    expect(out).toContain('[home]');
  });

  it('removes a bearer token however the scheme is cased', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const out = baselineRedact(`request failed: ${scheme} hostile.truth.tok3n`);
      expect(out).not.toContain('hostile.truth.tok3n');
    }
  });

  it('leaves ordinary text alone', () => {
    const text = 'The tool answered on port 4096 and listed 3 models for users of this route.';
    expect(baselineRedact(text)).toBe(text);
  });
});
