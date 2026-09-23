import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAX_SEGMENTS, segmentModel } from '../client/console/segment-bar-model';
import { SegmentBar } from '../client/console/SegmentBar';

describe('segment bar honesty', () => {
  it('draws nothing countable when the record counted nothing', () => {
    for (const input of [
      {},
      { total: 0, done: 0 },
      { total: 4 },
      { total: Number.NaN, done: 1 },
      { total: 4, done: Number.POSITIVE_INFINITY },
      { steps: [] },
    ]) {
      const model = segmentModel(input);
      expect(model.indeterminate).toBe(true);
      expect(model.segments).toEqual([]);
      expect(model.text).toBe('Working');
    }
  });

  it('lights exactly the counted units and marks the next one active while running', () => {
    const model = segmentModel({ total: 4, done: 3, noun: 'records read' });
    expect(model.segments).toEqual(['done', 'done', 'done', 'active']);
    expect(model.text).toBe('3 of 4 records read');
  });

  it('never marks a unit active once the work has stopped moving', () => {
    expect(segmentModel({ total: 3, done: 1, running: false }).segments).toEqual([
      'done',
      'pending',
      'pending',
    ]);
  });

  it('shows the waiting and failed unit in its state colour', () => {
    expect(segmentModel({ total: 3, done: 1, blocked: true }).segments[1]).toBe('blocked');
    expect(segmentModel({ total: 3, done: 2, failed: true }).segments[2]).toBe('failed');
  });

  it('clamps a count outside the record rather than drawing past the end', () => {
    expect(segmentModel({ total: 2, done: 7 }).segments).toEqual(['done', 'done']);
    expect(segmentModel({ total: 2, done: -3 }).segments).toEqual(['active', 'pending']);
  });

  it('derives counts from named steps when the record lists them', () => {
    const model = segmentModel({
      steps: [
        { label: 'Read orders', state: 'done' },
        { label: 'Read invoices', state: 'done' },
        { label: 'Match rows', state: 'active' },
        { label: 'Write checklist', state: 'pending' },
      ],
    });
    expect(model.done).toBe(2);
    expect(model.total).toBe(4);
    expect(model.text).toBe('2 of 4 steps done');
  });

  it('groups long runs without hiding the most urgent unit', () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({
      state: index < 20 ? ('done' as const) : index === 25 ? ('blocked' as const) : ('pending' as const),
    }));
    const model = segmentModel({ steps });
    expect(model.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(model.segments).toContain('blocked');
    expect(model.total).toBe(30);
    expect(model.done).toBe(20);
  });
});

describe('segment bar fraction mode', () => {
  const bar = (props: Parameters<typeof SegmentBar>[0]) => renderToStaticMarkup(createElement(SegmentBar, props));

  it('clamps a share below 0 and above 1 to the ends of the track', () => {
    expect(segmentModel({ fraction: -0.4 })).toMatchObject({ indeterminate: false, fraction: 0, text: '0%' });
    expect(segmentModel({ fraction: 1.7 })).toMatchObject({ indeterminate: false, fraction: 1, text: '100%' });
    expect(bar({ label: 'Below', fraction: -3 })).toContain('aria-valuenow="0"');
    expect(bar({ label: 'Above', fraction: 12 })).toContain('aria-valuenow="100"');
    expect(bar({ label: 'Above', fraction: 12 })).toContain('--seg-share:1');
  });

  it('treats NaN, the infinities, null and nothing as no share at all', () => {
    for (const fraction of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined]) {
      const model = segmentModel({ fraction });
      expect(model.indeterminate).toBe(true);
      expect(model.fraction).toBeNull();
      expect(model.text).toBe('Working');
      const html = bar({ label: 'Reading', fraction });
      expect(html).not.toContain('aria-valuenow');
      expect(html).toContain('seg-scan');
      expect(html).not.toContain('seg-fill');
    }
  });

  it('reads steps first, then a whole count, then a share, then nothing', () => {
    const steps = [
      { label: 'Read', state: 'done' as const },
      { label: 'Match', state: 'active' as const },
    ];
    // Steps win over a count and a share.
    expect(segmentModel({ steps, total: 9, done: 1, fraction: 0.9 })).toMatchObject({
      fraction: null,
      done: 1,
      total: 2,
      text: '1 of 2 steps done',
    });
    // A whole count wins over a share.
    expect(segmentModel({ total: 4, done: 1, fraction: 0.9 })).toMatchObject({
      fraction: null,
      segments: ['done', 'active', 'pending', 'pending'],
      text: '1 of 4 steps done',
    });
    // A count that counted nothing gives way to the share.
    expect(segmentModel({ total: 0, done: 0, fraction: 0.25 })).toMatchObject({ fraction: 0.25, segments: [] });
    expect(segmentModel({ total: 4, fraction: 0.25 })).toMatchObject({ fraction: 0.25 });
    // Nothing at all is indeterminate.
    expect(segmentModel({ total: 4 }).indeterminate).toBe(true);
  });

  it('is a progressbar from 0 to 100 at the rounded percent', () => {
    const html = bar({ label: 'Downloading version 0.1.7', fraction: 0.456, detail: '36.5 of 80.0 MB', size: 'panel' });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Downloading version 0.1.7"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="46"');
    expect(html).toContain('aria-valuetext="46%, 36.5 of 80.0 MB"');
    // One continuous track, no segments.
    expect(html).toContain('<span class="seg-fill" aria-hidden="true" style="--seg-share:0.456"></span>');
    expect(html).not.toMatch(/class="seg (done|active|pending)/);
    expect(html).toContain('class="seg-bar panel fraction words"');
  });

  it("captions a share in the source's own words and never invents a k of n", () => {
    const withDetail = bar({ label: 'Counted', fraction: 0.4, detail: '40 of 100 items' });
    expect(withDetail).toContain('<span class="seg-caption" aria-hidden="true">Counted · 40 of 100 items</span>');
    const bare = bar({ label: 'Counted', fraction: 0.4 });
    expect(bare).toContain('<span class="seg-caption" aria-hidden="true">Counted</span>');
    expect(bare).toContain('aria-valuetext="40%"');
    expect(bare).not.toMatch(/\d+ of \d+/);
    // An indeterminate bar given the source's words says them too, and reads them as its value.
    const busy = bar({ label: 'Checking for updates', fraction: null, detail: 'Installed 0.1.6' });
    expect(busy).toContain('aria-valuetext="Installed 0.1.6"');
    expect(busy).toContain('<span class="seg-caption" aria-hidden="true">Checking for updates · Installed 0.1.6</span>');
  });

  it('leaves the segmented form exactly as it was when a share is also given', () => {
    const plain = bar({ label: 'Comparing delivery records', total: 4, done: 3, noun: 'records read' });
    const withShare = bar({ label: 'Comparing delivery records', total: 4, done: 3, noun: 'records read', fraction: 0.1 });
    expect(withShare).toBe(plain);
    expect(plain).toContain('aria-valuemax="4"');
    expect(plain).toContain('<span class="seg-caption" aria-hidden="true">3 of 4 records read</span>');
    const indeterminate = bar({ label: 'Working on it' });
    expect(indeterminate).not.toContain('seg-caption');
    expect(indeterminate).toContain('aria-valuetext="Working"');
  });

  it('keeps the state colours a count has', () => {
    expect(bar({ label: 'Stalled', fraction: 0.3, failed: true })).toContain('class="seg-bar card fraction failed words"');
    expect(bar({ label: 'Waiting', fraction: 0.3, blocked: true })).toContain('class="seg-bar card fraction blocked words"');
  });
});

describe('segment bar markup', () => {
  it('exposes a progressbar with the counted value and plain words', () => {
    const html = renderToStaticMarkup(
      createElement(SegmentBar, { label: 'Comparing delivery records', total: 4, done: 3, noun: 'records read' }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="4"');
    expect(html).toContain('aria-valuetext="3 of 4 records read"');
    expect(html.match(/class="seg /g)?.length).toBe(4);
    expect(html).toContain('3 of 4 records read</span>');
  });

  it('omits a value from an indeterminate bar', () => {
    const html = renderToStaticMarkup(createElement(SegmentBar, { label: 'Working on it' }));
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('aria-valuetext="Working"');
    expect(html).toContain('seg-scan');
  });
});

describe('a reply’s own progress is never drawn as a record’s (contract A15)', () => {
  const reply = (props: Omit<Parameters<typeof SegmentBar>[0], 'source'>) =>
    renderToStaticMarkup(createElement(SegmentBar, { ...props, source: 'reply' }));

  it('is only ever a share or indeterminate, never counted segments, whatever it is given', () => {
    const counted = reply({
      label: 'Launch',
      steps: [{ label: 'a', state: 'done' }, { label: 'b', state: 'active' }],
      done: 1,
      total: 2,
      fraction: 0.5,
      running: true,
    });
    expect(counted).toContain('<div class="seg-bar card fraction words" data-source="reply">');
    expect(counted).toContain('aria-valuenow="50"');
    expect(counted).not.toMatch(/class="seg (done|active|pending)/);
    const busy = reply({ label: 'Launch', done: 1, total: 2, running: true });
    expect(busy).toContain('class="seg-bar card indeterminate" data-source="reply"');
    expect(busy).not.toMatch(/class="seg (done|active|pending)/);
    // A record's bar given the same count stays the segmented form.
    const record = renderToStaticMarkup(createElement(SegmentBar, { label: 'Launch', done: 1, total: 2, running: true }));
    expect(record).not.toContain('data-source');
    expect(record.match(/class="seg /g)).toHaveLength(2);
  });

  it('keeps the reply’s own words and none of a record’s state', () => {
    const html = reply({ label: 'Packing', fraction: 0.4, detail: '40 of 100 boxes', failed: true, blocked: true });
    expect(html).toContain('<span class="seg-caption" aria-hidden="true">Packing · 40 of 100 boxes</span>');
    expect(html).toContain('aria-valuetext="40%, 40 of 100 boxes"');
    expect(html).not.toMatch(/fraction (failed|blocked)/);
  });
});

describe('segment bar stylesheet', () => {
  const read = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const css = read('client/console/segment-bar.css');
  /** The body of the one rule whose selector list is exactly this. */
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('stops every travelling highlight, scan and snap when motion intensity is 0', () => {
    expect(css).toContain('--seg-on: min(1, calc(var(--dm-motion-intensity, 0.5) * 1000));');
    const moving = [...css.matchAll(/\b(animation|transition):\s*([^;]+);/g)]
      .map((m) => m[2].replace(/\s+/g, ' ').trim())
      .filter((value) => value !== 'none');
    expect(moving.length).toBeGreaterThanOrEqual(4);
    expect(moving.filter((value) => !value.includes('var(--seg-on)'))).toEqual([]);
    // Still, the indeterminate span is the whole track, not a 28% that reads as 28% done.
    expect(rule('.seg-bar .seg-scan')).toContain('width: calc(100% - 72% * var(--seg-on));');
  });

  it('names the reduced-motion setting and a motion preset of none outright, as artifacts.css does', () => {
    for (const setting of ["html[data-motion='reduced']", "html[data-motion-preset='none']"]) {
      for (const part of ['.seg-bar .seg', '.seg-bar .seg::after', '.seg-bar .seg-scan'])
        expect(css).toMatch(new RegExp(`${escape(`${setting} ${part}`)}[,\\s][^{]*\\{\\s*animation: none;`));
      expect(css).toMatch(new RegExp(`${escape(`${setting} .seg-bar .seg-scan`)}[,\\s][^{]*\\{\\s*width: 100%;\\s*opacity: 0\\.45;`));
      expect(css).toMatch(new RegExp(`${escape(`${setting} .seg-bar .seg.active::after`)}[^{]*\\{\\s*display: none;`));
    }
  });

  it('draws a reply’s bar as an outlined gauge that never moves', () => {
    expect(rule(".seg-bar[data-source='reply'] .seg-track")).toContain('border: 1px solid var(--seg-reply-rule);');
    expect(rule(".seg-bar[data-source='reply'] .seg-track .seg-scan")).toContain('animation: none;');
    expect(rule(".seg-bar[data-source='reply'] .seg-track .seg-fill")).toContain('transition: none;');
  });

  it('meets 3:1 on the Nectovia grounds for pending and active, and keeps done apart from pending', () => {
    const nectovia = read('client/console/nectovia.css');
    const styles = read('client/styles.css');
    const scheme = styles.slice(styles.indexOf("html[data-package='nectovia'] {"));
    const token = (name: string) => new RegExp(`${name}: (#[0-9a-f]{6});`).exec(scheme)?.[1];
    const grounds = ['--chrome', '--surface', '--raised'].map(token);
    const lead = token('--light');
    const pending = /\[data-package='nectovia'\] \.seg-bar \{\s*--seg-ahead: (#[0-9a-f]{6});/.exec(nectovia)?.[1];
    const active = /\[data-package='nectovia'\] \.seg-bar \.seg\.active \{\s*background: (#[0-9a-f]{6});/.exec(nectovia)?.[1];
    expect([...grounds, lead, pending, active].every(Boolean)).toBe(true);
    for (const ground of grounds) {
      expect(contrast(pending!, ground!), `pending on ${ground}`).toBeGreaterThanOrEqual(3);
      expect(contrast(active!, ground!), `active on ${ground}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(lead!, pending!)).toBeGreaterThanOrEqual(3);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** WCAG 2.x contrast ratio of two opaque sRGB colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
