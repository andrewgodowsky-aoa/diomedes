import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
let stage: string;
beforeAll(async () => {
  stage = await fs.mkdtemp(path.join(root, '.desktop-stage-native-auth-'));
  const { buildDesktopAuth } = await import(
    new URL('../scripts/build-desktop-auth.mjs', import.meta.url).href
  );
  await buildDesktopAuth(root, stage);
});
afterAll(async () => {
  if (!stage) return;
  const relative = path.relative(root, path.resolve(stage));
  if (!relative.startsWith('.desktop-stage-native-auth-') || relative.includes(path.sep))
    throw new Error('Unexpected cleanup path.');
  await fs.rm(stage, { recursive: true, force: true });
});

it('bundles a self-contained CJS preload using only the sandbox Electron API', async () => {
  const code = await fs.readFile(path.join(stage, 'native-auth-preload.cjs'), 'utf8');
  const invoke = vi.fn(async () => ({ ok: true, data: null }));
  let bridge: Record<string, (...args: any[]) => any> | undefined;
  const required: string[] = [];
  vm.runInNewContext(code, {
    process: { contextIsolated: true },
    require(name: string) {
      required.push(name);
      if (name !== 'electron') throw new Error('Forbidden sandbox preload import: ' + name);
      return {
        contextBridge: {
          exposeInMainWorld(key: string, api: typeof bridge) {
            expect(key).toBe('__authkit_electron');
            bridge = api;
          },
        },
        ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
      };
    },
  });
  expect(required).toEqual(['electron']);
  expect(Object.keys(bridge!)).not.toContain('invoke');
  expect(Object.keys(bridge!)).not.toContain('send');
  await bridge!.signIn();
  expect(invoke).toHaveBeenCalledWith('authkit:sign-in', undefined);
  expect(code).not.toMatch(/refreshToken|safeStorage|client_secret|WORKOS_API_KEY/);
});

it('bundles the SDK main module without runtime npm package imports', async () => {
  const code = await fs.readFile(path.join(stage, 'native-auth.mjs'), 'utf8');
  const imports = [
    ...code.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  expect(imports.some((name) => name?.startsWith('@workos/') || name === 'electron-store')).toBe(
    false,
  );
  expect(code).toContain('createRequire');
  expect(code).toContain('createNativeAuth');
});

it('preserves the shell security settings and accounts for both auth bundles in packaging', async () => {
  const main = await fs.readFile(path.join(root, 'desktop/main.mjs'), 'utf8');
  expect(main).toMatch(/nodeIntegration:\s*false/);
  expect(main).toMatch(/contextIsolation:\s*true/);
  expect(main).toMatch(/sandbox:\s*true/);
  expect(main).toContain('native-auth-preload.cjs');
  expect(main).toContain('setWindowOpenHandler');
  expect(main).toContain("return { action: 'deny' }");
  expect(main).toContain('setPermissionRequestHandler');
  expect(main).toContain('app.requestSingleInstanceLock()');
  const packaging = await fs.readFile(path.join(root, 'scripts/package-desktop.mjs'), 'utf8');
  expect(packaging).toContain('await buildDesktopAuth(root, stage)');
  expect(packaging.match(/scripts\/build-desktop-auth\.mjs/g)).toHaveLength(2);
});
