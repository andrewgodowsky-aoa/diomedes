import { useId, type ReactNode } from 'react';
import type { AccountStateView } from '../shared/accounts';
import { routeDisplayName } from '../shared/engines';
import {
  SETUP_ORDER,
  activeBusinessIncludesAgent,
  advanceSetup,
  hasUsableService,
  type SetupStep,
} from '../shared/onboarding';
import type { Detail, Settings } from '../shared/types';
import type { MemberRole } from '../shared/workspaces';
import AISetup from './AISetup';
import { useAccount } from './AccountGate';
import { Button } from './components';
import { NectoviaMark } from './console/NectoviaMark';
import { nectoviaLockedBy } from './console/FreePlanNotice';
import { shownView } from './console/work-view';
import { DETAIL_LABELS, DETAIL_WORDS, detailSample } from './detail-words';
import './setup.css';

/**
 * First run, as the round 2 boards draw it (D01 to D06): a welcome that says who is signed in,
 * three questions, AI setup and a summary of the answers. Every step reads and writes the same
 * settings record, so a reload resumes where the person left off.
 */

const ROLE_WORDS: Readonly<Record<MemberRole, string>> = {
  owner: 'owner',
  admin: 'manager',
  member: 'employee',
};

/** Who is signed in, as the welcome says it, or null when there is no account to name. */
export function signedInLine(
  state: AccountStateView | null | undefined,
  settings: Settings,
): string | null {
  const person = state?.person;
  if (!person) return null;
  const name = person.name || person.email;
  const active = settings.activeWorkspace;
  const business =
    active?.kind === 'business'
      ? state.workspaces.find((entry) => entry.organization.id === active.organizationId)
      : undefined;
  return business
    ? `Signed in as ${name}, ${ROLE_WORDS[business.role]} of ${business.organization.name}.`
    : `Signed in as ${name}.`;
}

export interface ReadyLines {
  ai: string;
  view: string;
  detail: string;
  files: string;
}

/**
 * The ready page's summary. AI names what will answer: Nectovia's own AI when the business this
 * person is acting in includes it or credits they bought open it, and their own default engine
 * beside it. The page never promises Nectovia's AI on a guess, so a plan the account service
 * hasn't answered for reads as none. Starts in is the view finishing opens: the first finish
 * moves a person to the Nectovia view (advanceSetup), and the free version always opens Work.
 */
export function readyLines(
  settings: Settings,
  account: AccountStateView | null | undefined,
): ReadyLines {
  const nectovia = activeBusinessIncludesAgent(settings, account?.workspaces)
    ? "Nectovia's own AI, included with your plan."
    : account?.plan.payAsYouGo === true
      ? "Nectovia's own AI, for your Personal work, on the credits you bought."
      : '';
  const own = hasUsableService(settings)
    ? `${routeDisplayName(settings.services?.['defaultEngine'] as string)} is your default.`
    : '';
  const locked = nectoviaLockedBy(account?.plan) !== null;
  const opens = shownView(settings.onboarding.completedAt ? settings.view : 'conversation', locked);
  const words = DETAIL_WORDS[settings.detail];
  return {
    ai:
      [nectovia, own].filter(Boolean).join(' ') ||
      'None yet, so Nectovia shows sample work until you sign in to one.',
    view:
      opens === 'conversation'
        ? 'The Nectovia view. The switch at the top moves to Work.'
        : locked
          ? 'The Work view. The Nectovia view comes with a paid plan.'
          : 'The Work view.',
    detail: `${DETAIL_LABELS[settings.detail]}: ${words.charAt(0).toLowerCase()}${words.slice(1)}`,
    files: settings.permissions.changingFiles
      ? 'A job waits for your OK before it changes files.'
      : 'A job changes files without waiting. Changes it proposes still wait for your review.',
  };
}

const WORK_KINDS = [
  { value: 'business', label: 'Business' },
  { value: 'school', label: 'School and research' },
  { value: 'software', label: 'Software and technical work' },
  { value: 'personal', label: 'Personal projects' },
  { value: 'mix', label: 'A mix' },
] as const;

const CHECK = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    focusable="false"
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/** One question's answers: real radios, drawn as the boards' rows with a check on the chosen one. */
function Choices<T extends string>({
  name,
  labelledBy,
  value,
  options,
  onPick,
}: {
  name: string;
  labelledBy: string;
  value: T | null;
  options: readonly { value: T; label: string; note?: string }[];
  onPick: (value: T) => void;
}) {
  return (
    <div className="setup-choices" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label key={option.value} className={on ? 'setup-choice on' : 'setup-choice'}>
            <input type="radio" name={name} checked={on} onChange={() => onPick(option.value)} />
            <span className="setup-check" aria-hidden="true">
              {on && CHECK}
            </span>
            <span className="setup-choice-text">
              <strong>{option.label}</strong>
              {option.note && <span className="setup-choice-note">{option.note}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function Setup({
  settings,
  save,
  busy,
}: {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy: boolean;
}) {
  const account = useAccount();
  const headingId = useId();
  const step = settings.onboarding.resumeAt as SetupStep;
  const index = (SETUP_ORDER as readonly string[]).indexOf(step);
  const update = (patch: Partial<Settings['onboarding']>) =>
    save({ ...settings, onboarding: { ...settings.onboarding, ...patch } });
  async function next(skip = false) {
    await save(advanceSetup(settings, skip));
  }
  if (step === 'done') return null;

  const back = (to: SetupStep) => (
    <Button tone="quiet" onClick={() => void update({ resumeAt: to })}>
      Back
    </Button>
  );
  const questionActions = (
    <>
      {back(SETUP_ORDER[index - 1])}
      <Button tone="quiet push-right" disabled={busy} onClick={() => void next(true)}>
        Skip for now
      </Button>
      <Button tone="primary" disabled={busy} onClick={() => void next()}>
        Continue
      </Button>
    </>
  );
  const question = (title: string, body: ReactNode, caption?: string) => (
    <>
      <p className="setup-count">Question {index} of 3</p>
      <h1 id={headingId}>{title}</h1>
      {body}
      {caption && <p className="setup-caption">{caption}</p>}
    </>
  );

  let content: ReactNode;
  let actions: ReactNode = null;
  if (step === 'welcome') {
    const who = signedInLine(account?.state, settings);
    content = (
      <>
        <span className="setup-welcome-mark" role="img" aria-label="Nectovia">
          <NectoviaMark word={false} size={56} />
        </span>
        <h1>Welcome to Nectovia</h1>
        <p className="setup-lede">Hand it a problem, a job or a whole project, and it does the work.</p>
        {who && (
          <p className="setup-caption setup-who">
            {who}{' '}
            <button type="button" className="setup-link" onClick={() => void account?.signOut()}>
              Sign out
            </button>
          </p>
        )}
      </>
    );
    actions = (
      <Button tone="primary push-right" disabled={busy} onClick={() => void next()}>
        Continue
      </Button>
    );
  } else if (step === 'q1') {
    content = question(
      'What are you here to work on?',
      <Choices
        name="work"
        labelledBy={headingId}
        value={settings.onboarding.work}
        options={WORK_KINDS}
        onPick={(work) => void update({ work })}
      />,
    );
    actions = questionActions;
  } else if (step === 'q2') {
    // A new person's settings start at Guided, and skipping keeps what the settings hold, so the
    // page shows that answer picked until another is chosen.
    const level: Detail = settings.onboarding.detail ?? settings.detail;
    const engine = hasUsableService(settings)
      ? routeDisplayName(settings.services?.['defaultEngine'] as string)
      : '';
    content = question(
      'How much detail do you want?',
      <>
        <Choices
          name="detail"
          labelledBy={headingId}
          value={level}
          options={(['guided', 'standard', 'technical'] as const).map((value) => ({
            value,
            label: DETAIL_LABELS[value],
            note: DETAIL_WORDS[value],
          }))}
          onPick={(detail) => void update({ detail })}
        />
        <div className="setup-sample" role="region" aria-label="How a finished job reads">
          <p className="setup-sample-head">
            How a finished job reads<span className="setup-tag">Sample</span>
          </p>
          <p className="setup-sample-line">{detailSample(level, engine)}</p>
        </div>
      </>,
      'Change it any time in Settings, under Interface detail.',
    );
    actions = questionActions;
  } else if (step === 'q3') {
    content = question(
      'Should Nectovia ask before it changes files?',
      <Choices
        name="file-changes"
        labelledBy={headingId}
        value={settings.permissions.changingFiles ? 'ask' : 'go'}
        options={[
          {
            value: 'ask',
            label: 'Ask me first',
            note: 'A job waits for your OK before it changes files in a project.',
          },
          {
            value: 'go',
            label: "Don't ask",
            note: 'A job changes files without waiting. Changes it proposes still wait for your review.',
          },
        ]}
        onPick={(answer) =>
          void save({
            ...settings,
            permissions: { ...settings.permissions, changingFiles: answer === 'ask' },
          })
        }
      />,
      'Deleting files has its own switch in Settings, under Permissions.',
    );
    actions = questionActions;
  } else if (step === 'ai') {
    // AI setup keeps today's content inside the new frame until the engine sign-in flow lands.
    content = (
      <AISetup
        settings={settings}
        save={save}
        busy={busy}
        onContinue={() => void next()}
        onBack={() => void update({ resumeAt: 'q3' })}
      />
    );
  } else {
    const lines = readyLines(settings, account?.state);
    content = (
      <>
        <h1>You&apos;re set up</h1>
        <dl className="setup-summary">
          <dt>AI</dt>
          <dd>{lines.ai}</dd>
          <dt>Starts in</dt>
          <dd>{lines.view}</dd>
          <dt>Detail</dt>
          <dd>{lines.detail}</dd>
          <dt>File changes</dt>
          <dd>{lines.files}</dd>
        </dl>
        <p className="setup-caption">You can change any of these in Settings.</p>
      </>
    );
    actions = (
      <>
        {back('ai')}
        <Button tone="primary push-right" disabled={busy} onClick={() => void next()}>
          Open Nectovia
        </Button>
      </>
    );
  }

  return (
    <div className={`setup step-${step}`}>
      <header className="setup-top">
        {step !== 'welcome' && (
          <span className="setup-mark" role="img" aria-label="Nectovia">
            <NectoviaMark word={false} size={28} />
          </span>
        )}
      </header>
      <main className="setup-body">
        <div className="setup-column">{content}</div>
      </main>
      {actions && <footer className="setup-foot">{actions}</footer>}
    </div>
  );
}
