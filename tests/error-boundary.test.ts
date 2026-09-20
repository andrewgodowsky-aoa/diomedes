/**
 * What a render crash is allowed to put on the screen.
 *
 * Two of these have already shipped, and both showed the person an empty
 * window: nothing in `client/` caught a render error, so React unmounted the
 * whole tree and left the ground colour. The recovery screen exists to end
 * that, which makes what it says a promise of its own — it is drawn from an
 * exception object, and an exception carries whatever the code that threw put
 * in it: a path, a URL, a whole stack.
 *
 * So the line it shows is built by a pure function, and that function is held
 * here to the error's name and the first line of its message, with the places
 * this computer keeps files taken out.
 */
import { describe, expect, it } from 'vitest';
import { ErrorBoundary, failureLine } from '../client/ErrorBoundary.js';

describe('the one line a recovery screen shows', () => {
  it('names the error and says what it said', () => {
    expect(failureLine(new TypeError('Cannot read properties of undefined'))).toBe(
      'TypeError: Cannot read properties of undefined',
    );
  });

  it('stops at the first line, because the rest is a stack', () => {
    const error = new Error('Something broke\n    at Shell (index-a1b2c3.js:1:2)');
    expect(failureLine(error)).toBe('Error: Something broke');
  });

  it('shows no path from this computer', () => {
    const windows = failureLine(new Error('ENOENT: open C:\\Users\\andrew\\Diomedes\\data\\x.json'));
    expect(windows).not.toContain('andrew');
    expect(windows).not.toMatch(/[A-Za-z]:\\/);
    const posix = failureLine(new Error('ENOENT: open /home/andrew/diomedes/data/x.json'));
    expect(posix).not.toContain('/home/andrew');
    const url = failureLine(new Error('Failed to fetch http://127.0.0.1:5174/assets/index.js'));
    expect(url).not.toContain('127.0.0.1');
    expect(failureLine(new Error('at file:///C:/app/resources/app.asar/index.js'))).not.toContain(
      'app.asar',
    );
  });

  it('answers for a thrown thing that is not an error at all', () => {
    expect(failureLine('just a string').trim()).not.toBe('');
    expect(failureLine(undefined).trim()).not.toBe('');
    expect(failureLine({ toString: () => 'C:\\Users\\andrew' })).not.toContain('andrew');
  });

  it('is short enough to read, whatever was thrown', () => {
    const long = failureLine(new Error('x'.repeat(4_000)));
    expect(long.length).toBeLessThanOrEqual(200);
  });

  it('is what the boundary puts in its state when a render throws', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new RangeError('out of range'))).toEqual({
      failure: 'RangeError: out of range',
    });
  });
});
