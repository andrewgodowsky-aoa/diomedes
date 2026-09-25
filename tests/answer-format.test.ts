/**
 * The answer format and the one composer of a conversation's instructions (server/answer-format.ts).
 * What the format tells a model is held to what the Console actually reads and draws: the fences
 * and declarations of shared/turn-blocks.ts and shared/artifacts.ts, and the Mermaid pre-check in
 * client/console/mermaid-render.ts.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ARTIFACT_FORMAT, answerInstructions } from '../server/answer-format';
import { DECISION_FORMAT, splitDecision } from '../server/interaction-turn';
import { MODES, VISUAL_INSTRUCTIONS } from '../server/modes';
import { declarationOf, DECLARED_ID, indexArtifacts } from '../shared/artifacts';
import { fenceKind } from '../shared/turn-blocks';
import { REFUSED_IMAGE, REFUSED_MATH_MARKUP, refusal } from '../client/console/mermaid-render';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { TextEngineAdapter } from '../server/engines/contract';
import { routeContractFor } from '../server/harness/route-contract';

describe('the composed conversation instructions', () => {
  test('Ask and Plan are their own text, then the answer format', () => {
    for (const mode of ['ask', 'plan'] as const)
      expect(answerInstructions(mode)).toBe(`${MODES[mode].instructions}\n\n${ARTIFACT_FORMAT}`);
  });

  test('Automatic is its own text, the visual instructions, the answer format, and the decision format last', () => {
    expect(answerInstructions('auto')).toBe(
      `${MODES.auto.instructions}\n\n${VISUAL_INSTRUCTIONS}\n\n${ARTIFACT_FORMAT}\n\n${DECISION_FORMAT}`,
    );
    expect(MODES.auto.instructions).not.toContain(VISUAL_INSTRUCTIONS);
  });

  test('an artifact written before the decision block stays in the answer the person reads', () => {
    const answer = [
      'Here is the flow.',
      '```mermaid',
      '%% artifact: id=delivery-flow title="Delivery check"',
      'graph TD',
      'A --> B',
      '```',
      '```diomedes-decision',
      '{"source_message_id":"sm.00000000000000000000000000000000"}',
      '```',
    ].join('\n');
    const { answerText } = splitDecision(answer, 'sm.00000000000000000000000000000000', 'automatic', 'Show me');
    expect(answerText).toContain('%% artifact: id=delivery-flow');
    expect(indexArtifacts('thread', [{ id: 'a1', role: 'assistant', text: answerText }]).list).toEqual([
      expect.objectContaining({ kind: 'diagram', declaredId: 'delivery-flow', title: 'Delivery check' }),
    ]);
  });

  test('the text has no carriage return and the format never mentions a decision block', () => {
    for (const mode of ['ask', 'plan', 'auto'] as const) expect(answerInstructions(mode)).not.toContain('\r');
    expect(ARTIFACT_FORMAT).not.toContain('diomedes-decision');
  });
});

describe('what the format tells a model is what the Console reads', () => {
  const mermaidExample = /%% artifact: [^\n]*?"Delivery check"/.exec(ARTIFACT_FORMAT)![0];
  const commentExample = /<!-- artifact: [^>]*-->/.exec(ARTIFACT_FORMAT)![0];

  test('its two example declarations are read by the parser as written', () => {
    expect(declarationOf('diagram', `${mermaidExample}\ngraph TD\nA --> B`)).toEqual({ id: 'delivery-flow', title: 'Delivery check' });
    for (const kind of ['image', 'design', 'document'] as const)
      expect(declarationOf(kind, `${commentExample}\n<p>x</p>`)).toEqual({ id: 'home-mock', title: 'Home mock' });
    expect(DECLARED_ID.test('delivery-flow')).toBe(true);
    expect(ARTIFACT_FORMAT).toContain('up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit');
    expect(ARTIFACT_FORMAT).toContain('at most 120 characters');
  });

  test('each fence it names becomes an artifact', () => {
    expect(ARTIFACT_FORMAT).toContain('fenced as mermaid, svg, html or markdown');
    expect(fenceKind('mermaid', 'graph TD')).toBe('diagram');
    expect(fenceKind('svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe('image');
    expect(fenceKind('html', '<p>x</p>')).toBe('design');
    expect(fenceKind('markdown', '# x')).toBe('document');
  });

  test('a diagram written by its Mermaid rules is drawn, and one that breaks them is refused', () => {
    // The rules, as the model reads them: math within one line, < as \lt, a data:image picture.
    expect(ARTIFACT_FORMAT).toContain('$$...$$ within one line');
    expect(ARTIFACT_FORMAT).toContain('no < (write \\lt) or ~ anywhere and no & or \\ outside the math');
    expect(ARTIFACT_FORMAT).toContain('a math row break is \\\\\\\\');
    expect(ARTIFACT_FORMAT).toContain('A@{ img: "data:image/png;base64,..." } (PNG, JPEG, GIF or WebP)');
    expect(ARTIFACT_FORMAT).toContain('under 50,000 characters');
    const onBuilt = { math: true };
    expect(refusal('graph TD\nA["$$x \\lt 1$$"] --> B', onBuilt)).toBeNull();
    expect(refusal('graph TD\nA["$$x < 1$$"] --> B', onBuilt)).toBe(REFUSED_MATH_MARKUP);
    expect(refusal('graph TD\nA["$$\\begin{matrix} a \\\\\\\\ b \\end{matrix}$$"] --> B', onBuilt)).toBeNull();
    expect(refusal('flowchart TD\nA@{ img: "data:image/png;base64,iVBORw0KGgo=" }', onBuilt)).toBeNull();
    expect(refusal('flowchart TD\nA@{ img: "https://example.com/a.png" }', onBuilt)).toBe(REFUSED_IMAGE);
  });
});

describe('the ask route', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture() {
    const engine = 'claude-code' as const;
    const version = TESTED_VERSIONS[engine];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-answer-format-'));
    const generate = vi.fn<TextEngineAdapter['generate']>(async (input) => ({
      projectId: input.projectId,
      threadId: input.threadId,
      requestId: input.requestId,
      model: input.model,
      text: input.prompt.includes('STRICT JSON')
        ? JSON.stringify({ summary: 'Proposed text', changes: [{ path: 'Note.md', text: 'Reviewed text', summary: 'Create note' }] })
        : 'A drafted answer',
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
        contract: routeContractFor(engine),
        inspect: async () => ({
          authentication: 'signed-in',
          accountRoute: 'claude-code:claude.ai',
          models: [{ slug: 'sonnet', name: 'Sonnet', description: '', efforts: [], defaultEffort: null }],
          detail: 'Checked',
        }),
        generate,
      }),
    });
    const app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'), engineService: service });
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
    expect((await api('/ai/discover', 'POST', { consent: true })).status).toBe(200);
    expect((await api(`/ai/check/${engine}`, 'POST', {})).status).toBe(200);
    expect((await api('/ai/select', 'POST', { engine, model: 'sonnet' })).status).toBe(200);
    const created = (await api('/projects', 'POST', { name: 'Cafe' })).data;
    expect(
      (
        await api(`/projects/${created.id}/cloud-sharing`, 'PUT', {
          expectedVersion: 0, routes: ['claude-code'], documents: [], shareConversationHistory: false, shareReviewPackets: false,
        })
      ).status,
    ).toBe(200);
    const thread = (await api(`/projects/${created.id}/threads`, 'POST', {})).data;
    return { api, generate, projectId: created.id as string, threadId: thread.id as string };
  }

  test('sends an Ask or Plan answer with the answer format, and a Build proposal with its own text alone', async () => {
    const { api, generate, projectId, threadId } = await fixture();
    const ask = (mode: string, text: string) =>
      api(`/projects/${projectId}/ask`, 'POST', { text, mode, route: 'claude-code', threadId, consent: true });
    expect((await ask('ask', 'What is on the menu?')).status).toBe(200);
    // The mode's text with the answer format first, then the rule path's section (shipped product
    // knowledge here; this project has no instruction files).
    const sent = (mode: 'ask' | 'plan') => {
      const instructions = String(generate.mock.calls.at(-1)![0].instructions);
      expect(instructions.startsWith(`${answerInstructions(mode)}

`)).toBe(true);
      expect(instructions).toContain('--- BEGIN DIOMEDES PRODUCT KNOWLEDGE ---');
    };
    sent('ask');
    expect((await ask('plan', 'Plan the week')).status).toBe(200);
    sent('plan');

    const calls = generate.mock.calls.length;
    expect((await ask('build', 'Create a note')).status).toBe(200);
    for (let n = 0; n < 200 && generate.mock.calls.length === calls; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    const build = generate.mock.calls.at(-1)![0];
    expect(build.prompt).toContain('STRICT JSON');
    expect(build.instructions).toBe(MODES.build.instructions);
    expect(build.instructions).not.toContain(ARTIFACT_FORMAT);
  });
});
