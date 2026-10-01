import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMacKeyboard, modifierName, shortcutHint } from '../client/keyboard';

// Node 22 has its own navigator, whose platform follows the host, so every case
// here names the keyboard it describes instead of inheriting the test machine's.
const read = (relative: string) => fs.readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shortcut labels follow the keyboard in front of the person', () => {
  it('reads ⌘K and Cmd on a Mac, Apple Silicon included', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    expect(isMacKeyboard()).toBe(true);
    expect(shortcutHint('K')).toBe('⌘K');
    expect(modifierName()).toBe('Cmd');
  });

  it('reads Ctrl K and Ctrl on Windows and Linux', () => {
    for (const platform of ['Win32', 'Linux x86_64']) {
      vi.stubGlobal('navigator', { platform, userAgent: '' });
      expect(isMacKeyboard(), platform).toBe(false);
      expect(shortcutHint('K'), platform).toBe('Ctrl K');
      expect(modifierName(), platform).toBe('Ctrl');
    }
  });

  it('falls back to the user agent when the platform is empty, and to Ctrl with no browser', () => {
    vi.stubGlobal('navigator', {
      platform: '',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(shortcutHint('K')).toBe('⌘K');
    vi.stubGlobal('navigator', undefined);
    expect(shortcutHint('K')).toBe('Ctrl K');
  });
});

describe('the global shortcuts answer to Cmd as well as Ctrl', () => {
  it('opens search and reaches Stop with either modifier', async () => {
    const app = await read('client/App.tsx');
    expect(app).toContain("(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'");
    expect(app).toContain("(e.ctrlKey || e.metaKey) && e.key === '.'");
    expect(app).not.toMatch(/if \(e\.ctrlKey && /);
  });

  it('names the shortcut through the keyboard helper wherever the Console hints it', async () => {
    for (const file of [
      'client/App.tsx',
      'client/console/Home.tsx',
      'client/console/TopStrip.tsx',
      'client/console/Shell.tsx',
      'client/console/PackSettings.tsx',
    ]) {
      const source = await read(file);
      // Rendered text and badge literals, not the comments that describe them.
      expect(source, file).not.toMatch(/>\s*Ctrl K\s*</);
      expect(source, file).not.toContain("'Ctrl K'");
      expect(source, file).toContain("shortcutHint('K')");
    }
    const settings = await read('client/Settings.tsx');
    expect(settings).not.toContain('Ctrl+Plus and Ctrl+Minus change interface size');
    expect(settings).toContain('{modifierName()}+Plus');
  });
});
