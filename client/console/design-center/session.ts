/**
 * The Studio session: what is being edited, what it was, and how to get back.
 *
 * Three boundaries this file exists to hold.
 *
 * 1. **Undo is Studio-only.** The stack holds nothing but whole ThemePacks.
 *    Undo, redo, reset-property and reset-theme change the pack in this screen
 *    and nothing else. No settings are written, no theme is applied, the
 *    running app does not change colour. Only Apply does that, and Apply is a
 *    button a person presses.
 *
 * 2. **Autosave is never the applied theme.** The debounced write goes to
 *    `PUT /api/themes/:id` with `draft: true`, which the service records in
 *    `draft.json` and nowhere else. A power cut during editing loses at most a
 *    few seconds of sliding; it cannot leave the app wearing a half-finished
 *    design.
 *
 * 3. **Nothing is sent that would not be accepted.** Every pack is put through
 *    `validateThemePack` in this process before it leaves it, because a refusal
 *    inside `store.locked` on the service costs a whole store reload (A2's own
 *    note) and a person moving a slider would cause one per keystroke.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePackV1 } from '../../../shared/theme-pack/types';
import { validateThemePack } from '../../../shared/theme-pack/validate';
import { api } from '../../api';

/** How long the editor waits after the last change before autosaving. */
export const AUTOSAVE_DELAY_MS = 900;

/** How many steps back the Studio remembers. Bounded so a long session is not a leak. */
export const UNDO_DEPTH = 60;

export type SaveState = 'clean' | 'editing' | 'saving' | 'saved' | 'failed';

export interface StudioSession {
  /** The pack as it is being edited. */
  pack: ThemePackV1;
  /** The pack as it was when this session opened: the "before" of before/after. */
  baseline: ThemePackV1;
  /** Which of the two the preview is showing. */
  showing: 'after' | 'before';
  /** The pack the preview must paint, honouring the before/after toggle. */
  previewPack: ThemePackV1;
  canUndo: boolean;
  canRedo: boolean;
  /** True when the edited pack differs from the baseline. */
  dirty: boolean;
  saveState: SaveState;
  /** What the last validation or save said, when it said anything. */
  problem: string;
  edit(next: ThemePackV1): void;
  undo(): void;
  redo(): void;
  /** Back to the baseline, as one undoable step. */
  resetTheme(): void;
  /** Replace the whole session — after an Apply, a Save-as, an import or a restore. */
  adopt(pack: ThemePackV1, asBaseline?: boolean): void;
  setShowing(showing: 'after' | 'before'): void;
  /** Write the autosave now rather than waiting for the timer. */
  flush(): Promise<void>;
}

const same = (a: ThemePackV1, b: ThemePackV1) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validate here, in the editor, before anything is sent.
 *
 * Returns the first problem in plain words, or an empty string.
 */
export function packProblem(pack: ThemePackV1): string {
  const result = validateThemePack(pack);
  return result.ok ? '' : result.errors[0];
}

export function useStudioSession(initial: ThemePackV1 | null): StudioSession | null {
  const [pack, setPack] = useState<ThemePackV1 | null>(initial);
  const [baseline, setBaseline] = useState<ThemePackV1 | null>(initial);
  const [past, setPast] = useState<ThemePackV1[]>([]);
  const [future, setFuture] = useState<ThemePackV1[]>([]);
  const [showing, setShowing] = useState<'after' | 'before'>('after');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [problem, setProblem] = useState('');
  // The pack the autosave timer will write. Held in a ref so the timer does not
  // have to be rebuilt — and the effect re-run — on every keystroke.
  const pending = useRef<ThemePackV1 | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A different theme opened: the session starts again, history and all.
  const initialId = initial ? `${initial.id}@${initial.revision}` : null;
  const startedFrom = useRef<string | null>(initialId);
  useEffect(() => {
    if (startedFrom.current === initialId) return;
    startedFrom.current = initialId;
    setPack(initial);
    setBaseline(initial);
    setPast([]);
    setFuture([]);
    setShowing('after');
    setSaveState('clean');
    setProblem('');
  }, [initialId, initial]);

  const save = useCallback(async (value: ThemePackV1) => {
    const found = packProblem(value);
    if (found) {
      // Nothing is sent. A pack the service would refuse costs it a store
      // reload, and while someone is still editing that is the ordinary case.
      setProblem(found);
      setSaveState('failed');
      return;
    }
    setSaveState('saving');
    try {
      await api(`/themes/${encodeURIComponent(value.id)}`, 'PUT', { ...value, draft: true });
      setProblem('');
      setSaveState('saved');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The draft could not be saved.');
      setSaveState('failed');
    }
  }, []);

  const schedule = useCallback(
    (value: ThemePackV1) => {
      pending.current = value;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const next = pending.current;
        pending.current = null;
        if (next) void save(next);
      }, AUTOSAVE_DELAY_MS);
    },
    [save],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next) await save(next);
  }, [save]);

  const edit = useCallback(
    (next: ThemePackV1) => {
      if (!pack || same(pack, next)) return;
      setPast((stack) => [...stack, pack].slice(-UNDO_DEPTH));
      setFuture([]);
      setPack(next);
      setSaveState('editing');
      // Editing while the "before" is showing would edit something invisible.
      setShowing('after');
      schedule(next);
    },
    [pack, schedule],
  );

  const undo = useCallback(() => {
    const moved = past[past.length - 1];
    if (!moved || !pack) return;
    setPast(past.slice(0, -1));
    setFuture((stack) => [...stack, pack].slice(-UNDO_DEPTH));
    setPack(moved);
    setShowing('after');
    setSaveState('editing');
    schedule(moved);
  }, [past, pack, schedule]);

  const redo = useCallback(() => {
    const moved = future[future.length - 1];
    if (!moved || !pack) return;
    setFuture(future.slice(0, -1));
    setPast((stack) => [...stack, pack].slice(-UNDO_DEPTH));
    setPack(moved);
    setShowing('after');
    setSaveState('editing');
    schedule(moved);
  }, [future, pack, schedule]);

  const resetTheme = useCallback(() => {
    if (baseline) edit(baseline);
  }, [baseline, edit]);

  const adopt = useCallback((next: ThemePackV1, asBaseline = true) => {
    clearTimeout(timer.current);
    pending.current = null;
    setPack(next);
    if (asBaseline) setBaseline(next);
    setPast([]);
    setFuture([]);
    setShowing('after');
    setSaveState('clean');
    setProblem('');
    startedFrom.current = `${next.id}@${next.revision}`;
  }, []);

  const previewPack = showing === 'before' ? baseline : pack;
  const dirty = useMemo(
    () => (pack && baseline ? !same(pack, baseline) : false),
    [pack, baseline],
  );

  if (!pack || !baseline || !previewPack) return null;
  return {
    pack,
    baseline,
    showing,
    previewPack,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    dirty,
    saveState,
    problem,
    edit,
    undo,
    redo,
    resetTheme,
    adopt,
    setShowing,
    flush,
  };
}
