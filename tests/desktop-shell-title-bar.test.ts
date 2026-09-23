import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The desktop shell helpers are an executable JavaScript module.
import { supportsTitleBarOverlay, titleBarWindowOptions } from '../desktop/app-updates.mjs';

// The Windows overlay literal as desktop/main.mjs has always passed it. It is
// Field's own pair and the overlay a window opens with, before the stored scheme
// is read; app-updates.mjs is unchanged by the Nectovia scheme.
const WINDOWS_OVERLAY = { color: '#121417', symbolColor: '#e6e9ed', height: 40 };
// desktop/main.mjs starts Electron when it is imported, so its scheme table is
// read as text: each built-in scheme's [chrome, t1] pair for the title bar.
const shell = fs.readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

describe('desktop shell title bar options', () => {
  it('keeps the exact Windows hidden title bar and overlay', () => {
    expect(titleBarWindowOptions('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: WINDOWS_OVERLAY,
    });
    expect(titleBarWindowOptions('linux')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: WINDOWS_OVERLAY,
    });
  });

  it('uses the native traffic lights on darwin and passes no overlay', () => {
    const options = titleBarWindowOptions('darwin');
    expect(options).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(options).not.toHaveProperty('titleBarOverlay');
  });

  it('answers a fresh options object so a caller cannot mutate the next window', () => {
    const first = titleBarWindowOptions('win32');
    first.titleBarOverlay.color = '#ff0000';
    expect(titleBarWindowOptions('win32').titleBarOverlay).toEqual(WINDOWS_OVERLAY);
  });

  it('allows setTitleBarOverlay everywhere except darwin', () => {
    expect(supportsTitleBarOverlay('win32')).toBe(true);
    expect(supportsTitleBarOverlay('linux')).toBe(true);
    expect(supportsTitleBarOverlay('darwin')).toBe(false);
  });

  it('colours the title bar and the first paint from the stored scheme, Nectovia for a new install', () => {
    // Field keeps its own pair; Nectovia's is its ink chrome and silver text.
    expect(shell).toContain("field: ['#121417', '#e6e9ed'],");
    expect(shell).toContain("nectovia: ['#08080c', '#e6e9ed'],");
    // The window's first paint follows the stored scheme and falls back to ink.
    expect(shell).toMatch(/backgroundColor: await windowBackground\(\),/);
    expect(shell).toContain("return '#08080c';");
    expect(shell).not.toContain("backgroundColor: '#16191d'");
  });
});
