import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { TaskDocumentSelect } from '../client/console/TaskDocumentSelect';
import type { DocumentInfo } from '../shared/types';

const doc = (path: string, kind: DocumentInfo['kind'] = 'markdown', size = 20): DocumentInfo => ({
  path,
  kind,
  size,
  changedAt: '',
  hasChangesWaiting: false,
  recorded: true,
});
const documents = [
  doc('one/brief.md'),
  doc('two/brief.md'),
  doc('Plan.md', 'plan'),
  doc('data.csv', 'text'),
  doc('photo.png', 'unsupported'),
  doc('large.md', 'text', 128_001),
];

test('the picker uses full visible text paths, includes plans, and excludes unsupported or oversized files', () => {
  const onChange = vi.fn();
  const markup = renderToStaticMarkup(
    createElement(TaskDocumentSelect, { documents, value: 'two/brief.md', onChange }),
  );
  expect(markup).toContain('value="two/brief.md" selected=""');
  expect(markup).toContain('one/brief.md');
  expect(markup).toContain('Plan.md');
  expect(markup).toContain('data.csv');
  expect(markup).not.toContain('photo.png');
  expect(markup).not.toContain('large.md');
  expect(onChange).not.toHaveBeenCalled();
});

test('an unavailable selected file remains visible and loading failure is an error', () => {
  const missing = renderToStaticMarkup(
    createElement(TaskDocumentSelect, { documents, value: 'gone.md', onChange() {} }),
  );
  expect(missing).toContain('gone.md (unavailable)');
  expect(missing).toContain('no longer listed');
  const failed = renderToStaticMarkup(
    createElement(TaskDocumentSelect, {
      documents: [],
      value: '',
      failure: 'Listing failed',
      onChange() {},
    }),
  );
  expect(failed).toContain('disabled=""');
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('Listing failed');
});
