import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  commandLinesOf,
  ownsProcess,
  parsePsCommandLine,
  signatureMatches,
  // @ts-expect-error The dev-server guard is an executable JavaScript module.
} from '../scripts/dev-server-guard.mjs';

// The guard only signals a process whose live command line still names this
// worktree. These tests pin how that command line is read per platform, and
// that an unreadable one stays unreadable (so the holder is reported as
// foreign and refused, never killed).

type Call = { command: string; args: string[] };

/** A fake `ps` that answers per queried pid, like the real one asked about one pid. */
function fakePs(table: Record<number, string>) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    const pid = Number(args.at(-1));
    const stdout = table[pid];
    return stdout === undefined ? { status: 1, stdout: '' } : { status: 0, stdout };
  };
  return { calls, spawn };
}

const refuseProc = () => {
  throw new Error('/proc must not be read on this platform');
};

describe('parsePsCommandLine', () => {
  it('returns the full command line, keeping interior spaces', () => {
    expect(
      parsePsCommandLine(
        '  412 /usr/local/bin/node --import tsx /Users/a/My Projects/diomedes/server/index.ts\n',
        412,
      ),
    ).toBe('/usr/local/bin/node --import tsx /Users/a/My Projects/diomedes/server/index.ts');
  });

  it('refuses output whose pid is not the one that was asked about', () => {
    expect(parsePsCommandLine('  413 /bin/zsh\n', 412)).toBeNull();
  });

  it('refuses a header, an empty answer and a row that does not start with a pid', () => {
    expect(parsePsCommandLine('  PID COMMAND\n', 1)).toBeNull();
    expect(parsePsCommandLine('', 1)).toBeNull();
    expect(parsePsCommandLine(undefined, 1)).toBeNull();
    expect(parsePsCommandLine('not-a-pid something\n', 1)).toBeNull();
  });

  it('treats later lines as the same process, so a newline in argv cannot forge another row', () => {
    // ps prints argv verbatim. This process was started with a script argument
    // that contains a line shaped exactly like a row for pid 501.
    const line = parsePsCommandLine(
      ' 777 /usr/bin/node -e console.log(1)\n  501 /Users/a/diomedes/scripts/dev.mjs\n',
      777,
    );
    expect(line).toBe('/usr/bin/node -e console.log(1) 501 /Users/a/diomedes/scripts/dev.mjs');
    // And asked about 501, that same output is not an answer about 501.
    expect(
      parsePsCommandLine(
        ' 777 /usr/bin/node -e console.log(1)\n  501 /Users/a/diomedes/scripts/dev.mjs\n',
        501,
      ),
    ).toBeNull();
  });
});

describe('commandLinesOf on darwin', () => {
  it('asks ps about one pid at a time, wide, with separate -o columns, and never reads /proc', () => {
    const { calls, spawn } = fakePs({
      501: ' 501 /opt/homebrew/bin/node /Users/a/diomedes/scripts/dev.mjs\n',
      502: ' 502 /opt/homebrew/bin/node /Users/a/diomedes/server/index.ts\n',
    });
    const lines = commandLinesOf([501, 502], { platform: 'darwin', spawn, readFile: refuseProc });
    expect(calls).toEqual([
      { command: 'ps', args: ['-ww', '-o', 'pid=', '-o', 'command=', '-p', '501'] },
      { command: 'ps', args: ['-ww', '-o', 'pid=', '-o', 'command=', '-p', '502'] },
    ]);
    expect(lines.get(501)).toBe('/opt/homebrew/bin/node /Users/a/diomedes/scripts/dev.mjs');
    expect(lines.get(502)).toBe('/opt/homebrew/bin/node /Users/a/diomedes/server/index.ts');
  });

  it('cannot be given a forged row for one pid by another process', () => {
    const { spawn } = fakePs({
      501: ' 501 (node)\n',
      777: ' 777 /usr/bin/node -e x\n  501 /Users/a/diomedes/scripts/dev.mjs\n',
    });
    const lines = commandLinesOf([501, 777], { platform: 'darwin', spawn, readFile: refuseProc });
    // 501's own answer stands: ps could not read its argv and printed its name.
    expect(lines.get(501)).toBe('(node)');
  });

  it('leaves a dead pid absent so its holder cannot be proved ours', () => {
    const { spawn } = fakePs({ 501: ' 501 /opt/homebrew/bin/node dev.mjs\n' });
    const lines = commandLinesOf([501, 502], { platform: 'darwin', spawn, readFile: refuseProc });
    expect(lines.has(502)).toBe(false);
  });

  it('returns nothing when ps cannot be run at all', () => {
    const spawn = () => ({ status: null, stdout: null, error: new Error('ENOENT') });
    expect(commandLinesOf([1], { platform: 'darwin', spawn, readFile: refuseProc }).size).toBe(0);
  });

  it('drops anything that is not a positive integer pid, and asks about each pid once', () => {
    const { calls, spawn } = fakePs({});
    commandLinesOf([12, Number.NaN, -4, 0, 3.5, 12], { platform: 'darwin', spawn, readFile: refuseProc });
    expect(calls.map((call) => call.args.at(-1))).toEqual(['12']);
  });

  it('does not spawn anything for an empty pid list', () => {
    const { calls, spawn } = fakePs({});
    expect(commandLinesOf([], { platform: 'darwin', spawn, readFile: refuseProc }).size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('commandLinesOf on linux', () => {
  it('still reads /proc and does not spawn ps', () => {
    const { calls, spawn } = fakePs({});
    const readFile = (file: string) => {
      expect(file).toBe('/proc/42/cmdline');
      return 'node\0--import\0tsx\0/srv/diomedes/server/index.ts\0';
    };
    const lines = commandLinesOf([42], { platform: 'linux', spawn, readFile });
    expect(lines.get(42)).toBe('node --import tsx /srv/diomedes/server/index.ts');
    expect(calls).toEqual([]);
  });
});

describe('signatureMatches', () => {
  it('folds case on Windows, where paths are case-insensitive', () => {
    expect(signatureMatches('node F:\\Dio\\scripts\\dev.mjs', 'f:\\dio\\scripts\\DEV.mjs', 'win32')).toBe(true);
  });

  it('is exact elsewhere, so two worktrees that differ only by case stay distinct', () => {
    const signature = '/Users/a/Dev/dio/scripts/dev.mjs';
    expect(signatureMatches(`node ${signature}`, signature, 'darwin')).toBe(true);
    expect(signatureMatches('node /Users/a/dev/dio/scripts/dev.mjs', signature, 'darwin')).toBe(false);
    expect(signatureMatches('node /users/a/dev/dio/scripts/dev.mjs', signature, 'linux')).toBe(false);
  });

  it('never matches an empty signature or an unreadable command line', () => {
    expect(signatureMatches('node /x/dev.mjs', '', 'darwin')).toBe(false);
    expect(signatureMatches('node /x/dev.mjs', undefined, 'darwin')).toBe(false);
    expect(signatureMatches('', '/x/dev.mjs', 'darwin')).toBe(false);
    expect(signatureMatches(undefined, '/x/dev.mjs', 'win32')).toBe(false);
    expect(signatureMatches('(node)', '/x/dev.mjs', 'darwin')).toBe(false);
  });

  it('does not confuse a sibling worktree whose name extends this one', () => {
    expect(
      signatureMatches('node /a/dio-2/scripts/dev.mjs', '/a/dio/scripts/dev.mjs', 'darwin'),
    ).toBe(false);
  });
});

describe('ownsProcess re-reads the process immediately before a signal', () => {
  const entry = { pid: 501, signature: '/Users/a/diomedes/server/index.ts' };

  it('is true while the live command line still carries the signature', () => {
    const { spawn } = fakePs({ 501: ' 501 /opt/homebrew/bin/node --import tsx /Users/a/diomedes/server/index.ts\n' });
    expect(ownsProcess(entry, { platform: 'darwin', spawn, readFile: refuseProc })).toBe(true);
  });

  it('is false once the pid has been reused by something else', () => {
    const { spawn } = fakePs({ 501: ' 501 /Applications/Safari.app/Contents/MacOS/Safari\n' });
    expect(ownsProcess(entry, { platform: 'darwin', spawn, readFile: refuseProc })).toBe(false);
  });

  it('is false once the process is gone, and for an entry with no signature', () => {
    const { spawn } = fakePs({});
    expect(ownsProcess(entry, { platform: 'darwin', spawn, readFile: refuseProc })).toBe(false);
    const live = fakePs({ 7: ' 7 /bin/zsh\n' });
    expect(ownsProcess({ pid: 7 }, { platform: 'darwin', spawn: live.spawn, readFile: refuseProc })).toBe(false);
  });
});

// OS-exclusive: reads the real process table of a Unix host, through `ps` on
// macOS and through /proc on Linux. It cannot run on Windows, where the guard
// uses Win32_Process and `ps` is not a system tool. On macOS this is the only
// check in this file that touches the real `ps`.
describe.skipIf(process.platform === 'win32')('commandLinesOf against the real process table', () => {
  it("reads this test process's own command line", () => {
    const lines = commandLinesOf([process.pid]);
    expect(lines.get(process.pid) ?? '').toContain('node');
  });

  it('reads a child whose arguments contain a space', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const {commandLinesOf}=await import(process.argv[1]);const l=commandLinesOf([process.pid]);console.log(l.get(process.pid)??'');",
        new URL('../scripts/dev-server-guard.mjs', import.meta.url).href,
        'marker with space',
      ],
      { encoding: 'utf8' },
    );
    expect(child.stdout).toContain('marker with space');
  });
});
