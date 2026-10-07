import { useEffect, useId, useRef, useState } from 'react';
import { AGENT_NAME } from '../shared/agent-name';
import type {
  SubscriptionWorkersPreference,
  SubscriptionWorkersView,
  WhenUnavailable,
} from '../shared/subscription-workers';
import { api } from './api';
import { Button } from './components';
import {
  DEFAULT_KEEP_PERCENT,
  chooseTool,
  codingToolsForm,
  codingToolsWrite,
  consentChanged,
  keepPercent,
  moveTool,
  type CodingToolsForm,
} from './coding-tools-view';

const PATH = '/settings/subscription-workers';

const FALLBACKS: readonly (readonly [WhenUnavailable, string])[] = [
  ['single-agent', `${AGENT_NAME} uses your credits for the task`],
  ['pause', 'Hold the work until one of your tools can take it'],
];

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * The Settings view of the person's coding tools, read once when Settings opens: undefined while
 * it's read, null when it can't be. Either way the section isn't offered.
 */
export function useCodingToolsView(): [
  SubscriptionWorkersView | null | undefined,
  (view: SubscriptionWorkersView) => void,
] {
  const [view, setView] = useState<SubscriptionWorkersView | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    api<SubscriptionWorkersView>(PATH, 'GET', undefined, controller.signal).then(
      (read) => setView(read),
      () => {
        if (!controller.signal.aborted) setView(null);
      },
    );
    return () => controller.abort();
  }, []);
  return [view, setView];
}

/**
 * Settings' "Your coding tools" (subscription-aware orchestration S3): whether a Nectovia loop the
 * person starts in their Personal work may hand a task to a coding tool they already pay for,
 * which tools in which order, what share of each tool's limit they keep, and what happens when
 * none can take it. Nothing shows unless this build offers it. Each change saves at once through
 * the preference's own route, and the server's sentence shows when it refuses one.
 */
export function CodingTools({
  view,
  onSaved,
}: {
  view: SubscriptionWorkersView;
  onSaved(view: SubscriptionWorkersView): void;
}) {
  if (!view.available) return null;
  if (!view.signedIn) return <p className="prose">Sign in to choose your coding tools.</p>;
  return <CodingToolsChoice view={view} onSaved={onSaved} />;
}

function CodingToolsChoice({
  view,
  onSaved,
}: {
  view: SubscriptionWorkersView;
  onSaved(view: SubscriptionWorkersView): void;
}) {
  const id = useId();
  const [form, setForm] = useState(() => codingToolsForm(view));
  // Ticked before it can be turned on. While it's on, it reads as ticked: that's what was agreed.
  const [understood, setUnderstood] = useState(false);
  const [percent, setPercent] = useState(() =>
    String(view.preference?.reserve.kind === 'provider-window' ? view.preference.reserve.keepPercent : DEFAULT_KEEP_PERCENT),
  );
  const [error, setError] = useState('');
  // What the server holds now, to go back to when it refuses a change. Only the newest save
  // sets the controls, so an earlier answer never undoes a later change.
  const saved = useRef({ view, form });
  const ticket = useRef(0);
  const typed = useRef(false);
  const names = new Map(view.tools.map((tool) => [tool.route, tool.name]));

  const save = async (next: CodingToolsForm) => {
    const shown = form;
    setForm(next);
    const body = codingToolsWrite(next, saved.current.view);
    // Moving a tool that isn't ticked changes nothing the server keeps.
    if (JSON.stringify(body) === JSON.stringify(codingToolsWrite(shown, saved.current.view))) return;
    const mine = ++ticket.current;
    setError('');
    try {
      const { preference } = await api<{ preference: SubscriptionWorkersPreference }>(PATH, 'PUT', body);
      const nextView = { ...saved.current.view, preference };
      saved.current = { view: nextView, form: codingToolsForm(nextView, next.order) };
      onSaved(nextView);
      if (mine !== ticket.current) return;
      setForm(saved.current.form);
      if (preference.reserve.kind === 'provider-window') setPercent(String(preference.reserve.keepPercent));
    } catch (failure) {
      if (mine !== ticket.current) return;
      setError(messageOf(failure, 'Your coding tools could not be saved.'));
      setForm(saved.current.form);
      const kept = saved.current.form.reserve;
      if (kept.kind === 'provider-window') setPercent(String(kept.keepPercent));
    }
  };

  const turn = (on: boolean) => {
    // Turned off, it asks again before it's on again, as it does after a reload.
    if (!on) setUnderstood(false);
    void save({ ...form, on });
  };

  const keep = (value: number) => {
    setPercent(String(value));
    void save({ ...form, reserve: { kind: 'provider-window', keepPercent: value } });
  };

  const commitPercent = () => {
    if (!typed.current) return;
    typed.current = false;
    const value = keepPercent(percent);
    if (value !== null) keep(value);
    else setPercent(String(form.reserve.kind === 'provider-window' ? form.reserve.keepPercent : DEFAULT_KEEP_PERCENT));
  };

  return (
    <>
      <p className="prose">
        Use a coding tool you already pay for on Personal tasks. Those tasks use that tool's plan.
      </p>
      {consentChanged(view) && (
        <p className="prose">
          What handing tasks to your coding tools sends has changed. Read it again and confirm.
        </p>
      )}
      <p className="prose">{view.consent.text}</p>
      <div className="setting-rows">
        <label className="setting-row">
          <span>I understand</span>
          <input
            type="checkbox"
            checked={form.on || understood}
            disabled={form.on}
            onChange={(event) => setUnderstood(event.target.checked)}
          />
        </label>
        <label className="setting-row">
          <span>Hand tasks to my coding tools</span>
          <input
            type="checkbox"
            checked={form.on}
            disabled={!form.on && !understood}
            onChange={(event) => turn(event.target.checked)}
          />
        </label>
      </div>
      <h2 id={`${id}-tools`}>Tools to use, first choice at the top</h2>
      <div className="setting-rows" role="group" aria-labelledby={`${id}-tools`}>
        {form.order.map((route, index) => {
          const name = names.get(route) ?? route;
          return (
            <div className="setting-row" key={route} data-tool={route}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={form.chosen.includes(route)}
                  onChange={(event) => void save(chooseTool(form, route, event.target.checked))}
                />
                {name}
              </label>
              <span className="actions">
                <Button
                  tone="quiet"
                  aria-label={`Move ${name} up`}
                  disabled={index === 0}
                  onClick={() => void save({ ...form, order: moveTool(form.order, route, -1) })}
                >
                  Move up
                </Button>
                <Button
                  tone="quiet"
                  aria-label={`Move ${name} down`}
                  disabled={index === form.order.length - 1}
                  onClick={() => void save({ ...form, order: moveTool(form.order, route, 1) })}
                >
                  Move down
                </Button>
              </span>
            </div>
          );
        })}
      </div>
      <h2 id={`${id}-reserve`}>Keep part of each tool&apos;s limit for your own work</h2>
      <div className="radio-list" role="radiogroup" aria-labelledby={`${id}-reserve`}>
        <label className={`radio-row ${form.reserve.kind === 'none' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="coding-tools-reserve"
            checked={form.reserve.kind === 'none'}
            onChange={() => void save({ ...form, reserve: { kind: 'none' } })}
          />
          <span>
            <strong>No. Use a tool whenever it can take the task.</strong>
          </span>
        </label>
        <label className={`radio-row ${form.reserve.kind === 'provider-window' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="coding-tools-reserve"
            checked={form.reserve.kind === 'provider-window'}
            onChange={() => keep(keepPercent(percent) ?? DEFAULT_KEEP_PERCENT)}
          />
          <span>
            <strong>
              Yes, keep{' '}
              <input
                type="number"
                className="coding-tools-keep"
                aria-label="Share of each tool's limit to keep, in percent"
                min={1}
                max={90}
                step={1}
                value={percent}
                onChange={(event) => {
                  typed.current = true;
                  setPercent(event.target.value);
                }}
                onBlur={commitPercent}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              % of each tool&apos;s limit for me.
            </strong>
          </span>
        </label>
      </div>
      <p className="caption">
        A tool that doesn&apos;t report how much of its limit is left won&apos;t get tasks while you
        keep a share.
      </p>
      <h2 id={`${id}-fallback`}>When none of your tools can take a task</h2>
      <div className="radio-list" role="radiogroup" aria-labelledby={`${id}-fallback`}>
        {FALLBACKS.map(([value, label]) => (
          <label key={value} className={`radio-row ${form.whenUnavailable === value ? 'selected' : ''}`}>
            <input
              type="radio"
              name="coding-tools-fallback"
              value={value}
              checked={form.whenUnavailable === value}
              onChange={() => void save({ ...form, whenUnavailable: value })}
            />
            <span>
              <strong>{label}</strong>
            </span>
          </label>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
