import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import { ThreadView } from '../client/console/ThreadView';
import type { Conversation, Turn } from '../shared/types';

const at = '2026-09-10T12:00:00.000Z';
const noAction = () => {};
function renderThread(turn: Turn, pickedModel = 'new-picker-model') {
  const thread: Conversation = {
    id: 'thread-attribution',
    attachedTo: { kind: 'project', ref: 'project-attribution' },
    name: 'Historical origin',
    mode: 'ask',
    requested: { model: pickedModel, effort: 'medium' },
    turns: [turn],
  };
  return renderToStaticMarkup(createElement(ThreadView, {
    thread, title: 'Historical origin', task: null, sessions: [], mail: [], members: [],
    member: null, needs: [], settings: defaults(), mode: 'ask', route: 'codex',
    busy: false, online: true, onMode: noAction, onPermission: noAction, onRename: noAction,
    onSend: noAction, onResolve: noAction, onPreview: noAction, onStopSession: noAction,
    onOpenBoard: noAction,
  }));
}
const historicTurn: Turn = {
  id: 'historical-turn', role: 'diomedes', mode: 'ask', text: 'A saved answer.',
  at, sources: [], helper: { engine: 'codex', model: 'original-model', verified: true },
};

describe('rendered historical attribution', () => {
  it('uses saved verified metadata after the current model picker changes', () => {
    for (const picker of ['new-picker-model', 'another-picker-model']) {
      const html = renderThread(historicTurn, picker);
      expect(html).toContain('<b>original-model</b>');
      expect(html).not.toContain(`<b>${picker}</b>`);
    }
  });

  it('does not promote model prose or unverified metadata into the author', () => {
    const html = renderThread({ ...historicTurn, text: 'I am a different model.',
      helper: { engine: 'codex', model: 'unverified-name', verified: false } });
    expect(html).toContain('<b>Codex</b>');
    expect(html).not.toContain('<b>unverified-name</b>');
    expect(html).not.toContain('<b>Diomedes</b>');
  });

  it('preserves unknown historic origin instead of inventing a model', () => {
    const { helper: _helper, ...unknown } = historicTurn;
    const html = renderThread(unknown);
    expect(html).toContain('<b>Assistant</b>');
    expect(html).toContain('model not recorded');
  });

  it('renders externally supplied model names as text', () => {
    const html = renderThread({ ...historicTurn,
      helper: { engine: 'codex', model: '<img src=x onerror=alert(1)>', verified: true } });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
