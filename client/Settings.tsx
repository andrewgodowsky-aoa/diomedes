import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  EngineCatalog,
  IntegrationStatus,
  Settings as SettingsModel,
  UsageSnapshot,
} from '../shared/types';
import { api } from './api';
import { INTERFACE_SCALES } from '../shared/interface-scale';
import { AppUpdates } from './AppUpdates';
import { freshnessLine, planLine, shouldShowEmptyDetail } from './usage-presentation';
import { AIConnections } from './AISetup';
import { isExternalEngine } from '../shared/engines';
import { SCHEMES, schemeId } from './console/schemes';
import {
  Button,
  Mark,
  Modal,
  UsageBar,
  leftPercent,
  tightestWindow,
  detailDescriptions,
  meterLine,
  surfaceDescriptions,
  surfaceOf,
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
  integrations,
  usage,
  openHelpersSignal,
  refresh,
}: {
  settings: SettingsModel;
  save: (value: SettingsModel) => Promise<void>;
  integrations: IntegrationStatus[];
  usage: UsageSnapshot[];
  openHelpersSignal?: number;
  refresh: () => void;
}) {
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
  const surface = surfaceOf(settings);
  const isDesk = surface === 'console';
  const helpersSection = isDesk ? 'Engines' : 'Helpers on this computer';
  // The top-bar chip asks for the helpers section by raising this signal.
  useEffect(() => {
    if (openHelpersSignal) setSection(helpersSection);
  }, [openHelpersSignal, helpersSection]);
  const sections = [
    'Interface detail',
    'Helpers on this computer',
    'Permissions',
    'History',
    'Appearance',
    'About',
    ...(isDesk ? ['Engines', 'App updates', 'Rules', 'Developer'] : []),
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
                  Choose how Diomedes lays out your work and how much detail the Workbook shows.
                </p>
                <h2>Surface</h2>
                <div className="radio-list">
                  {(['workbook', 'console'] as const).map((s) => (
                    <label key={s} className={`radio-row ${surface === s ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="settings-surface"
                        checked={surface === s}
                        onChange={() =>
                          void save({
                            ...settings,
                            surface: s,
                            ...(s === 'workbook' && settings.detail === 'technical'
                              ? { detail: 'standard' }
                              : {}),
                          })
                        }
                      />
                      <span>
                        <strong>The {titleCase(s)}</strong>
                        <span className="caption">{surfaceDescriptions[s]}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {surface === 'workbook' && (
                  <>
                    <h2>Detail</h2>
                    <div className="radio-list">
                      {(['guided', 'standard'] as const).map((d) => (
                        <label
                          key={d}
                          className={`radio-row ${settings.detail === d ? 'selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="settings-detail"
                            checked={settings.detail === d}
                            onChange={() =>
                              void save({ ...settings, detail: d, surface: 'workbook' })
                            }
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
                <section className="block">
                  <h3>Same work, two surfaces</h3>
                  <p className="prose">
                    Documents, tasks, approvals and History stay in place when you switch. Every
                    decision is still yours.
                  </p>
                </section>
              </>
            )}
            {(section === 'Helpers on this computer' || section === 'Engines') && (
              <>
                {section === 'Engines' ? (
                  <p className="prose">
                    Diomedes uses AI services to do work. Here is which ones, and what is sent.
                  </p>
                ) : (
                  <p className="prose">
                    Diomedes can use these to do work. Here is which ones it found, and what each
                    one sends.
                  </p>
                )}
                {isDesk && <AIConnections settings={settings} save={save} />}
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
                  {(settings.detail === 'guided' && !isDesk
                    ? integrations.filter((s) => s.adapter === 'ready')
                    : integrations
                  )
                    .filter((s) => s.kind !== 'sample' && (!isDesk || !isExternalEngine(s.id)))
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
                        {isDesk && (
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
                        )}
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
            {section === 'History' && (
              <>
                <h2>A way back</h2>
                <p className="prose">
                  Diomedes records its changes to supported text files before writing them.
                  Restoring a change creates a new entry, so the restore can be undone too.
                </p>
                <p className="prose">
                  History stays on this computer. Automatic cleanup is not active in this build; no
                  entries are removed on a schedule.
                </p>
                <p className="caption">
                  Files must be valid text and no larger than 8 MB. Edits from other applications
                  are recorded when Diomedes next reads the file. Intermediate external edits cannot
                  be recovered.
                </p>
              </>
            )}
            {section === 'Appearance' && (
              <>
                <h2>Appearance package</h2>
                <div className="radio-list">
                  {SCHEMES.map((s) => {
                    const selected = schemeId(settings.appearance.package) === s.id;
                    return (
                      <label className={`radio-row ${selected ? 'selected' : ''}`} key={s.id}>
                        <input
                          type="radio"
                          name="appearance"
                          checked={selected}
                          onChange={() =>
                            void save({
                              ...settings,
                              appearance: { ...settings.appearance, package: s.id },
                            })
                          }
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
                <label className="setting-row">
                  <span>Reduced motion</span>
                  <input
                    type="checkbox"
                    checked={settings.appearance.motion === 'reduced'}
                    onChange={(e) =>
                      void save({
                        ...settings,
                        appearance: {
                          ...settings.appearance,
                          motion: e.target.checked ? 'reduced' : 'normal',
                        },
                      })
                    }
                  />
                </label>
                {(() => {
                  const effectiveInterfaceScale = settings.appearance.interfaceScale ?? 1;
                  return (['interfaceScale', 'readingScale', 'codeScale'] as const).map(
                    (key, i) => (
                      <label key={key} className="setting-row">
                        <span>{['Interface size', 'Reading size', 'Code size'][i]}</span>
                        <select
                          value={
                            key === 'interfaceScale'
                              ? (settings.appearance.interfaceScale ?? effectiveInterfaceScale)
                              : (settings.appearance[key] ?? 1)
                          }
                          onChange={(e) =>
                            void save({
                              ...settings,
                              appearance: {
                                ...settings.appearance,
                                [key]: Number(e.target.value),
                              },
                            })
                          }
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
                </p>
              </>
            )}
            {section === 'About' && (
              <>
                <h2>Diomedes</h2>
                <p className="prose">By Diomedes Systems. Version 0.1.</p>
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
              </>
            )}
          </div>
          <aside className="margin">
            <section className="block">
              <h3>{isDesk ? 'Engines' : 'Helpers on this computer'}</h3>
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
                      <span className="engine-row-name">{isDesk ? s.name : 'Online service'}</span>
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
 * One button that copies the support bundle: version, host, paths, engine
 * status, counts and recent errors, with secrets scrubbed and the exclusions
 * listed in the text itself. The feedback says what actually happened.
 */
function SupportBundleCopy() {
  const [note, setNote] = useState('');
  return (
    <p className="caption">
      <button
        type="button"
        onClick={async () => {
          setNote('');
          try {
            const { text } = await api<{ text: string }>('/support/bundle');
            if (!navigator.clipboard) throw new Error('The clipboard is not available here.');
            await navigator.clipboard.writeText(text);
            setNote('Copied. Secrets and document contents are not included.');
          } catch (error) {
            setNote(error instanceof Error ? error.message : 'The bundle could not be copied.');
          }
        }}
      >
        Copy support information
      </button>
      {note && <span role="status"> {note}</span>}
    </p>
  );
}
