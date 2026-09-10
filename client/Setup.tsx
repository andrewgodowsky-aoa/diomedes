import type { Settings } from '../shared/types';
import { Brand, Button, detailDescriptions, titleCase } from './components';
import { advanceSetup, hasUsableService } from '../shared/onboarding';
import AISetup from './AISetup';

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
  const order = ['welcome', 'q1', 'q2', 'q3', 'ai', 'ready', 'done'] as const;
  const index = (order as readonly string[]).indexOf(step);
  const update = (patch: Partial<Settings['onboarding']>) =>
    save({ ...settings, onboarding: { ...settings.onboarding, ...patch } });
  async function next(skip = false) {
    await save(advanceSetup(settings, skip));
  }
  if (step === 'done') return null;
  const usable = hasUsableService(settings);
  const engine =
    typeof settings.services?.['defaultEngine'] === 'string'
      ? (settings.services['defaultEngine'] as string)
      : '';
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
        ) : step === 'ai' ? (
          <AISetup
            settings={settings}
            save={save}
            busy={busy}
            onContinue={() => void next()}
            onBack={() => void update({ resumeAt: 'q3' })}
          />
        ) : step === 'ready' ? (
          <>
            <h1>Your workspace is ready</h1>
            <p className="prose intro">
              You&apos;ll work in the {settings.surface === 'workbook' ? 'Workbook' : 'Console'}{' '}
              with {titleCase(settings.detail)} detail:{' '}
              {detailDescriptions[settings.detail].toLowerCase()} File proposals require review
              before Diomedes applies them. Your other approval preferences are saved separately in
              Settings.
            </p>
            {usable ? (
              <p className="prose">
                {titleCase(engine)} is your selected default. Diomedes checks its connection before
                sending a request.
              </p>
            ) : (
              <p className="prose">
                {settings.onboarding.aiSkipped ? 'AI setup was skipped. ' : ''}No usable service is
                connected, so Diomedes uses sample work on this computer.
              </p>
            )}
            <div className="actions">
              <Button tone="quiet" onClick={() => void update({ resumeAt: 'ai' })}>
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
                  ? 'How much detail do you want?'
                  : 'How should file changes work?'}
            </h1>
            {step === 'q1' && (
              <div className="radio-list" role="radiogroup" aria-label="Kind of work">
                {(
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
              </div>
            )}
            {step === 'q2' && (
              <>
                <div className="radio-list" role="radiogroup" aria-label="Detail preference">
                  {(['guided', 'standard', 'technical'] as const).map((value) => (
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
                        <strong>{titleCase(value)}</strong>
                        <span className="caption">{detailDescriptions[value]}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="caption">
                  You can change this any time in Settings &gt; Interface detail.
                </p>
              </>
            )}
            {step === 'q3' && (
              <>
                <div className="setting-rows">
                  <label className="setting-row">
                    <span>Ask before changing files in a project</span>
                    <input
                      type="checkbox"
                      checked={settings.permissions.changingFiles}
                      onChange={(e) =>
                        void save({
                          ...settings,
                          permissions: {
                            ...settings.permissions,
                            changingFiles: e.target.checked,
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <p className="caption">
                  Exact proposals always require your review, even if you allow direct edits.
                </p>
              </>
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
