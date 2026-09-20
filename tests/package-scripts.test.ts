import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
// @ts-expect-error The desktop packaging entry is an executable JavaScript module.
import { targetFromArgs } from '../scripts/package-desktop.mjs';

// Compiling the source and packaging a desktop app are separate commands. When
// packaging ran as `postbuild`, a plain `npm run build` on a Mac exited non-zero
// after tsc and Vite had both succeeded, because the host-default target is
// darwin/arm64 and that target refuses without its prerequisites. These tests
// keep the two apart without weakening any of the packager's refusals.

const scripts: Record<string, string> = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).scripts;

const PACKAGER = 'scripts/package-desktop.mjs';

describe('build and packaging are separate commands', () => {
  it('build compiles and does not package', () => {
    expect(scripts.build).toBe('tsc --noEmit && vite build');
    expect(scripts.build).not.toContain(PACKAGER);
  });

  it('has no lifecycle hook that packages behind a build', () => {
    expect(scripts.prebuild).toBeUndefined();
    expect(scripts.postbuild).toBeUndefined();
  });

  it.each([
    ['package:desktop', []],
    ['package:windows', ['--platform win32', '--arch x64']],
    ['package:mac', ['--platform darwin', '--arch arm64']],
  ])('%s builds, then runs the packager exactly once', (name, flags) => {
    const script = scripts[name];
    expect(script, `${name} is missing`).toBeTypeOf('string');
    expect(script.startsWith('npm run build && ')).toBe(true);
    expect(script.split(PACKAGER).length - 1).toBe(1);
    for (const flag of flags) expect(script).toContain(flag);
    // Windows certificate stores are why the packager has always run this way.
    expect(script).toContain('node --use-system-ca');
  });

  it('no package command names a package command, so none can recurse', () => {
    for (const [name, script] of Object.entries(scripts))
      if (name.startsWith('package:')) expect(script).not.toMatch(/npm run package:/);
  });

  it('the host-default command passes no target, leaving the choice to the packager', () => {
    expect(scripts['package:desktop']).not.toContain('--platform');
    expect(scripts['package:desktop']).not.toContain('--arch');
  });
});

describe('targetFromArgs', () => {
  it('returns nothing for no arguments, so environment and host defaults still apply', () => {
    expect(targetFromArgs([])).toEqual({});
  });

  it('reads an explicit target', () => {
    expect(targetFromArgs(['--platform', 'darwin', '--arch', 'arm64'])).toEqual({
      platform: 'darwin',
      arch: 'arm64',
    });
  });

  it('keeps operating system and architecture independent', () => {
    expect(targetFromArgs(['--arch', 'x64'])).toEqual({ arch: 'x64' });
    expect(targetFromArgs(['--platform', 'win32'])).toEqual({ platform: 'win32' });
  });

  it('refuses an unknown flag instead of packaging the wrong target quietly', () => {
    expect(() => targetFromArgs(['--plaform', 'darwin'])).toThrow(/Unknown argument: --plaform/);
  });

  it('refuses a flag with no value', () => {
    expect(() => targetFromArgs(['--platform'])).toThrow(/--platform needs a value/);
    expect(() => targetFromArgs(['--platform', '--arch', 'x64'])).toThrow(/--platform needs a value/);
  });
});
