/**
 * The send dialog states what one message may read, and offers the whole-project choice only
 * where Diomedes checks each read before it runs: Ask and Plan on Claude Code.
 */
import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendConfirmation } from '../client/console/SendConfirmation';
import type { Mode, Route } from '../shared/types';

const render = (route: Route, mode: Mode, readAccess?: 'selected' | 'project', offer = true) =>
  renderToStaticMarkup(
    createElement(SendConfirmation, {
      kind: 'message',
      instruction: 'What sells best?',
      route,
      sources: ['menu.md'],
      mode,
      ...(readAccess ? { readAccess } : {}),
      ...(offer ? { onReadAccess: () => {} } : {}),
      onClose: () => {},
      onSend: () => {},
    }),
  );

test('selected documents are the default, and the sentence names only them', () => {
  const html = render('claude-code', 'ask');
  expect(html).toContain('Let Claude Code look through the project folder for this message');
  expect(html).not.toContain('checked');
  expect(html).toContain('Documents included: menu.md.');
  expect(html).not.toContain('list the project folder and read');
});

test('choosing the whole project says so in the same sentence', () => {
  const html = render('claude-code', 'plan', 'project');
  expect(html).toContain('checked');
  expect(html).toContain(
    'Documents included: menu.md. For this message Claude Code may also list the project folder and read any other file this project shares with it.',
  );
});

test('no route that cannot check reads first, and no Work mode, is offered the choice', () => {
  for (const [route, mode] of [
    ['codex', 'ask'],
    ['opencode', 'plan'],
    ['cursor', 'ask'],
    ['claude-code', 'build'],
    ['claude-code', 'fix'],
  ] as const) {
    const html = render(route, mode, 'project');
    expect(html).not.toContain('look through the project folder');
    // A stale choice is never disclosed as if it applied.
    expect(html).not.toContain('list the project folder');
  }
  // A dialog that is not given the control (a task send) never shows it.
  expect(render('claude-code', 'ask', 'project', false)).not.toContain('look through the project folder');
});
