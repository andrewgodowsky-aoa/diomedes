import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactBody, ArtifactPane, type ArtifactPaneProps } from '../client/console/ArtifactPane';
import { indexArtifacts, type ArtifactIndex } from '../client/console/artifacts';
import { InlineVisual, VisualBoundary } from '../client/console/InlineVisual';
import { TurnBody } from '../client/console/TurnBody';

const said = (id: string, text: string) => ({ id, role: 'diomedes', text });
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
/** A declared diagram: the same id in two turns is two versions of one artifact. */
const diagram = (id: string, extra = '') =>
  fence('mermaid', `%% artifact: id=${id} title="Weekly sends"\ngraph TD\n  A-->B${extra}`);
const WEEKLY = JSON.stringify({
  kind: 'bar',
  title: 'Weekly sends',
  labels: ['Mon', 'Tue'],
  series: [{ name: 'Sent', values: [3, 4] }],
});

function pane(index: ArtifactIndex, at: number, extra: Partial<ArtifactPaneProps> = {}) {
  return renderToStaticMarkup(
    createElement(ArtifactPane, {
      record: index.list[at],
      index,
      arrived: false,
      focusToken: 0,
      width: 480,
      onWidth: () => undefined,
      onSelect: () => undefined,
      onClose: () => undefined,
      ...extra,
    }),
  );
}

/** Every element in a tree a hook-free component returned, depth first. */
function* elements(node: ReactNode): Generator<ReactElement<{ children?: ReactNode }>> {
  if (Array.isArray(node)) for (const child of node) yield* elements(child);
  else if (isValidElement<{ children?: ReactNode }>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}

describe('the artifact panel', () => {
  const versions = indexArtifacts('thread-1', [said('t1', diagram('weekly')), said('t2', diagram('weekly', '-->C'))]);

  it('is a labelled plate with its title, kind, and every control as a real button', () => {
    const html = pane(versions, 1, { onSave: async () => ({ ok: false, sentence: '' }) });
    expect(html).toMatch(/^<aside class="art-pane" aria-label="Artifact" style="width:min\(480px, 100%\)">/);
    expect(html).toContain('<div class="art-grip" role="separator" aria-orientation="vertical" aria-label="Resize the artifact panel" tabindex="0">');
    expect(html).toContain('<svg class="art-pane-lit"');
    expect(html).toContain('<div class="art-plate"><div class="art-plate-face">');
    expect(html).toContain('<span class="art-kind">Diagram</span><h2 class="art-title" tabindex="-1">Weekly sends</h2>');
    for (const label of ['Close', 'Rendered', 'Source', 'Copy source', 'Save to Files'])
      expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));
    expect(html).toContain('<button type="button" aria-pressed="true">Rendered</button>');
    expect(html).toContain('<p class="art-status" aria-live="polite"></p>');
    expect(html).not.toContain('aria-disabled="true">Save to Files');
  });

  it('steps between the versions of one declared artifact', () => {
    const last = pane(versions, 1);
    expect(last).toContain('<span class="art-version" aria-live="polite">v2 of 2</span>');
    expect(last).toContain('aria-label="Previous version">');
    expect(last).toContain('aria-label="Next version" aria-disabled="true">');
    const first = pane(versions, 0);
    expect(first).toContain('aria-label="Previous version" aria-disabled="true">');
    const alone = pane(indexArtifacts('thread-1', [said('t1', diagram('solo'))]), 0);
    expect(alone).not.toContain('art-stepper');
  });

  it('says why Save is not offered where there is no folder to save into', () => {
    const html = pane(versions, 0);
    expect(html).toContain('<button type="button" class="art-tool" aria-disabled="true">Save to Files</button>');
  });

  it('draws a visual with the turn’s own renderer, at the panel’s width, as a single version', () => {
    const index = indexArtifacts('thread-1', [said('t1', `Sends.\n\n${fence('visual', WEEKLY)}`)]);
    const html = pane(index, 0);
    expect(html).toContain('<span class="art-kind">Visual</span><h2 class="art-title" tabindex="-1">Weekly sends</h2>');
    expect(html).toContain('<div class="art-visual"><figure class="iv iv-bar"><figcaption class="iv-title">Weekly sends</figcaption>');
    expect(html).toContain('role="img" aria-label="Bar chart: Weekly sends. 2 points, Mon to Tue. Sent from 3 to 4."');
    // Drawn at the width it measured (560 before a browser measures), not scaled from 640.
    expect(html).toContain('viewBox="0 0 560 240"');
    expect(html).not.toContain('art-stepper');
    for (const label of ['Rendered', 'Source', 'Copy source', 'Save to Files'])
      expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));
  });

  it('keeps an app card live in the panel with the conversation’s run, and names a visual it cannot draw', () => {
    const index = indexArtifacts('thread-1', [said('t1', fence('visual', '{"kind":"app","key":"run-status"}'))]);
    expect(pane(index, 0)).toContain('Not available here.');
    const session: NonNullable<ArtifactPaneProps['session']> = {
      id: 'session-1',
      taskId: 'task-1',
      state: 'working',
      startedAt: '2026-09-23T09:00:00.000Z',
      endedAt: null,
      sample: false,
      log: [{ time: '2026-09-23T09:00:05.000Z', sentence: 'Reading the brief.', level: 'plain' }],
      entryIds: [],
      needId: null,
      engine: { name: 'claude-code', model: null, worker: 0, branch: null, context: null, events: 1 },
    };
    const live = pane(index, 0, { session });
    expect(live).not.toContain('Not available here.');
    expect(live).toContain('Reading the brief.');
    const broken = { ...index.list[0], source: '{"kind":"bar"}' };
    const html = pane({ ...index, list: [broken] }, 0);
    expect(html).toContain('<div class="art-error" role="group" aria-label="This visual could not be drawn.">');
    expect(html).toContain('aria-label="Source as written"');
  });

  it('draws what it shows inside a boundary, so an artifact that throws is one line, not a blank Console', () => {
    const index = indexArtifacts('thread-1', [said('t1', fence('visual', WEEKLY))]);
    const drawn = ArtifactBody({ record: index.list[0], source: false, session: null, onOpen: () => undefined });
    expect(isValidElement(drawn) && drawn.type).toBe(VisualBoundary);
    const fallback = isValidElement<{ fallback?: ReactNode }>(drawn) ? drawn.props.fallback : null;
    expect(renderToStaticMarkup(createElement('div', null, fallback))).toBe(
      '<div><p class="iv-note">This artifact could not be shown here. Its source is under Source.</p></div>',
    );
    // The source view is plain text and needs none.
    const source = ArtifactBody({ record: index.list[0], source: true, session: null, onOpen: () => undefined });
    expect([...elements(source)].some((element) => element.type === VisualBoundary)).toBe(false);
  });

  it('shows a table with a way to chart any of its number columns', () => {
    const index = indexArtifacts('thread-1', [
      said('t1', '| Region | Sent | Replies |\n|---|---|---|\n| North | 120 | 9 |\n| South | 80 | 4 |'),
    ]);
    const html = pane(index, 0);
    expect(html).toContain('<table class="art-table">');
    expect(html).toContain('<select><option value="1" selected="">Sent</option><option value="2">Replies</option></select>');
    expect(html).toContain('<button type="button" class="art-tool" aria-expanded="false">Chart this</button>');
    const words = indexArtifacts('thread-1', [said('t1', '| Name | Role |\n|---|---|\n| Ada | Lead |\n| Bo | Ops |')]);
    expect(pane(words, 0)).toContain('No column holds only numbers, so there is nothing to chart.');
  });

  it('offers Chart this only for a column that makes a valid visual', () => {
    const rows = Array.from({ length: 201 }, (_, at) => `| r${at} | ${at} |`).join('\n');
    const index = indexArtifacts('thread-1', [said('t1', `| Row | Value |\n|---|---|\n${rows}`)]);
    const html = pane(index, 0);
    expect(html).not.toContain('Chart this');
    expect(html).toContain('Nothing here can be charted: a chart draws at most 200 rows, and this column has 201.');
  });

  it('reads a document with the turn renderer and offers its own artifacts as chips', () => {
    const index = indexArtifacts('thread-1', [
      said('t1', fence('markdown', '<!-- artifact: id=runbook title="Runbook" -->\n# Steps\n\n```mermaid\ngraph TD\n  A-->B\n```')),
    ]);
    const html = pane(index, 0);
    expect(html).toContain('<h2 class="art-title" tabindex="-1">Runbook</h2>');
    expect(html).toContain('<div class="body art-document"><h3 class="art-h art-h1">Steps</h3>');
    expect(html).toContain('<span class="art-chip-kind">Diagram</span>');
    expect(html).toContain('<span class="art-chip-title">Steps</span>');
    expect(html).not.toContain('artifact: id=runbook');
  });

  it('waits for Mermaid before it shows anything of a diagram', () => {
    const index = indexArtifacts('thread-1', [said('t1', fence('mermaid', 'graph TD\n  A-->B'))]);
    expect(pane(index, 0)).toContain('<p class="art-waiting" role="status">Drawing the diagram…</p>');
  });
});

describe('chips in a turn', () => {
  const text = `## Delivery check\n\n${fence('mermaid', 'graph TD\n  A-->B')}\n\n| Day | Sent |\n|---|---|\n| Mon | 3 |\n| Tue | 4 |`;
  const index = indexArtifacts('thread-1', [said('t1', text)]);
  const body = (openKey: string | null) =>
    renderToStaticMarkup(
      createElement(TurnBody, {
        text,
        artifactAt: (block: number) => index.forBlock('t1', block),
        onOpenArtifact: () => undefined,
        openKey,
      }),
    );

  it('stand in for a fence the panel draws, and sit under a table that stays readable', () => {
    const html = body(null);
    expect(html).not.toContain('graph TD');
    expect(html).toContain(
      '<div class="art-chip-row"><span class="art-chip-plate"><svg class="art-chip-lit" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><line x1="0" y1="0" x2="10" y2="10"></line></svg><button type="button" class="art-chip"><span class="art-chip-face"><span class="art-chip-kind">Diagram</span>',
    );
    expect(html).toContain('<span class="art-chip-title">Delivery check</span>');
    expect(html).toContain('<table class="art-table">');
    expect(html).toContain('<span class="art-chip-kind">Table</span>');
    expect(html.match(/<span class="art-chip-open">Open<\/span>/g)).toHaveLength(2);
  });

  it('say which one the panel is showing', () => {
    const html = body(index.list[0].key);
    expect(html).toContain('<button type="button" class="art-chip on" aria-current="true">');
    expect(html).toContain('<span class="art-chip-open">In panel</span>');
  });
});

describe('Open in panel on an inline visual', () => {
  const text = `Sends.\n\n${fence('visual', WEEKLY)}\n\n${fence('visual', '{"kind":"stat","items":[{"label":"Sent","value":7}]}')}`;
  const index = indexArtifacts('thread-1', [said('t1', text)]);
  const turn = (props: Partial<Parameters<typeof TurnBody>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(TurnBody, {
        text,
        artifactAt: (block: number) => index.forBlock('t1', block),
        onOpenArtifact: () => undefined,
        openKey: null,
        ...props,
      }),
    );

  it('sits under every valid visual of a saved turn, named for the visual it opens', () => {
    const html = turn();
    expect(html).toContain('<figure class="iv iv-bar">');
    expect(html).toContain(
      '<div class="iv-open-row"><button type="button" class="iv-open">Open in panel<span class="art-sr">: Weekly sends</span></button></div>',
    );
    expect(html).toContain('<span class="art-sr">: Key figures</span>');
    expect(html.match(/class="iv-open"/g)).toHaveLength(2);
    // No chip: the visual is already drawn in place.
    expect(html).not.toContain('art-chip');
  });

  it('keeps a chip’s state: In panel, and aria-current, while the panel shows it', () => {
    const html = turn({ openKey: index.list[0].key });
    expect(html).toContain(
      '<button type="button" class="iv-open on" aria-current="true">In panel<span class="art-sr">: Weekly sends</span></button>',
    );
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('is never offered on a streaming preview, or where there is no panel to open', () => {
    expect(turn({ preview: true })).not.toContain('iv-open');
    expect(turn({ artifactAt: undefined })).not.toContain('iv-open');
    expect(turn({ onOpenArtifact: undefined })).not.toContain('iv-open');
  });

  it('wraps each inline visual in a boundary, so a visual that throws leaves the reply readable', () => {
    const tree = TurnBody({ text, artifactAt: (block: number) => index.forBlock('t1', block) });
    const boundaries = [...elements(tree)].filter((element) => element.type === VisualBoundary);
    expect(boundaries).toHaveLength(2);
    for (const boundary of boundaries) {
      const child = boundary.props.children;
      expect(isValidElement(child) && child.type).toBe(InlineVisual);
    }
  });
});
