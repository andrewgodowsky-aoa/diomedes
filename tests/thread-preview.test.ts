import { describe, expect, it } from 'vitest';
import { previewLine } from '../shared/thread-preview';

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe('the thread list preview', () => {
  it('never shows a fence raw: a turn that opens with a diagram reads as its kind and title', () => {
    const text = fence(
      'mermaid',
      '%% artifact: id=delivery-flow title="Delivery check"\ngraph TD\n  A-->B',
    );
    expect(previewLine(text, 60)).toBe('Diagram: Delivery check');
  });

  it('finds the first heading or paragraph anywhere, even after an artifact fence', () => {
    const text = `${fence('mermaid', 'graph TD\n  A-->B')}\n\nHere is the flow.`;
    expect(previewLine(text, 60)).toBe('Here is the flow.');
  });

  it('reads a heading or paragraph as plain words: bold markers gone, a bare link untouched', () => {
    expect(previewLine('# Weekly volume', 60)).toBe('Weekly volume');
    expect(previewLine('Check **this** out: https://example.com/path', 60)).toBe(
      'Check this out: https://example.com/path',
    );
  });

  it('skips a heading with no text and reads the next block', () => {
    expect(previewLine('#\n\nReal content here.', 60)).toBe('Real content here.');
  });

  it('names a visual by its own title, or the generic "Chart"', () => {
    const titled = fence(
      'visual',
      '{"kind":"bar","title":"Weekly sales","labels":["a"],"series":[{"name":"n","values":[1]}]}',
    );
    expect(previewLine(titled, 60)).toBe('Weekly sales');
    const untitled = fence(
      'visual',
      '{"kind":"bar","labels":["a"],"series":[{"name":"n","values":[1]}]}',
    );
    expect(previewLine(untitled, 60)).toBe('Chart');
  });

  it('reads any other fence as "Code"', () => {
    expect(previewLine(fence('ts', 'const a = 1;'), 60)).toBe('Code');
  });

  it('cuts at the limit and ends with an ellipsis, and leaves a short line alone', () => {
    const cut = previewLine('x'.repeat(80), 60);
    expect(cut).toHaveLength(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(previewLine('short', 60)).toBe('short');
  });

  it('reads nothing from an empty turn', () => {
    expect(previewLine('', 60)).toBe('');
  });
});
