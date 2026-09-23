import { describe, expect, it } from 'vitest';
import {
  artifactKey,
  cellNumber,
  chartColumns,
  declarationOf,
  declarationTitle,
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
  tableSource,
  tableVisual,
  temporal,
  turnKeyOf,
  visualOf,
  visualTitle,
  withoutDeclaration,
} from '../client/console/artifacts';
import { parseBlocks, type TableBlock } from '../client/console/turn-blocks';
import { savedPath } from '../client/console/artifact-save';
import { parseVisualSpec, VISUAL_MAX_PER_REPLY } from '../shared/visual-spec';

const said = (id: string, text: string) => ({ id, role: 'diomedes', text });
const asked = (id: string, text: string) => ({ id, role: 'you', text });
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const table = (text: string) => parseBlocks(text).find((block) => block.type === 'table') as TableBlock;
const BAR = '{"kind":"bar","labels":["a"],"series":[{"name":"n","values":[1]}]}';
const bar = (title?: string) =>
  JSON.stringify({ kind: 'bar', ...(title ? { title } : {}), labels: ['a'], series: [{ name: 'n', values: [1] }] });

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
      said('t1', `One\n\n${fence('visual', BAR)}\n\n${fence('mermaid', 'graph LR\n  X-->Y')}`),
      said('t2', fence('html', '<p>Hi</p>')),
    ]);
    expect(index.list.map((record) => [record.turnKey, record.blockIndex, record.kind])).toEqual([
      ['t1', 1, 'visual'],
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
    // A visual's strict spec has no id field, so nothing it holds is read as one.
    expect(declarationOf('visual', '{"kind":"bar","id":"sales","title":"Sales"}')).toEqual({ id: null, title: null });
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
          fence('mermaid', 'graph TD\n  Z-->Y'),
          fence('mermaid', 'graph TD\n  A-->B'),
          '**Delivery check:**',
          fence('mermaid', 'graph TD\n  C-->D'),
          'Plain words.',
          fence('html', '<p>x</p>'),
        ].join('\n\n'),
      ),
    ]);
    expect(index.list.map((record) => record.title)).toEqual([
      'Weekly volume',
      // The second diagram under the same heading does not borrow it: an artifact sits between.
      'Diagram 2',
      'Delivery check',
      'Design 1',
    ]);
  });

  it('names a visual by its own title, or else by its kind, and never borrows a heading', () => {
    const index = indexArtifacts('thread-1', [
      said(
        't1',
        [
          '## Weekly volume',
          fence('visual', bar()),
          fence('mermaid', 'graph TD\n  A-->B'),
          fence('visual', bar('Declared')),
          fence('visual', '{"kind":"progress","label":"Packing","value":0.5}'),
          fence('visual', '{"kind":"app","key":"update-progress"}'),
          fence('visual', '{"kind":"stat","items":[{"label":"Sent","value":3}]}'),
        ].join('\n\n'),
      ),
    ]);
    expect(index.list.map((record) => [record.kind, record.title])).toEqual([
      ['visual', 'Bar chart'],
      // A visual is drawn where it stands, so the heading above it is not the diagram's.
      ['diagram', 'Diagram 1'],
      ['visual', 'Declared'],
      ['visual', 'Progress'],
      ['visual', 'App update'],
      ['visual', 'Key figures'],
    ]);
    const run = parseVisualSpec({ kind: 'app', key: 'run-status' });
    expect(run.ok && visualTitle(run.spec)).toBe('Run status');
  });
});

describe('visuals as artifacts', () => {
  it('indexes a visual exactly when its turn draws one: closed, valid and within the reply limit', () => {
    const visuals = Array.from({ length: VISUAL_MAX_PER_REPLY + 1 }, (_, at) => fence('visual', bar(`Chart ${at + 1}`)));
    const index = indexArtifacts('thread-1', [said('t1', visuals.join('\n\n'))]);
    expect(index.list).toHaveLength(VISUAL_MAX_PER_REPLY);
    expect(index.list.map((record) => record.title).at(-1)).toBe(`Chart ${VISUAL_MAX_PER_REPLY}`);
    for (const record of index.list) {
      expect([record.kind, record.lang, record.declaredId, record.version, record.versionCount]).toEqual([
        'visual',
        'visual',
        null,
        1,
        1,
      ]);
      expect(record.identity).toBe(record.key);
      expect(visualOf(record.source).ok).toBe(true);
    }
    // An invalid visual and one never closed are notes, not artifacts, but they count toward the limit.
    const broken = indexArtifacts('thread-1', [
      said('t1', [fence('visual', '{"kind":"bar"}'), ...visuals.slice(0, VISUAL_MAX_PER_REPLY)].join('\n\n')),
      said('t2', `Done.\n\n\`\`\`visual\n${BAR}`),
    ]);
    expect(broken.list).toHaveLength(VISUAL_MAX_PER_REPLY - 1);
    expect(broken.list.every((record) => record.turnKey === 't1')).toBe(true);
  });

  it('reads a retired ```chart fence as an ordinary code block: no artifact, no record', () => {
    const chart = fence('chart', '{"type":"bar","id":"sales","x":["a"],"series":[{"name":"n","values":[1]}]}');
    expect(indexArtifacts('thread-1', [said('t1', `Sales.\n\n${chart}`)]).list).toEqual([]);
    expect(fileHasArtifacts('Saved artifacts/Sales.md', `# Sales\n\n${chart}\n`)).toBe(false);
  });

  it('reads a visual with every limit a reply applies, and says why one cannot be drawn', () => {
    expect(visualOf(BAR)).toMatchObject({ ok: true, spec: { kind: 'bar' } });
    expect(visualOf('{"kind":"bar","id":"x","labels":["a"],"series":[{"name":"n","values":[1]}]}')).toEqual({
      ok: false,
      reason: 'has a field it does not take (id)',
    });
    expect(visualOf('not json')).toEqual({ ok: false, reason: 'the block is not valid JSON' });
    expect(visualOf(`{"kind":"bar","pad":"${'x'.repeat(40_000)}"}`)).toEqual({ ok: false, reason: 'the block is too large' });
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

  it('reads a .json file as one visual only when it holds a valid visual spec', () => {
    const titled = indexFile('Saved artifacts/Sales.json', `${bar('Weekly sales')}\n`);
    expect(titled.list.map((record) => [record.kind, record.title, record.lang])).toEqual([
      ['visual', 'Weekly sales', 'visual'],
    ]);
    expect(indexFile('charts/Q3 numbers.json', BAR).list[0].title).toBe('Q3 numbers');
    expect(fileHasArtifacts('Saved artifacts/Sales.json', BAR)).toBe(true);
    for (const text of ['{"name":"diomedes","version":"0.1.6"}', '{"kind":"bar"}', 'not json', '[]'])
      expect(fileHasArtifacts('package.json', text), text).toBe(false);
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

  it('saves a visual as its JSON source in a .json file, and knows that file again by its content', () => {
    const source = bar('Weekly sales');
    const visual = thread(`## Numbers\n\n${fence('visual', source)}`);
    expect(visual.kind).toBe('visual');
    expect(savedExtension(visual.kind)).toBe('.json');
    // Nothing is added to the spec: it is strict, and an id field would make it invalid.
    expect(declaredSource(visual, 'Anything')).toBe(source);
    const saved = savedDocument(visual, visual.title);
    expect(saved).toBe(`${source}\n`);
    expect(JSON.parse(saved)).toEqual(JSON.parse(source));
    const path = 'Saved artifacts/Weekly sales.json';
    const reread = indexFile(path, saved).list[0];
    expect([reread.kind, reread.title]).toEqual(['visual', 'Weekly sales']);
    expect(fileBelongsTo(path, saved, visual)).toBe(true);
    // Another visual saved under the same name is not this one's file.
    const other = thread(fence('visual', bar('Weekly sales, again')));
    expect(fileBelongsTo(path, savedDocument(other, other.title), visual)).toBe(false);
    expect(fileBelongsTo(path, '{"name":"x"}', visual)).toBe(false);
  });

  it('keeps a declaration line whole, whatever the title says', () => {
    expect(declarationTitle('Plan --> next')).toBe('Plan -> next');
    expect(declarationTitle('a <!-- b --- c "d"\ne')).toBe("a <!- b - c 'd''e");
    const design = thread(fence('html', '<p>x</p>'));
    const saved = savedDocument(design, 'Plan --> next <!-- again');
    const [first, ...rest] = saved.split('\n');
    // One comment, opened once and closed once, at the end of its own line.
    expect(first).toBe(`<!-- artifact: id=${design.key} title="Plan -> next <!- again" -->`);
    expect(first.match(/-->/g)).toHaveLength(1);
    expect(first.match(/<!--/g)).toHaveLength(1);
    expect(rest.join('\n')).toBe('<p>x</p>\n');
    expect(indexFile('Saved artifacts/Plan.html', saved).list[0].title).toBe('Plan -> next <!- again');
    // An SVG's comment may hold no "--" at all (XML), so nothing of the title adds one.
    const image = thread(fence('svg', '<svg viewBox="0 0 1 1"/>'));
    const svg = declaredSource(image, 'Sign -- final');
    const comment = /^<!--([\s\S]*?)-->/.exec(svg)![1];
    expect(comment).not.toContain('--');
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

  it('draws a visual spec: bars across row labels, a line across ordered periods', () => {
    const regions = table('| Region | Sent | Replies |\n|---|---|---|\n| North | 120 | 9 |\n| South | 80 | n/a |');
    expect(chartColumns(regions)).toEqual({
      category: 0,
      numeric: [{ index: 1, name: 'Sent' }],
    });
    const sent = tableVisual(regions, 1);
    expect(sent).toEqual({
      ok: true,
      spec: { kind: 'bar', title: 'Sent by Region', labels: ['North', 'South'], series: [{ name: 'Sent', values: [120, 80] }] },
      caption: null,
    });
    // What it draws is a spec a reply could hold: it passes the same parser.
    expect(sent.ok && parseVisualSpec(sent.spec)).toEqual({ ok: true, spec: sent.ok && sent.spec });
    // A column holding a word is not a column of numbers, so it is never charted as one.
    expect(tableVisual(regions, 2)).toEqual({ ok: false, reason: 'this column does not hold only numbers' });
    const months = table('| Month | Sent |\n|---|---|\n| Jan | 5 |\n| Feb | 7 |');
    expect(tableVisual(months, 1)).toMatchObject({ ok: true, spec: { kind: 'line', labels: ['Jan', 'Feb'] } });
    const idsFirst = table('| Id | Name | Score |\n|---|---|---|\n| 17 | Ada | 3 |\n| 42 | Bo | 5 |');
    expect(chartColumns(idsFirst).category).toBe(1);
  });

  it('leaves out a row with no number and says so, rather than drawing a 0 the table never held', () => {
    const gaps = table('| Region | Sent |\n|---|---|\n| North | 120 |\n| South |  |\n| East | 40 |\n| West |  |');
    const drawn = tableVisual(gaps, 1);
    expect(drawn).toMatchObject({
      ok: true,
      spec: { labels: ['North', 'East'], series: [{ name: 'Sent', values: [120, 40] }] },
      caption: '2 rows have no number in Sent and are left out.',
    });
    const one = tableVisual(table('| Region | Sent |\n|---|---|\n| North | 120 |\n| South |  |'), 1);
    expect(one.ok && one.caption).toBe('1 row has no number in Sent and is left out.');
  });

  it('keeps every label inside the spec’s limits, and offers nothing past its row limit', () => {
    const long = 'L'.repeat(90);
    const wide = table(`| **${long}** | ${'N'.repeat(90)} |\n|---|---|\n| ${long} | 1 |\n| \`b\` | 2 |\n|  | 3 |`);
    const drawn = tableVisual(wide, 1);
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.spec.labels.map((label) => label.length)).toEqual([60, 1, 5]);
    expect(drawn.spec.labels[0].endsWith('…')).toBe(true);
    expect(drawn.spec.labels.slice(1)).toEqual(['b', 'Row 3']);
    expect(drawn.spec.series[0].name).toHaveLength(60);
    expect(drawn.spec.title!.length).toBeLessThanOrEqual(120);
    const rows = Array.from({ length: 201 }, (_, at) => `| r${at} | ${at} |`).join('\n');
    expect(tableVisual(table(`| Row | Value |\n|---|---|\n${rows}`), 1)).toEqual({
      ok: false,
      reason: 'a chart draws at most 200 rows, and this column has 201',
    });
  });
});
