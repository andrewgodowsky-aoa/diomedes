import { useEffect, useRef, useState } from 'react';
import type { Conversation, Settings } from '../../shared/types';
import {
  WORK_STYLES,
  WORK_STYLE_DESCRIPTIONS,
  WORK_STYLE_LABELS,
  isWorkStyle,
  type WorkStyle,
  type WorkStyleResolution,
} from '../../shared/work-style';
import { routeDisplayName } from '../../shared/engines';
import { api } from '../api';
import type { PickerProps } from './Picker';

/** What `GET /projects/:id/threads/:threadId/work-style` answers. */
export interface WorkStyleView {
  route: string;
  style: WorkStyle | null;
  source: 'thread' | 'settings' | 'default' | 'none';
  resolution: WorkStyleResolution | null;
}

/** The style a thread follows: its own, else the Settings default, else none. */
export function threadStyle(thread: Conversation, settings: Settings): WorkStyle | null {
  if (isWorkStyle(thread.workStyle)) return thread.workStyle;
  const saved = settings.services?.workStyle;
  return isWorkStyle(saved) ? saved : null;
}

/**
 * What the header button says. A pinned model is named as a choice, not as a
 * style, because a style does not decide anything while a pin holds.
 */
export function styleButtonLabel(thread: Conversation, settings: Settings): string {
  if (thread.requested?.model) return 'Chosen model';
  const style = threadStyle(thread, settings);
  return style ? WORK_STYLE_LABELS[style] : 'Choose a style';
}

/**
 * The resolved model and level, as the details line writes them. Only a route
 * whose adapter reads a level shows one: ChatGPT and AWS today.
 */
export function resolvedDetail(view: WorkStyleView | null): string {
  const r = view?.resolution;
  if (!view || !r) return '';
  if (r.outcome === 'ask') return r.reason;
  const model = r.model ?? 'engine default';
  const effort = r.effort && (view.route === 'codex' || view.route === 'aws-bedrock') ? ` ${r.effort}` : '';
  return `${model}${effort} · ${routeDisplayName(view.route)}`;
}

/**
 * Reads what the thread's next request would run with. Refreshed whenever a
 * choice that could move it changes; a failed read leaves the last answer.
 */
export function useWorkStyleView(
  projectId: string | undefined,
  thread: Conversation,
  keys: readonly unknown[],
): WorkStyleView | null {
  const [view, setView] = useState<WorkStyleView | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    api<WorkStyleView>(
      `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(thread.id)}/work-style`,
    )
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        // Nothing is invented when the read fails.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, thread.id, thread.workStyle, thread.requested?.model, thread.requested?.effort, ...keys]);
  return view;
}

export interface WorkStylePickerProps {
  thread: Conversation;
  settings: Settings;
  live: boolean;
  busy: boolean;
  view: WorkStyleView | null;
  onStyle(style: WorkStyle | null): void;
  /** Render with the menu open. For render tests; the header starts closed. */
  initialOpen?: boolean;
}

/**
 * The thread header's one model control: Efficient, Focused or Thorough, each in
 * one line. A customer never chooses a route or a model (owner decision
 * 2026-09-23): the owner's tier map decides both, and they are named only in
 * the details line. The mode still says what the thread may do, and nothing
 * chosen here changes that. The owner's route pin for testing lives in AI
 * setup, under Advanced, never here.
 */
export function WorkStylePicker({
  thread,
  settings,
  live,
  busy,
  view,
  onStyle,
  initialOpen = false,
}: WorkStylePickerProps) {
  const [open, setOpen] = useState(initialOpen);
  const root = useRef<HTMLDivElement>(null);
  const pinned = Boolean(thread.requested?.model);
  const current = pinned ? null : threadStyle(thread, settings);
  const asks = view?.resolution?.outcome === 'ask';

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function choose(style: WorkStyle) {
    if (live || busy) return;
    onStyle(style);
    setOpen(false);
  }

  return (
    <div className="picker style-picker" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="How much care this thread takes"
        onClick={() => setOpen(!open)}
      >
        <span className="mdl">{styleButtonLabel(thread, settings)}</span>
        {asks && <span className="eff capped">needs setup</span>}
      </button>
      {open && (
        <div className="pmenu open" role="menu">
          {live ? (
            <div className="note">Waiting for the current run to finish</div>
          ) : (
            <>
              {WORK_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  className={`m ${current === style ? 'on' : ''}`}
                  role="menuitemradio"
                  aria-checked={current === style}
                  onClick={() => choose(style)}
                >
                  <span>{WORK_STYLE_LABELS[style]}</span>
                  <span className="id" />
                  <small>{WORK_STYLE_DESCRIPTIONS[style]}</small>
                </button>
              ))}
              {pinned && (
                <p className="note">
                  This thread was pinned to one model before styles decided the model. Picking a
                  style clears the pin.
                </p>
              )}
              {asks && view?.resolution && <p className="note">{view.resolution.reason}</p>}
              <p className="note">
                Nectovia picks the model for the style you choose. The mode still decides what
                this thread may do.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface ThreadModelControlsProps extends PickerProps {
  projectId: string;
  onStyle(style: WorkStyle | null): void;
}

/**
 * The header's model control: the style picker only. It takes the thread
 * picker's props so its callers need not change; no route or model list is
 * rendered from them.
 */
export function ThreadModelControls(props: ThreadModelControlsProps) {
  const { projectId, onStyle, ...picker } = props;
  const view = useWorkStyleView(projectId, picker.thread, [
    picker.route,
    picker.mode,
    picker.settings.services?.workStyle,
  ]);
  return (
    <WorkStylePicker
      thread={picker.thread}
      settings={picker.settings}
      live={picker.live}
      busy={picker.busy}
      view={view}
      onStyle={onStyle}
    />
  );
}
