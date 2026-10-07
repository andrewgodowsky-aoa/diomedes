import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  Conversation,
  EngineCatalog,
  EngineModel,
  IntegrationStatus,
  Mode,
  Route,
  Settings,
  Turn,
} from '../../shared/types';
import type { EngineConnection } from '../../shared/engines';
import { isExternalEngine } from '../../shared/engines';
import { NECTOVIA_ROUTE } from '../../shared/model-api';
import { localSlug } from '../../shared/local-model';
import { effortFor } from '../../shared/effort';
import type { WorkStyle } from '../../shared/work-style';
import { api, engineConnections } from '../api';
import { NectoviaMark } from './NectoviaMark';
import type { WorkStyleView } from './WorkStylePicker';
import {
  LOCAL_MODEL,
  NECTOVIA_LOCKED,
  ROW_ENGINES,
  START,
  STARTING,
  START_LOCAL,
  contextAmount,
  contextGauge,
  contextLine,
  contextWindowLine,
  currentModel,
  currentTier,
  effortState,
  effortWord,
  engineEntries,
  engineLabel,
  engineName,
  localChoice,
  localModel,
  localProfileEntries,
  localReady,
  localStoppedLine,
  offeredEngine,
  shownEngine,
  startingModel,
  tierBars,
  tierEntries,
  tierLabel,
  type EffortState,
  type EngineEntry,
  type LocalModel,
} from './ask-row';
import './ask-row.css';

/** One choice from the row, written to the thread in a single update. */
export interface AskChange {
  engine?: Route;
  requested?: Conversation['requested'];
  workStyle?: WorkStyle | null;
}

const PATHS = {
  chev: <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  term: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 10l3 2-3 2" />
      <path d="M12.5 15H17" />
    </>
  ),
  chip: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" />
    </>
  ),
  gauge: (
    <>
      <path d="M4.5 16.5a7.5 7.5 0 0 1 15 0" />
      <path d="M12 16.5l3.6-4.4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  attach: (
    <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
  ),
  send: (
    <>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </>
  ),
  power: (
    <>
      <path d="M12 4v7" />
      <path d="M7.4 7.2a7 7 0 1 0 9.2 0" />
    </>
  ),
} as const;

export function AskIcon({
  name,
  size = 16,
  stroke = 1.8,
}: {
  name: keyof typeof PATHS;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

function Bars({ lit }: { lit: number }) {
  return (
    <span className="ask-bars" aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <span key={n} className={n <= lit ? 'on' : ''} />
      ))}
    </span>
  );
}

/** Closes a popup on a press outside it, and on Escape, handing focus back to its opener. */
function usePopup() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    close();
  };
  return { open, setOpen, root, opener, close, onKeyDown };
}

/**
 * Puts a popup above its own box, starting where the box starts but never past the right edge of
 * the bar, which is the popup's containing block. Layout offsets rather than screen rectangles,
 * so the interface scale cancels out.
 */
function place(menu: HTMLElement, box: HTMLElement) {
  const bar = menu.offsetParent;
  if (!(bar instanceof HTMLElement)) return;
  const room = bar.clientWidth - menu.offsetWidth;
  menu.style.left = `${Math.max(0, Math.min(box.offsetLeft, room))}px`;
}

/** A box and the popup it opens. The popup opens upward: the row sits at the foot of the page. */
function Box({
  className = '',
  label,
  glyph,
  text,
  title,
  disabled = false,
  popup = 'menu',
  children,
}: {
  className?: string;
  label: string;
  glyph: ReactNode;
  text: string;
  title?: string;
  disabled?: boolean;
  popup?: 'menu' | 'dialog';
  children(close: () => void): ReactNode;
}) {
  const { open, setOpen, root, opener, close, onKeyDown } = usePopup();
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className={`ask-box ${className}`.trim()} ref={root} onKeyDown={onKeyDown}>
      <button
        ref={opener}
        type="button"
        className="ask-pick"
        aria-haspopup={popup}
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="ask-glyph">{glyph}</span>
        <span className="ask-text">{text}</span>
        <span className="ask-chev">
          <AskIcon name="chev" size={14} stroke={2} />
        </span>
      </button>
      {open && children(close)}
    </div>
  );
}

/** Up and Down move between a menu's choices; Home and End jump to its ends. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)',
    ),
  ];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next].focus();
}

/** A popup's body. `onOpen` runs once, when it appears: a menu reads its engine on opening. */
function Menu({
  label,
  className = '',
  role = 'menu',
  onOpen,
  children,
}: {
  label: string;
  className?: string;
  role?: 'menu' | 'dialog';
  onOpen?(): void;
  children: ReactNode;
}) {
  const ran = useRef(false);
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    onOpen?.();
  });
  useLayoutEffect(() => {
    const menu = self.current;
    if (menu?.parentElement) place(menu, menu.parentElement);
  });
  return (
    <div
      ref={self}
      className={`ask-menu ${className}`.trim()}
      role={role}
      aria-label={label}
      onKeyDown={role === 'menu' ? moveFocus : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The Agent control keeps its own menu (AgentPicker.tsx). Its box here places that menu the way
 * the row places its own, whenever the menu opens.
 */
function AgentBox({ children }: { children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    const fit = () => {
      const menu = box.querySelector<HTMLElement>('.pmenu.open');
      if (menu) place(menu, box);
    };
    const watch = new MutationObserver(fit);
    watch.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);
  return (
    <div className="ask-box ask-agent" ref={wrap}>
      {children}
    </div>
  );
}

function Item({
  checked,
  disabled = false,
  glyph,
  name,
  sub,
  right,
  locked = false,
  onPick,
}: {
  checked: boolean;
  disabled?: boolean;
  glyph?: ReactNode;
  name: string;
  sub?: string;
  right?: ReactNode;
  locked?: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      className="ask-item"
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="ask-check">{checked && <AskIcon name="check" size={16} stroke={2.4} />}</span>
      <span className="ask-mark">{glyph}</span>
      <span className="ask-name">
        <span className="ask-title">
          {name}
          {locked && (
            <span className="ask-lock">
              <AskIcon name="lock" size={13} stroke={2} />
            </span>
          )}
        </span>
        {sub && <span className="ask-sub">{sub}</span>}
      </span>
      {right && <span className="ask-right">{right}</span>}
    </button>
  );
}

/**
 * The thread's catalogue entry on the local model, as the host declares it: what the ring's
 * window is and whether a message may carry images. Null on every other route, and until the
 * catalogue answers.
 */
export function useLocalProfile(
  route: Route,
  integrations: readonly IntegrationStatus[],
  slug: string | null | undefined,
): EngineModel | null {
  const local = localModel(integrations);
  const onLocal = local !== null && route === local.route;
  const [models, setModels] = useState<EngineModel[] | null>(null);
  useEffect(() => {
    if (!onLocal) {
      setModels(null);
      return;
    }
    let alive = true;
    api<EngineCatalog>(`/engines/${encodeURIComponent(route)}/models`)
      .then((catalog) => {
        if (alive) setModels(catalog.models);
      })
      .catch(() => {
        if (alive) setModels(null);
      });
    return () => {
      alive = false;
    };
  }, [onLocal, route]);
  // A profile saved under its earlier name reads as the profile it was.
  const wanted = localSlug(slug);
  return onLocal && wanted ? (models?.find((model) => model.slug === wanted) ?? null) : null;
}

/** The Start inside an open menu: the one way the row wakes the local model. */
function StartItem({ starting, disabled, onStart }: { starting: boolean; disabled: boolean; onStart(): void }) {
  return (
    <button
      type="button"
      className="ask-item ask-start-item"
      role="menuitem"
      disabled={disabled || starting}
      onClick={onStart}
    >
      <span className="ask-check" />
      <span className="ask-mark">
        <AskIcon name="power" />
      </span>
      <span className="ask-name">
        <span className="ask-title">{starting ? STARTING : START_LOCAL}</span>
      </span>
    </button>
  );
}

/**
 * The Effort box: the model's own levels as a slider, the thread's choice, and Fix's ceiling.
 * The words around it are the caller's, so a local profile and another engine each say theirs.
 */
function EffortBox({
  mode,
  effort,
  current,
  waiting,
  locked,
  head,
  unlisted,
  defaultLine,
  onOpen,
  onPick,
}: {
  mode: Mode;
  effort: EffortState;
  current: { slug: string; model: EngineModel | null } | null;
  waiting?: string;
  locked: boolean;
  head: string;
  /** What the popup says before the model's levels are listed. */
  unlisted: string;
  /** The line naming the model's own default, or null. */
  defaultLine: string | null;
  onOpen?(): void;
  onPick(level: string): void;
}) {
  const at = effort.wanted ? effort.levels.findIndex((level) => level.id === effort.wanted) : -1;
  const effortText = effort.runs ? effortWord(effort.runs) : 'Default';
  const listsNoLevels = Boolean(current?.model) && effort.levels.length === 0;
  const step = (index: number) => (effort.levels.length > 1 ? (index / (effort.levels.length - 1)) * 100 : 50);
  return (
    <Box
      className={`ask-effort${effort.capped ? ' capped' : ''}`}
      label={`Effort: ${effortText}`}
      text={effortText}
      popup="dialog"
      title={
        waiting ??
        (listsNoLevels
          ? 'This model has no effort setting.'
          : effort.capped && effort.wanted
            ? `${effortWord(effort.wanted)}, runs ${effortText}`
            : undefined)
      }
      disabled={locked || listsNoLevels}
      glyph={<AskIcon name="gauge" />}
    >
      {(close) => (
        <Menu label="Effort" role="dialog" className="ask-effort-menu" onOpen={onOpen}>
          <p className="ask-head">{head}</p>
          {effort.levels.length > 0 && current ? (
            <div
              className="ask-slider"
              role="radiogroup"
              aria-label="Effort"
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const stops = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
                const from = stops.indexOf(document.activeElement as HTMLButtonElement);
                const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                stops[Math.max(0, Math.min(stops.length - 1, (from < 0 ? at : from) + delta))]?.focus();
              }}
            >
              <span className="ask-track">
                <span className="ask-fill" style={{ width: `${at >= 0 ? step(at) : 0}%` }} />
              </span>
              {effort.levels.map((level, index) => (
                <button
                  key={level.id}
                  type="button"
                  role="radio"
                  aria-checked={level.id === effort.wanted}
                  aria-label={effortWord(level.id)}
                  title={level.description || undefined}
                  className={[
                    'ask-stop',
                    index <= at ? 'on' : '',
                    level.id === effort.wanted ? 'cur' : '',
                    effortFor(mode, level.id, level.id) !== level.id ? 'capped' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: `${step(index)}%` }}
                  onClick={() => {
                    close();
                    onPick(level.id);
                  }}
                >
                  <span className="ask-knob" />
                  <span className="ask-level">{effortWord(level.id)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="ask-note">{current?.model ? 'This model has no effort setting.' : unlisted}</p>
          )}
          {effort.ceiling && mode === 'fix' ? (
            <p className="ask-note">
              <b>Fix runs at {effortWord(effort.ceiling)}.</b> Your choice still governs Ask, Plan and Build.
            </p>
          ) : (
            defaultLine && <p className="ask-note">{defaultLine}</p>
          )}
        </Menu>
      )}
    </Box>
  );
}

export interface AskRowProps {
  thread: Conversation;
  mode: Mode;
  /** The thread's recorded route: the person's choice. */
  route: Route;
  integrations: IntegrationStatus[];
  settings: Settings;
  /** The host's answer for the next request: the model and level a style resolves to. */
  styleView: WorkStyleView | null;
  /** The free version: Nectovia is listed grayed, with the way to use it. */
  free: boolean;
  /** Model names show: in Work, and for a paid person on their own engine. */
  names: boolean;
  /** A run is live or a send is in flight; nothing here changes until it ends. */
  locked: boolean;
  onChoose(change: AskChange): void;
  /** The Agent control, drawn by the caller. */
  agent?: ReactNode;
  /** Server-rendered fixture; production reads each engine's catalogue when it is needed. */
  initialCatalogs?: Record<string, EngineCatalog>;
  /** The engines listed after Nectovia. The project row's engines unless given. */
  engines?: readonly Route[];
}

/**
 * The ask box's row: Engine, Model or tier, Effort (an engine other than Nectovia only), then
 * the Agent. Each choice is one thread update. Opening a menu reads its engine again, so a model
 * list follows the account and any update made outside the app.
 *
 * On the local model the second box lists its profiles from the host's catalogue and Effort
 * holds the profile's own levels, as for any other engine; on a paid plan the same menu leads
 * with the tiers, the way back to Nectovia. Choosing the local model or a profile never wakes
 * it: only the person's Start does, offered where the choice is grayed or the profile is not
 * loaded.
 */
export function AskRow({
  thread,
  mode,
  route,
  integrations,
  settings,
  styleView,
  free,
  names,
  locked,
  onChoose,
  agent = null,
  initialCatalogs = {},
  engines = ROW_ENGINES,
}: AskRowProps) {
  const [connections, setConnections] = useState<Partial<Record<string, EngineConnection>>>({});
  const [catalogs, setCatalogs] = useState<Record<string, EngineCatalog>>(initialCatalogs);
  // The local model's entry as last read on its own. The page reads its list once, at start.
  const [fresh, setFresh] = useState<IntegrationStatus[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A failed Start is said where it was pressed, and not carried to another thread.
  useEffect(() => setStartError(null), [thread.id, route]);
  const listed = localModel(integrations);
  const local: LocalModel | null = fresh ? localModel(fresh) : listed;
  const shown = shownEngine(route, local, free);
  const onNectovia = shown === NECTOVIA_ROUTE;
  const localRoute = local && route === local.route ? local.route : null;

  const readRoster = () =>
    engineConnections()
      .then((rows) => {
        if (alive.current) setConnections(Object.fromEntries(rows.map((row) => [row.engine, row])));
      })
      .catch(() => {
        // A failed read leaves the last answer in place; nothing is invented.
      });
  // The roster is answered from memory and starts no process, so the closed boxes can name the
  // thread's model without waiting for a menu.
  useEffect(() => {
    void readRoster();
  }, []);

  const readCatalog = (id: string): Promise<EngineCatalog | null> =>
    api<EngineCatalog>(`/engines/${encodeURIComponent(id)}/models`)
      .then((catalog) => {
        if (alive.current) setCatalogs((prev) => ({ ...prev, [id]: catalog }));
        return catalog;
      })
      .catch(() => {
        // An engine that cannot answer keeps whatever it last listed.
        return null;
      });

  /** The local model's status, read on its own. Reading it starts nothing. */
  const readLocal = () =>
    api<{ integrations: IntegrationStatus[] }>('/integrations/local')
      .then((answer) => {
        if (alive.current) setFresh(answer.integrations);
      })
      .catch(() => {
        // A failed read leaves the last answer in place.
      });
  // Once the page lists a local model, its status is read again: the page's list is from its start.
  const listedRoute = listed?.route ?? null;
  useEffect(() => {
    if (listedRoute) void readLocal();
  }, [listedRoute]);
  // A thread on the local model lists its profiles, and reads its status again whenever the
  // window comes back, since the model can be started or stopped outside the app.
  useEffect(() => {
    if (!localRoute) return;
    void readCatalog(localRoute);
    const again = () => void readLocal();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [localRoute]);

  /** Checks every engine that is on again, then the roster, as the thread picker did. */
  const recheck = () => {
    const ids = engines.filter(
      (id) => offeredEngine(id, { integrations, settings, connections }) || settings.services?.[id] === true,
    );
    void Promise.all(ids.map(readCatalog)).then(readRoster);
    if (local) {
      void readCatalog(local.route);
      void readLocal();
    }
  };

  function modelsFor(id: string): EngineModel[] {
    if (catalogs[id]) return catalogs[id].models;
    if (isExternalEngine(id)) return connections[id]?.models ?? [];
    return [];
  }

  const entries = engineEntries({ integrations, settings, connections, free, route, local, engines });
  const waiting = locked ? 'Waiting for the current run to finish' : undefined;
  const engineText = engineLabel(route, { integrations, local, free });
  const savedLocal = local ? localSlug(settings.services?.[`${local.route}Model`]) : undefined;
  const localPick = local ? localChoice(local, modelsFor(local.route), savedLocal) : null;

  /** The person's Start: the one call that wakes the local model. Choosing it never does. */
  const start = (slug: string | null | undefined) => {
    if (!slug || starting) return;
    setStarting(true);
    setStartError(null);
    void api<unknown>('/ai/local-models/wake', 'POST', { model: slug })
      .catch((e: unknown) => {
        if (alive.current) setStartError(e instanceof Error ? e.message : "The local model couldn't start.");
      })
      .then(readLocal)
      .finally(() => {
        if (alive.current) setStarting(false);
      });
  };

  /**
   * Moves the thread to the local model on the profile `localChoice` names, with that profile's
   * own default effort, the way a picked engine pins its model. It starts nothing.
   */
  const chooseLocal = async () => {
    if (!local) return;
    const listedModels = modelsFor(local.route);
    const models = listedModels.length ? listedModels : ((await readCatalog(local.route))?.models ?? []);
    const pick = localChoice(local, models, savedLocal);
    if (!pick || !alive.current) return;
    onChoose({ engine: local.route, requested: { model: pick.slug, effort: pick.defaultEffort } });
  };

  function pickEngine(id: Route) {
    if (id === shown) return;
    if (local && id === local.route) {
      void chooseLocal();
      return;
    }
    if (id === NECTOVIA_ROUTE) {
      onChoose({ engine: id, requested: null });
      return;
    }
    const first = startingModel(modelsFor(id), settings.services?.[`${id}Model`]);
    onChoose({ engine: id, requested: first ? { model: first.slug, effort: first.defaultEffort } : null });
  }

  // Where the local model is listed but grayed, its Start sits beside it in the open menu.
  const startItem =
    local && local.found && !local.running ? (
      <>
        <StartItem starting={starting} disabled={locked || !localPick} onStart={() => start(localPick?.slug)} />
        {startError && (
          <p className="ask-note" role="alert">
            {startError}
          </p>
        )}
      </>
    ) : null;

  const engineBox = (
    <Box
      className="ask-engine"
      label={`Engine: ${engineText}`}
      text={engineText}
      title={waiting}
      disabled={locked}
      glyph={
        onNectovia ? (
          <span className="ask-nv">
            <NectoviaMark word={false} size={16} />
            <span className="ask-online" />
          </span>
        ) : (
          <AskIcon name="term" />
        )
      }
    >
      {(close) => (
        <EngineMenu
          entries={entries}
          shown={shown}
          onOpen={recheck}
          onPick={(id) => {
            close();
            pickEngine(id);
          }}
          // On the free version the local model is listed here as an engine of its own.
          extra={free ? startItem : null}
        />
      )}
    </Box>
  );

  let modelBox: ReactNode = null;
  let effortBox: ReactNode = null;
  let localLine: ReactNode = null;
  if (local && localRoute) {
    const models = modelsFor(local.route);
    const slug = localSlug(thread.requested?.model);
    const current = currentModel(models, slug, null);
    const named = names && current?.model ? current.model.name : null;
    const modelText = names && current ? (current.model?.name ?? current.slug) : LOCAL_MODEL;
    modelBox = (
      <Box
        className="ask-model"
        label={`Model: ${modelText}`}
        text={modelText}
        title={waiting}
        disabled={locked}
        glyph={<AskIcon name="chip" />}
      >
        {(close) => (
          <Menu
            label={free ? 'Model' : 'How much care'}
            onOpen={() => {
              void readCatalog(local.route);
              void readLocal();
            }}
          >
            {/* A paid plan's way back to Nectovia: the local model is one of its options. */}
            {!free && (
              <>
                <p className="ask-head">How much care</p>
                {tierEntries(null, null, names).map((entry) => (
                  <Item
                    key={entry.id}
                    checked={false}
                    glyph={<Bars lit={entry.bars} />}
                    name={entry.name}
                    sub={entry.sub}
                    onPick={() => {
                      close();
                      if (entry.id === 'local') return;
                      onChoose({ engine: NECTOVIA_ROUTE, requested: null, workStyle: entry.id });
                    }}
                  />
                ))}
              </>
            )}
            <p className="ask-head">{LOCAL_MODEL}</p>
            {models.length === 0 && !catalogs[local.route] && (
              <p className="ask-note">Local model profiles are unavailable.</p>
            )}
            {localProfileEntries(local, models, names).map((entry) => (
              <Item
                key={entry.slug}
                checked={current?.slug === entry.slug}
                glyph={<AskIcon name="chip" />}
                name={entry.name}
                sub={entry.sub}
                right={
                  entry.running ? (
                    <>
                      <span className="ask-dot" aria-hidden="true" />
                      Running
                    </>
                  ) : undefined
                }
                onPick={() => {
                  close();
                  if (slug === entry.slug) return;
                  const model = models.find((item) => item.slug === entry.slug);
                  onChoose({
                    engine: local.route,
                    requested: { model: entry.slug, effort: model?.defaultEffort ?? null },
                  });
                }}
              />
            ))}
          </Menu>
        )}
      </Box>
    );
    if (current) {
      const effort = effortState(current.model, thread.requested?.effort, null, mode);
      const fallback = current.model?.defaultEffort ? effortWord(current.model.defaultEffort) : null;
      effortBox = (
        <EffortBox
          mode={mode}
          effort={effort}
          current={current}
          waiting={waiting}
          locked={locked}
          head={named ? `Effort for ${named}` : 'Effort'}
          unlisted="This profile's effort settings are unavailable."
          defaultLine={fallback ? (named ? `The default for ${named} is ${fallback}.` : `The default is ${fallback}.`) : null}
          onPick={(level) => {
            if (level === effort.wanted && slug === current.slug) return;
            onChoose({ engine: local.route, requested: { model: current.slug, effort: level } });
          }}
        />
      );
    }
    // Withdrawn and said so: a profile that isn't loaded is never swapped for a cloud model.
    const line = starting ? STARTING : localStoppedLine(local, slug, free);
    if (line || startError)
      localLine = (
        <div className="ask-local">
          {line && (
            <p className="ask-stopped" role="status">
              {line}
            </p>
          )}
          {startError && !starting && (
            <p className="ask-stopped" role="alert">
              {startError}
            </p>
          )}
          {slug && !localReady(local, slug) && (
            <button
              type="button"
              className="ask-start"
              disabled={locked || starting}
              title={waiting}
              onClick={() => start(slug)}
            >
              {START}
            </button>
          )}
        </div>
      );
  } else if (onNectovia) {
    const tier = currentTier(thread, settings, route, local);
    const localName = names && localPick ? localPick.name : null;
    modelBox = (
      <Box
        className="ask-tier"
        label={`How much care: ${tierLabel(tier)}`}
        text={tierLabel(tier)}
        // The free version keeps Nectovia in view, grayed, with the way to use it.
        title={waiting ?? (free ? NECTOVIA_LOCKED : undefined)}
        disabled={locked || free}
        glyph={tier === 'local' ? <AskIcon name="chip" /> : <Bars lit={tierBars(tier)} />}
      >
        {(close) => (
          <Menu
            label="How much care"
            onOpen={
              local
                ? () => {
                    void readCatalog(local.route);
                    void readLocal();
                  }
                : undefined
            }
          >
            <p className="ask-head">How much care</p>
            {tierEntries(local, localName, names).map((entry) => (
              <Item
                key={entry.id}
                checked={entry.id === tier}
                disabled={entry.disabled}
                glyph={entry.id === 'local' ? <AskIcon name="chip" /> : <Bars lit={entry.bars} />}
                name={entry.name}
                sub={entry.sub}
                onPick={() => {
                  close();
                  if (entry.id === tier) return;
                  if (entry.id === 'local') {
                    void chooseLocal();
                    return;
                  }
                  onChoose({
                    // A model pin left from another engine goes with a style; the Agent stays.
                    ...(thread.requested?.model ? { requested: null } : {}),
                    workStyle: entry.id,
                  });
                }}
              />
            ))}
            {startItem}
          </Menu>
        )}
      </Box>
    );
  } else if (route !== 'sample') {
    // Sample work is deterministic and lists no choices (server/models.ts), so it has no model
    // or effort box.
    const models = modelsFor(route);
    const answered = styleView?.route === route ? styleView.resolution : null;
    const current = currentModel(models, thread.requested?.model, answered?.model);
    const savedEffort =
      route === 'codex' && typeof settings.services?.codexEffort === 'string' ? settings.services.codexEffort : null;
    const effort = effortState(current?.model ?? null, thread.requested?.effort, savedEffort ?? answered?.effort, mode);
    const engine = engineName(route, integrations);
    const modelText = current ? (current.model?.name ?? current.slug) : 'Default';
    modelBox = (
      <Box
        className="ask-model"
        label={`Model: ${modelText}`}
        text={modelText}
        title={waiting}
        disabled={locked}
        glyph={<AskIcon name="chip" />}
      >
        {(close) => (
          <Menu label="Model" onOpen={() => void readCatalog(route)}>
            {catalogs[route]?.detail && <p className="ask-head">{catalogs[route].detail}</p>}
            {models.length === 0 && !catalogs[route] && (
              <p className="ask-note">The model list for {engine} is unavailable.</p>
            )}
            {models.map((model) => (
              <Item
                key={model.slug}
                checked={current?.slug === model.slug}
                name={model.name}
                sub={model.description}
                onPick={() => {
                  close();
                  if (thread.requested?.model === model.slug) return;
                  onChoose({ engine: route, requested: { model: model.slug, effort: model.defaultEffort } });
                }}
              />
            ))}
          </Menu>
        )}
      </Box>
    );
    effortBox = (
      <EffortBox
        mode={mode}
        effort={effort}
        current={current}
        waiting={waiting}
        locked={locked}
        head={current?.model ? `Effort for ${current.model.name}` : 'Effort'}
        unlisted={`This model's effort settings are unavailable from ${engine}.`}
        defaultLine={
          current?.model?.defaultEffort
            ? `${engine}’s default for ${current.model.name} is ${effortWord(current.model.defaultEffort)}.`
            : null
        }
        onOpen={!catalogs[route] && !isExternalEngine(route) ? () => void readCatalog(route) : undefined}
        onPick={(level) => {
          if (!current) return;
          if (level === effort.wanted && thread.requested?.model === current.slug) return;
          onChoose({ engine: route, requested: { model: current.slug, effort: level } });
        }}
      />
    );
  }

  return (
    <div className="ask-row" role="group" aria-label="AI settings for this thread">
      {engineBox}
      {modelBox}
      {effortBox}
      {agent && <AgentBox>{agent}</AgentBox>}
      {localLine}
    </div>
  );
}

function EngineMenu({
  entries,
  shown,
  onOpen,
  onPick,
  extra = null,
}: {
  entries: EngineEntry[];
  shown: Route;
  onOpen(): void;
  onPick(id: Route): void;
  /** Drawn after the engines: the local model's Start, where it is listed grayed. */
  extra?: ReactNode;
}) {
  return (
    <Menu label="Engines" className="ask-engines" onOpen={onOpen}>
      <p className="ask-head">Engines</p>
      {entries.map((entry) => (
        <Item
          key={entry.id}
          checked={entry.id === shown}
          disabled={entry.disabled}
          locked={entry.locked}
          glyph={
            entry.id === NECTOVIA_ROUTE ? <NectoviaMark word={false} size={18} /> : <AskIcon name="term" size={18} />
          }
          name={entry.name}
          sub={entry.sub}
          right={
            entry.online ? (
              <>
                <span className="ask-dot" aria-hidden="true" />
                Online
              </>
            ) : undefined
          }
          onPick={() => onPick(entry.id)}
        />
      ))}
      {extra}
    </Menu>
  );
}

/**
 * The context ring: always present, filled from the newest answer's own record. Opening it lists
 * what filled the context. With no declared window it counts tokens instead of a percentage.
 * `window` is the window the thread's current model declares, when it declares one: a local
 * profile's own size.
 */
export function ContextRing({
  turns,
  window: declared = null,
}: {
  turns: readonly Pick<Turn, 'role' | 'context'>[];
  window?: number | null;
}) {
  const gauge = contextGauge(turns, declared);
  const line = contextLine(gauge);
  const size = contextWindowLine(gauge);
  const circumference = 2 * Math.PI * 8;
  const filled = gauge.percent === null ? 0 : (gauge.percent / 100) * circumference;
  const { open, setOpen, root, opener, onKeyDown } = usePopup();
  return (
    <div className="ask-ring-box" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={opener}
        type="button"
        className="ask-ring"
        aria-label={line}
        title={size ? `${line}. ${size}` : line}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
          <circle className="ask-ring-track" cx="11" cy="11" r="8" fill="none" strokeWidth="2.4" />
          <circle
            className="ask-ring-fill"
            cx="11"
            cy="11"
            r="8"
            fill="none"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`}
            transform="rotate(-90 11 11)"
          />
        </svg>
      </button>
      {open && (
        <div className="ask-menu ask-context" role="dialog" aria-label="Context">
          <p className="ask-context-line">{line}</p>
          {size && <p className="ask-context-size">{size}</p>}
          {gauge.rows.length > 0 && (
            <ul>
              {gauge.rows.map((row) => (
                <li key={row.label}>
                  <span>{row.label}</span>
                  <span className="ask-num">{contextAmount(row)}</span>
                  {row.percent !== null && (
                    <span className="ask-meter">
                      <span style={{ width: `${row.percent}%` }} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
