import { describe, expect, it } from 'vitest';
// @ts-expect-error The desktop shell helpers are an executable JavaScript module.
import { engineSetupDownloads, setupReferenceLinks } from '../desktop/app-updates.mjs';

// The pinned Windows engine artefacts desktop/main.mjs has always allowed.
const WINDOWS_DOWNLOADS = [
  'https://downloads.claude.ai/claude-code-releases/2.1.252/win32-x64/claude.exe',
  'https://github.com/anomalyco/opencode/releases/download/v1.18.4/opencode-windows-x64-baseline.zip',
  'https://github.com/can1357/oh-my-pi/releases/download/v18.0.6/omp-windows-x64.exe',
];
// The references that are not downloads and belong to every platform.
const SHARED_LINKS = [
  'https://github.com/can1357/oh-my-pi/blob/v18.0.6/docs/models.md#auth-and-api-key-resolution-order',
  'https://platform.openai.com/api-keys',
  'https://github.com/andrewgodowsky-aoa/diomedes/releases',
  'http://127.0.0.1:4400/',
];

describe('desktop shell engine setup references', () => {
  it('offers the pinned Windows artefacts on win32 only', () => {
    expect(engineSetupDownloads('win32')).toEqual(WINDOWS_DOWNLOADS);
    expect(engineSetupDownloads('darwin')).toEqual([]);
    expect(engineSetupDownloads('linux')).toEqual([]);
  });

  it('keeps the exact Windows allowlist', () => {
    expect(new Set(setupReferenceLinks('win32'))).toEqual(
      new Set([...SHARED_LINKS, ...WINDOWS_DOWNLOADS]),
    );
  });

  it('allows no downloadable artefact on darwin', () => {
    const links = setupReferenceLinks('darwin');
    expect(new Set(links)).toEqual(new Set(SHARED_LINKS));
    for (const download of WINDOWS_DOWNLOADS) expect(links).not.toContain(download);
    expect(links.filter((link: string) => /\.exe$|\.zip$/.test(link))).toEqual([]);
  });

  it('invents no macOS download in place of the Windows ones', () => {
    for (const platform of ['darwin', 'linux'])
      for (const link of setupReferenceLinks(platform)) expect(SHARED_LINKS).toContain(link);
  });

  it('answers a fresh list so a caller cannot widen the next allowlist', () => {
    const links = setupReferenceLinks('darwin');
    links.push('https://example.invalid/mac-installer.dmg');
    expect(setupReferenceLinks('darwin')).not.toContain(
      'https://example.invalid/mac-installer.dmg',
    );
  });
});
