import type { Settings } from '../shared/types';
import { Brand, Button, detailDescriptions, titleCase } from './components';

export function Setup({
  settings,
  save,
  busy,
}: {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy: boolean;
}) {
  const step = settings.onboarding.resumeAt;
  const order = ['welcome', 'q1', 'q2', 'q3', 'ready', 'done'] as const;
  const index = order.indexOf(step);
  const update = (patch: Partial<Settings['onboarding']>) =>
    save({ ...settings, onboarding: { ...settings.onboarding, ...patch } });
  async function next(skip = false) {
    const ob = { ...settings.onboarding };
    if (step === 'q1' && (!ob.work || skip)) ob.work = 'mix';
    if (step === 'q2' && (!ob.detail || skip)) ob.detail = 'standard';
    if (step === 'q3' && (!ob.familiarity || skip)) ob.familiarity = 'some';
    ob.resumeAt = order[index + 1];
    if (ob.resumeAt === 'done') ob.completedAt = new Date().toISOString();
    await save({
      ...settings,
      onboarding: ob,
      detail: ob.detail ?? 'standard',
      permissions: { ...settings.permissions, changingFiles: ob.familiarity === 'new' },
      explanations:
        ob.familiarity === 'new' ? 'persistent' : ob.familiarity === 'comfortable' ? 'off' : 'once',
    });
  }
  return (
    <div className="setup">
      <header className="setup-top">
        <Brand />
      </header>
      <main className="setup-content">
        {step === 'welcome' ? (
          <>
            <h1>A place for your work</h1>
            <p className="prose intro">
              Diomedes is a place for your work: projects, documents, plans, tasks, and a history of
              everything that changed.
            </p>
            <div className="actions">
              <Button tone="primary" disabled={busy} onClick={() => void next()}>
                Continue
              </Button>
            </div>
          </>
        ) : step === 'ready' ? (
          <>
            <h1>Ready.</h1>
            <p className="prose intro">
              You'll see <strong>{titleCase(settings.detail)}</strong> detail:{' '}
              {detailDescriptions[settings.detail].toLowerCase()} Diomedes asks before{' '}
              {settings.permissions.changingFiles ? 'changing files, ' : ''}deleting, sending
              anything outside this computer, or working outside a project. Change either in
              Settings.
            </p>
            <div className="actions">
              <Button tone="quiet" onClick={() => void update({ resumeAt: 'q3' })}>
                Back
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void next()}>
                Open Diomedes
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="caption">Question {index} of 3</p>
            <h1>
              {step === 'q1'
                ? 'What are you here to work on?'
                : step === 'q2'
                  ? 'How much technical detail would you like to see?'
                  : 'How familiar are you with software that can edit files or complete tasks for you?'}
            </h1>
            <div
              className="radio-list"
              role="radiogroup"
              aria-label={
                step === 'q1' ? 'Kind of work' : step === 'q2' ? 'Interface detail' : 'Familiarity'
              }
            >
              {step === 'q1' &&
                (
                  [
                    ['business', 'Business'],
                    ['school', 'School and research'],
                    ['software', 'Software and technical work'],
                    ['personal', 'Personal projects'],
                    ['mix', 'A mix'],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    className={`radio-row ${settings.onboarding.work === value ? 'selected' : ''}`}
                    key={value}
                  >
                    <input
                      type="radio"
                      name="work"
                      checked={settings.onboarding.work === value}
                      onChange={() => void update({ work: value })}
                    />
                    <strong>{label}</strong>
                  </label>
                ))}
              {step === 'q2' &&
                (
                  [
                    ['guided', 'Keep it simple'],
                    ['standard', 'Show useful details'],
                    ['technical', 'Show technical controls'],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    className={`radio-row ${settings.onboarding.detail === value ? 'selected' : ''}`}
                    key={value}
                  >
                    <input
                      type="radio"
                      name="detail"
                      checked={settings.onboarding.detail === value}
                      onChange={() => void update({ detail: value })}
                    />
                    <span>
                      <strong>{label}</strong>
                      <span className="caption">{detailDescriptions[value]}</span>
                    </span>
                  </label>
                ))}
              {step === 'q3' &&
                (
                  [
                    [
                      'new',
                      'New to this',
                      'Diomedes will ask before changing files and explain as it goes.',
                    ],
                    [
                      'some',
                      "I've used some",
                      'Diomedes will ask before deleting, sending anything outside this computer, or working outside a project.',
                    ],
                    ['comfortable', 'Very comfortable', 'Same safety checks, fewer explanations.'],
                  ] as const
                ).map(([value, label, description]) => (
                  <label
                    className={`radio-row ${settings.onboarding.familiarity === value ? 'selected' : ''}`}
                    key={value}
                  >
                    <input
                      type="radio"
                      name="familiarity"
                      checked={settings.onboarding.familiarity === value}
                      onChange={() => void update({ familiarity: value })}
                    />
                    <span>
                      <strong>{label}</strong>
                      <span className="caption">{description}</span>
                    </span>
                  </label>
                ))}
            </div>
            {step === 'q2' && (
              <p className="caption">
                You can change this any time in Settings &gt; Interface detail.
              </p>
            )}
            <div className="setup-actions">
              <Button tone="quiet" onClick={() => void update({ resumeAt: order[index - 1] })}>
                Back
              </Button>
              <Button tone="quiet push-right" disabled={busy} onClick={() => void next(true)}>
                Skip for now
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void next()}>
                Continue
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
