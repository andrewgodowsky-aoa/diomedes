import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Conversation, DocumentInfo } from '../shared/types.js';
import { BONSAI_PROFILES, type LocalModelsView } from '../shared/bonsai.js';
import { LocalModelControls } from '../client/console/LocalModelControls.js';
import { modelAttachmentProblem } from '../client/console/attachments.js';

const view: LocalModelsView = { route: 'bonsai', kind: 'local', models: BONSAI_PROFILES,
  status: { installed: true, state: 'unloaded', mode: null, owned: false, detail: 'Choose a profile to load Bonsai.' } };
const thread: Conversation = { id: 't', name: 'Local model', attachedTo: { kind: 'project', ref: 'p' }, mode: 'ask',
  engine: 'bonsai', requested: { model: 'bonsai-gaming', effort: 'xhigh', agent: 'auto' }, turns: [] };
describe('local profile controls', () => {
  it.each(['bonsai-gaming', 'bonsai-full'])('shows %s with the engine, effort, Auto and declared context', model => {
    const html = renderToStaticMarkup(createElement(LocalModelControls, { projectId: 'p', thread: { ...thread,
      requested: { model, effort: 'xhigh', agent: 'auto' } }, route: 'bonsai', mode: 'ask', busy: false, live: false,
      initialView: view, onChanged: () => {} }));
    expect(html).toContain('Nectovia'); expect(html).toContain(`value="${model}" selected=""`);
    expect(html).toContain('value="xhigh" selected="">Extra'); expect(html).toContain('Auto');
    expect(html).toContain(model === 'bonsai-gaming' ? '16,384 token context' : '131,072 token context');
    expect(html).not.toContain('Codex'); expect(html).toContain('>Load</button>');
  });
  it('uses host labels, never a model-name list in the renderer', () => {
    const changed = { ...view, models: [{ ...BONSAI_PROFILES[0], name: 'My local profile' }] };
    const html = renderToStaticMarkup(createElement(LocalModelControls, { projectId: 'p', thread, route: 'bonsai',
      mode: 'ask', busy: false, live: true, initialView: changed, onChanged: () => {} }));
    expect(html).toContain('My local profile'); expect(html).not.toContain('Bonsai Gaming');
    expect(html).toContain('aria-label="Local model" disabled=""');
  });
  it('hides an absent installation without choosing another model', () => {
    const html = renderToStaticMarkup(createElement(LocalModelControls, { projectId: 'p', thread, route: 'nectovia',
      mode: 'ask', busy: false, live: false, initialView: { ...view, status: { ...view.status, installed: false, state: 'missing' }, models: [] }, onChanged: () => {} }));
    expect(html).toBe('');
  });
  it('admits bounded images only for an image-capable profile, retaining existing text rules', () => {
    const image: Pick<DocumentInfo, 'path' | 'kind' | 'size'> = { path: 'diagram.png', kind: 'unsupported', size: 1000 };
    expect(modelAttachmentProblem(image)).toContain('not a text document');
    expect(modelAttachmentProblem(image, true)).toBeNull();
    expect(modelAttachmentProblem({ ...image, size: 4 * 1024 * 1024 + 1 }, true)).toContain('4 MB');
    expect(modelAttachmentProblem({ path: 'notes.md', kind: 'markdown', size: 1000 }, true)).toBeNull();
    expect(modelAttachmentProblem({ path: 'notes.md', kind: 'markdown', size: 128001 }, true)).toContain('128 KB');
  });
});
