import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { paragraphs } from '../client/console/diomedes-view';
import {
  artifactKindOf,
  DRAWING,
  fenceKind,
  gatePreview,
  inlineSpans,
  KIND_LABEL,
  parseBlocks,
  plainText,
  splitRow,
  startsWithSvg,
  svgRoot,
  type CodeBlock,
  type ListBlock,
  type TableBlock,
} from '../shared/turn-blocks';
import { TurnBody } from '../client/console/TurnBody';

const code = (text: string, at = 0) => {
  const block = parseBlocks(text).filter((b) => b.type === 'code')[at];
  if (!block || block.type !== 'code') throw new Error('no code block');
  return block as CodeBlock;
};
const table = (text: string) => {
  const block = parseBlocks(text).find((b) => b.type === 'table');
  if (!block) throw new Error('no table');
  return block as TableBlock;
};
const html = (props: Parameters<typeof TurnBody>[0]) => renderToStaticMarkup(createElement(TurnBody, props));

describe('paragraphs read as they always did', () => {
  it('splits plain text on blank lines exactly as paragraphs() does', () => {
    for (const text of [
      'One line.',
      'First line\nsame paragraph\n\nSecond paragraph',
      '  One  \n   \n  Two  ',
      'A\n\n\n\nB\n \t \nC',
      'Trailing space   \n\n',
      '',
      ' \n\n ',
      'Costs 4 * 5 = 20, and a # in the middle stays.',
    ]) {
      const blocks = parseBlocks(text);
      expect(blocks.every((b) => b.type === 'paragraph')).toBe(true);
      expect(blocks.map((b) => (b.type === 'paragraph' ? b.text : ''))).toEqual(paragraphs(text));
    }
  });

  it('renders a plain answer as the same <p> elements the thread drew before', () => {
    const text = 'First line\nsame paragraph\n\nSecond <b>not bold</b> & more';
    const expected = paragraphs(text)
      .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
      .join('');
    expect(html({ text })).toBe(expected);
  });

  it('treats CRLF and lone CR as newlines', () => {
    expect(parseBlocks('One\r\ntwo\r\n\r\nThree\rfour\r\rFive')).toEqual([
      { type: 'paragraph', text: 'One\ntwo' },
      { type: 'paragraph', text: 'Three\nfour' },
      { type: 'paragraph', text: 'Five' },
    ]);
    const block = code('```ts\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\n');
    expect(block.source).toBe('const a = 1;\nconst b = 2;');
    expect(block.closed).toBe(true);
  });
});

describe('fenced code blocks', () => {
  it('reads the language and the whole info string', () => {
    const block = code('```TypeScript title="a.ts" {1,3}\nlet x = 1;\n```');
    expect(block).toMatchObject({ lang: 'typescript', info: 'TypeScript title="a.ts" {1,3}', source: 'let x = 1;' });
    expect(code('```\nplain\n```')).toMatchObject({ lang: '', info: '', source: 'plain' });
    expect(code('~~~ python\nprint(1)\n~~~')).toMatchObject({ lang: 'python', source: 'print(1)' });
  });

  it('closes only on a fence of the same character at least as long', () => {
    const block = code('````md\n```js\nnested();\n```\n````\nafter');
    expect(block.lang).toBe('md');
    expect(block.source).toBe('```js\nnested();\n```');
    expect(block.closed).toBe(true);
    expect(parseBlocks('````md\n```js\nnested();\n```\n````\nafter').at(-1)).toEqual({
      type: 'paragraph',
      text: 'after',
    });
    expect(code('~~~\n```\nstill inside\n~~~').source).toBe('```\nstill inside');
    expect(code('```\n~~~\n```').source).toBe('~~~');
    expect(code('```\nx\n``` not a close\n```').source).toBe('x\n``` not a close');
  });

  it('runs an unclosed fence to the end of the text and says so', () => {
    const block = code('Before\n\n```mermaid\ngraph TD\n  A-->B');
    expect(block).toMatchObject({ lang: 'mermaid', source: 'graph TD\n  A-->B', closed: false, line: 2 });
  });

  it('keeps a fence body exactly, blank lines and markup included', () => {
    const source = '# not a heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- not a list\n  <script>x</script>';
    expect(code(`\`\`\`text\n${source}\n\`\`\``).source).toBe(source);
  });

  it('does not open a backtick fence whose info string holds a backtick', () => {
    expect(parseBlocks('```not`a fence\ntext').every((b) => b.type === 'paragraph')).toBe(true);
  });

  it('strips the opening fence indentation from its content, as CommonMark does', () => {
    expect(code('  ```\n  indented\n    deeper\nflush\n  ```').source).toBe('indented\n  deeper\nflush');
  });

  it('interrupts a paragraph and reads a fence under a list item', () => {
    const blocks = parseBlocks('Look:\n```sh\nls\n```\n- step\n\n  ```sh\n  pwd\n  ```');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'code', 'list', 'code']);
    expect((blocks[3] as CodeBlock).source).toBe('pwd');
  });
});

describe('tables', () => {
  it('reads a GFM pipe table with alignment', () => {
    expect(table('| Month | Sent | Rate |\n|:---|---:|:---:|\n| Jan | 1,204 | 4% |\n| Feb | 988 | 5% |')).toEqual({
      type: 'table',
      header: ['Month', 'Sent', 'Rate'],
      align: ['left', 'right', 'center'],
      rows: [
        ['Jan', '1,204', '4%'],
        ['Feb', '988', '5%'],
      ],
    });
  });

  it('reads tables without outer pipes, with escaped pipes and ragged rows', () => {
    const t = table('a | b\n--- | ---\n1 \\| 2 | 3\nonly\nx | y | z');
    expect(t.header).toEqual(['a', 'b']);
    expect(t.align).toEqual([null, null]);
    expect(t.rows).toEqual([
      ['1 | 2', '3'],
      ['only', ''],
      ['x', 'y'],
    ]);
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('needs a delimiter row that matches the header', () => {
    expect(parseBlocks('| a | b |\n| --- |\n| 1 | 2 |').some((b) => b.type === 'table')).toBe(false);
    expect(parseBlocks('a | b\nnot a rule\n1 | 2').some((b) => b.type === 'table')).toBe(false);
  });

  it('interrupts a paragraph and ends at a blank line', () => {
    const blocks = parseBlocks('Numbers below.\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
  });

  it('becomes an artifact only with two rows or more', () => {
    expect(artifactKindOf(table('| a |\n|---|\n| 1 |'))).toBeNull();
    expect(artifactKindOf(table('| a |\n|---|\n| 1 |\n| 2 |'))).toBe('table');
  });
});

describe('headings and lists', () => {
  it('reads ATX headings and leaves a hashtag alone', () => {
    expect(parseBlocks('# One\n### Three ###\n#hashtag\n####### seven')).toEqual([
      { type: 'heading', level: 1, text: 'One' },
      { type: 'heading', level: 3, text: 'Three' },
      { type: 'paragraph', text: '#hashtag\n####### seven' },
    ]);
  });

  it('reads nested, ordered and lazily continued lists', () => {
    const [list] = parseBlocks('3. Third\n4. Fourth\n   - child a\n   - child b\n     more of b\n5. Fifth') as ListBlock[];
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(list.items.map((i) => i.text)).toEqual(['Third', 'Fourth', 'Fifth']);
    expect(list.items[1].children[0].items.map((i) => i.text)).toEqual(['child a', 'child b\nmore of b']);
  });

  it('keeps a list across one blank line between items and ends it at a paragraph', () => {
    const blocks = parseBlocks('- a\n\n- b\n\nAfter the list.');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph']);
    expect((blocks[0] as ListBlock).items.map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('does not let a number in running text start a list', () => {
    expect(parseBlocks('We shipped in\n2024. It went well.').map((b) => b.type)).toEqual(['paragraph']);
  });
});

describe('artifact detection', () => {
  it('maps fence languages to artifact kinds and leaves everything else code', () => {
    expect(fenceKind('mermaid', 'graph TD')).toBe('diagram');
    expect(fenceKind('svg', '<svg/>')).toBe('image');
    expect(fenceKind('html', '<p>x</p>')).toBe('design');
    expect(fenceKind('markdown', '# x')).toBe('document');
    expect(fenceKind('md', '# x')).toBe('document');
    for (const lang of ['', 'ts', 'json', 'htm', 'mmd', 'xhtml']) expect(fenceKind(lang, '<svg/>')).toBeNull();
  });

  it('reads a retired ```chart fence as the code block it is, and leaves a visual to its own renderer', () => {
    const chart = '{"type":"bar","x":["a"],"series":[{"name":"n","values":[1]}]}';
    expect(fenceKind('chart', chart)).toBeNull();
    expect(fenceKind('visual', '{"kind":"bar"}')).toBeNull();
    const [block] = parseBlocks(`\`\`\`chart\n${chart}\n\`\`\``);
    expect(block).toMatchObject({ type: 'code', lang: 'chart', source: chart, closed: true });
    expect(artifactKindOf(block)).toBeNull();
    expect(Object.keys(KIND_LABEL)).not.toContain('chart');
    expect(Object.keys(DRAWING)).not.toContain('chart');
    expect(KIND_LABEL.visual).toBe('Visual');
  });

  it('treats xml as an image only when its root element is svg', () => {
    const bom = String.fromCharCode(0xfeff);
    for (const source of [
      '<svg viewBox="0 0 1 1"/>',
      `${bom}<?xml version="1.0"?>\n<!DOCTYPE svg>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg">`,
      '  <SVG>',
    ])
      expect(fenceKind('xml', source)).toBe('image');
    for (const source of ['<project/>', '<svgfoo/>', 'svg', '<?xml version="1.0"?><root/>'])
      expect(fenceKind('xml', source)).toBeNull();
    expect(startsWithSvg('<svg>')).toBe(true);
    expect(svgRoot('<?xml version="1.0"?>')).toBe('unknown');
    expect(svgRoot('<sv')).toBe('unknown');
    expect(svgRoot('<project>')).toBe('other');
  });
});

describe('inline spans', () => {
  it('reads code spans and bold as text, and nothing else', () => {
    expect(inlineSpans('Run `npm ci` then **check** <b>it</b> [link](https://x.test)')).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'code', text: 'npm ci' },
      { type: 'text', text: ' then ' },
      { type: 'strong', text: 'check' },
      { type: 'text', text: ' <b>it</b> [link](https://x.test)' },
    ]);
    expect(inlineSpans('``a ` b`` and `unclosed')).toEqual([
      { type: 'code', text: 'a ` b' },
      { type: 'text', text: ' and `unclosed' },
    ]);
    expect(plainText('**Delivery** check')).toBe('Delivery check');
  });
});

describe('the preview gate', () => {
  it('holds back an artifact fence from its opening line until the turn is saved', () => {
    expect(gatePreview('Here is the flow:\n\n```mermaid\ngraph TD\n  A-->B')).toEqual({
      text: 'Here is the flow:\n',
      pending: 'diagram',
    });
    // A retired chart fence is code, so it streams as code rather than being held back.
    expect(gatePreview('Chart:\n```chart\n{"type":')).toEqual({ text: 'Chart:\n```chart\n{"type":', pending: null });
  });

  it('holds back a last line that could still become a fence', () => {
    expect(gatePreview('Text\n``').text).toBe('Text');
    expect(gatePreview('Text\n```merm').text).toBe('Text');
    expect(gatePreview('Text\n~~~ htm').text).toBe('Text');
    // A line that plainly is not a fence shows as it arrives.
    expect(gatePreview('Text\n`npm ci` first').text).toBe('Text\n`npm ci` first');
  });

  it('streams an ordinary code block as it arrives', () => {
    expect(gatePreview('Run:\n```sh\nnpm ci\n')).toEqual({ text: 'Run:\n```sh\nnpm ci\n', pending: null });
  });

  it('decides an xml fence by its root element', () => {
    expect(gatePreview('A\n```xml\n<?xml version="1.0"?>\n')).toEqual({ text: 'A', pending: null });
    expect(gatePreview('A\n```xml\n<svg viewBox="0 0 2 2">\n')).toEqual({ text: 'A', pending: 'image' });
    expect(gatePreview('A\n```xml\n<project>\n').pending).toBeNull();
    expect(gatePreview('A\n```xml\n<project>\n').text).toContain('<project>');
  });

  it('draws a finished artifact in live text as one placeholder line, never the artifact', () => {
    const live = html({ text: 'Done:\n\n```mermaid\ngraph TD\n```\n\nMore.', preview: true });
    expect(live).toBe('<p>Done:</p><p class="art-drawing">Drawing a diagram…</p><p>More.</p>');
    const open = html({ text: 'See:\n\n```html\n<script>alert(1)</script>', preview: true });
    expect(open).toBe('<p>See:</p><p class="art-drawing" role="status">Building a design…</p>');
  });
});

describe('the turn body', () => {
  it('renders every block with text nodes only', () => {
    const out = html({
      text: '## Plan <img src=x onerror=alert(1)>\n\n- **one** `two`\n\n```html\n<script>alert(1)</script>\n```\n\n| a | b |\n|---|---|\n| <i>1</i> | 2 |',
    });
    expect(out).not.toMatch(/<script|<img|<i>/);
    expect(out).toContain('<h4 class="art-h art-h2">Plan &lt;img src=x onerror=alert(1)&gt;</h4>');
    expect(out).toContain('<strong>one</strong> <code class="art-inline-code">two</code>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('<td class="num" style="text-align:right">2</td>');
  });

  it('renders a code fence as a real code block with its own Copy', () => {
    const out = html({ text: '```ts\nconst a = 1;\n```' });
    expect(out).toBe(
      '<div class="art-code"><div class="art-code-head"><span class="art-code-lang">ts</span>' +
        '<button type="button">Copy</button></div>' +
        '<pre tabindex="0" aria-label="ts code"><code>const a = 1;</code></pre></div>',
    );
  });
});
