import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  DESIGN_WIDTHS,
  FRAME_SANDBOX,
  NECTOVIA_TOKENS,
  designLayout,
  frameDocument,
  frameHeight,
  frameTokens,
  svgBox,
  type DesignWidth,
  type FrameTokens,
} from './artifact-frame';
import { shortDigest, withoutDeclaration, type ArtifactRecord } from './artifacts';
import { renderDiagram, type DiagramResult } from './mermaid-render';

// What the panel shows for the three kinds a model writes as markup: a
// Mermaid diagram, an SVG image and an HTML design. Each is shown only inside
// an iframe whose srcdoc artifact-frame.ts builds, CSP first. A diagram and an
// image are pictures (sandbox="", no pointer events); a design runs its own
// script in an opaque origin (sandbox="allow-scripts") and can reach nothing.

/** The artifact as written: mono, unwrapped, scrollable, focusable. */
export function SourceView({ source, label = 'Source' }: { source: string; label?: string }) {
  return (
    <pre className="art-source" tabIndex={0} aria-label={label}>
      <code>{source}</code>
    </pre>
  );
}

/** Why an artifact could not be drawn, with what it was given. */
export function ArtifactError({ heading, problem, source }: { heading: string; problem: string; source: string }) {
  return (
    <div className="art-error" role="group" aria-label={heading}>
      <p className="art-error-title">
        <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M5 0 10 10H0Z" />
        </svg>
        {heading}
      </p>
      <p className="art-error-problem">{problem}</p>
      <SourceView source={source} label="Source as written" />
    </div>
  );
}

/** An element's content size, kept current as the panel is resized. */
export function useElementSize<T extends HTMLElement>(fallback: { width: number; height: number }): [
  RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      if (next.width <= 0) return;
      setSize((now) => (now.width === next.width && now.height === next.height ? now : next));
    };
    const rect = node.getBoundingClientRect();
    read(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) read(box.width, box.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** The running scheme's colours for a frame, re-read when the scheme changes. */
function useFrameTokens(ref: RefObject<HTMLElement | null>): FrameTokens | null {
  const [tokens, setTokens] = useState<FrameTokens | null>(null);
  useEffect(() => {
    const read = () => {
      const node = ref.current;
      if (!node) return;
      const style = getComputedStyle(node);
      const next = frameTokens((name) => style.getPropertyValue(name));
      setTokens((now) => (now && JSON.stringify(now) === JSON.stringify(next) ? now : next));
    };
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [ref]);
  return tokens;
}

/** A picture: a diagram or an image, drawn at the panel's width and as tall as it needs. */
function StillFrame({ kind, svg, tokens, label }: { kind: 'diagram' | 'image'; svg: string; tokens: FrameTokens; label: string }) {
  const [ref, size] = useElementSize<HTMLDivElement>({ width: 440, height: 0 });
  const box = useMemo(() => svgBox(svg), [svg]);
  const srcdoc = useMemo(() => frameDocument(kind, svg, tokens), [kind, svg, tokens]);
  return (
    <div ref={ref}>
      <iframe
        className={`art-frame still ${kind}`}
        title={label}
        sandbox={FRAME_SANDBOX[kind]}
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        tabIndex={-1}
        style={{ height: frameHeight(box, size.width) }}
      />
    </div>
  );
}

function DiagramView({ source, title }: { source: string; title: string }) {
  const probe = useRef<HTMLDivElement | null>(null);
  const tokens = useFrameTokens(probe);
  const [result, setResult] = useState<DiagramResult | null>(null);
  useEffect(() => {
    if (!tokens) return;
    let alive = true;
    setResult(null);
    void renderDiagram(source, tokens).then((drawn) => {
      if (alive) setResult(drawn);
    });
    return () => {
      alive = false;
    };
  }, [source, tokens]);
  return (
    <div ref={probe}>
      {!result || !tokens ? (
        <p className="art-waiting" role="status">
          Drawing the diagram…
        </p>
      ) : result.ok ? (
        <StillFrame kind="diagram" svg={result.svg} tokens={tokens} label={`Diagram: ${title}`} />
      ) : (
        <ArtifactError heading="This diagram could not be drawn." problem={result.problem} source={source} />
      )}
    </div>
  );
}

function ImageView({ svg, title }: { svg: string; title: string }) {
  const probe = useRef<HTMLDivElement | null>(null);
  const tokens = useFrameTokens(probe);
  return (
    <div ref={probe}>
      <StillFrame kind="image" svg={svg} tokens={tokens ?? NECTOVIA_TOKENS} label={`Image: ${title}`} />
    </div>
  );
}

const WIDTH_LABEL: Record<DesignWidth, string> = { fit: 'Fit', phone: 'Phone', desktop: 'Desktop' };

/**
 * A design: the model's page, running its own script inside an opaque origin
 * with no network. If it navigates its own frame away (a sandbox cannot stop a
 * frame leaving itself; the desktop shell refuses it outright), the frame is
 * taken down rather than showing whatever it went to.
 */
function DesignView({ html, title }: { html: string; title: string }) {
  const [mode, setMode] = useState<DesignWidth>('fit');
  const [generation, setGeneration] = useState(0);
  const [stopped, setStopped] = useState(false);
  const loads = useRef(0);
  const [ref, size] = useElementSize<HTMLDivElement>({ width: 440, height: 480 });
  const layout = designLayout(mode, size.width);
  const srcdoc = useMemo(() => frameDocument('design', html), [html]);
  useEffect(() => {
    loads.current = 0;
    setStopped(false);
  }, [srcdoc, generation]);
  return (
    <div className="art-design">
      <div className="art-design-bar">
        <div className="art-seg" role="group" aria-label="Width">
          {(Object.keys(DESIGN_WIDTHS) as DesignWidth[]).map((option) => (
            <button key={option} type="button" aria-pressed={mode === option} onClick={() => setMode(option)}>
              {WIDTH_LABEL[option]}
            </button>
          ))}
        </div>
        <span className="art-waiting">
          {layout.width} px{layout.scale < 1 ? ` at ${Math.round(layout.scale * 100)}%` : ''}
        </span>
      </div>
      <div ref={ref} className={`art-stage${layout.scale < 1 ? ' scaled' : ''}`}>
        {stopped ? (
          <div className="art-left">
            <p>This design tried to open another page, so it was stopped.</p>
            <button type="button" className="art-tool" onClick={() => setGeneration((value) => value + 1)}>
              Load it again
            </button>
          </div>
        ) : (
          <iframe
            key={`${generation}:${shortDigest(srcdoc)}`}
            title={`Design: ${title}`}
            sandbox={FRAME_SANDBOX.design}
            referrerPolicy="no-referrer"
            srcDoc={srcdoc}
            onLoad={() => {
              loads.current += 1;
              if (loads.current > 1) setStopped(true);
            }}
            style={{
              width: layout.width,
              height: Math.max(1, Math.round(size.height / layout.scale)),
              transform: layout.scale < 1 ? `scale(${layout.scale})` : undefined,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The frame for a diagram, image or design record. */
export function ArtifactFrame({ record }: { record: ArtifactRecord }) {
  if (record.kind === 'diagram')
    return <DiagramView source={withoutDeclaration('diagram', record.source)} title={record.title} />;
  if (record.kind === 'image') return <ImageView svg={withoutDeclaration('image', record.source)} title={record.title} />;
  return <DesignView html={record.source} title={record.title} />;
}
