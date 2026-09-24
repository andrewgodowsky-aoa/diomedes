import { expect, test } from 'vitest';
import { attachmentProblem } from '../client/console/Composer';

// An attachment travels on the one text source path every route already takes,
// so it is exactly a selected source: text within the message limit, or a
// refusal in words. Nothing wider is ever read because a file was attached.
test('text documents within the limit travel; pictures, PDFs and large files are refused in words', () => {
  expect(attachmentProblem({ path: 'brief.md', kind: 'markdown', size: 100 })).toBeNull();
  expect(attachmentProblem({ path: 'Imports/stock.csv', kind: 'text', size: 128_000 })).toBeNull();
  expect(attachmentProblem({ path: 'plans/next.md', kind: 'plan', size: 10 })).toBeNull();
  expect(attachmentProblem({ path: 'Imports/photo.png', kind: 'unsupported', size: 70 })).toBe(
    'photo.png is not a text document, so a message cannot carry it to an engine. It stays in Files; remove it to send.',
  );
  expect(attachmentProblem({ path: 'drawing.svg', kind: 'drawing', size: 70 })).toContain('not a text document');
  expect(attachmentProblem({ path: 'big.txt', kind: 'text', size: 128_001 })).toContain('128 KB');
});
