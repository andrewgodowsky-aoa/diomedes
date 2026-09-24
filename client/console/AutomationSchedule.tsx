import { useId, useMemo, useState } from 'react';
import type { AttentionView, AutomationView, ScheduleAct } from '../../shared/automations';
import {
  CATCH_UP_CHOICES,
  DEFAULT_CATCH_UP_MINUTES,
  WEEKDAY_NAMES,
  checkSchedule,
  nextSlots,
  slotText,
  type AutomationSchedule,
  type Weekday,
} from '../../shared/automation-schedule';
import { changeSchedule, markAttentionSeen, type ScheduleAction } from './automation-schedule-api';

/**
 * Automations Milestone B: the schedule, this computer, and what needs a
 * person, inside an automation's detail.
 *
 * Everything shown is the host's record: the saved revision, whether it is
 * on, paused or off and who said so, the next slots the host computed, and
 * the last heartbeat this computer wrote. The only thing computed here is the
 * preview of a schedule still being edited, from the same shared functions
 * the host uses. Turning a schedule on is its own button: saving one never
 * turns it on.
 */

const when = (at: string) =>
  new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const ACT_TEXT: Readonly<Record<ScheduleAct['kind'], string>> = {
  edited: 'Changed the schedule',
  enabled: 'Turned the schedule on',
  paused: 'Paused',
  resumed: 'Resumed',
  'turned-off': 'Turned the schedule off',
};

const CATCH_UP_TEXT: Readonly<Record<number, string>> = {
  0: 'Never: record it only',
  60: 'Within 1 hour',
  120: 'Within 2 hours',
  240: 'Within 4 hours',
};

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zones(current: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = ['UTC'];
  }
  return all.includes(current) ? all : [current, ...all];
}

export interface ScheduleSectionProps {
  organizationId: string;
  automation: AutomationView;
  /** The person's own id, so "turned on by" can say "you". */
  personId: string | null;
  onChanged(message: string): void;
}

function Editor({
  initial,
  catchUp,
  busy,
  onSave,
  onCancel,
}: {
  initial: AutomationSchedule;
  catchUp: number;
  busy: boolean;
  onSave(schedule: AutomationSchedule, catchUpMinutes: number): void;
  onCancel(): void;
}) {
  const [cadence, setCadence] = useState(initial.cadence);
  const [weekday, setWeekday] = useState<Weekday>(initial.weekday ?? 1);
  const [time, setTime] = useState(initial.time);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [catchUpMinutes, setCatchUp] = useState(catchUp);
  const ids = { cadence: useId(), weekday: useId(), time: useId(), zone: useId(), catchUp: useId() };
  const draft = { cadence, weekday: cadence === 'weekly' ? weekday : null, time, timezone };
  const checked = checkSchedule(draft);
  const preview = useMemo(
    () => (checked.ok ? nextSlots(checked.schedule, Date.now(), 3) : []),
    // `checked` is derived from exactly these fields.
    [cadence, weekday, time, timezone],
  );
  const zoneList = useMemo(() => zones(initial.timezone), [initial.timezone]);
  return (
    <form
      className="auto-schedule-form"
      aria-label="Edit schedule"
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok && !busy) onSave(checked.schedule, catchUpMinutes);
      }}
    >
      <div className="auto-field">
        <label htmlFor={ids.cadence}>Repeats</label>
        <select
          id={ids.cadence}
          value={cadence}
          onChange={(event) => setCadence(event.target.value as AutomationSchedule['cadence'])}
        >
          <option value="weekly">Every week</option>
          <option value="daily">Every day</option>
        </select>
      </div>
      {cadence === 'weekly' && (
        <div className="auto-field">
          <label htmlFor={ids.weekday}>Day</label>
          <select
            id={ids.weekday}
            value={weekday}
            onChange={(event) => setWeekday(Number(event.target.value) as Weekday)}
          >
            {WEEKDAY_NAMES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="auto-field">
        <label htmlFor={ids.time}>Local time</label>
        <input
          id={ids.time}
          type="time"
          step={60}
          value={time}
          required
          onChange={(event) => setTime(event.target.value.slice(0, 5))}
        />
      </div>
      <div className="auto-field auto-field-wide">
        <label htmlFor={ids.zone}>Timezone</label>
        <select id={ids.zone} value={timezone} onChange={(event) => setTimezone(event.target.value)}>
          {zoneList.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="auto-field auto-field-wide">
        <label htmlFor={ids.catchUp}>A run missed while this computer is off</label>
        <select
          id={ids.catchUp}
          value={catchUpMinutes}
          onChange={(event) => setCatchUp(Number(event.target.value))}
        >
          {CATCH_UP_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? CATCH_UP_TEXT[0] : `Still runs if the computer is back ${CATCH_UP_TEXT[minutes]!.toLowerCase()}`}
            </option>
          ))}
        </select>
      </div>
      <div className="auto-preview" aria-live="polite">
        {checked.ok ? (
          <>
            <span className="auto-preview-head">Would run</span>
            <ul>
              {preview.map((slot) => (
                <li key={slot.at}>{slotText(checked.schedule, slot)}</li>
              ))}
            </ul>
          </>
        ) : (
          <span>{checked.message}</span>
        )}
      </div>
      <div className="auto-schedule-actions">
        <button type="submit" className="button primary" aria-disabled={!checked.ok || busy}>
          {busy ? 'Saving...' : 'Save schedule'}
        </button>
        <button type="button" className="auto-toggle" onClick={onCancel}>
          Cancel
        </button>
        <span className="auto-blocked">Saving does not turn it on.</span>
      </div>
    </form>
  );
}

export function ScheduleSection({ organizationId, automation, personId, onChanged }: ScheduleSectionProps) {
  const schedule = automation.schedule;
  const [editing, setEditing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reasonId = useId();
  const blockedId = useId();
  const who = (id: string | null) => (id && id === personId ? 'you' : id ?? 'someone');

  async function act(change: ScheduleAction, message: (result: Awaited<ReturnType<typeof changeSchedule>>) => string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await changeSchedule(organizationId, automation.id, schedule.generation, change);
      setEditing(false);
      setPausing(false);
      setReason('');
      onChanged(message(result));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The schedule could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  const initial: AutomationSchedule = schedule.current?.schedule ?? {
    cadence: 'weekly',
    weekday: 1,
    time: '08:00',
    timezone: localZone(),
  };
  const state =
    schedule.state === 'enabled'
      ? `On since ${when(schedule.since!)}, turned on by ${who(schedule.by)}`
      : schedule.state === 'paused'
        ? `Paused ${when(schedule.since!)} by ${who(schedule.by)}: ${schedule.pauseReason}`
        : 'Off. It runs only when someone presses Run once.';
  return (
    <section aria-label="Schedule" className="auto-schedule">
      <h3>Schedule</h3>
      <dl className="auto-facts">
        <div>
          <dt>Runs</dt>
          <dd>{schedule.text ?? 'No schedule saved'}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd data-schedule-state={schedule.state}>{state}</dd>
        </div>
        {schedule.next.length > 0 && (
          <div>
            <dt>{schedule.state === 'enabled' ? 'Next runs' : 'Would run'}</dt>
            <dd>
              <ul aria-label={schedule.state === 'enabled' ? 'Next runs' : 'Would run'}>
                {schedule.next.map((slot) => (
                  <li key={slot.at}>{slot.text}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {schedule.current && (
          <div>
            <dt>Missed runs</dt>
            <dd>{schedule.catchUpText}</dd>
          </div>
        )}
        <div>
          <dt>Runs on</dt>
          <dd>
            This computer, <span className="mono lc">{schedule.host.name}</span>.{' '}
            {schedule.host.lastSeenAt
              ? `Last checked ${when(schedule.host.lastSeenAt)}${
                  schedule.host.state === 'unknown' ? '; it has not checked since.' : '.'
                }`
              : 'It has not checked yet.'}
            {!schedule.host.here && ' The schedule is assigned to another computer.'}
          </dd>
        </div>
      </dl>
      {error && (
        <p className="auto-refusal" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <Editor
          initial={initial}
          catchUp={schedule.current?.catchUpMinutes ?? DEFAULT_CATCH_UP_MINUTES}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(next, catchUpMinutes) =>
            void act({ action: 'edit', schedule: next, catchUpMinutes }, () =>
              schedule.state === 'enabled'
                ? 'Schedule changed. It stays on, from the next slot.'
                : 'Schedule saved. It is not on until someone turns it on.',
            )
          }
        />
      ) : pausing ? (
        <div className="auto-schedule-actions" role="group" aria-label="Pause the schedule">
          <label htmlFor={reasonId} className="auto-hidden">
            Reason
          </label>
          <input
            id={reasonId}
            className="auto-reason-input"
            placeholder="Reason (optional)"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="button primary"
            aria-disabled={busy}
            onClick={() =>
              void act({ action: 'pause', ...(reason.trim() ? { reason: reason.trim() } : {}) }, (result) =>
                result.inFlight
                  ? 'Paused. The run already started keeps going; pausing does not stop it.'
                  : 'Paused. Nothing starts on its own until it is resumed.',
              )
            }
          >
            Pause
          </button>
          <button type="button" className="auto-toggle" onClick={() => setPausing(false)}>
            Cancel
          </button>
        </div>
      ) : schedule.mayControl ? (
        <div className="auto-schedule-actions">
          <button type="button" className="auto-toggle" onClick={() => setEditing(true)}>
            {schedule.current ? 'Edit schedule' : 'Set a schedule'}
          </button>
          {schedule.state === 'off' && schedule.current && (
            <button
              type="button"
              className="button primary"
              aria-disabled={busy || !!schedule.enableBlocked}
              aria-describedby={schedule.enableBlocked ? blockedId : undefined}
              onClick={() => {
                if (!schedule.enableBlocked)
                  void act({ action: 'enable' }, (result) =>
                    `Schedule on. Next run: ${result.automation.schedule.next[0]?.text ?? 'none'}.`,
                  );
              }}
            >
              Turn on schedule
            </button>
          )}
          {schedule.state === 'enabled' && (
            <button type="button" className="auto-toggle" onClick={() => setPausing(true)}>
              Pause
            </button>
          )}
          {schedule.state === 'paused' && (
            <button
              type="button"
              className="button primary"
              aria-disabled={busy}
              onClick={() => void act({ action: 'resume' }, () => 'Resumed. Paused slots do not run.')}
            >
              Resume
            </button>
          )}
          {schedule.state !== 'off' && (
            <button
              type="button"
              className="auto-toggle"
              aria-disabled={busy}
              onClick={() => void act({ action: 'turn-off' }, () => 'Schedule off. It runs only when someone presses Run once.')}
            >
              Turn off
            </button>
          )}
          {schedule.state === 'off' && schedule.current && schedule.enableBlocked && (
            <span id={blockedId} className="auto-blocked">
              {schedule.enableBlocked}
            </span>
          )}
        </div>
      ) : (
        <p className="auto-quiet">Only an owner or administrator can change the schedule.</p>
      )}
      {schedule.acts.length > 0 && (
        <details className="auto-evidence">
          <summary>Changes</summary>
          <ol className="auto-acts">
            {schedule.acts.map((item) => (
              <li key={`${item.at}-${item.kind}`}>
                <span className="auto-occurrence-time">{when(item.at)}</span>{' '}
                {ACT_TEXT[item.kind]}
                {item.kind === 'edited' ? ` (revision ${item.revision})` : ''}
                {item.reason ? `: ${item.reason}` : ''} · {who(item.by)}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** Open attention items, one per underlying issue, each with "Mark as seen". */
export function AttentionList({
  organizationId,
  items,
  onChanged,
}: {
  organizationId: string;
  items: readonly AttentionView[];
  onChanged(message: string): void;
}) {
  const [error, setError] = useState('');
  if (!items.length) return null;
  return (
    <section className="auto-attention" aria-label="Needs attention">
      <h3>Needs attention</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id} data-attention-kind={item.kind}>
            <div className="auto-attention-text">
              <strong>{item.title}</strong>
              {item.count > 1 && <span className="auto-attention-count"> · {item.count} times</span>}
              <p>{item.detail}</p>
            </div>
            <button
              type="button"
              className="auto-toggle"
              onClick={async () => {
                setError('');
                try {
                  await markAttentionSeen(organizationId, item.automationId, item.id);
                  onChanged(`Marked as seen: ${item.title}.`);
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : 'It could not be marked.');
                }
              }}
            >
              Mark as seen
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
