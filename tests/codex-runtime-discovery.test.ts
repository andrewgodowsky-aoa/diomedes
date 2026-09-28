import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireCodexProtocol, resolveCodexRuntime } from '../server/engines/codex-runtime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'));
  roots.push(root);
  const options = { dataRoot: root, home: root, platform: 'win32' as const, env: { LOCALAPPDATA: root, PATH: '' } as NodeJS.ProcessEnv };
  const place = (folder: string) => {
    fs.mkdirSync(folder, { recursive: true });
    const executable = path.join(folder, 'codex.exe');
    fs.writeFileSync(executable, 'fixture');
    return executable;
  };
  return { root, options, place };
}
describe('current installed Codex selection', () => {
  it('uses the newest installed desktop build instead of the bundled snapshot', () => {
    const { root, options, place } = fixture();
    const old = place(path.join(root, 'OpenAI', 'Codex', 'bin', 'ffff-old'));
    fs.utimesSync(old, 1, 1);
    const current = place(path.join(root, 'OpenAI', 'Codex', 'bin', '0000-new'));
    place(path.join(root, 'native-runtime'));
    expect(resolveCodexRuntime(options)).toMatchObject({ executable: current, source: 'installed' });
  });
  it('does not replace an explicit runtime, even when it is missing', () => {
    const { root, options, place } = fixture();
    place(path.join(root, 'OpenAI', 'Codex', 'bin', 'new'));
    options.env.DIOMEDES_RUNTIME_DIR = path.join(root, 'selected');
    expect(resolveCodexRuntime(options)).toMatchObject({ executable: path.join(root, 'selected', 'codex.exe'), source: 'explicit' });
  });
  it.each(['codex-command-runner.exe', 'codex-windows-sandbox-setup.exe',
    'codex-app-server.exe', 'codex-code-mode-host.exe'])('detects a new installation and changed %s without restarting the app', (helper) => {
    const { root, options, place } = fixture();
    place(path.join(root, 'native-runtime'));
    const bundled = resolveCodexRuntime(options);
    const folder = path.join(root, 'OpenAI', 'Codex', 'bin', 'next');
    place(folder);
    const installed = resolveCodexRuntime(options);
    expect(installed.identity).not.toBe(bundled.identity);
    fs.writeFileSync(path.join(folder, helper), 'new-helper');
    expect(resolveCodexRuntime(options).identity).not.toBe(installed.identity);
  });
  it('retains the bundled fallback when no owned engine is installed', () => {
    const { root, options } = fixture();
    options.env.DIOMEDES_BUNDLED_RUNTIME_DIR = path.join(root, 'resources', 'native-runtime');
    expect(resolveCodexRuntime(options)).toMatchObject({ source: 'bundled', executable: path.join(root, 'resources', 'native-runtime', 'codex.exe') });
  });
  it('keeps metadata-only changes stable but detects changed bytes even at the same size and modification time', () => {
    const { root, options, place } = fixture();
    const executable = place(path.join(root, 'OpenAI', 'Codex', 'bin', 'current'));
    const original = resolveCodexRuntime(options).identity;
    fs.utimesSync(executable, 100, 100);
    expect(resolveCodexRuntime(options).identity).toBe(original);
    fs.writeFileSync(executable, 'changed');
    fs.utimesSync(executable, 100, 100);
    expect(resolveCodexRuntime(options).identity).not.toBe(original);
  });
});

describe('Codex protocol capability boundary', () => {
  // Required request fields from the experimental app-server protocol. Version
  // strings are deliberately absent: supported fields determine admission.
  const schemas = () => Object.fromEntries(Object.entries({
    ThreadStartParams: ['cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'modelProvider', 'config', 'environments', 'runtimeWorkspaceRoots', 'selectedCapabilityRoots', 'dynamicTools', 'allowProviderModelFallback'],
    ThreadResumeParams: ['threadId', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'modelProvider', 'config', 'runtimeWorkspaceRoots'],
    ThreadForkParams: ['threadId', 'cwd', 'sandbox', 'approvalPolicy', 'modelProvider', 'config', 'runtimeWorkspaceRoots'],
    TurnStartParams: ['threadId', 'input', 'cwd', 'approvalPolicy', 'sandboxPolicy', 'environments', 'runtimeWorkspaceRoots', 'effort', 'summary'],
  }).map(([name, fields]) => [name, { properties: Object.fromEntries(fields.map(field => [field, {}])) }]));
  it('accepts a runtime that describes the isolation and dispatch capabilities', () => {
    expect(() => requireCodexProtocol(schemas())).not.toThrow();
  });
  it.each([
    ['ThreadStartParams', 'allowProviderModelFallback'],
    ['ThreadResumeParams', 'runtimeWorkspaceRoots'],
    ['ThreadForkParams', 'approvalPolicy'],
    ['TurnStartParams', 'sandboxPolicy'],
  ])('refuses a runtime missing %s.%s before dispatch', (schema, field) => {
    const current = schemas();
    delete current[schema].properties[field];
    expect(() => requireCodexProtocol(current)).toThrow(field);
  });
});
