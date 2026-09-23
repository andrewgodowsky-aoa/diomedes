import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  chartColumns,
  indexArtifacts,
  tableChart,
  withoutDeclaration,
  type ArtifactIndex,
  type ArtifactRecord,
} from './artifacts';
import { parseChart } from './chart-spec';
import { Chart } from './Chart';
import { ArtifactError, ArtifactFrame, SourceView } from './artifact-frames';
import { clampArtifactWidth, viewportWidth } from './artifact-width';
import type { SaveOutcome } from './artifact-save';
import { TableView, TurnBody, useCopy } from './TurnBody';
import { KIND_LABEL, type TableBlock } from './turn-blocks';

export interface ArtifactPaneProps {
  record: ArtifactRecord;
  /** The index the record belongs to; its other versions come from here. */
  index: ArtifactIndex;
  /** The record switched in by itself because a new turn brought it. */
  arrived: boolean;
  /** Changes when a person opened an artifact, so the title takes focus. */
  focusToken: number;
  width: number;
  onWidth(width: number): void;
  /** Another version of the same artifact. */
  onSelect(record: ArtifactRecord): void;
  onClose(): void;
  /** Kept mounted behind Files, so what it was showing survives the switch. */
  hidden?: boolean;
  /** A full-height column over the page, where the page has no third column. */
  overlay?: boolean;
  /** The Files | Artifact switch, while both views are open. */
  switcher?: ReactNode;
  /** Saves into the project's Files. Absent where there is no project folder to save into. */
  onSave?(record: ArtifactRecord): Promise<SaveOutcome>;
  /** Why saving is not offered here. */
  saveUnavailable?: string;
  /** Shows a saved file in Files. */
  onShowFile?(path: string): void;
}

/**
 * The artifact panel: a plate whose cut corner is top-left, facing the thread.
 * Every control is a real button; Esc closes it while focus is inside it.
 */
export function ArtifactPane({
  record: top,
  index,
  arrived,
  focusToken,
  width,
  onWidth,
  onSelect,
  onClose,
  hidden = false,
  overlay = false,
  switcher,
  onSave,
  saveUnavailable,
  onShowFile,
}: ArtifactPaneProps) {
  // Artifacts opened from inside a document, deepest last.
  const [trail, setTrail] = useState<ArtifactRecord[]>([]);
  const [source, setSource] = useState(false);
  const [status, setStatus] = useState<{ text: string; path?: string }>({ text: '' });
  const [saving, setSaving] = useState(false);
  const [played, setPlayed] = useState(false);
  const [copied, copy] = useCopy();
  const title = useRef<HTMLHeadingElement>(null);
  const dragFrom = useRef<{ x: number; width: number } | null>(null);
  const shown = trail[trail.length - 1] ?? top;

  // A different artifact starts at its own top, and says so when it arrived by itself.
  useEffect(() => {
    setTrail([]);
    setPlayed(false);
    setStatus({
      text: arrived
        ? `New ${KIND_LABEL[top.kind].toLowerCase()}: ${top.title}${top.versionCount > 1 ? `, version ${top.version} of ${top.versionCount}` : ''}.`
        : '',
    });
    // `arrived` is read for this key only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top.key]);

  // A person opened this: move focus to it, once its view is the one showing.
  useEffect(() => {
    if (focusToken && !hidden) title.current?.focus();
  }, [focusToken, hidden]);

  const versions = index.versionsOf(top);
  const at = Math.max(0, versions.findIndex((version) => version.key === top.key));
  const step = (by: number) => {
    const next = versions[at + by];
    if (next) onSelect(next);
  };

  async function save() {
    if (saving) return;
    if (!onSave) {
      setStatus({ text: saveUnavailable ?? 'Saving is not available here.' });
      return;
    }
    setSaving(true);
    setStatus({ text: 'Saving…' });
    try {
      const outcome = await onSave(shown);
      setStatus(outcome.ok ? { text: outcome.sentence, path: outcome.path } : { text: outcome.sentence });
    } finally {
      setSaving(false);
    }
  }

  const onGripDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onGripMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (from) onWidth(clampArtifactWidth(from.width + (from.x - event.clientX), viewportWidth()));
  };
  const onGripUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const parent = trail.length > 1 ? trail[trail.length - 2] : top;
  return (
    <aside
      className={`art-pane${overlay ? ' overlay' : ''}${arrived && !played ? ' arrived' : ''}`}
      aria-label="Artifact"
      hidden={hidden}
      style={{ width: `min(${width}px, 100%)` }}
      onAnimationEnd={(event) => {
        // The arrival is over once the lit edge has drawn; it must not replay
        // when the view is hidden behind Files and shown again.
        if (event.animationName === 'art-lit') setPlayed(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="art-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the artifact panel"
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onWidth(clampArtifactWidth(width + 16, viewportWidth()));
          if (event.key === 'ArrowRight') onWidth(clampArtifactWidth(width - 16, viewportWidth()));
        }}
      />
      <svg className="art-pane-lit" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
        <line x1="0" y1="22" x2="22" y2="0" />
      </svg>
      <div className="art-plate">
        <div className="art-plate-face">
          <div className="art-head">
            {switcher}
            <div className="art-head-row">
              <div>
                <span className="art-kind">{KIND_LABEL[shown.kind]}</span>
                <h2 className="art-title" ref={title} tabIndex={-1}>
                  {shown.title}
                </h2>
              </div>
              <button type="button" className="art-close" onClick={onClose}>
                Close
              </button>
            </div>
            {trail.length > 0 && (
              <div className="art-trail">
                <button type="button" className="art-back" onClick={() => setTrail((list) => list.slice(0, -1))}>
                  Back to {parent.title}
                </button>
              </div>
            )}
            <div className="art-tools">
              {trail.length === 0 && versions.length > 1 && (
                <div className="art-stepper" role="group" aria-label="Versions">
                  <button
                    type="button"
                    aria-label="Previous version"
                    aria-disabled={at === 0 || undefined}
                    onClick={() => step(-1)}
                  >
                    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                      <polyline points="7.5,2.5 4,6 7.5,9.5" />
                    </svg>
                  </button>
                  <span className="art-version" aria-live="polite">
                    v{at + 1} of {versions.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next version"
                    aria-disabled={at === versions.length - 1 || undefined}
                    onClick={() => step(1)}
                  >
                    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                      <polyline points="4.5,2.5 8,6 4.5,9.5" />
                    </svg>
                  </button>
                </div>
              )}
              <div className="art-seg" role="group" aria-label="Show">
                <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
                  Rendered
                </button>
                <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
                  Source
                </button>
              </div>
              <button type="button" className="art-tool" onClick={() => copy(shown.source)}>
                {copied ? 'Copied' : 'Copy source'}
              </button>
              <button
                type="button"
                className="art-tool"
                aria-disabled={!onSave || saving || undefined}
                onClick={() => void save()}
              >
                Save to Files
              </button>
            </div>
            <p className="art-status" aria-live="polite">
              {status.text}
              {status.path && onShowFile && (
                <button type="button" onClick={() => onShowFile(status.path!)}>
                  Show in Files
                </button>
              )}
            </p>
          </div>
          <div className="art-body" key={shown.key}>
            {source ? (
              <SourceView source={shown.source} />
            ) : (
              <ArtifactView record={shown} onOpen={(sub) => setTrail((list) => [...list, sub])} />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function ArtifactView({ record, onOpen }: { record: ArtifactRecord; onOpen(record: ArtifactRecord): void }) {
  switch (record.kind) {
    case 'chart': {
      const parsed = parseChart(record.source);
      return parsed.ok ? (
        <Chart spec={parsed.spec} />
      ) : (
        <ArtifactError heading="This chart could not be drawn." problem={parsed.problem} source={record.source} />
      );
    }
    case 'table':
      return record.table ? <TableArtifact table={record.table} title={record.title} /> : null;
    case 'document':
      return <DocumentArtifact record={record} onOpen={onOpen} />;
    case 'diagram':
    case 'image':
    case 'design':
      return <ArtifactFrame record={record} />;
  }
}

/** A table, and the chart a person can make of one of its columns. */
function TableArtifact({ table, title }: { table: TableBlock; title: string }) {
  const { numeric } = chartColumns(table);
  const [column, setColumn] = useState(numeric[0]?.index ?? -1);
  const [charted, setCharted] = useState(false);
  const chosen = numeric.some((entry) => entry.index === column) ? column : (numeric[0]?.index ?? -1);
  return (
    <>
      <TableView table={table} caption={title} />
      {numeric.length > 0 ? (
        <div className="art-chartable">
          {numeric.length > 1 && (
            <label>
              Column{' '}
              <select value={chosen} onChange={(event) => setColumn(Number(event.target.value))}>
                {numeric.map((entry) => (
                  <option key={entry.index} value={entry.index}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="art-tool"
            aria-expanded={charted}
            onClick={() => setCharted((value) => !value)}
          >
            {charted ? 'Hide chart' : 'Chart this'}
          </button>
        </div>
      ) : (
        <p className="art-waiting">No column holds only numbers, so there is nothing to chart.</p>
      )}
      {charted && chosen >= 0 && <Chart spec={tableChart(table, chosen)} showTitle />}
    </>
  );
}

/** A Markdown document, read with the turn renderer; its own artifacts open in the panel. */
function DocumentArtifact({ record, onOpen }: { record: ArtifactRecord; onOpen(record: ArtifactRecord): void }) {
  const body = withoutDeclaration('document', record.source);
  const inner = useMemo(
    () => indexArtifacts(`doc:${record.key}`, [{ id: 'doc', role: 'document', text: body }]),
    [record.key, body],
  );
  return (
    <div className="body art-document">
      <TurnBody text={body} artifactAt={(block) => inner.forBlock('doc', block)} onOpenArtifact={onOpen} />
    </div>
  );
}
