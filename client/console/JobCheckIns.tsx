import { useEffect, useState } from 'react';
import { JOB_TIERS, jobTierLabel } from '../../shared/job-caps';
import { MAX_CHECK_IN_CREDITS, type CheckInSettingsView, type SetCheckInOverrideInput } from '../../shared/job-check-ins';
import type { JobTier } from '../../shared/managed-usage';
import { api } from '../api';
import { Button } from '../components';

/**
 * Settings, Usage: how many credits a job uses before it asks whether to keep going, for this business.
 *
 * Only an owner or an admin sees it, because it sits in the Usage section they see; the server refuses
 * everyone else too, so leaving it out is a courtesy and not the protection. The amounts are the account
 * service's: each tier shows Nectovia's amount, and a business may set its own, which applies to this
 * business alone. An empty box goes back to Nectovia's amount. Credits, never dollars.
 */

export const CHECK_INS_UNREADABLE = 'Job check-ins can’t be shown right now.';
export const CHECK_INS_INVALID = `Each amount is a whole number of credits from 1 to ${MAX_CHECK_IN_CREDITS.toLocaleString('en-US')}, or empty.`;

type Read = <T>(path: string) => Promise<T>;
type Send = <T>(path: string, method: 'POST', body: unknown) => Promise<T>;

const path = (organizationId: string) => `/workspace/organizations/${encodeURIComponent(organizationId)}/job-check-ins`;

/** One read of the business's check-in settings, or null when they can't be read. Never throws. */
export async function loadJobCheckIns(organizationId: string, read: Read = api): Promise<CheckInSettingsView | null> {
  try {
    return await read<CheckInSettingsView>(path(organizationId));
  } catch {
    return null;
  }
}

/** What the person typed per tier: whole credits, or empty for "use Nectovia's amount". Anything else is invalid. */
export function parseAmounts(text: Record<Exclude<JobTier, 'expert'>, string> & { expert?: string }): SetCheckInOverrideInput['amounts'] | null {
  const out: Partial<Record<JobTier, number | null>> = {};
  for (const tier of JOB_TIERS) {
    if (tier === 'expert' && text[tier] === undefined) continue;
    const raw = (text[tier] ?? '').trim();
    if (raw === '') {
      out[tier] = null;
      continue;
    }
    if (!/^\d{1,6}$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CHECK_IN_CREDITS) return null;
    out[tier] = value;
  }
  return out as SetCheckInOverrideInput['amounts'];
}

/** The boxes as the business's own setting fills them: its own number, or empty where it has none. */
export const amountsText = (view: CheckInSettingsView): Record<JobTier, string> => ({
  efficient: view.override.efficient === null ? '' : String(view.override.efficient),
  focused: view.override.focused === null ? '' : String(view.override.focused),
  thorough: view.override.thorough === null ? '' : String(view.override.thorough),
  expert: view.override.expert == null ? '' : String(view.override.expert),
});

/** Save the business's own amounts. The service validates, applies and answers with what is now in force. */
export const saveJobCheckIns = (
  organizationId: string,
  amounts: SetCheckInOverrideInput['amounts'],
  send: Send = api as Send,
) => send<CheckInSettingsView>(path(organizationId), 'POST', { amounts });

const credits = (amount: number) => `${amount.toLocaleString('en-US')} ${amount === 1 ? 'credit' : 'credits'}`;

export function JobCheckIns({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<CheckInSettingsView | null | undefined>(undefined);
  const [text, setText] = useState<Record<JobTier, string>>({ efficient: '', focused: '', thorough: '', expert: '' });
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setView(undefined);
    void loadJobCheckIns(organizationId).then((read) => {
      if (!live) return;
      setView(read);
      if (read) setText(amountsText(read));
    });
    return () => {
      live = false;
    };
  }, [organizationId]);

  if (view === undefined) return <p className="caption">Checking job check-ins.</p>;
  if (view === null) return <p className="caption">{CHECK_INS_UNREADABLE}</p>;

  const save = async () => {
    const amounts = parseAmounts(text);
    if (!amounts) {
      setLine(CHECK_INS_INVALID);
      return;
    }
    setBusy(true);
    setLine(null);
    try {
      const saved = await saveJobCheckIns(organizationId, amounts);
      setView(saved);
      setText(amountsText(saved));
      setLine('Saved.');
    } catch (error) {
      setLine(error instanceof Error ? error.message : CHECK_INS_UNREADABLE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block" aria-labelledby="job-check-ins-title">
      <h2 id="job-check-ins-title">Job check-ins</h2>
      <p className="prose">
        A job asks whether to keep going once it has used its amount. Keep going lets that one job use the same amount
        again. Leave a box empty to use Nectovia’s amount. A change applies to jobs that start after it.
      </p>
      {JOB_TIERS.map((tier) => (
        <label className="caption" key={tier}>
          {jobTierLabel(tier)}
          <input
            type="text"
            inputMode="numeric"
            value={text[tier]}
            placeholder={String(view.defaults[tier])}
            disabled={busy}
            onChange={(event) => setText({ ...text, [tier]: event.target.value })}
          />
          <span className="caption">
            {view.effective.source[tier] === 'business'
              ? `Your amount. Nectovia’s is ${credits(view.defaults[tier] ?? 750)}.`
              : view.effective.source[tier] === 'plan'
                ? `Your Managed plan's amount is ${credits(view.defaults[tier] ?? 750)}.`
                : `Nectovia’s amount is ${credits(view.defaults[tier] ?? 750)}.`}
          </span>
        </label>
      ))}
      <div className="ws-actions">
        <Button tone="primary" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {line && (
        <p className="caption" role="status">
          {line}
        </p>
      )}
    </section>
  );
}
