import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
// @ts-expect-error The dev-server guard is an executable JavaScript module.
import { commandLinesOf, parsePsCommandLines } from '../scripts/dev-server-guard.mjs';

// The guard only kills a process whose live command line still names this
// worktree. These tests pin how that command line is read per platform, and
// that an unreadable one stays unreadable (so the holder is reported as
// foreign and refused, never killed).

type Call = { command: string; args: string[] };

function recordingSpawn(stdout: string, status = 0) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status, stdout };
  };
  return { calls, spawn };
}

const refuseProc = () => {
  throw new Error('/proc must not be read on this platform');
};

describe('parsePsCommandLines', () => {
  it('maps each pid to its full command line, keeping interior spaces', () => {
    const lines = parsePsCommandLines(
      [
        '  412 /usr/local/bin/node --import tsx /Users/a/My Projects/diomedes/server/index.ts',
        '81234 /usr/local/bin/node /Users/a/My Projects/diomedes/node_modules/vite/bin/vite.js --host 127.0.0.1',
        '',
      ].join('\n'),
    );
    expect(lines.get(412)).toBe(
      '/usr/local/bin/node --import tsx /Users/a/My Projects/diomedes/server/index.ts',
    );
    expect(lines.get(81234)).toContain('/My Projects/diomedes/node_modules/vite/bin/vite.js');
    expect(lines.size).toBe(2);
  });

  it('ignores rows that do not start with a pid', () => {
    const lines = parsePsCommandLines('  PID COMMAND\nnot-a-pid something\n   7 /bin/zsh\n');
    expect([...lines.entries()]).toEqual([[7, '/bin/zsh']]);
  });
});

describe('commandLinesOf on darwin', () => {
  it('asks ps for wide output with separate -o columns and never reads /proc', () => {
    const { calls, spawn } = recordingSpawn(' 501 /opt/homebrew/bin/node /Users/a/diomedes/scripts/dev.mjs\n');
    const lines = commandLinesOf([501, 502], { platform: 'darwin', spawn, readFile: refuseProc });
    expect(calls).toEqual([
      { command: 'ps', args: ['-ww', '-o', 'pid=', '-o', 'command=', '-p', '501,502'] },
    ]);
    expect(lines.get(501)).toBe('/opt/homebrew/bin/node /Users/a/diomedes/scripts/dev.mjs');
  });

  it('leaves a dead pid absent so its holder cannot be proved ours', () => {
    const { spawn } = recordingSpawn(' 501 /opt/homebrew/bin/node dev.mjs\n');
    const lines = commandLinesOf([501, 502], { platform: 'darwin', spawn, readFile: refuseProc });
    expect(lines.has(502)).toBe(false);
  });

  it('returns nothing when ps finds no listed pid (exit 1, empty output)', () => {
    const { spawn } = recordingSpawn('', 1);
    expect(commandLinesOf([999], { platform: 'darwin', spawn, readFile: refuseProc }).size).toBe(0);
  });

  it('returns nothing when ps cannot be run at all', () => {
    const spawn = () => ({ status: null, stdout: null, error: new Error('ENOENT') });
    expect(commandLinesOf([1], { platform: 'darwin', spawn, readFile: refuseProc }).size).toBe(0);
  });

  it('drops anything that is not a positive integer pid before building the ps argument', () => {
    const { calls, spawn } = recordingSpawn('');
    commandLinesOf([12, Number.NaN, -4, 0, 3.5, 12], { platform: 'darwin', spawn, readFile: refuseProc });
    expect(calls[0].args.at(-1)).toBe('12');
  });

  it('does not spawn anything for an empty pid list', () => {
    const { calls, spawn } = recordingSpawn('');
    expect(commandLinesOf([], { platform: 'darwin', spawn, readFile: refuseProc }).size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('commandLinesOf on linux', () => {
  it('still reads /proc and does not spawn ps', () => {
    const { calls, spawn } = recordingSpawn('');
    const readFile = (file: string) => {
      expect(file).toBe('/proc/42/cmdline');
      return 'node\0--import\0tsx\0/srv/diomedes/server/index.ts\0';
    };
    const lines = commandLinesOf([42], { platform: 'linux', spawn, readFile });
    expect(lines.get(42)).toBe('node --import tsx /srv/diomedes/server/index.ts');
    expect(calls).toEqual([]);
  });
});

// OS-exclusive: exercises the real `ps` of a Unix host. It cannot run on
// Windows, where the guard uses Win32_Process instead and `ps` is not a system
// tool. On macOS this is the only check here that touches the real platform.
describe.skipIf(process.platform === 'win32')('commandLinesOf against the real ps', () => {
  it("reads this test process's own command line", () => {
    const lines = commandLinesOf([process.pid]);
    expect(lines.get(process.pid) ?? '').toContain('node');
  });

  it('reads a child whose script path contains a space', () => {
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
