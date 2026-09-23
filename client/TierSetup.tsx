import { useEffect, useState } from 'react';
import type { Settings } from '../shared/types';
import { routeDisplayName } from '../shared/engines';
import { TIER_DEFAULT_NOTES } from '../shared/tier-map';
import { WORK_STYLES, WORK_STYLE_DESCRIPTIONS, WORK_STYLE_LABELS } from '../shared/work-style';
import { Button } from './components';
import {
  OWNER_PIN_ROUTES,
  ownerPinDraft,
  tierDraftFrom,
  tierRouteChoices,
  withOwnerPin,
  withTierDraft,
  type TierDraft,
} from './tier-setup-view';

/**
 * The owner's tier map: which company account and which model serve
 * Efficient, Focused and Thorough (owner decisions 2026-09-23). Customers only
 * ever choose a tier; this is the one place that decides routing. The host
 * checks every value when it is saved, and refuses a tier by name when its
 * route is not connected, so nothing chosen here can move work to another
 * payer on its own.
 *
 * Under Advanced, the owner and technical staff can pin one route for every
 * tier while testing. It is labelled as owner testing and is never offered in
 * a thread.
 */
export function TierSetup({
  settings,
  save,
  busy,
}: {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy?: boolean;
}) {
  const services = settings.services;
  const [draft, setDraft] = useState<TierDraft>(() => tierDraftFrom(services));
  const [pin, setPin] = useState(() => ownerPinDraft(services));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedKey = JSON.stringify(services ?? {});
  // Saved settings refill the form; an unsaved edit survives only until they change.
  useEffect(() => {
    setDraft(tierDraftFrom(services));
    setPin(ownerPinDraft(services));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const disabled = busy || working;
  const run = async (next: Settings['services'], done: string) => {
    setWorking(true);
    setError(null);
    setSaved(null);
    try {
      await save({ ...settings, services: next });
      setSaved(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The tier settings could not be saved.');
    } finally {
      setWorking(false);
    }
  };
  const change = (style: (typeof WORK_STYLES)[number], next: Partial<TierDraft[typeof style]>) =>
    setDraft({ ...draft, [style]: { ...draft[style], ...next } });

  return (
    <section className="service" aria-label="Tiers">
      <div className="row">
        <h3>Tiers</h3>
        <span className="caption push-right">Owner</span>
      </div>
      <p className="caption ai-route">
        People choose Efficient, Focused or Thorough, never a route or a model. Choose which of your
        company accounts, and which model, serves each one. A tier whose account is not connected is
        refused by name; it never moves to another account.
      </p>
      <form
        className="ai-aws-connect ai-provider-connect"
        onSubmit={(event) => {
          event.preventDefault();
          void run(withTierDraft(services, draft), 'Tiers saved.');
        }}
      >
        {WORK_STYLES.map((style) => (
          <fieldset key={style} className="ai-provider-model">
            <legend>{WORK_STYLE_LABELS[style]}</legend>
            <p className="caption">{WORK_STYLE_DESCRIPTIONS[style]}</p>
            <label>
              Account
              <select
                aria-label={`${WORK_STYLE_LABELS[style]} account`}
                value={draft[style].route}
                disabled={disabled}
                onChange={(event) => change(style, { route: event.target.value, model: '' })}
              >
                {tierRouteChoices(draft[style].route).map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model id, exactly as that account lists it
              <input
                aria-label={`${WORK_STYLE_LABELS[style]} model`}
                autoComplete="off"
                spellCheck={false}
                value={draft[style].model}
                disabled={disabled}
                onChange={(event) => change(style, { model: event.target.value })}
                placeholder="Not chosen yet"
              />
            </label>
            <p className="caption">Default: {TIER_DEFAULT_NOTES[style]}</p>
          </fieldset>
        ))}
        <div className="actions">
          <Button tone="primary" type="submit" disabled={disabled}>
            Save tiers
          </Button>
        </div>
      </form>

      <details className="ai-connection-details">
        <summary>Advanced: owner testing</summary>
        <p className="caption">
          For the owner and technical staff only. Pins one route, and optionally one model, for every
          tier on this computer while you test it. People still see only the tiers. Clear it when you
          are done.
        </p>
        <form
          className="ai-aws-connect ai-provider-connect"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              withOwnerPin(services, pin.route, pin.model),
              pin.route ? 'Owner testing pin saved.' : 'Owner testing pin cleared.',
            );
          }}
        >
          <label>
            Pin every tier to
            <select
              aria-label="Owner testing route"
              value={pin.route}
              disabled={disabled}
              onChange={(event) => setPin({ route: event.target.value, model: '' })}
            >
              <option value="">No pin: the tier map decides</option>
              {OWNER_PIN_ROUTES.map((route) => (
                <option key={route} value={route}>
                  {routeDisplayName(route)}
                </option>
              ))}
            </select>
          </label>
          {pin.route && (
            <label>
              Model id (empty uses the route’s saved default)
              <input
                aria-label="Owner testing model"
                autoComplete="off"
                spellCheck={false}
                value={pin.model}
                disabled={disabled}
                onChange={(event) => setPin({ ...pin, model: event.target.value })}
              />
            </label>
          )}
          <div className="actions">
            <Button type="submit" disabled={disabled}>
              {pin.route ? 'Save owner testing pin' : 'Clear the pin'}
            </Button>
          </div>
        </form>
      </details>
      {error && (
        <p className="ai-note" role="alert">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="caption" role="status">
          {saved}
        </p>
      )}
    </section>
  );
}
