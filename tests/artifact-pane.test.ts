import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactPane, type ArtifactPaneProps } from '../client/console/ArtifactPane';
import { indexArtifacts, type ArtifactIndex } from '../client/console/artifacts';
import { TurnBody } from '../client/console/TurnBody';

const said = (id: string, text: string) => ({ id, role: 'diomedes', text });
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const chart = (id: string, values: number[]) =>
  fence('chart', JSON.stringify({ type: 'bar', id, title: 'Weekly sends', x: ['Mon', 'Tue'], series: [{ name: 'Sent', values }] }));

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

describe('the artifact panel', () => {
  const versions = indexArtifacts('thread-1', [said('t1', chart('weekly', [3, 4])), said('t2', chart('weekly', [5, 6]))]);

  it('is a labelled plate with its title, kind, and every control as a real button', () => {
    const html = pane(versions, 1, { onSave: async () => ({ ok: false, sentence: '' }) });
    expect(html).toMatch(/^<aside class="art-pane" aria-label="Artifact" style="width:min\(480px, 100%\)">/);
    expect(html).toContain('<div class="art-grip" role="separator" aria-orientation="vertical" aria-label="Resize the artifact panel" tabindex="0">');
    expect(html).toContain('<svg class="art-pane-lit"');
    expect(html).toContain('<div class="art-plate"><div class="art-plate-face">');
    expect(html).toContain('<span class="art-kind">Chart</span><h2 class="art-title" tabindex="-1">Weekly sends</h2>');
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
    const alone = pane(indexArtifacts('thread-1', [said('t1', chart('solo', [1, 2]))]), 0);
    expect(alone).not.toContain('art-stepper');
  });

  it('says why Save is not offered where there is no folder to save into', () => {
    const html = pane(versions, 0);
    expect(html).toContain('<button type="button" class="art-tool" aria-disabled="true">Save to Files</button>');
  });

  it('draws the chart, and names the problem with a chart it cannot draw', () => {
    expect(pane(versions, 0)).toContain('role="img" aria-label="Bar chart: Weekly sends.');
    const broken = indexArtifacts('thread-1', [said('t1', fence('chart', '{"type":"bar","x":["a"],"series":[{"name":"n","values":[1,2]}]}'))]);
    const html = pane(broken, 0);
    expect(html).toContain('<div class="art-error" role="group" aria-label="This chart could not be drawn.">');
    expect(html).toContain('series 1 (&quot;n&quot;) has 2 values; &quot;x&quot; has 1 labels.');
    expect(html).toContain('aria-label="Source as written"');
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
