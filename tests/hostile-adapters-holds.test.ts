import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseLimitError, SseParser } from '../server/engines/sse.js';
import { ENGINE_ROUTE_PROFILES, routeCaption } from '../shared/engine-routes.js';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import { NativeLogin, type SignInOutcome } from '../server/engines/login.js';
import type { EngineConnection } from '../shared/engines.js';
import type { ExternalEngine } from '../shared/types.js';

/**
 * Hostile verification of the first-run repair, adapters area (F02, F04, F07).
 *
 * Every test in this file PASSES. Each one is a property the repair claims that
 * survived an attempt to break it, recorded so the claim is not taken on a
 * summary. The claims that did not survive are in
 * `tests/hostile-adapters-defects.test.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const source = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
const walk = (folder: string, match: RegExp): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(repo, folder), { withFileTypes: true })) {
    const next = `${folder}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(next, match));
    else if (match.test(entry.name)) out.push(next);
  }
  return out;
};

const encoder = new TextEncoder();
const feed = (parser: SseParser, ...pieces: (string | Uint8Array)[]) =>
  pieces.flatMap((piece) => parser.push(typeof piece === 'string' ? encoder.encode(piece) : piece));

describe('SSE framing survives the chunk boundaries a socket actually produces', () => {
  it('remembers a pending carriage return across a chunk that decodes to nothing', () => {
    // A multi-byte character split at a chunk boundary decodes to the empty
    // string. If that empty decode cleared the pending line ending, the line
    // feed opening the next chunk would end a second, empty line and dispatch
    // an event that the stream never finished.
    const parser = new SseParser();
    const euro = encoder.encode('€');
    expect(feed(parser, 'data: one\r')).toEqual([]);
    expect(feed(parser, euro.slice(0, 1))).toEqual([]);
    expect(feed(parser, euro.slice(1), '\n')).toEqual([]);
    // The euro landed at the head of the next line, so that line is not a data
    // field and the event still carries only `one`.
    expect(feed(parser, '\n')).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('keeps a line ending that is split with nothing at all in between', () => {
    const parser = new SseParser();
    expect(feed(parser, 'data: one\r', new Uint8Array(0), '\n\n')).toEqual([
      { event: 'message', data: 'one' },
    ]);
  });
  it('reads a carriage return followed by a carriage-return line feed as a blank line', () => {
    expect(feed(new SseParser(), 'data: one\r\r\n')).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('never dispatches the last event of a stream that stopped before its blank line', () => {
    const parser = new SseParser();
    expect(feed(parser, 'data: {"done":true}\n\ndata: {"done":tru')).toEqual([
      { event: 'message', data: '{"done":true}' },
    ]);
    // Nothing flushes on end of stream, so a truncated event stays unsent.
    expect(feed(parser, '')).toEqual([]);
  });
  it('carries a null character inside data through untouched', () => {
    // The specification sanitises nothing but the id field; a payload byte is
    // the adapter's problem, and it refuses the JSON rather than guessing.
    expect(feed(new SseParser(), 'data: a\0b\n\n')).toEqual([{ event: 'message', data: 'a\0b' }]);
  });
  it('bounds an event whose type and id lines are the thing growing', () => {
    // `event:` and `id:` values are not counted in the data bound, so the true
    // worst case is about three times the limit rather than one. That is a
    // departure from a strict reading of the bound and not from the format:
    // memory is still bounded, which is what the bound exists for.
    const parser = new SseParser({ maxBufferBytes: 512 });
    for (let round = 0; round < 200; round += 1)
      expect(feed(parser, `event: ${'e'.repeat(100)}\nid: ${'i'.repeat(100)}\ndata: x\n\n`)).toEqual(
        [{ event: 'e'.repeat(100), data: 'x' }],
      );
    expect(() => feed(parser, `event: ${'e'.repeat(2_000)}`)).toThrow(SseLimitError);
  });
  it('does not let a stream that never dispatches grow without end', () => {
    const parser = new SseParser({ maxBufferBytes: 4_096 });
    expect(() => {
      for (let round = 0; round < 1_000; round += 1) feed(parser, 'data: xxxxxxxxxxxxxxxx\n');
    }).toThrow(SseLimitError);
  });
});

describe('every route names itself from the profile, and no route is Codex', () => {
  it('gives each of the five routes an account route and a task scope', () => {
    for (const engine of EXTERNAL_ENGINES) {
      const profile = ENGINE_ROUTE_PROFILES[engine];
      expect(profile.routeLabel.length).toBeGreaterThan(0);
      expect(profile.taskScope).toBe('Text and reviewed proposals');
      expect(routeCaption(engine)).toBe(`${profile.routeLabel} · ${profile.taskScope}`);
    }
    expect(routeCaption('opencode')).toBe('OpenCode Go · Text and reviewed proposals');
  });
  it('names no Codex route profile', () => {
    expect(Object.keys(ENGINE_ROUTE_PROFILES)).not.toContain('codex');
    expect(JSON.stringify(ENGINE_ROUTE_PROFILES)).not.toMatch(/codex/i);
  });
  it('hand-types no OpenCode route label anywhere a person reads one', () => {
    // A label that bypasses the profile is a label the adapter does not enforce.
    const offenders: string[] = [];
    for (const file of [...walk('client', /\.(ts|tsx)$/), ...walk('server', /\.ts$/)]) {
      if (file.endsWith('shared/engine-routes.ts')) continue;
      for (const [index, line] of source(file).split('\n').entries()) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        if (/'[^']*OpenCode Go[^']*'|"[^"]*OpenCode Go[^"]*"|`[^`]*OpenCode Go[^`]*`/.test(line))
          offenders.push(`${file}:${index + 1}`);
      }
    }
    // The adapter's own sentences about its one account route are the adapter's
    // to write; what must not exist is a *selectable* label typed by hand.
    expect(offenders.filter((row) => row.startsWith('client/'))).toEqual([]);
  });
});

describe('a failure names the stage it happened at', () => {
  /** Count the arguments of one `new EngineError(` call without running it. */
  function calls(file: string) {
    const text = source(file);
    const found: { line: number; args: number; text: string }[] = [];
    let at = 0;
    while ((at = text.indexOf('new EngineError(', at)) >= 0) {
      let depth = 0;
      let end = text.indexOf('(', at + 'new EngineError'.length);
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const call = text.slice(at, end + 1);
      let inner = 0;
      let commas = 0;
      let quote: string | null = null;
      for (let i = 'new EngineError('.length; i < call.length - 1; i += 1) {
        const c = call[i];
        if (quote) {
          if (c === '\\') i += 1;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if ('([{'.includes(c)) inner += 1;
        else if (')]}'.includes(c)) inner -= 1;
        else if (c === ',' && inner === 0) commas += 1;
      }
      found.push({
        line: text.slice(0, at).split('\n').length,
        args: commas + 1,
        text: call.replace(/\s+/g, ' ').slice(0, 90),
      });
      at = end + 1;
    }
    return found;
  }
  it('carries a stage on every adapter failure but the two the stream loop stamps', () => {
    const stageless: string[] = [];
    for (const engine of ['claude', 'opencode', 'omp', 'cursor', 'devin'])
      for (const call of calls(`server/engines/${engine}.ts`))
        if (call.args < 4) stageless.push(`${engine}.ts:${call.line} ${call.text}`);
    // The two exceptions are raised inside the OpenCode stream loop, which
    // stamps whatever reaches it with the stage the attempt had got to
    // (server/engines/opencode.ts:828-830), so both arrive as `stream`.
    expect(stageless).toHaveLength(2);
    expect(stageless.every((row) => row.startsWith('opencode.ts:') && row.includes('OUTPUT_LIMIT')))
      .toBe(true);
  });
});

describe('nothing sends a paid request twice on its own', () => {
  it('gives the dispatch step one attempt and the local admission step three', () => {
    const text = source('server/harness/text-route.ts');
    const dispatch = text.slice(text.indexOf('const dispatchStep'));
    expect(dispatch).toMatch(/maxAttempts:\s*1/);
    const admission = text.slice(text.indexOf('const admissionStep'), text.indexOf('const dispatchStep'));
    expect(admission).toMatch(/maxAttempts:\s*3/);
    expect(admission).toMatch(/destination:\s*'local'/);
  });
  it('pins the native tools own retry and fallback off rather than inheriting a default', () => {
    // `engineEnvironment` strips the person's environment, so an unset variable
    // is the tool's default and not zero. Each one is set on purpose.
    expect(source('server/engines/claude.ts')).toMatch(/CLAUDE_CODE_MAX_RETRIES:\s*'0'/);
    const omp = source('server/engines/omp.ts');
    expect(omp).toMatch(/retry:\\n {2}enabled: false\\n {2}maxRetries: 0\\n {2}modelFallback: false/);
    expect(omp).toMatch(/set_auto_retry/);
  });
  it('stops rather than redispatching when the tool announces a retry of its own', () => {
    expect(source('server/engines/opencode.ts')).toMatch(
      /OpenCode started a retry\. Diomedes stopped without redispatching\./,
    );
  });
  it('kills only a child whose handle it still holds', () => {
    // PID reuse is the hazard. The guard reads the handle Diomedes spawned, and
    // Windows keeps a pid reserved while a handle to it is open, so a pid this
    // reaches cannot already belong to somebody else's process.
    expect(source('server/integrations.ts')).toMatch(
      /child\.exitCode !== null \|\| child\.signalCode !== null \|\| child\.pid === undefined\) return;/,
    );
  });
});

describe('a native sign-in window reports what happened to the window, never to the account', () => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'hostile-login-'));
  afterEach(() => vi.restoreAllMocks());
  const connection = (engine: ExternalEngine): EngineConnection =>
    ({
      engine,
      installation: 'found',
      compatibility: 'supported',
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
      checkedAt: new Date().toISOString(),
      detail: '',
      usage: { state: 'unknown', checkedAt: null },
      location: path.join(root, 'opencode.exe'),
    }) as unknown as EngineConnection;
  /** A window Diomedes opened, with no pid, so cleanup never reaches taskkill. */
  function fakeWindow() {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, unref() {} });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }
  it.skipIf(process.platform !== 'win32')(
    'reads exit 0 as a window that ended and asks the host to check again',
    async () => {
      const seen: { engine: ExternalEngine; outcome: SignInOutcome }[] = [];
      const windows: (ChildProcess & EventEmitter)[] = [];
      const login = new NativeLogin(
        root,
        () => {
          const child = fakeWindow();
          windows.push(child);
          return child;
        },
        { onFinished: (engine, outcome) => void seen.push({ engine, outcome }) },
      );
      const started = await login.start(connection('opencode'), true);
      expect(started.detail).toMatch(/checks this service again/i);
      expect(login.state('opencode')).toBe('running');
      // A second window for one engine is refused rather than opened.
      await login.start(connection('opencode'), true);
      expect(windows).toHaveLength(1);
      windows[0].emit('exit', 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The outcome names the window, not the account: nothing here says signed in.
      expect(seen).toEqual([{ engine: 'opencode', outcome: 'exited' }]);
      expect(login.state('opencode')).toBe('idle');
      expect(JSON.stringify(seen)).not.toMatch(/signed.?in|success/i);
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'reads a non-zero exit exactly as it reads exit zero',
    async () => {
      const seen: SignInOutcome[] = [];
      const windows: (ChildProcess & EventEmitter)[] = [];
      const login = new NativeLogin(
        root,
        () => {
          const child = fakeWindow();
          windows.push(child);
          return child;
        },
        { onFinished: (_engine, outcome) => void seen.push(outcome) },
      );
      await login.start(connection('claude-code'), true);
      windows[0].emit('exit', 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(seen).toEqual(['exited']);
    },
  );
  it.skipIf(process.platform !== 'win32')('names a cancelled window stopped', async () => {
    const seen: SignInOutcome[] = [];
    const login = new NativeLogin(root, () => fakeWindow(), {
      onFinished: (_engine, outcome) => void seen.push(outcome),
    });
    await login.start(connection('cursor'), true);
    const stopped = await login.stop('cursor');
    expect(stopped.detail).toMatch(/checking this service again/i);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(['stopped']);
    expect(login.state('cursor')).toBe('idle');
  });
  it('opens no window at all without consent', async () => {
    const launch = vi.fn(() => fakeWindow());
    const login = new NativeLogin(root, launch);
    await expect(login.start(connection('opencode'), false)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect(launch).not.toHaveBeenCalled();
  });
});
