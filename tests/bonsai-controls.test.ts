import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Conversation, DocumentInfo } from '../shared/types.js';
import { localModelCatalog, parseLocalModelDescriptor, type LocalModelsView } from '../shared/local-model.js';
import { LocalModelControls } from '../client/console/LocalModelControls.js';
import { modelAttachmentProblem } from '../client/console/attachments.js';
import { BONSAI_DESCRIPTOR, BONSAI_FOLDER, MEADOW_FOLDER, meadowDescriptor } from './fixtures/local-model.js';

const descriptor = parseLocalModelDescriptor(meadowDescriptor(), MEADOW_FOLDER);
const view: LocalModelsView = { route: 'bonsai', kind: 'local', name: 'Meadow Local', folder: { path: MEADOW_FOLDER, source: 'settings' },
  models: localModelCatalog(descriptor, null),
  status: { installed: true, state: 'unloaded', mode: null, owned: false, detail: "Meadow Local isn't running." } };
const thread: Conversation = { id: 't', name: 'Local model', attachedTo: { kind: 'project', ref: 'p' }, mode: 'ask',
  engine: 'bonsai', requested: { model: 'local:quick', effort: 'xhigh', agent: 'auto' }, turns: [] };
const render = (overrides: Partial<Parameters<typeof LocalModelControls>[0]> = {}) =>
  renderToStaticMarkup(createElement(LocalModelControls, { projectId: 'p', thread, route: 'bonsai', mode: 'ask', busy: false,
    live: false, initialView: view, onChanged: () => {}, ...overrides }));

describe('local profile controls', () => {
  it.each(['local:quick', 'local:deep'])('shows %s with the engine, effort, Auto and declared context', model => {
    const html = render({ thread: { ...thread, requested: { model, effort: 'xhigh', agent: 'auto' } } });
    expect(html).toContain('Nectovia'); expect(html).toContain(`value="${model}" selected=""`);
    expect(html).toContain('value="xhigh" selected="">Extra'); expect(html).toContain('Auto');
    expect(html).toContain(model === 'local:quick' ? '16,384 token context' : '131,072 token context');
    expect(html).toContain(model === 'local:quick' ? '>meadow-9b Quick</option>' : '>meadow-9b Deep</option>');
    expect(html).not.toContain('Codex'); expect(html).toContain('>Start</button>');
  });
  it('shows a profile saved under its earlier slug as the profile it was', () => {
    const earlier = { ...view, models: localModelCatalog(parseLocalModelDescriptor(BONSAI_DESCRIPTOR, BONSAI_FOLDER), null) };
    const html = render({ initialView: earlier, thread: { ...thread, requested: { model: 'bonsai-gaming', effort: 'medium', agent: 'auto' } } });
    expect(html).toContain('value="local:gaming" selected=""');
    expect(html).toContain('16,384 token context');
  });
  it('uses host labels, never a model-name list in the renderer', () => {
    const changed = { ...view, models: [{ ...view.models[0], name: 'My local profile' }] };
    const html = render({ live: true, initialView: changed });
    expect(html).toContain('My local profile'); expect(html).not.toContain('meadow-9b Quick');
    expect(html).toContain('aria-label="Local model" disabled=""');
  });
  it('hides an absent installation without choosing another model', () => {
    const html = render({ route: 'nectovia',
      initialView: { ...view, status: { ...view.status, installed: false, state: 'missing' }, models: [] } });
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
