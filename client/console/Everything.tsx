import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import './everything.css';

export interface EverythingItem {
  /** Stable id, e.g. 'board'. Used for pinning and for the caller's own routing. */
  id: string;
  /** What a business owner reads, e.g. 'Tasks'. Never a system word. */
  label: string;
  /** One short sentence: what a person does there. */
  hint: string;
  /** Optional count or state shown at the row's end, e.g. '3 waiting'. */
  badge?: string;
  /** A destination that exists but cannot act yet, with the reason. Named to match
   *  `unavailableReason` in shared/permissions.ts and shared/managed-usage.ts, which is
   *  the same idea already shipped: two names for one concept is how drift starts. */
  unavailableReason?: string;
  /** A place kept in the sidebar for a destination that is not built yet, so switching it
   *  on later needs no redesign. It may be pinned although it cannot open. Meaningless on
   *  a destination that can. */
  reserved?: boolean;
}

export interface EverythingProps {
  items: EverythingItem[];
  /** Ids currently pinned to the rail. */
  pinned: string[];
  /** The destination showing right now, so the flyout can mark it. */
  currentId?: string;
  onSelect(id: string): void;
  onTogglePin(id: string): void;
  /** Optional: rows may be grouped under headings when the caller supplies them. */
  groups?: { heading: string; ids: string[] }[];
}

/** The heading unavailable rows collect under when the caller supplies no groups. */
const NOT_READY = 'Not ready yet';

/** Matches the `width` `.console .pmenu` already sets in console.css. */
const PANEL_WIDTH = 340;
const GAP = 6;
const EDGE = 16;
/** Long enough that crossing the foot on the way elsewhere opens nothing. */
const HOVER_OPEN_MS = 120;
/** Long enough to cross the gap between the trigger and the panel without losing it. */
const HOVER_CLOSE_MS = 260;

/** What opened the panel. A pointer that wandered in may wander out; a click or a key is a decision. */
export type OpenedBy = 'pointer' | 'intent';

/**
 * What a click on the trigger does. A click on a panel the pointer opened
 * confirms it rather than toggling it shut: a click moves the pointer onto the
 * trigger first, so on a slow machine the hover can win the race, and the
 * person would watch the panel they asked for close under their hand.
 */
export function triggerClick(open: boolean, by: OpenedBy): 'open' | 'keep' | 'close' {
  if (!open) return 'open';
  return by === 'pointer' ? 'keep' : 'close';
}

type Part = 'row' | 'pin';
interface Section {
  heading: string;
  items: EverythingItem[];
}

/**
 * The order the rows are read and walked in. A caller's groups govern
 * completely: its headings, its order inside them, and anything it left out
 * trailing behind with no heading. Without groups the flyout does the one
 * piece of sorting it is entitled to — destinations that cannot be opened yet
 * collect at the end instead of being scattered between working ones.
 *
 * An id that names no item is skipped, an id in two groups belongs to the
 * first, and a group that resolves to nothing does not print a heading.
 */
export function everythingSections(
  items: readonly EverythingItem[],
  groups?: readonly { heading: string; ids: string[] }[],
): Section[] {
  if (groups && groups.length > 0) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const sections: Section[] = [];
    for (const group of groups) {
      const found: EverythingItem[] = [];
      for (const id of group.ids) {
        const item = byId.get(id);
        if (!item || seen.has(id)) continue;
        seen.add(id);
        found.push(item);
      }
      if (found.length > 0) sections.push({ heading: group.heading, items: found });
    }
    const rest = items.filter((item) => !seen.has(item.id));
    if (rest.length > 0) sections.push({ heading: '', items: rest });
    return sections;
  }
  const ready = items.filter((item) => !item.unavailableReason);
  const waiting = items.filter((item) => item.unavailableReason);
  const sections: Section[] = [];
  if (ready.length > 0) sections.push({ heading: '', items: ready });
  if (waiting.length > 0) sections.push({ heading: NOT_READY, items: waiting });
  return sections;
}

/**
 * `html` carries `zoom: var(--dm-ui-scale)`, so a length written inside the
 * Console renders multiplied by that scale while `getBoundingClientRect` and
 * `innerHeight` are already in viewport pixels. Every measurement below is
 * divided by this to get back to the units the panel is written in — the same
 * conversion `.console .pmenu`'s `calc(100vw / var(--dm-ui-scale))` makes.
 */
function cssZoom(element: HTMLElement): number {
  const current = (element as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof current === 'number' && current > 0) return current;
  const declared = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--dm-ui-scale'),
  );
  return Number.isFinite(declared) && declared > 0 ? declared : 1;
}

/**
 * The rail scrolls (`overflow-y: auto`, which makes the other axis clip too),
 * so an absolutely positioned flyout would be cut off at the rail's edge. The
 * panel is fixed and placed from the trigger's own rectangle instead: beside
 * it, growing into whichever of above or below has more room, and never past
 * the window on any side.
 */
function place(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const zoom = cssZoom(trigger);
  const spaceBelow = window.innerHeight - rect.top;
  const spaceAbove = rect.bottom;
  const below = spaceBelow >= spaceAbove;
  const space = below ? spaceBelow : spaceAbove;
  const right = window.innerWidth / zoom - PANEL_WIDTH - GAP;
  return {
    left: Math.max(GAP, Math.min(rect.right / zoom + GAP, right)),
    top: below ? rect.top / zoom : 'auto',
    bottom: below ? 'auto' : (window.innerHeight - rect.bottom) / zoom,
    maxHeight: Math.max(120, Math.min(560, space / zoom - EDGE)),
  };
}

/**
 * Everything: one rail entry that opens onto every destination in the app.
 * Clicking a row goes there; the pin beside it keeps that destination in the
 * sidebar, so a person keeps the few they use and reaches the rest from here.
 * Pinning does not close the panel, because pinning several at once is the
 * normal visit.
 *
 * A destination carrying `unavailableReason` is a first-class row here, not a
 * defensive branch: it is a real place in the app that is not wired to
 * anything yet, and a person meets several on their first visit. It stays
 * readable, stays reachable by arrow key, says plainly why it cannot open, and
 * offers no pin — pinning it would put a dead entry in somebody's sidebar.
 * This is not the availability hedging we take off the marketing site: there, a
 * caveat beside every claim was noise; here, a control that does nothing when
 * clicked is a defect, and one that states why it cannot act yet is correct.
 *
 * The one exception to "no pin" is a `reserved` destination: a place the owner
 * wants held in the sidebar before the work behind it exists, so that wiring it
 * up later moves nothing. The rail draws it inert and says why when pressed.
 *
 * It opens on hover as well as on a click or a key. A panel the pointer opened
 * takes no focus and closes when the pointer leaves; one opened on purpose
 * behaves as it always did. Touch has no hover and is unchanged.
 *
 * Presentation only. It holds no list of its own and remembers nothing: the
 * caller owns `items`, `pinned` and where a row goes.
 */
export function Everything({
  items,
  pinned,
  currentId,
  onSelect,
  onTogglePin,
  groups,
}: EverythingProps) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<CSSProperties | null>(null);
  // The row the keyboard is on. Both of that row's controls are tabbable and
  // every other row's are not, so Tab reaches the pin beside the destination it
  // belongs to and then leaves the panel, while Up and Down walk the rows.
  const [active, setActive] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const by = useRef<OpenedBy>('intent');
  const opening = useRef<number | null>(null);
  const closing = useRef<number | null>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const headingId = useId();

  const sections = everythingSections(items, groups);
  const rows = sections.flatMap((section) => section.items);
  // Items can change while the panel is open. Walk from an id, and fall back to
  // the first row when the one we were on is gone, so a refresh never leaves
  // the keyboard with nowhere to be.
  const activeId = rows.some((row) => row.id === active) ? active : (rows[0]?.id ?? null);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current;
    if (!anchor) return;
    const measure = () => setBox(place(anchor));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  // Opening puts the keyboard on the destination showing now, or on the first
  // row when it is not in the list. A panel the pointer opened gets the tab stop
  // but not the focus: hovering must never move a person's caret.
  function enter(focus: boolean) {
    const wanted = currentId && rows.some((row) => row.id === currentId) ? currentId : rows[0]?.id;
    if (!wanted) return;
    setActive(wanted);
    if (focus) cells.current.get(`${wanted}:row`)?.focus();
  }
  useEffect(() => {
    if (open) enter(by.current === 'intent');
  }, [open]);

  function cancel(timer: { current: number | null }) {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(
    () => () => {
      cancel(opening);
      cancel(closing);
    },
    [],
  );

  function onTrigger() {
    cancel(opening);
    cancel(closing);
    const outcome = triggerClick(open, by.current);
    by.current = 'intent';
    if (outcome === 'keep') enter(true);
    else setOpen(outcome === 'open');
  }

  function onPointerEnter(event: React.PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    cancel(closing);
    if (open || opening.current !== null) return;
    opening.current = window.setTimeout(() => {
      opening.current = null;
      by.current = 'pointer';
      setOpen(true);
    }, HOVER_OPEN_MS);
  }

  function onPointerLeave(event: React.PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    cancel(opening);
    if (!open || by.current !== 'pointer') return;
    closing.current = window.setTimeout(() => {
      closing.current = null;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = root.current?.contains(document.activeElement);
      setOpen(false);
      if (inside) trigger.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function announce(text: string) {
    setSaid((prev) => ({ text, seq: prev.seq + 1 }));
  }

  function focusCell(id: string, part: Part) {
    const cell = cells.current.get(`${id}:${part}`) ?? cells.current.get(`${id}:row`);
    cell?.focus();
  }

  function select(item: EverythingItem) {
    if (item.unavailableReason) {
      // Not silently inert: it says why, and takes the focus ring so the
      // reason is where the person just clicked.
      focusCell(item.id, 'row');
      announce(`${item.label} cannot open yet. ${item.unavailableReason}`);
      return;
    }
    // Synchronously, before the caller navigates, so a destination that moves
    // focus itself still wins.
    trigger.current?.focus();
    setOpen(false);
    onSelect(item.id);
  }

  function togglePin(item: EverythingItem) {
    const was = pinned.includes(item.id);
    // Unpinning a destination that is not ready takes its own control away
    // with it, so the row catches the focus before the button goes.
    if (was && item.unavailableReason) focusCell(item.id, 'row');
    announce(`${item.label} ${was ? 'removed from' : 'pinned to'} the sidebar`);
    onTogglePin(item.id);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key))
      return;
    const index = rows.findIndex((row) => row.id === activeId);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Ends clamp rather than wrap, the way the file tree and the picker do.
    if (event.key === 'ArrowRight') {
      focusCell(rows[index].id, 'pin');
      return;
    }
    if (event.key === 'ArrowLeft') {
      focusCell(rows[index].id, 'row');
      return;
    }
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, index + 1)
            : Math.max(0, index - 1);
    focusCell(rows[next].id, 'row');
  }

  function keep(key: string) {
    return (element: HTMLButtonElement | null) => {
      if (element) cells.current.set(key, element);
      else cells.current.delete(key);
    };
  }

  function renderRow(item: EverythingItem) {
    const unavailable = !!item.unavailableReason;
    const isPinned = pinned.includes(item.id);
    const here = item.id === currentId;
    const on = activeId === item.id;
    const state = [here ? 'Showing now' : '', isPinned ? 'Pinned' : ''].filter(Boolean).join(' · ');
    // Nothing that cannot be opened is offered a pin, because that would put a
    // dead entry in somebody's sidebar. One that is already pinned keeps the
    // control, or a destination pinned before it stalled could never be taken
    // back out from here.
    const pinnable = !unavailable || isPinned || !!item.reserved;
    return (
      <div className="ev-row" role="none" key={item.id}>
        <button
          type="button"
          role="menuitem"
          ref={keep(`${item.id}:row`)}
          className={`m ev-open${here ? ' on' : ''}`}
          // Focusable and explained, never removed from the walk: a row the
          // keyboard cannot reach is a row whose reason is never read.
          aria-disabled={unavailable || undefined}
          aria-current={here ? 'true' : undefined}
          tabIndex={on ? 0 : -1}
          onFocus={() => setActive(item.id)}
          onClick={() => select(item)}
        >
          <span className="ev-label">{item.label}</span>
          {item.badge && <span className="id">{item.badge}</span>}
          <small>{item.hint}</small>
          {item.unavailableReason && (
            <small className="ev-reason">Not ready · {item.unavailableReason}</small>
          )}
          {state && <small className="ev-state">{state}</small>}
        </button>
        {pinnable && (
          <button
            type="button"
            ref={keep(`${item.id}:pin`)}
            className="ev-pin"
            aria-pressed={isPinned}
            aria-label={
              isPinned
                ? `Remove ${item.label} from the sidebar`
                : `Pin ${item.label} to the sidebar`
            }
            title={
              isPinned
                ? `Remove ${item.label} from the sidebar`
                : `Pin ${item.label} to the sidebar`
            }
            tabIndex={on ? 0 : -1}
            onFocus={() => setActive(item.id)}
            onClick={() => togglePin(item)}
          >
            {isPinned ? 'Remove' : 'Pin'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="everything"
      ref={root}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <button
        type="button"
        ref={trigger}
        className={`ev-trigger${open ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onTrigger}
      >
        Everything
      </button>
      {open && (
        <div
          className="pmenu open ev-panel"
          role="menu"
          aria-label="Everything"
          style={box ?? undefined}
          onKeyDown={onKeyDown}
          // Pressing anything in here is a decision: the panel stops following
          // the pointer, so pinning three destinations does not end when the
          // hand drifts off the edge.
          onPointerDown={() => {
            by.current = 'intent';
            cancel(closing);
          }}
          // Tab out of the last control closes the panel rather than leaving it
          // open behind the person. Focus is never pulled back here: that would
          // be a trap.
          onBlur={(event) => {
            if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false);
          }}
        >
          {rows.length === 0 ? (
            <p className="note">There is nothing to open here yet.</p>
          ) : (
            sections.map((section, index) =>
              section.heading ? (
                <div
                  key={section.heading}
                  role="group"
                  aria-labelledby={`${headingId}-${index}`}
                  className="ev-group"
                >
                  <h4 id={`${headingId}-${index}`}>{section.heading}</h4>
                  {section.items.map(renderRow)}
                </div>
              ) : (
                <div key={`ungrouped-${index}`} role="none" className="ev-group">
                  {section.items.map(renderRow)}
                </div>
              ),
            )
          )}
        </div>
      )}
      {/* Mounted whether or not the panel is, so a pin announcement is a change
          inside a region the reader is already watching. */}
      <p className="ev-said" role="status">
        <span key={said.seq}>{said.text}</span>
      </p>
    </div>
  );
}
