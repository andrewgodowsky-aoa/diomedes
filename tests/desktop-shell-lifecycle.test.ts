import { describe, expect, it } from 'vitest';
// @ts-expect-error The desktop shell helpers are an executable JavaScript module.
import { shouldQuitWhenAllWindowsClosed, shouldReopenMainWindow } from '../desktop/app-updates.mjs';

// The platform is injected. Nothing here starts Electron, opens a window or
// observes a real macOS Dock: these are the shell's decisions, not a Mac pass.
describe('desktop shell window lifecycle decisions', () => {
  it('quits with the last window everywhere except darwin', () => {
    expect(shouldQuitWhenAllWindowsClosed('win32')).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed('linux')).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed('darwin')).toBe(false);
  });

  it('reopens a window on darwin only when none is open', () => {
    expect(shouldReopenMainWindow('darwin', 0)).toBe(true);
    expect(shouldReopenMainWindow('darwin', 1)).toBe(false);
    expect(shouldReopenMainWindow('darwin', 3)).toBe(false);
  });

  it('never reopens a window on Windows or Linux, which quit instead', () => {
    for (const platform of ['win32', 'linux']) {
      expect(shouldReopenMainWindow(platform, 0)).toBe(false);
      expect(shouldReopenMainWindow(platform, 1)).toBe(false);
    }
  });
});
