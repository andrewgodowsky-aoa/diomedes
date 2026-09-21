import { describe, expect, it } from 'vitest';
// @ts-expect-error The desktop shell helpers are an executable JavaScript module.
import { supportsTitleBarOverlay, titleBarWindowOptions } from '../desktop/app-updates.mjs';

// The Windows overlay literal as desktop/main.mjs has always passed it.
const WINDOWS_OVERLAY = { color: '#121417', symbolColor: '#e6e9ed', height: 40 };

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
});
