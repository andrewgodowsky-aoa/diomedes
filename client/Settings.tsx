import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  EngineCatalog,
  ExternalEngine,
  IntegrationStatus,
  Settings as SettingsModel,
  UsageSnapshot,
} from '../shared/types';
import type { ThemePackV1 } from '../shared/theme-pack/types';
import { api } from './api';
import {
  CONVERSATION_TEXT_SCALES,
  INTERFACE_SCALES,
  conversationTextLabel,
} from '../shared/interface-scale';
import { AppUpdates, useInstalledVersion } from './AppUpdates';
import { freshnessLine, planLine, shouldShowEmptyDetail } from './usage-presentation';
import { AIConnections } from './AISetup';
import { ReadConnectors } from './ReadConnectors';
import { isExternalEngine } from '../shared/engines';
import { SCHEMES, schemeId } from './console/schemes';
import { readCustomizationStatus } from './console/design-center/entitlement-api';
import {
  Button,
  Mark,
  Modal,
  UsageBar,
  leftPercent,
  tightestWindow,
  detailDescriptions,
  meterLine,
  titleCase,
} from './components';

/** The runtime's own effort ids read badly title-cased ('Xhigh'), so name them. */
const effortNames: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

function resetLine(resetsAt: string | null): string {
  if (!resetsAt) return 'No reset time reported.';
  const at = new Date(resetsAt);
  const day = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const clock = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Resets ${day}, ${clock}.`;
}

export function SettingsPage({
  settings,
  save,
  patchAppearance,
  integrations,
  usage,
  openHelpersSignal,
  sectionRequest,
  refresh,
  onOpenDesignCenter,
  onStartFirstTask,
  appliedTheme = null,
  themeApplies = false,
}: {
  settings: SettingsModel;
  save: (value: SettingsModel) => Promise<void>;
  /**
   * Write one appearance field and name only that field.
   *
   * The Appearance screen used to send `{ ...settings, appearance: { ...settings.appearance, … } }`
   * for every control on it. Two things were wrong with that. It echoed
   * `appearance.activeTheme` back from a snapshot this screen may have taken
   * before a theme was applied, which quietly un-applied it; and picking a
   * built-in scheme while a theme was applied did nothing visible, because the
   * theme is what the resolver paints and the scheme underneath it is not.
   * Every control here now owns one field, the way the Ctrl+Plus handler does.
   */
  patchAppearance: (patch: Record<string, unknown>) => Promise<void>;
  integrations: IntegrationStatus[];
  usage: UsageSnapshot[];
  openHelpersSignal?: number;
  /** A section asked for by name from outside, e.g. the Projects page's rail. */
  sectionRequest?: { section: string; n: number } | null;
  refresh: () => void;
  /** Opens the full Design Center workspace. Console only. */
  onOpenDesignCenter?: () => void;
  /**
   * Closes Settings and puts the person in front of a composer on the route a
   * test just verified. Console only, and never a send: what it carries is the
   * thread's route and model choice.
   */
  onStartFirstTask?: (route: ExternalEngine, model: string, effort: string | null) => void;
  /**
   * The custom theme this app is actually wearing, or null for a built-in
   * package. The resolved answer from `GET /api/themes/active`, held by
   * `client/App.tsx` and passed down — never `appearance.activeTheme`.
   *
   * The pointer is one field in one global settings file while themes are
   * stored per workspace, so in a workspace where the theme was not applied
   * the pointer is set and the built-in package is what paints. Reading the
   * pointer here made this screen say a theme was applied over a built-in
   * scheme, show no scheme as selected, and offer to "put away" a theme that
   * belongs to another workspace.
   */
  appliedTheme?: ThemePackV1 | null;
  /**
   * `applies` from `GET /api/themes/active`: the pointer is this workspace's
   * own, whether or not anything could be read through it.
   *
   * The two are not the same question, and the difference is a person who
   * cannot get back. A pointer at a theme whose `pack.json` and
   * last-known-good are both unreadable paints the built-in package and
   * carries a notice on every launch — so `appliedTheme` is null while the
   * pointer is very much still here. Gating the way back on the pack would
   * hide the only control that clears it. Gating on the notice would be worse:
   * `client/App.tsx` sets one of its own when the fetch fails, and a server
   * hiccup must not be able to clear a good pointer.
   */
  themeApplies?: boolean;
}) {
  // Failures on the Appearance and Design Center screens, which share nothing
  // with the connection check above and must not borrow its message line.
  const [appearanceError, setAppearanceError] = useState('');
  /**
   * The launch-time design authoring authorization, read from the service. Only
   * stated, never offered as a control: it is set in the environment the app was
   * started in, and no setting here could change it.
   */
  const [designAuthoring, setDesignAuthoring] = useState(false);
  const [section, setSection] = useState('Interface detail');
  const [disclosure, setDisclosure] = useState<IntegrationStatus | null>(null);
  const [connectionError, setConnectionError] = useState('');
  // Discovery starts only when this page asks for it, once per visit to the helpers section.
  const askedForHelpers = useRef(false);
  const helpersOpen = section === 'Helpers on this computer' || section === 'Engines';
  useEffect(() => {
    if (!helpersOpen) {
      askedForHelpers.current = false;
      return;
    }
    if (askedForHelpers.current) return;
    if (
      settings.onboarding.discoveryConsentAt &&
      integrations.some((s) => s.status === 'Not checked')
    ) {
      askedForHelpers.current = true;
      refresh();
    }
  }, [helpersOpen, integrations, refresh, settings.onboarding.discoveryConsentAt]);
  useEffect(() => {
    let live = true;
    void readCustomizationStatus()
      .then((status) => {
        if (live) setDesignAuthoring(status.authoring);
      })
      .catch(() => {
        // Off is the conservative reading, and it is already in state.
      });
    return () => {
      live = false;
    };
  }, []);
  // What each engine says it can run. Only engines with a ready adapter are
  // asked, and the key is the id list so an unchanged roster does not refetch.
  const [catalogs, setCatalogs] = useState<Record<string, EngineCatalog>>({});
  const catalogKey = useMemo(
    () =>
      integrations
        .filter((s) => s.adapter === 'ready' && s.kind !== 'sample')
        .map((s) => s.id)
        .join(','),
    [integrations],
  );
  useEffect(() => {
    let live = true;
    const ids = catalogKey ? catalogKey.split(',') : [];
    void Promise.all(
      ids.map(async (engine) => {
        try {
          return [engine, await api<EngineCatalog>(`/engines/${engine}/models`)] as const;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (!live) return;
      setCatalogs(Object.fromEntries(rows.filter((r) => r !== null)));
    });
    return () => {
      live = false;
    };
  }, [catalogKey]);
  const chosenText = (key: string): string => {
    const raw = settings.services?.[key];
    return typeof raw === 'string' ? raw : '';
  };
  const saveChoice = (model: string, effort: string) =>
    void save({
      ...settings,
      services: { ...settings.services, codexModel: model, codexEffort: effort },
    });
  const helpersSection = 'Engines';
  // The top-bar chip asks for the helpers section by raising this signal.
  useEffect(() => {
    if (openHelpersSignal) setSection(helpersSection);
  }, [openHelpersSignal, helpersSection]);
  // Only a section this build offers is opened; an unknown name leaves the page
  // where it was rather than on an empty pane.
  const requested = sectionRequest?.section;
  const requestCount = sectionRequest?.n;
  useEffect(() => {
    if (!requested) return;
    const known = requested === 'Engines' ? helpersSection : requested;
    setSection(known);
  }, [requested, requestCount, helpersSection]);
  const sections = [
    'Interface detail',
    'Helpers on this computer',
    'Permissions',
    'Appearance',
    'About',
    'Design Center',
    'Engines',
    'App updates',
    'Rules',
    'Developer',
  ];
  return (
    <div className="settings-layout">
      <nav className="rail" aria-label="Settings">
        {sections.map((s) => (
          <button
            key={s}
            className={`rail-link ${s === section ? 'active' : ''}`}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </nav>
      <main className="main">
        <header className="page-header">
          <h1>{section}</h1>
          <span className="caption">Settings</span>
        </header>
        <div className="workbook-layout">
          <div className="reading">
            {section === 'Interface detail' && (
              <>
                <p className="prose">
                  Choose how much detail Nectovia shows you about each change.
                </p>
                {/* Detail stands on its own. It was gated on the Workbook, and
                    choosing a level also wrote `surface: 'workbook'`, so picking
                    one from the Console moved you out of it. Both are gone: this
                    control writes the detail level and nothing else. */}
                <h2>Detail</h2>
                <div className="radio-list">
                  {(['guided', 'standard', 'technical'] as const).map((d) => (
                    <label key={d} className={`radio-row ${settings.detail === d ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="settings-detail"
                        checked={settings.detail === d}
                        onChange={() => void save({ ...settings, detail: d })}
                      />
                      <span>
                        <strong>{titleCase(d)}</strong>
                        <span className="caption">{detailDescriptions[d]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
            {(section === 'Helpers on this computer' || section === 'Engines') && (
              <>
                {section === 'Engines' ? (
                  <p className="prose">
                    Nectovia uses AI services to do work. Here is which ones, and what is sent.
                  </p>
                ) : (
                  <p className="prose">
                    Nectovia can use these to do work. Here is which ones it found, and what each
                    one sends.
                  </p>
                )}
                <AIConnections
                  settings={settings}
                  save={save}
                  onStartFirstTask={onStartFirstTask}
                />
                <p className="caption">
                  Check connections runs bounded local version, account and status checks. It sends
                  no model prompts and opens no sign-in pages.
                </p>
                <Button
                  onClick={() => {
                    setConnectionError('');
                    void api('/ai/discover', 'POST', { consent: true })
                      .then(refresh)
                      .catch((e) =>
                        setConnectionError(
                          e instanceof Error ? e.message : 'Connection check failed.',
                        ),
                      );
                  }}
                >
                  Check connections
                </Button>
                {connectionError && <p role="alert">{connectionError}</p>}
                <div className="service-list">
                  {integrations
                    .filter((s) => s.kind !== 'sample' && !isExternalEngine(s.id))
                    .map((s) => (
                      <section className="service" key={s.id}>
                        <div className="row">
                          <h3>
                            <Mark
                              state={
                                s.available && s.enabled
                                  ? 'done'
                                  : s.found && s.adapter === 'ready'
                                    ? 'waiting'
                                    : 'todo'
                              }
                            />
                            {s.name}
                          </h3>
                          <span className="caption push-right">{s.status}</span>
                        </div>
                        <p>{s.detail}</p>
                        {(() => {
                          const snapshot = usage.find((u) => u.engine === s.id);
                          if (!snapshot) return null;
                          return (
                            <div className="usage-block">
                              {snapshot.windows.map((w) => (
                                <div key={w.id}>
                                  <div className="usage-row">
                                    <span>{w.label}</span>
                                    <UsageBar window={w} />
                                    <span>{leftPercent(w)}% left</span>
                                  </div>
                                  <p className="caption">{resetLine(w.resetsAt)}</p>
                                </div>
                              ))}
                              {snapshot.thread ? (
                                <p className="caption">{meterLine(snapshot.thread.meter)}</p>
                              ) : shouldShowEmptyDetail(snapshot) ? (
                                <p className="caption">{snapshot.detail}</p>
                              ) : null}
                              {(() => {
                                const plan = planLine(snapshot);
                                const freshness = freshnessLine(snapshot);
                                if (!plan && !freshness) return null;
                                return (
                                  <>
                                    {plan ? <p className="caption">{plan}</p> : null}
                                    {freshness ? <p className="caption">{freshness}</p> : null}
                                  </>
                                );
                              })()}
                            </div>
                          );
                        })()}
                        <p className="code caption">
                          {s.installedVersion ?? 'Version not reported'}
                          <br />
                          {s.provenVersion ? (
                            <>
                              proven on {s.provenVersion}
                              <br />
                            </>
                          ) : null}
                          {s.location ? (
                            <>
                              {s.location}
                              <br />
                            </>
                          ) : null}
                          {s.capabilities.join(', ') || 'No execution capabilities'}
                        </p>
                        {settings.services?.[s.id] === true &&
                          (catalogs[s.id]?.models.length ?? 0) > 0 &&
                          (() => {
                            const models = catalogs[s.id].models;
                            const chosen = models.find((m) => m.slug === chosenText('codexModel'));
                            const efforts = chosen?.efforts ?? [];
                            const effort = efforts.some((e) => e.id === chosenText('codexEffort'))
                              ? chosenText('codexEffort')
                              : (chosen?.defaultEffort ?? '');
                            return (
                              <div className="row choice-row">
                                <span className="caption">Default</span>
                                <select
                                  aria-label="Default choice"
                                  value={chosen?.slug ?? ''}
                                  onChange={(e) => {
                                    const picked = models.find((m) => m.slug === e.target.value);
                                    // A new choice brings its own level: the
                                    // ladders are not the same from one to the next.
                                    saveChoice(picked?.slug ?? '', picked?.defaultEffort ?? '');
                                  }}
                                >
                                  <option value="">Whatever Codex uses</option>
                                  {models.map((m) => (
                                    <option key={m.slug} value={m.slug} title={m.description}>
                                      {m.name}
                                    </option>
                                  ))}
                                </select>
                                {efforts.length > 0 && (
                                  <select
                                    aria-label="Default reasoning level"
                                    value={effort}
                                    onChange={(e) => saveChoice(chosen?.slug ?? '', e.target.value)}
                                  >
                                    {efforts.map((e) => (
                                      <option key={e.id} value={e.id} title={e.description}>
                                        {effortNames[e.id] ?? titleCase(e.id)}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            );
                          })()}
                        <div className="actions">
                          {s.adapter === 'ready' && s.kind !== 'sample' && (
                            <label className="switch">
                              <input
                                type="checkbox"
                                checked={settings.services?.[s.id] === true}
                                disabled={!s.available}
                                onChange={(e) =>
                                  void save({
                                    ...settings,
                                    services: { ...settings.services, [s.id]: e.target.checked },
                                  })
                                }
                              />
                              {settings.services?.[s.id] ? 'On' : 'Off'}
                            </label>
                          )}
                          {s.adapter === 'ready' && (
                            <Button tone="quiet" onClick={() => setDisclosure(s)}>
                              What is sent
                            </Button>
                          )}
                        </div>
                      </section>
                    ))}
                </div>
                {/* What Ask and Plan may read beyond the project folder. */}
                <ReadConnectors />
              </>
            )}
            {section === 'Design Center' && (
              <>
                <p className="prose">
                  The Design Center is where you change how Nectovia looks: its colours, its type,
                  how round its controls are, how much it moves. It works with no internet
                  connection and no AI engine, and nothing in it asks a model anything.
                </p>
                <div className="service-list">
                  <section className="service">
                    <div className="row">
                      <h3>
                        <Mark state={appliedTheme ? 'done' : 'todo'} />
                        Appearance
                      </h3>
                      <span className="caption push-right">
                        {appliedTheme
                          ? `Theme applied (version ${appliedTheme.revision})`
                          : 'Built-in package'}
                      </span>
                    </div>
                    <p>
                      {appliedTheme
                        ? `“${appliedTheme.id}” is applied to this app.`
                        : themeApplies
                          ? // The pointer is this workspace's own and nothing
                            // could be read through it. Saying only "the
                            // built-in package is showing" would leave the
                            // button below looking like it had nothing to do.
                            `The theme you chose could not be read, so the built-in “${schemeId(settings.appearance.package)}” package is showing. Put the theme away to stop being told so.`
                          : `The built-in “${schemeId(settings.appearance.package)}” package is showing. Open the Design Center to make a theme of your own.`}
                    </p>
                    <p className="caption">
                      A theme made here can be applied to this app and exported for the website as a
                      single .diomedes-theme file.
                    </p>
                    {appearanceError && <p role="alert">{appearanceError}</p>}
                    <div className="actions">
                      <Button tone="primary" onClick={() => onOpenDesignCenter?.()}>
                        Open Design Center
                      </Button>
                      {/* The way back. Gated on the pointer belonging here, not
                          on a pack having been read: a theme whose files are
                          gone is exactly the pointer that needs clearing. */}
                      {themeApplies && (
                        <Button
                          tone="quiet"
                          onClick={() => {
                            setAppearanceError('');
                            // Reset clears the pointer on the server; the patch that
                            // follows re-affirms the package this app was already
                            // wearing and is what hands back fresh settings, so this
                            // card stops saying a theme is applied. Same two steps,
                            // same order, as the radio list below.
                            void api('/themes/reset', 'POST')
                              .then(() =>
                                patchAppearance({ package: schemeId(settings.appearance.package) }),
                              )
                              .catch(() => setAppearanceError('The theme could not be put away.'));
                          }}
                        >
                          Use the built-in package
                        </Button>
                      )}
                    </div>
                  </section>
                </div>
              </>
            )}
            {section === 'App updates' && <AppUpdates />}
            {section === 'Permissions' && (
              <>
                <h2>Ask before...</h2>
                <div className="setting-rows">
                  {(
                    [
                      ['changingFiles', 'changing files in a project'],
                      ['deleting', 'deleting files'],
                      ['workingOutside', 'working outside the project folder'],
                      ['spending', 'spending money'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="setting-row" key={key}>
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={settings.permissions[key]}
                        onChange={(e) =>
                          void save({
                            ...settings,
                            permissions: { ...settings.permissions, [key]: e.target.checked },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="caption">
                  Working outside a project and purchases are unavailable in this build. Switching
                  these off does not grant access to either.
                </p>
              </>
            )}
            {section === 'Appearance' && (
              <>
                {/* What the Console shows, never what Nectovia can do. The
                    Console's ··· menu and Ctrl K change the same setting. */}
                <h2>View</h2>
                <div className="radio-list">
                  {(
                    [
                      ['conversation', 'Conversation', 'The prompt box and your threads, and nothing else.'],
                      ['architect', 'Architect', 'The full Console: Board, Team, History, Files and the project panel.'],
                    ] as const
                  ).map(([id, label, description]) => (
                    <label
                      key={id}
                      className={`radio-row ${(settings.view ?? 'architect') === id ? 'selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="settings-view"
                        checked={(settings.view ?? 'architect') === id}
                        onChange={() => void save({ ...settings, view: id })}
                      />
                      <span>
                        <strong>{label}</strong>
                        <span className="caption">{description}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <h2>Appearance package</h2>
                {appliedTheme && (
                  <p className="caption">
                    A theme from the Design Center is applied. Choosing a built-in package below
                    puts that theme away and shows the package instead; the theme itself is kept.
                  </p>
                )}
                <div className="radio-list">
                  {SCHEMES.map((s) => {
                    // What is painted decides what is selected. A theme applied
                    // in another workspace leaves the pointer set while the
                    // built-in package paints, and reading the pointer here
                    // showed no scheme selected at all.
                    const selected = !appliedTheme && schemeId(settings.appearance.package) === s.id;
                    return (
                      <label className={`radio-row ${selected ? 'selected' : ''}`} key={s.id}>
                        <input
                          type="radio"
                          name="appearance"
                          checked={selected}
                          onChange={() => {
                            // Two writes, each owning one thing: the theme
                            // routes own `activeTheme` and nothing else may
                            // send it, and the package is patched on its own.
                            // Picking a scheme while a theme is applied used to
                            // be a visual no-op, because the theme is what the
                            // resolver paints.
                            setAppearanceError('');
                            // With no pointer of this workspace's own there is
                            // nothing to put away, and the reset would be a
                            // second request that can only fail. One control,
                            // one write. The test is whether the pointer is
                            // *here* — not whether a pack was read through it,
                            // which would strand an unreadable theme, and not
                            // the raw pointer, which would let a scheme picked
                            // here clear another workspace's theme.
                            const put = themeApplies
                              ? api('/themes/reset', 'POST').then(() => undefined)
                              : Promise.resolve();
                            void put
                              .then(() => patchAppearance({ package: s.id }))
                              .catch(() =>
                                setAppearanceError('The appearance package could not be changed.'),
                              );
                          }}
                        />
                        <span
                          className="palette-dot"
                          aria-hidden="true"
                          style={
                            {
                              '--sw-light': s.light,
                            } as CSSProperties
                          }
                        />
                        <strong>{s.name}</strong>
                      </label>
                    );
                  })}
                </div>
                {appearanceError && <p role="alert">{appearanceError}</p>}
                <label className="setting-row">
                  <span>Reduced motion</span>
                  <input
                    type="checkbox"
                    checked={settings.appearance.motion === 'reduced'}
                    onChange={(e) =>
                      void patchAppearance({ motion: e.target.checked ? 'reduced' : 'normal' })
                    }
                  />
                </label>
                {(() => {
                  const effectiveInterfaceScale = settings.appearance.interfaceScale ?? 1;
                  return (['interfaceScale', 'readingScale', 'codeScale'] as const).map(
                    (key, i) => (
                      <label key={key} className="setting-row">
                        <span>{['Interface size', 'Conversation text size', 'Code size'][i]}</span>
                        <select
                          value={
                            key === 'interfaceScale'
                              ? (settings.appearance.interfaceScale ?? effectiveInterfaceScale)
                              : (settings.appearance[key] ?? 1)
                          }
                          onChange={(e) => void patchAppearance({ [key]: Number(e.target.value) })}
                        >
                          {key === 'interfaceScale' ? (
                            <>
                              {INTERFACE_SCALES.map((scale) => (
                                <option key={scale} value={scale}>
                                  {Math.round(scale * 100)}%{scale === 1 ? ' (Default)' : ''}
                                </option>
                              ))}
                              {!INTERFACE_SCALES.some(
                                (scale) => scale === effectiveInterfaceScale,
                              ) && (
                                <option value={effectiveInterfaceScale}>
                                  {Math.round(effectiveInterfaceScale * 100)}% (Custom)
                                </option>
                              )}
                            </>
                          ) : key === 'readingScale' ? (
                            <>
                              {CONVERSATION_TEXT_SCALES.map((scale) => (
                                <option key={scale} value={scale}>
                                  {conversationTextLabel(scale)}
                                </option>
                              ))}
                              {!(CONVERSATION_TEXT_SCALES as readonly number[]).includes(
                                settings.appearance.readingScale ?? 1,
                              ) && (
                                <option value={settings.appearance.readingScale}>
                                  {Math.round((settings.appearance.readingScale ?? 1) * 100)}%
                                  (Custom)
                                </option>
                              )}
                            </>
                          ) : (
                            <>
                              <option value={1}>Default</option>
                              <option value={1.12}>Larger</option>
                              <option value={1.24}>Largest</option>
                            </>
                          )}
                        </select>
                      </label>
                    ),
                  );
                })()}
                <p className="caption">
                  Ctrl+Plus and Ctrl+Minus change interface size. Ctrl+0 resets it to 100%.
                  Conversation text size changes only messages and replies; the ··· menu has it
                  too.
                </p>
              </>
            )}
            {section === 'About' && (
              <>
                <h2>Nectovia</h2>
                <AboutLine />
                <p className="prose">
                  A workbook for your projects, documents, plans, tasks, and the history of what
                  changed.
                </p>
                <p className="prose">
                  Online work uses only a service you explicitly enable. Fonts are bundled and
                  served locally.
                </p>
                <p className="caption">
                  Local browser application. Text and Markdown editing. No startup service or remote
                  access.
                </p>
                <SupportBundleCopy />
              </>
            )}
            {section === 'Rules' && (
              <>
                <h2>How work is bounded</h2>
                <p className="prose">
                  Each project is a folder. All edits made here go through the same recorded write
                  path. Online work proposes file changes for your approval. The example workflow
                  runs a fixed demonstration.
                </p>
                <p className="code">
                  Ask: read-only response
                  <br />
                  Plan: response saved through History
                  <br />
                  Work: approved file proposals or local sample
                  <br />
                  Review: human Keep / Undo
                </p>
              </>
            )}
            {section === 'Developer' && (
              <>
                <h2>Local runtime</h2>
                <p className="code">
                  Schema: diomedes/1
                  <br />
                  Host: loopback only
                  <br />
                  Transport: HTTP and server-sent events
                  <br />
                  Storage: this app&apos;s own data folder; its path is in the support information below
                  <br />
                  History: content-addressed objects and journal
                  <br />
                  Client: React and TypeScript
                  <br />
                  Shell: browser, replaceable
                </p>
                <p className="prose">
                  Requests from other origins are blocked. The local service has no sign-in; other
                  software running on this computer can access it.
                </p>
                <h2>Design authoring</h2>
                {/*
                  Read-only on purpose. This is a launch-time authorization the
                  service reads from its own environment, so it cannot be turned
                  on or off from inside the running app — stating it here and
                  offering no switch is the honest shape.
                */}
                <p className="code" data-design-authoring={designAuthoring ? 'on' : 'off'}>
                  Design authoring: {designAuthoring ? 'on (set at launch)' : 'off'}
                </p>
                <p className="prose">
                  When it is on, themes can be authored for this computer without a plan. It grants
                  nothing else: no organization branding, no agent authority, and it cannot be
                  changed from here.
                </p>
              </>
            )}
          </div>
          <aside className="margin">
            <section className="block">
              <h3>Engines</h3>
              {integrations
                .filter((s) => s.kind !== 'sample' && (s.kind !== 'local' || s.available))
                .slice(0, 3)
                .map((s) => {
                  // The allowance when the engine reports one, otherwise the same
                  // bar full or empty for whether it can run at all.
                  const snapshot = usage.find((u) => u.engine === s.id);
                  const tight = snapshot ? tightestWindow(snapshot) : null;
                  return (
                    <div className="reference-row metered" key={s.id}>
                      {tight ? (
                        <UsageBar window={tight} />
                      ) : (
                        <span className="engine-meter" aria-hidden="true">
                          <span className={`engine-meter-fill${s.available ? ' on' : ''}`} />
                        </span>
                      )}
                      <span className="engine-row-name">{s.name}</span>
                      <span className="caption push-right engine-state">
                        <Mark state={s.available ? 'working' : 'todo'} />
                        {s.available ? 'Available' : 'Unavailable'}
                      </span>
                    </div>
                  );
                })}
            </section>
            <p className="caption">Your settings are saved on this computer.</p>
          </aside>
        </div>
      </main>
      {disclosure && (
        <Modal title="What is sent" onClose={() => setDisclosure(null)}>
          <ul className="prose">
            {disclosure.disclosure.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="dialog-actions">
            <Button onClick={() => setDisclosure(null)}>Close</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * A long machine string in a dialog is the case decision 5 is about, so the
 * preview wraps and scrolls inside its own box instead of widening the dialog.
 */
const supportPreview: CSSProperties = {
  margin: 0,
  minWidth: 0,
  maxHeight: '40vh',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

/** Who makes the app, and the version this copy is running when the app can say it. */
function AboutLine() {
  const version = useInstalledVersion();
  return (
    <p className="prose">
      Nectovia by Diomedes Systems.{version ? ` Version ${version}.` : ''}
    </p>
  );
}

/**
 * The support bundle, read before it is shared: build identity, host, paths,
 * per-route connection facts, counts and recent errors, with secrets scrubbed
 * and the exclusions listed in the text itself.
 *
 * It carries paths, so it is not anonymous and is not offered as anonymous. The
 * person sees the exact characters first and copies that same string — the
 * preview is the payload, never a summary of one.
 */
function SupportBundleCopy() {
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <>
      <p className="caption">
        <button
          type="button"
          onClick={async () => {
            setNote('');
            try {
              const { text } = await api<{ text: string }>('/support/bundle');
              setPreview(text);
            } catch (error) {
              setNote(error instanceof Error ? error.message : 'The bundle could not be read.');
            }
          }}
        >
          Review support information
        </button>
        {note && preview === null && <span role="status"> {note}</span>}
      </p>
      {preview !== null && (
        <Modal
          title="Support information"
          wide
          onClose={() => {
            setPreview(null);
            setNote('');
          }}
        >
          <pre className="code" style={supportPreview}>
            {preview}
          </pre>
          <div className="dialog-actions">
            <Button
              tone="primary"
              onClick={async () => {
                try {
                  if (!navigator.clipboard)
                    throw new Error('The clipboard is not available here.');
                  await navigator.clipboard.writeText(preview);
                  setNote('Copied.');
                } catch (error) {
                  setNote(
                    error instanceof Error ? error.message : 'The bundle could not be copied.',
                  );
                }
              }}
            >
              Copy
            </Button>
            <Button
              onClick={() => {
                setPreview(null);
                setNote('');
              }}
            >
              Close
            </Button>
            {note && <span role="status">{note}</span>}
          </div>
        </Modal>
      )}
    </>
  );
}
