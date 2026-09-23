import { describe, expect, it } from 'vitest';
import {
  artifactKey,
  cellNumber,
  chartColumns,
  declarationOf,
  declaredSource,
  fileBelongsTo,
  fileHasArtifacts,
  indexArtifacts,
  indexFile,
  safeFileBase,
  savedDocument,
  savedExtension,
  savedIdOf,
  shortDigest,
  tableChart,
  tableSource,
  temporal,
  turnKeyOf,
  withoutDeclaration,
} from '../client/console/artifacts';
import { parseBlocks, type TableBlock } from '../client/console/turn-blocks';
import { savedPath } from '../client/console/artifact-save';

const said = (id: string, text: string) => ({ id, role: 'diomedes', text });
const asked = (id: string, text: string) => ({ id, role: 'you', text });
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const table = (text: string) => parseBlocks(text).find((block) => block.type === 'table') as TableBlock;

describe('artifact identity', () => {
  it('is a short digest of the thread, the turn and the block, and nothing else', () => {
    const key = artifactKey('thread-1', 'turn-1', 2);
    expect(key).toMatch(/^art-[0-9a-z]{11}$/);
    expect(artifactKey('thread-1', 'turn-1', 2)).toBe(key);
    expect(artifactKey('thread-2', 'turn-1', 2)).not.toBe(key);
    expect(artifactKey('thread-1', 'turn-2', 2)).not.toBe(key);
    expect(artifactKey('thread-1', 'turn-1', 3)).not.toBe(key);
    expect(shortDigest('')).toHaveLength(11);
  });

  it('reads artifacts from assistant turns only, in turn order, then block order', () => {
    const index = indexArtifacts('thread-1', [
      asked('t0', fence('mermaid', 'graph TD\n  A-->B')),
      said('t1', `One\n\n${fence('chart', '{"type":"bar","x":["a"],"series":[{"name":"n","values":[1]}]}')}\n\n${fence('mermaid', 'graph LR\n  X-->Y')}`),
      said('t2', fence('html', '<p>Hi</p>')),
    ]);
    expect(index.list.map((record) => [record.turnKey, record.blockIndex, record.kind])).toEqual([
      ['t1', 1, 'chart'],
      ['t1', 2, 'diagram'],
      ['t2', 0, 'design'],
    ]);
    for (const record of index.list) {
      expect(record.key).toBe(artifactKey('thread-1', record.turnKey, record.blockIndex));
      expect(index.forBlock(record.turnKey, record.blockIndex)).toBe(record);
      expect(index.byKey.get(record.key)).toBe(record);
    }
    expect(index.forBlock('t0', 0)).toBeUndefined();
  });

  it('names a turn without an id by its place, as older records have none', () => {
    expect(turnKeyOf({ role: 'diomedes', text: '' }, 3)).toBe('#3');
    expect(turnKeyOf({ id: 'abc', role: 'diomedes', text: '' }, 3)).toBe('abc');
    const index = indexArtifacts('thread-1', [{ role: 'diomedes', text: fence('svg', '<svg/>') }]);
    expect(index.list[0].turnKey).toBe('#0');
  });
});

describe('versions', () => {
  const first = `Here is the flow.\n\n${fence('mermaid', '%% artifact: id=delivery-flow title="Delivery check"\ngraph TD\n  A-->B')}`;
  const second = `Updated.\n\n${fence('mermaid', '%% artifact: id=delivery-flow title="Delivery check"\ngraph TD\n  A-->B-->C')}`;

  it('treats the same declared id later in the thread as the next version', () => {
    const index = indexArtifacts('thread-1', [said('t1', first), asked('t2', 'Add a step'), said('t3', second)]);
    const [one, two] = index.list;
    expect([one.version, one.versionCount, two.version, two.versionCount]).toEqual([1, 2, 2, 2]);
    expect(one.identity).toBe('id:delivery-flow');
    expect(two.identity).toBe('id:delivery-flow');
    expect(one.key).not.toBe(two.key);
    expect(index.versionsOf(one)).toEqual([one, two]);
    expect(index.versionsOf(two)).toEqual([one, two]);
    expect(two.title).toBe('Delivery check');
  });

  it('keeps an artifact that declares nothing as the only version of itself', () => {
    const body = fence('mermaid', 'graph TD\n  A-->B');
    const index = indexArtifacts('thread-1', [said('t1', body), said('t2', body)]);
    expect(index.list.map((record) => [record.version, record.versionCount])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(index.list[0].identity).toBe(index.list[0].key);
  });

  it('reads declarations for every kind and ignores ids it cannot use', () => {
    expect(declarationOf('diagram', '%% artifact: id=flow-1 title="Flow one"\ngraph TD')).toEqual({ id: 'flow-1', title: 'Flow one' });
    expect(declarationOf('design', '<!-- artifact: id=home-mock title="Home mock" -->\n<p>x</p>')).toEqual({ id: 'home-mock', title: 'Home mock' });
    expect(declarationOf('image', "  \n<!-- artifact: id=logo title='Logo' -->\n<svg/>")).toEqual({ id: 'logo', title: 'Logo' });
    expect(declarationOf('document', '<!-- artifact: id=plan.v2 -->\n# Plan')).toEqual({ id: 'plan.v2', title: null });
    expect(declarationOf('chart', '{"type":"bar","id":"sales","title":" Sales "}')).toEqual({ id: 'sales', title: 'Sales' });
    expect(declarationOf('chart', '{"type":"bar","id":"has space"}')).toEqual({ id: null, title: null });
    expect(declarationOf('chart', 'not json')).toEqual({ id: null, title: null });
    expect(declarationOf('diagram', '%% artifact: id=-bad title="T"')).toEqual({ id: null, title: 'T' });
    expect(declarationOf('diagram', 'graph TD\n%% artifact: id=late')).toEqual({ id: null, title: null });
    expect(declarationOf('table', 'anything')).toEqual({ id: null, title: null });
    expect(declarationOf('diagram', `%% artifact: title="${'x'.repeat(200)}"`).title).toHaveLength(120);
  });

  it('removes only the declaration line from what a renderer draws', () => {
    expect(withoutDeclaration('diagram', '%% artifact: id=a\ngraph TD\n  A-->B')).toBe('graph TD\n  A-->B');
    expect(withoutDeclaration('design', '<!-- artifact: id=a -->\n<p>x</p>')).toBe('<p>x</p>');
    expect(withoutDeclaration('diagram', 'graph TD\n  A-->B')).toBe('graph TD\n  A-->B');
  });
});

describe('titles', () => {
  it('uses the declared title, then the nearest heading or bold line, then a numbered kind', () => {
    const index = indexArtifacts('thread-1', [
      said(
        't1',
        [
          '## Weekly volume',
          fence('chart', '{"type":"bar","x":["a"],"series":[{"name":"n","values":[1]}]}'),
          fence('mermaid', 'graph TD\n  A-->B'),
          '**Delivery check:**',
          fence('mermaid', 'graph TD\n  C-->D'),
          fence('chart', '{"type":"bar","title":"Declared","x":["a"],"series":[{"name":"n","values":[1]}]}'),
          'Plain words.',
          fence('html', '<p>x</p>'),
        ].join('\n\n'),
      ),
    ]);
    expect(index.list.map((record) => record.title)).toEqual([
      'Weekly volume',
      // The second diagram under the same heading does not borrow it: an artifact sits between.
      'Diagram 1',
      'Delivery check',
      'Declared',
      'Design 1',
    ]);
  });
});

describe('tables', () => {
  it('become artifacts with two rows or more, and keep their own lines as source', () => {
    const text = '| Month | Sent |\n|:---|---:|\n| Jan | 1,204 |\n| Feb | 9\\|8 |';
    const [record] = indexArtifacts('thread-1', [said('t1', text)]).list;
    expect(record.kind).toBe('table');
    expect(record.table?.rows).toEqual([
      ['Jan', '1,204'],
      ['Feb', '9|8'],
    ]);
    expect(tableSource(record.table!)).toBe('| Month | Sent |\n| :--- | ---: |\n| Jan | 1,204 |\n| Feb | 9\\|8 |');
    expect(indexArtifacts('thread-1', [said('t1', '| a |\n|---|\n| 1 |')]).list).toEqual([]);
  });
});

describe('files', () => {
  it('reads a Markdown file like a turn and an HTML file as one design', () => {
    const md = indexFile('Saved artifacts/Flow.md', `# Flow\n\n${fence('mermaid', 'graph TD\n  A-->B')}`);
    expect(md.scope).toBe('file:Saved artifacts/Flow.md');
    expect(md.list.map((record) => [record.kind, record.title])).toEqual([['diagram', 'Flow']]);
    const html = indexFile('mocks/Home page.html', '<!doctype html><p>Hi</p>');
    expect(html.list.map((record) => [record.kind, record.title, record.source])).toEqual([
      ['design', 'Home page', '<!doctype html><p>Hi</p>'],
    ]);
    expect(fileHasArtifacts('notes.md', 'Just words.')).toBe(false);
    expect(fileHasArtifacts('notes.md', fence('mermaid', 'graph TD'))).toBe(true);
    expect(fileHasArtifacts('notes.txt', fence('mermaid', 'graph TD'))).toBe(false);
    expect(fileHasArtifacts('page.html', '<p>x</p>')).toBe(true);
  });
});

describe('saving', () => {
  const thread = (text: string) => indexArtifacts('thread-1', [said('t1', text)]).list[0];

  it('makes a file name every platform accepts', () => {
    expect(safeFileBase('Q3: plan/review?', 'Chart')).toBe('Q3 plan review');
    expect(safeFileBase('  trailing dots... ', 'Chart')).toBe('trailing dots');
    expect(safeFileBase('CON', 'Diagram')).toBe('Diagram');
    expect(safeFileBase('***', 'Diagram')).toBe('Diagram');
    expect(safeFileBase('x'.repeat(200), 'Diagram')).toHaveLength(80);
    expect(savedPath('Flow', 1, '.md')).toBe('Saved artifacts/Flow.md');
    expect(savedPath('Flow', 3, '.md')).toBe('Saved artifacts/Flow 3.md');
  });

  it('saves a design as a page and everything else as titled Markdown holding the fence', () => {
    const design = thread(fence('html', '<!-- artifact: id=mock -->\n<p>x</p>'));
    expect(savedExtension(design.kind)).toBe('.html');
    expect(savedDocument(design, design.title)).toBe('<!-- artifact: id=mock -->\n<p>x</p>\n');
    const image = thread(`## Logo\n\n${fence('xml', '<svg viewBox="0 0 1 1"/>')}`);
    expect(savedExtension(image.kind)).toBe('.md');
    expect(savedDocument(image, image.title)).toBe(
      `# Logo\n\n\`\`\`svg\n<!-- artifact: id=${image.key} title="Logo" -->\n<svg viewBox="0 0 1 1"/>\n\`\`\`\n`,
    );
    const doc = thread(fence('md', 'Run:\n```sh\nnpm ci\n```'));
    expect(savedDocument(doc, 'Runbook')).toContain('````md\n');
  });

  it('declares an identity on what it saves, so a later save finds its own file', () => {
    const diagram = thread(fence('mermaid', 'graph TD\n  A-->B'));
    expect(savedIdOf(diagram)).toBe(diagram.key);
    expect(declaredSource(diagram, 'Flow "one"')).toBe(`%% artifact: id=${diagram.key} title="Flow 'one'"\ngraph TD\n  A-->B`);
    const chart = thread(fence('chart', '{"type":"bar","x":["a"],"series":[{"name":"n","values":[1]}]}'));
    expect(JSON.parse(declaredSource(chart, 'Sales'))).toEqual({
      id: chart.key,
      title: 'Sales',
      type: 'bar',
      x: ['a'],
      series: [{ name: 'n', values: [1] }],
    });
    const declared = thread(fence('mermaid', '%% artifact: id=flow\ngraph TD'));
    expect(declaredSource(declared, 'Anything')).toBe('%% artifact: id=flow\ngraph TD');

    const path = 'Saved artifacts/Flow.md';
    const saved = savedDocument(diagram, 'Flow');
    const reread = indexFile(path, saved).list[0];
    expect([reread.kind, reread.declaredId, reread.title]).toEqual(['diagram', diagram.key, 'Flow']);
    expect(withoutDeclaration('diagram', reread.source)).toBe(diagram.source);
    expect(fileBelongsTo(path, saved, diagram)).toBe(true);
    // Another artifact (another turn, so another key) saved under the same name is not this one's file.
    const other = indexArtifacts('thread-1', [said('t9', fence('mermaid', 'graph LR'))]).list[0];
    expect(other.key).not.toBe(diagram.key);
    expect(fileBelongsTo(path, savedDocument(other, 'Flow'), diagram)).toBe(false);
    expect(fileBelongsTo(path, '# Notes\n\nNo artifacts here.', diagram)).toBe(false);
  });
});

describe('charting a table', () => {
  it('reads numbers the way tables write them', () => {
    expect(cellNumber('1,234')).toBe(1234);
    expect(cellNumber('$12.50')).toBe(12.5);
    expect(cellNumber('45%')).toBe(45);
    expect(cellNumber('-3')).toBe(-3);
    expect(cellNumber('1 200')).toBe(1200);
    expect(cellNumber('€5')).toBe(5);
    expect(cellNumber('')).toBeNull();
    expect(cellNumber('12a')).toBeNull();
    expect(cellNumber('n/a')).toBeNull();
  });

  it('knows a sequence in time when it sees one', () => {
    expect(temporal(['2024', '2025'])).toBe(true);
    expect(temporal(['Jan', 'Feb', 'March'])).toBe(true);
    expect(temporal(['Q1 2025', 'Q2 2025'])).toBe(true);
    expect(temporal(['2025-01', '2025-02'])).toBe(true);
    expect(temporal(['Mon', 'Tue'])).toBe(true);
    expect(temporal(['North', 'South'])).toBe(false);
    expect(temporal(['2024'])).toBe(false);
  });

  it('draws bars across row labels, a line across time, and says which cells had no number', () => {
    const regions = table('| Region | Sent | Replies |\n|---|---|---|\n| North | 120 | 9 |\n| South | 80 | n/a |');
    expect(chartColumns(regions)).toEqual({
      category: 0,
      numeric: [{ index: 1, name: 'Sent' }],
    });
    expect(tableChart(regions, 1)).toEqual({
      type: 'bar',
      title: 'Sent by Region',
      x: ['North', 'South'],
      series: [{ name: 'Sent', values: [120, 80] }],
    });
    expect(tableChart(regions, 2)).toMatchObject({
      series: [{ name: 'Replies', values: [9, 0] }],
      caption: '1 row has no number in Replies and is drawn at 0.',
    });
    const months = table('| Month | Sent |\n|---|---|\n| Jan | 5 |\n| Feb | 7 |');
    expect(tableChart(months, 1).type).toBe('line');
    const idsFirst = table('| Id | Name | Score |\n|---|---|---|\n| 17 | Ada | 3 |\n| 42 | Bo | 5 |');
    expect(chartColumns(idsFirst).category).toBe(1);
  });
});
