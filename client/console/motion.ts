import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ShellView } from './types';

/**
 * The Living Thread motion language (field 4a), 1:1 with the mechanics of
 * `05-instrumented-density-prototype.html`:
 *
 * - One travelling point at a time; a new trip cancels the last.
 * - Web Animations API for travel and the mode-strip spring; CSS only for
 *   arrival fades and the landing scale. No library, no View Transitions.
 * - Nothing waits on motion: the destination is already live when travel
 *   runs, and no caller ever awaits an animation.
 * - Repeated trips of a kind get plainer: the fifth runs at 160 ms without
 *   the landing pulse; after the eighth only the arrival fade remains
 *   (travel stops, the board's `.arrived` fade still plays).
 * - Enter never animates (no call site on send paths).
 * - Reduced motion (`html[data-motion='reduced']` or the media query) keeps
 *   the fade and the state change and drops the travel.
 */

export const EASE_ARRIVE = 'cubic-bezier(.16,1,.3,1)';

export type TravelFrom = Element | { x: number; y: number } | null;
export type TravelTo = Element | null;

const travelCount: Record<string, number> = {};
let activeTravel: Animation | null = null;

export function reducedMotion(): boolean {
  try {
    if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced')
      return true;
  } catch {
    // A hostile DOM never blocks the state change; fall through to the query.
  }
  return (
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function hasRect(value: unknown): value is { getBoundingClientRect(): DOMRect } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getBoundingClientRect' in value &&
    typeof (value as { getBoundingClientRect?: unknown }).getBoundingClientRect === 'function'
  );
}

function centerOfRect(rect: { left: number; top: number; width: number; height: number }): {
  x: number;
  y: number;
} {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function centerOfTarget(from: TravelFrom): { x: number; y: number } | null {
  if (!from) return null;
  if (hasRect(from)) {
    try {
      const el = from as Element;
      // A detached source has no meaningful position; the caller falls back
      // to the rail point instead of flying from (0,0).
      if (typeof (el as Element).isConnected === 'boolean' && !el.isConnected) return null;
      return centerOfRect(from.getBoundingClientRect());
    } catch {
      return null;
    }
  }
  if (typeof from === 'object' && typeof from.x === 'number' && typeof from.y === 'number')
    return { x: from.x, y: from.y };
  return null;
}

/**
 * Fly the single travelling point from `from` to `to`. Resolves element
 * centres with getBoundingClientRect at call time, never throws when an
 * element is missing, and returns at once without awaiting anything.
 */
export function travel(from: TravelFrom, to: TravelTo, kind: string, ms: number): void {
  try {
    if (reducedMotion()) return;
    if (!to || !(to instanceof Element) || !to.isConnected) return;
    const a = centerOfTarget(from);
    if (!a) return;
    travelCount[kind] = (travelCount[kind] ?? 0) + 1;
    const n = travelCount[kind];
    if (n > 8) return;
    if (activeTravel) {
      try {
        activeTravel.cancel();
      } catch {
        // The previous dot is already gone; the new trip still runs.
      }
      activeTravel = null;
    }
    const b = centerOfRect(to.getBoundingClientRect());
    const dot = document.createElement('span');
    dot.className = 'traveller';
    // Inside `.console`, never on the body: motion.css scopes `.traveller`
    // to the console root, so a body-level span would never pick it up.
    (document.querySelector('.console') ?? document.body).append(dot);
    const dur = n > 4 ? Math.min(ms, 160) : ms;
    const mid = {
      x: (a.x + b.x) / 2,
      y: Math.min(a.y, b.y) - Math.min(40, Math.abs(b.x - a.x) * 0.08),
    };
    const anim = dot.animate(
      [
        { transform: `translate(${a.x}px, ${a.y}px)`, opacity: 1 },
        { transform: `translate(${mid.x}px, ${mid.y}px)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${b.x}px, ${b.y}px)`, opacity: 1 },
      ],
      { duration: dur, easing: EASE_ARRIVE, fill: 'forwards' },
    );
    activeTravel = anim;
    const done = () => {
      dot.remove();
      if (activeTravel === anim) activeTravel = null;
      if (n <= 4 && to.isConnected) {
        to.classList.remove('landed');
        void (to as HTMLElement).offsetWidth;
        to.classList.add('landed');
      }
    };
    anim.onfinish = done;
    anim.oncancel = () => {
      dot.remove();
      if (activeTravel === anim) activeTravel = null;
    };
  } catch {
    // Motion never breaks the state change it explains.
  }
}

/**
 * The mode-strip spring (stiffness 210, damping 22): the sampled positions
 * from `from` to `to` at 120 Hz. The exit test scales with the trip and the
 * loop is capped at 0.29 s, so the strip settles in at most 267 ms; callers
 * map the frames to `translateX()`/`scaleX()` transforms in one WAAPI
 * animation.
 */
export function spring(from: number, to: number): number[] {
  const frames: number[] = [];
  const k = 210;
  const c = 22;
  const m = 1;
  const dt = 1 / 120;
  // The exit test scales with the trip: an absolute 0.15 px never arrives
  // inside the budget on a long trip, so the strip overran its 300 ms.
  const span = Math.abs(to - from);
  const nearX = Math.max(0.15, span * 0.01);
  const nearV = Math.max(2, span * 8);
  let x = from;
  let v = 0;
  for (let t = 0; t < 0.29; t += dt) {
    const a = (-k * (x - to) - c * v) / m;
    v += a * dt;
    x += v * dt;
    frames.push(x);
    if (Math.abs(x - to) < nearX && Math.abs(v) < nearV && t > 0.12) break;
  }
  frames.push(to);
  return frames;
}

function esc(id: string): string {
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  } catch {
    // Fall through to the raw id; the query simply misses.
  }
  return id;
}

function query(root: ParentNode | null | undefined, sel: string): Element | null {
  try {
    return (root ?? document).querySelector(sel);
  } catch {
    return null;
  }
}

/** Where the selected thread's work lives on each screen. */
export const anchors = {
  /** The latest Diomedes turn's point, else the greeting's point. */
  threadAnchor(root: ParentNode = document): Element | null {
    try {
      const pts = (root ?? document).querySelectorAll('[data-thread-point]');
      if (pts.length) return pts[pts.length - 1] as Element;
    } catch {
      // Fall through to null; the caller falls back to the rail point.
    }
    return null;
  },
  /** A board row's point for one task id. */
  boardAnchor(root: ParentNode, taskId: string): Element | null {
    return query(root, `[data-task-point="${esc(taskId)}"]`);
  },
  /** The task point above the team lanes. */
  teamAnchor(root: ParentNode = document): Element | null {
    return query(root, '[data-focus-point]');
  },
  /** The rail spine's point: the ghost start when a source element is gone. */
  railAnchor(root: ParentNode = document): Element | null {
    return query(root, '.spine .gp');
  },
};

function anchorCenter(el: Element | null): { x: number; y: number } | null {
  if (!el || !(el instanceof Element)) return null;
  try {
    if (!el.isConnected) return null;
    return centerOfRect(el.getBoundingClientRect());
  } catch {
    return null;
  }
}

function anchorForView(
  root: ParentNode,
  view: ShellView,
  focusTaskId: string | null | undefined,
): Element | null {
  if (view === 'Board')
    return focusTaskId
      ? anchors.boardAnchor(root, focusTaskId)
      : query(root, '[data-task-point]');
  if (view === 'Team') return anchors.teamAnchor(root);
  return anchors.threadAnchor(root);
}

/**
 * Travels between the Thread, Board and Team views (kind `screen`, 260 ms).
 *
 * The outgoing anchor's centre is captured before React re-renders: a ref
 * updated on every commit holds the previous view's anchor position, so when
 * `view` changes the stored point is still the old screen's. After the new
 * view paints (requestAnimationFrame) travel runs from that point to the new
 * view's anchor. If the source is gone the rail's `.spine .gp` starts the
 * trip instead.
 */
export function useTravelOnView(
  view: ShellView,
  focusTaskId: string | null | undefined,
  rootRef: RefObject<HTMLElement | null>,
): void {
  const prevView = useRef<ShellView>(view);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const root: ParentNode = rootRef.current ?? document;
    const changed = prevView.current !== view;
    if (changed) {
      const from: TravelFrom =
        lastPos.current ?? anchors.railAnchor(rootRef.current ?? document);
      const to = anchorForView(root, view, focusTaskId);
      // The new view has committed; wait one frame so its anchor is laid
      // out, then resolve its centre at call time inside travel().
      requestAnimationFrame(() => {
        travel(from, to, 'screen', 260);
      });
    }
    // Record this view's anchor centre for the next transition.
    lastPos.current = anchorCenter(anchorForView(root, view, focusTaskId));
    prevView.current = view;
    // Re-record when the focus task moves so the next trip starts true;
    // travel itself only fires on a view change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, focusTaskId]);
}
