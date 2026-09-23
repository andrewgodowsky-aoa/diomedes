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
import { Picker, type PickerProps } from './Picker';

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
  return style ? WORK_STYLE_LABELS[style] : 'Default model';
}

/**
 * Whether the model and reasoning picker shows beside the style. Technical
 * detail shows it; so does a thread that already pins a model, so the pin can
 * always be seen and cleared; otherwise only when the person opens Advanced.
 */
export function showAdvanced(settings: Settings, thread: Conversation, opened: boolean): boolean {
  return opened || settings.detail === 'technical' || Boolean(thread.requested?.model);
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
  advanced: boolean;
  onStyle(style: WorkStyle | null): void;
  onAdvanced(): void;
  /** Render with the menu open. For render tests; the header starts closed. */
  initialOpen?: boolean;
}

/**
 * The thread header's plain control: Efficient, Focused or Thorough, each in
 * one line. It says how much care the thread takes; the mode still says what
 * the thread may do, and nothing chosen here changes that. The model and level
 * are inferred, and named only under Advanced and in the details line.
 */
export function WorkStylePicker({
  thread,
  settings,
  live,
  busy,
  view,
  advanced,
  onStyle,
  onAdvanced,
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

  function choose(style: WorkStyle | null) {
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
        {asks && <span className="eff capped">needs a choice</span>}
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
              {/* With a style saved as the default, clearing the thread's own returns it to
                  that style, so there is no separate model-default row to offer. */}
              {!isWorkStyle(settings.services?.workStyle) && (
                <button
                  type="button"
                  className={`m ${!pinned && current === null ? 'on' : ''}`}
                  role="menuitemradio"
                  aria-checked={!pinned && current === null}
                  onClick={() => choose(null)}
                >
                  <span>Default model</span>
                  <span className="id" />
                  <small>Runs the model saved in Settings, or the engine’s own.</small>
                </button>
              )}
              {pinned && (
                <p className="note">
                  A chosen model runs every call in this thread, with no substitute. Picking a
                  style or the default clears it.
                </p>
              )}
              {asks && view?.resolution && <p className="note">{view.resolution.reason}</p>}
              <p className="note">
                The mode still decides what this thread may do. A style only changes which model
                leads and how hard it thinks, from the next request.
              </p>
              {!advanced && (
                <button
                  type="button"
                  className="m"
                  role="menuitem"
                  onClick={() => {
                    onAdvanced();
                    setOpen(false);
                  }}
                >
                  <span>Advanced: choose model</span>
                  <span className="id" />
                  <small>Pick the exact model and reasoning level yourself.</small>
                </button>
              )}
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
 * The header pair: the style control always, and the existing model and level
 * picker when Advanced is open, the detail level is technical, or a model is
 * pinned.
 */
export function ThreadModelControls(props: ThreadModelControlsProps) {
  const { projectId, onStyle, ...picker } = props;
  const [opened, setOpened] = useState(false);
  const view = useWorkStyleView(projectId, picker.thread, [
    picker.route,
    picker.mode,
    picker.settings.services?.workStyle,
  ]);
  const advanced = showAdvanced(picker.settings, picker.thread, opened);
  return (
    <>
      <WorkStylePicker
        thread={picker.thread}
        settings={picker.settings}
        live={picker.live}
        busy={picker.busy}
        view={view}
        advanced={advanced}
        onStyle={onStyle}
        onAdvanced={() => setOpened(true)}
      />
      {advanced && <Picker {...picker} />}
    </>
  );
}
