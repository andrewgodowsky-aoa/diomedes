/**
 * Final hostile pass, server side: what the redaction floor removes from text
 * a person is shown.
 *
 * `baselineRedact` is wired as the preview redactor for every engine
 * (`server/app.ts`, `redactFor: () => baselineRedact`), and `previewSink`
 * applies it to each streamed delta before the frame reaches the screen. So
 * anything it rewrites is rewritten in the answer a person reads.
 */
import { describe, expect, it } from 'vitest';
import { baselineRedact } from '../server/secrets.js';

describe('the redaction floor under engine output', () => {
  it('still removes a home folder in either spelling', () => {
    expect(baselineRedact('C:\\Users\\Andrew\\notes.txt')).toContain('[home]');
    expect(baselineRedact('c:\\users\\andrew\\notes.txt')).toContain('[home]');
    expect(baselineRedact('/Users/andrew/notes.txt')).toContain('[home]');
    expect(baselineRedact('Authorization: bearer abc.def-ghi')).toContain('Bearer [redacted]');
  });

  it('does not rewrite a web route that merely contains a users segment', () => {
    // A person asking an engine about their own API gets the answer redacted:
    // there is no home folder here, and the path is the answer.
    expect(baselineRedact('GET https://api.example.com/users/42 returned 401')).toContain(
      '/users/42',
    );
    expect(baselineRedact('Call POST /api/v1/users/list to page the roster.')).toContain(
      '/users/list',
    );
  });
});
