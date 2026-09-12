import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { EngineInstaller } from '../server/engines/install.js';
import { loginCommand } from '../server/engines/login.js';
import type { TextEngineAdapter } from '../server/engines/contract.js';
import type { ExternalEngine, ProjectState } from '../shared/types.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIConnections } from '../client/AISetup.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(engine: ExternalEngine = 'claude-code') {
  const version = TESTED_VERSIONS[engine];
  const accountRoute = engine === 'cursor' ? 'cursor:cursor-account' : 'claude-code:claude.ai';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-ai-api-'));
  const generate = vi.fn<TextEngineAdapter['generate']>(async (input) => ({
    ...input,
    text: input.prompt.includes('STRICT JSON')
      ? JSON.stringify({
          summary: 'Proposed text',
          changes: [{ path: 'Note.md', text: 'Reviewed text', summary: 'Create note' }],
        })
      : 'A reasoned answer',
    version,
  }));
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: engine,
        name: 'Claude Code',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Found',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: version,
        location: 'fixture.exe',
        disclosure: [],
      },
    ],
    version: async () => version,
    adapter: () => ({
      id: engine,
      inspect: async () => ({
        authentication: 'signed-in',
        accountRoute,
        models: [
          {
            slug: 'sonnet',
            name: 'Sonnet',
            description: '',
            efforts: [],
            defaultEffort: null,
          },
        ],
        detail: 'Checked',
      }),
      generate,
    }),
  });
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
  });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cleanups.push(async () => {
    await app.locals.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const api = async (endpoint: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { api, app, generate };
}
async function connected(
  api: Awaited<ReturnType<typeof fixture>>['api'],
  engine: ExternalEngine = 'claude-code',
) {
  expect((await api('/ai/discover', 'POST', { consent: true })).status).toBe(200);
  expect((await api(`/ai/check/${engine}`, 'POST', {})).status).toBe(200);
  const chosen = await api('/ai/select', 'POST', { engine, model: 'sonnet' });
  expect(chosen.status).toBe(200);
  return chosen.data;
}
describe('first-run AI setup and the existing Work pipeline', () => {
  it('keeps a clean profile conservative, requires discovery consent, and preserves explicit upgrade choices', async () => {
    const { api, generate } = await fixture();
    const initial = (await api('/settings')).data;
    expect(initial.surface).toBe('console');
    expect(initial.permissions.changingFiles).toBe(true);
    const markup = renderToStaticMarkup(
      createElement(AIConnections, { settings: initial, save: async () => {} }),
    );
    expect(markup.match(/<section class="service"/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="Cursor"');
    expect(
      (await api('/ai/status')).data.connections.map((c: { engine: string }) => c.engine),
    ).toEqual(['claude-code', 'opencode', 'oh-my-pi', 'cursor']);
    expect(
      (await api('/ai/status')).data.connections.every(
        (c: { installation: string }) => c.installation === 'not-checked',
      ),
    ).toBe(true);
    expect((await api('/ai/discover', 'POST', {})).status).toBe(409);
    await api('/settings', 'PUT', {
      permissions: { changingFiles: false },
      onboarding: {
        familiarity: 'comfortable',
        resumeAt: 'done',
        completedAt: '2026-09-09T00:00:00Z',
      },
      services: { codex: true, codexModel: 'existing' },
    });
    const selected = await connected(api);
    expect(selected.permissions.changingFiles).toBe(false);
    expect(selected.services.codexModel).toBe('existing');
    expect(selected.onboarding.resumeAt).toBe('done');
    expect(generate).not.toHaveBeenCalled();
  });
  it('offers native Cursor login and manual installation without downloading anything', async () => {
    const { api } = await fixture();
    const offer = await api('/ai/install/cursor');
    expect(offer.status).toBe(200);
    expect(offer.data).toMatchObject({
      engine: 'cursor',
      available: false,
      source: 'https://cursor.com',
    });
    expect(offer.data.detail).toContain('Install Cursor from cursor.com');
    expect((await api('/ai/install/cursor', 'POST', { consent: true })).status).toBe(503);
    expect(loginCommand('cursor')).toEqual(['login']);
    const download = vi.fn<typeof fetch>();
    const installer = new EngineInstaller('unused', { fetch: download });
    await expect(installer.install('cursor', true)).rejects.toMatchObject({
      code: 'INSTALL_UNSUPPORTED',
    });
    expect(download).not.toHaveBeenCalled();
  });
  it.each(['claude-code', 'cursor'] as const)(
    'requires separate inference consent and retains %s on its thread',
    async (engine) => {
      const { api, generate } = await fixture(engine);
      await connected(api, engine);
      const project = (await api('/projects', 'POST', { name: 'Test' })).data;
      const thread = (await api(`/projects/${project.id}/threads`, 'POST', {})).data;
      const body = {
        text: 'Question',
        mode: 'ask',
        route: engine,
        threadId: thread.id,
      };
      expect((await api(`/projects/${project.id}/ask`, 'POST', body)).status).toBe(409);
      const answer = await api(`/projects/${project.id}/ask`, 'POST', {
        ...body,
        consent: true,
      });
      expect(answer.status).toBe(200);
      expect(answer.data.turn).toMatchObject({
        text: 'A reasoned answer',
        route: engine,
        helper: { engine, model: 'sonnet' },
      });
      expect(generate.mock.calls[0][0]).toMatchObject({
        projectId: project.id,
        threadId: thread.id,
        model: 'sonnet',
        accountRoute: engine === 'cursor' ? 'cursor:cursor-account' : 'claude-code:claude.ai',
      });
    },
  );
  it.each(['claude-code', 'cursor'] as const)(
    'keeps %s Plan read-only and Work proposals behind exact approval and History',
    async (engine) => {
      const { api } = await fixture(engine);
      await connected(api, engine);
      const project = (await api('/projects', 'POST', { name: 'Proposals' })).data;
      const thread = (await api(`/projects/${project.id}/threads`, 'POST', {})).data;
      const target = `/projects/${project.id}`;
      const plan = await api(`${target}/ask`, 'POST', {
        text: 'Plan a note',
        mode: 'plan',
        route: engine,
        threadId: thread.id,
        consent: true,
      });
      expect(plan.status).toBe(200);
      expect(plan.data.document).toBeUndefined();
      expect((await api(`${target}/documents`)).data.documents).toHaveLength(0);
      const start = await api(`${target}/ask`, 'POST', {
        text: 'Create a note',
        mode: 'build',
        route: engine,
        threadId: thread.id,
        consent: true,
      });
      expect(start.status).toBe(200);
      let state: ProjectState = (await api(`${target}/state`)).data;
      for (let n = 0; n < 100 && !state.needs.some((need) => need.state === 'open'); n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = (await api(`${target}/state`)).data;
      }
      const need = state.needs.find((need) => need.state === 'open')!;
      expect(need?.preview?.[0].after).toBe('Reviewed text');
      expect((await api(`${target}/documents`)).data.documents).toHaveLength(0);
      const result = await api(`${target}/needs/${need.id}/resolve`, 'POST', {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        resolution: 'go-ahead',
        allowForTask: false,
        proposalDigest: need.approval!.proposalDigest,
        actionDigest: need.approval!.actionDigest,
        baseDigest: need.approval!.baseDigest,
      });
      expect(result.status).toBe(200);
      const documents = (await api(`${target}/documents`)).data.documents;
      expect(documents).toHaveLength(1);
      expect(documents[0].path).toBe('Note.md');
      const final: ProjectState = (await api(`${target}/state`)).data;
      expect(
        final.history.filter((entry) =>
          entry.files.some((file) => file.path === 'Note.md' && file.after !== null),
        ),
      ).toHaveLength(1);
    },
  );
});
