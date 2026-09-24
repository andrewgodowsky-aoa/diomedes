import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '../../shared/types';
import { readBlock, type ReplySegment } from '../../shared/visual-spec';
import { blocksOf, chartColumns, isVisualBlock, type ArtifactRecord } from './artifacts';
import { InlineVisual, VisualBoundary, VisualNote, VisualPending } from './InlineVisual';
import {
  artifactKindOf,
  DRAWING,
  gatePreview,
  inlineSpans,
  KIND_LABEL,
  parseBlocks,
  type CodeBlock,
  type HeadingBlock,
  type ListBlock,
  type TableBlock,
  type TurnBlock,
} from './turn-blocks';

/**
 * One turn's text, rendered from its blocks with React text nodes only. No
 * markup a model writes is ever handed to the DOM as HTML: a tag in an answer
 * reads as the characters it is.
 *
 * Paragraphs render as the `<p>` children of the turn's `.body` they always
 * were, so a plain answer reads exactly as before. A fenced block in a language
 * the panel draws (mermaid, svg, html, markdown) becomes a chip that opens it
 * there; a `visual` block is drawn in place, with a quiet way to open it in the
 * panel once its turn is saved; every other fence (a retired ```chart
 * included) is a code block with its own Copy.
 */
export interface TurnBodyProps {
  text: string;
  /**
   * Live text that is still arriving. Nothing is drawn from it: an artifact
   * fence, open or closed, reads as one placeholder line until the turn is
   * saved (the durable turn is the only thing an artifact renders from).
   */
  preview?: boolean;
  /** The artifact a block became. Without it every block renders inline and no chip is drawn. */
  artifactAt?(blockIndex: number): ArtifactRecord | undefined;
  onOpenArtifact?(record: ArtifactRecord): void;
  /** The artifact the panel is showing, so its chip can say so. */
  openKey?: string | null;
  /** Feeds a `visual` block's live run-status card; without one the card says it is not available here. */
  session?: Session | null;
}

/**
 * A fenced `visual` block is drawn in place (InlineVisual), with the same limits
 * `splitVisuals` applies: a closed block is read, an open one is a placeholder
 * while the turn streams and a plain note once it is saved.
 */
function visualSegment(block: CodeBlock, ordinal: number, preview: boolean): ReplySegment {
  if (!block.closed)
    return preview ? { type: 'pending' } : { type: 'invalid', reason: 'the block was never closed' };
  return readBlock(block.source, ordinal);
}

export function TurnBody({ text, preview = false, artifactAt, onOpenArtifact, openKey, session = null }: TurnBodyProps) {
  const cut = preview ? gatePreview(text) : null;
  const blocks: TurnBlock[] = cut ? parseBlocks(cut.text) : blocksOf(text);
  let visuals = 0;
  return (
    <>
      {blocks.map((block, index) => {
        if (isVisualBlock(block)) {
          const segment = visualSegment(block, ++visuals, preview);
          if (segment.type === 'visual') {
            // Only a saved turn's visual is an artifact; a streaming preview never offers the panel.
            const record = preview ? undefined : artifactAt?.(index);
            return (
              <Fragment key={index}>
                <VisualBoundary>
                  <InlineVisual spec={segment.spec} session={session} />
                </VisualBoundary>
                {record?.kind === 'visual' && onOpenArtifact && (
                  <VisualOpen record={record} current={record.key === openKey} onOpen={onOpenArtifact} />
                )}
              </Fragment>
            );
          }
          if (segment.type === 'pending') return <VisualPending key={index} />;
          if (segment.type === 'invalid') return <VisualNote key={index} reason={segment.reason} />;
        }
        const kind = artifactKindOf(block);
        if (kind && preview && block.type === 'code')
          return (
            <p className="art-drawing" key={index}>
              {DRAWING[kind]}
            </p>
          );
        const record = kind && !preview ? artifactAt?.(index) : undefined;
        const chip =
          record && onOpenArtifact ? (
            <ArtifactChip
              key={`chip-${index}`}
              record={record}
              current={record.key === openKey}
              onOpen={onOpenArtifact}
            />
          ) : null;
        // A fence the panel draws is the chip alone; its source is one click
        // away in the panel. A table stays readable in place with its chip under it.
        if (chip && block.type === 'code') return chip;
        return (
          <BlockView key={index} block={block}>
            {chip}
          </BlockView>
        );
      })}
      {cut?.pending && (
        <p className="art-drawing" role="status">
          {DRAWING[cut.pending]}
        </p>
      )}
      {cut?.visualPending && <VisualPending />}
    </>
  );
}

function BlockView({ block, children }: { block: TurnBlock; children?: ReactNode }) {
  switch (block.type) {
    case 'paragraph':
      return <p>{spans(block.text)}</p>;
    case 'heading':
      return <Heading level={block.level}>{spans(block.text)}</Heading>;
    case 'list':
      return <ListView list={block} />;
    case 'code':
      return <CodeView block={block} />;
    case 'table':
      return (
        <>
          <TableView table={block} />
          {children}
        </>
      );
  }
}

/** Inline code, bold and italic, as elements holding text. Everything else is the text itself. */
export function spans(text: string): ReactNode[] {
  return inlineSpans(text).map((span, index) =>
    span.type === 'code' ? (
      <code className="art-inline-code" key={index}>
        {span.text}
      </code>
    ) : span.type === 'strong' ? (
      <strong key={index}>{span.text}</strong>
    ) : span.type === 'em' ? (
      <em key={index}>{span.text}</em>
    ) : (
      span.text
    ),
  );
}

/** A turn sits under the page's own h1 and the ledger's h2s, so its headings start at h3. */
function Heading({ level, children }: { level: HeadingBlock['level']; children: ReactNode }) {
  const className = `art-h art-h${Math.min(level, 4)}`;
  if (level === 1) return <h3 className={className}>{children}</h3>;
  if (level === 2) return <h4 className={className}>{children}</h4>;
  if (level === 3) return <h5 className={className}>{children}</h5>;
  return <h6 className={className}>{children}</h6>;
}

function ListView({ list }: { list: ListBlock }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {spans(item.text)}
      {item.children.map((child, at) => (
        <ListView list={child} key={at} />
      ))}
    </li>
  ));
  return list.ordered ? (
    <ol className="art-list" start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul className="art-list">{items}</ul>
  );
}

/** Copies text, and says so for a moment. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    copied,
    (text: string) => {
      try {
        void navigator.clipboard?.writeText(text);
      } catch {
        // Clipboard is unavailable; the text stays selectable.
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    },
  ];
}

/** A real code block: mono, scrolled sideways rather than wrapped, with its own Copy. */
export function CodeView({ block }: { block: Pick<CodeBlock, 'lang' | 'source'> }) {
  const [copied, copy] = useCopy();
  const language = block.lang || 'text';
  return (
    <div className="art-code">
      <div className="art-code-head">
        <span className="art-code-lang">{language}</span>
        <button type="button" onClick={() => copy(block.source)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre tabIndex={0} aria-label={`${language} code`}>
        <code>{block.source}</code>
      </pre>
    </div>
  );
}

/** Columns that hold only numbers are set right-aligned in tabular figures. */
export function TableView({ table, caption }: { table: TableBlock; caption?: string }) {
  const numeric = new Set(chartColumns(table).numeric.map((column) => column.index));
  const align = (index: number) =>
    table.align[index] ?? (numeric.has(index) ? 'right' : undefined);
  return (
    <div className="art-table-wrap" tabIndex={0} role="region" aria-label={caption ?? 'Table'}>
      <table className="art-table">
        {caption && <caption className="art-sr">{caption}</caption>}
        <thead>
          <tr>
            {table.header.map((cell, index) => (
              <th key={index} scope="col" style={{ textAlign: align(index) }}>
                {spans(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, at) => (
            <tr key={at}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={numeric.has(index) ? 'num' : undefined}
                  style={{ textAlign: align(index) }}
                >
                  {spans(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The quiet way from a visual in a turn to the panel. The visual is already
 * drawn above it, so it is a small text control rather than a chip; it keeps a
 * chip's state all the same: "In panel" and `aria-current` while the panel
 * shows this visual. Its accessible name carries the title, so two visuals in
 * one turn are two different controls.
 */
export function VisualOpen({
  record,
  current,
  onOpen,
}: {
  record: ArtifactRecord;
  current: boolean;
  onOpen(record: ArtifactRecord): void;
}) {
  return (
    <div className="iv-open-row">
      <button
        type="button"
        className={`iv-open${current ? ' on' : ''}`}
        aria-current={current ? 'true' : undefined}
        onClick={() => onOpen(record)}
      >
        {current ? 'In panel' : 'Open in panel'}
        <span className="art-sr">: {record.title}</span>
      </button>
    </div>
  );
}

/**
 * The chip an artifact leaves in its turn: a small plate whose cut corner is
 * lit in the lead colour. It names the kind and the title and opens the panel.
 */
export function ArtifactChip({
  record,
  current,
  onOpen,
}: {
  record: ArtifactRecord;
  current: boolean;
  onOpen(record: ArtifactRecord): void;
}) {
  return (
    <div className="art-chip-row">
      <span className="art-chip-plate">
        <svg className="art-chip-lit" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <line x1="0" y1="0" x2="10" y2="10" />
        </svg>
        <button
          type="button"
          className={`art-chip${current ? ' on' : ''}`}
          aria-current={current ? 'true' : undefined}
          onClick={() => onOpen(record)}
        >
          <span className="art-chip-face">
            <span className="art-chip-kind">{KIND_LABEL[record.kind]}</span>
            <span className="art-chip-dot" aria-hidden="true">
              ·
            </span>
            <span className="art-chip-title">{record.title}</span>
            {record.versionCount > 1 && (
              <>
                <span className="art-chip-dot" aria-hidden="true">
                  ·
                </span>
                <span className="art-chip-version">v{record.version}</span>
              </>
            )}
            <span className="art-chip-dot" aria-hidden="true">
              ·
            </span>
            <span className="art-chip-open">{current ? 'In panel' : 'Open'}</span>
          </span>
        </button>
      </span>
    </div>
  );
}
