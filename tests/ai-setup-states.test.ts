import { describe, expect, it } from 'vitest';
import { CONNECTION_TTL_MS } from '../shared/connection-policy.js';
import type { RepairReason } from '../shared/connection-policy.js';
import type { EngineCandidate, EngineConnection, SetupDiagnostic } from '../shared/engines.js';
import {
  NOT_SIGNING_IN,
  SIGN_IN_SETTLE_MS,
  SIGN_IN_WINDOW_MS,
  advanceSignIn,
  advanceWatches,
  attemptFailure,
  attemptSentence,
  attemptStage,
  benignConflict,
  installationConflict,
  signInSentence,
  signingIn,
  checkedSentence,
  compatibilityText,
  discoveryOutcome,
  NO_ENGINES_FOUND,
  connected,
  contextText,
  placeholderConnection,
  primaryControl,
  provenanceText,
  repairNote,
  repairText,
  routeIssueSentences,
  setupStates,
  showsCandidates,
  sourceText,
  stageAction,
  stageText,
  verified,
  verifiedSentence,
} from '../client/ai-setup-state.js';

/**
 * What the setup screen is allowed to say about one route.
 *
 * Every answer here comes from the host's own record: the four states, the one
 * next action the host derived, why a binding is broken, where an attempt
 * stopped, and the one expiry rule in `shared/connection-policy.ts`. The screen
 * that renders these has no clock comparison and no next action of its own.
 */

const CHECKED = '2026-09-20T10:00:00.000Z';
const NOW = Date.parse(CHECKED) + 1_000;
const time = (value: string) => `at ${Date.parse(value)}`;

const base: EngineConnection = {
  engine: 'opencode',
  installation: 'found',
  compatibility: 'supported',
  authentication: 'signed-in',
  accountRoute: 'opencode:opencode-go',
  models: [
    {
      slug: 'opencode-go/glm-5.2',
      name: 'GLM 5.2',
      description: 'A fixture model.',
      defaultEffort: null,
      efforts: [],
    },
  ],
  checkedAt: CHECKED,
  detail: 'Native OpenCode Go account connected.',
  usage: { state: 'unknown', checkedAt: null },
  revision: 3,
  nextAction: 'test-connection',
};

const candidate = (patch: Partial<EngineCandidate> = {}): EngineCandidate => ({
  id: 'system:opencode:C:\\Tools\\opencode.exe',
  engine: 'opencode',
  source: 'system',
  present: true,
  path: 'C:\\Tools\\opencode.exe',
  version: '1.18.3',
  sha256: 'a'.repeat(64),
  integrity: 'verified',
  protocol: 'passed',
  provenance: 'unverified',
  context: 'windows-native',
  compatibility: 'unsupported',
  ...patch,
});

describe('the four states one route shows', () => {
  it('says nothing has been checked before anything has been', () => {
    const states = setupStates(placeholderConnection('opencode'));
    expect(states.map((state) => state.value)).toEqual(['unknown', 'unknown', 'unknown', 'no']);
    expect(states.map((state) => state.text)).toEqual([
      'Not checked',
      'Not checked',
      'Not checked',
      'Not tested',
    ]);
  });

  it('counts the models the engine itself listed', () => {
    expect(setupStates(base).map((state) => state.text)).toEqual([
      'Found',
      'Detected',
      '1 listed',
      'Not tested',
    ]);
  });

  it('says found is not usable when the copy did not answer, changed or is corrupt', () => {
    const state = (patch: Partial<EngineConnection>) => setupStates({ ...base, ...patch })[0];
    expect(state({ installation: 'corrupt' })).toMatchObject({
      value: 'no',
      text: 'Found, failed its integrity check',
    });
    expect(state({ compatibility: 'unsupported' })).toMatchObject({
      value: 'no',
      text: 'Found, did not answer its check',
    });
    expect(state({ repair: 'selected-changed' })).toMatchObject({
      value: 'no',
      text: 'Found, needs repair',
    });
    expect(state({ installation: 'missing' }).text).toBe('Not found');
    expect(state({}).text).toBe('Found');
  });

  it('reports an empty model list as none listed once a check has run', () => {
    expect(setupStates({ ...base, models: [] })[2].text).toBe('None listed');
    expect(setupStates({ ...base, models: [], checkedAt: null })[2].text).toBe('Not checked');
    expect(setupStates({ ...base, authentication: 'signed-out' })[1].text).toBe('Not detected');
  });

  it('calls a route tested only when the receipt matches this binding revision', () => {
    const receipt = {
      engine: 'opencode' as const,
      revision: 3,
      candidateId: candidate().id,
      version: '1.18.4',
      accountRoute: 'opencode:opencode-go',
      model: 'opencode-go/glm-5.2',
      runId: 'run-1',
      buildId: 'build-1',
      verifiedAt: CHECKED,
    };
    expect(verified({ ...base, verification: receipt })).toBe(true);
    expect(setupStates({ ...base, verification: receipt })[3].text).toBe('Succeeded');
    // The selection moved after that result, so it verifies nothing now.
    expect(verified({ ...base, revision: 4, verification: receipt })).toBe(false);
    expect(verifiedSentence({ ...base, revision: 4, verification: receipt }, time)).toContain(
      'before this route changed',
    );
    expect(verifiedSentence({ ...base, verification: receipt }, time)).toContain(
      'opencode-go/glm-5.2',
    );
    // An older payload carries no revision at all, and a receipt for revision 0
    // still matches it.
    expect(verified({ ...base, revision: undefined, verification: { ...receipt, revision: 0 } })).toBe(
      true,
    );
  });
});

describe('the one next action, taken from the host', () => {
  it('renders each host action as one control', () => {
    const label = (action: EngineConnection['nextAction']) =>
      primaryControl({ ...base, nextAction: action }, 'OpenCode');
    expect(label('install')).toMatchObject({
      intent: 'install',
      label: 'Install compatible copy for Nectovia',
    });
    expect(label('repair')).toMatchObject({
      intent: 'install',
      label: 'Repair with a compatible copy for Nectovia',
    });
    expect(label('choose-installation')).toMatchObject({ intent: 'choose' });
    expect(label('check-connection')).toMatchObject({
      intent: 'check',
      label: 'Check sign-in and models',
    });
    expect(label('sign-in')).toMatchObject({ intent: 'sign-in', label: 'Sign in with OpenCode' });
    expect(label('enable')).toMatchObject({ intent: 'enable' });
    expect(label('test-connection')).toMatchObject({
      intent: 'test',
      label: 'Test this connection',
    });
    expect(label('ready')).toMatchObject({ intent: 'none', label: '' });
  });

  it('asks the host again when a record carries no next action', () => {
    expect(primaryControl(placeholderConnection('cursor'), 'Cursor')).toMatchObject({
      action: 'check-connection',
      intent: 'check',
    });
  });

  it('answers a route issue and an empty model list by looking again, never by demanding a purchase', () => {
    for (const action of ['explain-account-route', 'resolve-model-access'] as const) {
      const control = primaryControl({ ...base, nextAction: action }, 'OpenCode');
      expect(control.intent).toBe('check');
      expect(control.label).toBe('Check sign-in and models');
    }
  });

  it('names the API key route for oh-my-pi rather than a sign-in', () => {
    expect(
      primaryControl({ ...base, engine: 'oh-my-pi', nextAction: 'sign-in' }, 'oh-my-pi').label,
    ).toBe('Configure OpenAI API access');
  });
});

describe('a binding that broke', () => {
  const bound = {
    ...base,
    binding: {
      id: candidate().id,
      engine: 'opencode' as const,
      path: 'C:\\Tools\\opencode.exe',
      version: '1.18.4',
      sha256: 'a'.repeat(64),
      source: 'system' as const,
      boundAt: CHECKED,
      origin: 'explicit' as const,
    },
  };

  it('names the installation that disappeared and refuses to move on its own', () => {
    const text = repairText({ ...bound, repair: 'selected-missing' });
    expect(text).toContain('C:\\Tools\\opencode.exe');
    expect(text).toContain('will not switch to another copy on its own');
  });

  it('names the installation that changed', () => {
    expect(repairText({ ...bound, repair: 'selected-changed' })).toContain('has changed since you chose it');
    expect(repairText({ ...bound, repair: 'selected-unverified' })).toContain(
      'version and integrity checks',
    );
  });

  it('says plainly when no installation matches the supported version', () => {
    expect(repairText({ ...base, repair: 'no-reviewed-candidate' })).toBe(
      'No installation on this computer matches the version Nectovia supports.',
    );
  });

  it('says something about a repair reason this build has no words for', () => {
    // A newer host can send a reason this build was written before. The card
    // renders one sentence for a route that says it needs repair, and an empty
    // one is a card showing a problem and saying nothing about it.
    const newer = { ...bound, repair: 'a-reason-from-a-newer-host' as RepairReason };
    expect(repairText(newer)).toBe('');
    expect(repairNote(newer)).not.toBe('');
    expect(repairNote(newer)).toMatch(/installation/i);
    // A route that needs no repair still says nothing.
    expect(repairNote(base)).toBe('');
    // A reason it does know is said in its own words, not the fallback.
    expect(repairNote({ ...bound, repair: 'selected-missing' })).toBe(
      repairText({ ...bound, repair: 'selected-missing' }),
    );
  });

  it('explains a corrupt installation without a repair reason', () => {
    expect(repairText({ ...base, installation: 'corrupt', location: 'C:\\Tools\\opencode.exe' })).toContain(
      'failed its integrity check',
    );
    expect(repairText(base)).toBe('');
  });

  it('shows the installations when there is a choice, a recommendation or a repair', () => {
    expect(showsCandidates(base)).toBe(false);
    expect(showsCandidates({ ...base, candidates: [candidate()] })).toBe(false);
    expect(
      showsCandidates({
        ...base,
        candidates: [candidate(), candidate({ id: 'managed:opencode:x', source: 'managed' })],
      }),
    ).toBe(true);
    expect(
      showsCandidates({
        ...base,
        candidates: [candidate()],
        recommendedCandidateId: candidate().id,
      }),
    ).toBe(true);
    expect(
      showsCandidates({ ...bound, candidates: [candidate()], repair: 'selected-changed' }),
    ).toBe(true);
  });
});

describe('how an installation is described', () => {
  it('says whose copy it is', () => {
    expect(sourceText('managed')).toBe("Nectovia's private copy");
    expect(sourceText('system')).toBe('Your own installation');
    expect(sourceText('manual')).toContain('pointed Nectovia at');
  });

  it('says plainly that an unverified copy has an unproven publisher', () => {
    expect(provenanceText('unverified')).toBe(
      'Your own copy; Nectovia did not verify its publisher.',
    );
    expect(provenanceText('reviewed-release')).toContain('verified these bytes');
  });

  it('names a WSL copy and a desktop application as what they are', () => {
    expect(contextText('wsl')).toBe('WSL');
    expect(contextText('desktop-app')).toBe('Desktop application');
    expect(contextText('windows-native')).toBe('Windows command line');
    expect(compatibilityText('unsupported')).toBe('Did not answer its check');
  });
});

describe('a check that finds nothing', () => {
  it('says so aloud once a check has run and no route has a usable installation', () => {
    const none = (['claude-code', 'opencode'] as const).map((engine) => ({
      ...base,
      engine,
      installation: 'missing' as const,
    }));
    expect(discoveryOutcome(none)).toBe(NO_ENGINES_FOUND);
    expect(discoveryOutcome([...none, { ...base, repair: 'selected-missing' as const }])).toBe(
      NO_ENGINES_FOUND,
    );
  });
  it('stays quiet before any check and while one route is usable', () => {
    expect(discoveryOutcome([{ ...base, installation: 'not-checked' }])).toBeNull();
    expect(discoveryOutcome([{ ...base, installation: 'missing' }, base])).toBeNull();
  });
});

describe('a different account route', () => {
  it('reports what the tool said and which single route this adapter uses', () => {
    const sentences = routeIssueSentences(
      { ...base, routeIssue: { required: 'opencode-go', connected: ['zen', 'anthropic'] } },
      'OpenCode',
    );
    expect(sentences[0]).toBe('OpenCode reported zen, anthropic.');
    expect(sentences[1]).toContain('opencode-go');
    expect(sentences[1]).toContain('not used here');
    // Never a sign-out claim, and never an instruction to buy anything.
    expect(sentences.join(' ')).not.toMatch(/sign(ed)? in|sign(ed)? out|buy|subscribe|upgrade/i);
  });

  it('says nothing when the host reported no route issue', () => {
    expect(routeIssueSentences(base, 'OpenCode')).toEqual([]);
  });
});

describe('where an attempt stopped', () => {
  it('separates the local service from the provider account', () => {
    expect(stageText('local-handshake')).toContain("tool's own service on this computer");
    expect(stageAction('local-handshake')).toContain('not your provider account');
    expect(stageAction('provider-auth')).toContain('Check the account this route uses');
  });

  it('never answers a staged failure with a blanket sign-in instruction', () => {
    for (const stage of [
      'discovery',
      'runtime-verification',
      'launch',
      'local-handshake',
      'provider-auth',
      'model-list',
      'dispatch',
      'stream',
      'cleanup',
    ] as const) {
      expect(stageText(stage).length).toBeGreaterThan(0);
      expect(stageAction(stage)).not.toMatch(/sign in again/i);
    }
  });

  it('warns that a dispatched request may already have been answered', () => {
    expect(stageAction('dispatch')).toContain('reached the provider');
    expect(stageAction('cleanup')).toContain('may still be running');
  });
});

describe('how old a check is', () => {
  it('uses the one shared boundary: exactly the TTL old is no longer current', () => {
    const observed = Date.parse(CHECKED);
    expect(checkedSentence(base, observed + CONNECTION_TTL_MS - 1, time)).toBe(
      `Checked ${time(CHECKED)}`,
    );
    expect(checkedSentence(base, observed + CONNECTION_TTL_MS, time)).toContain(
      'no longer current',
    );
  });

  it('asks for a fresh check when the timestamp is unreadable or in the future', () => {
    expect(checkedSentence({ ...base, checkedAt: 'not a date' }, NOW, time)).toBe(
      'The last check carries no usable time. Check again.',
    );
    expect(checkedSentence({ ...base, checkedAt: new Date(NOW + 60_000).toISOString() }, NOW, time)).toBe(
      'The last check carries no usable time. Check again.',
    );
    expect(checkedSentence({ ...base, checkedAt: null }, NOW, time)).toBe('Not checked yet');
  });
});

/**
 * A native sign-in window Diomedes opened.
 *
 * The host owns the window and runs its own sign-in and model check when it
 * ends, so the screen waits rather than asking. The single rule these cases
 * exist to hold: a window that closed is not an account. Between the window
 * ending and the host's check landing, the card is still waiting — and what it
 * shows afterwards is whatever that check wrote, signed in or not.
 */
describe('waiting on a native sign-in window', () => {
  // The wait begins after the record's own last check, which is the real
  // ordering: the window opens, and only then does the host look again.
  const opened = Date.parse(CHECKED) + 60_000;
  const open: EngineConnection = { ...base, signInWindow: 'running' };
  const ended: EngineConnection = { ...base, signInWindow: 'idle' };

  it('starts waiting when the host reports a window of its own, and keeps one start', () => {
    const first = advanceSignIn(undefined, open, opened);
    expect(first).toMatchObject({ state: 'open', startedAtMs: opened, endedAtMs: null });
    // A second poll while it is still open does not move the start.
    expect(advanceSignIn(first, open, opened + 5_000)).toMatchObject({
      state: 'open',
      startedAtMs: opened,
    });
    expect(signingIn(first)).toBe(true);
  });

  it('waits for the host check instead of reading a closed window as signed in', () => {
    const watching = advanceSignIn(undefined, open, opened);
    // The window ended. The record still carries the check from before it.
    const settling = advanceSignIn(watching, { ...ended, checkedAt: CHECKED }, opened + 1_000);
    expect(settling.state).toBe('checking');
    expect(signingIn(settling)).toBe(true);
    // Nothing has been checked at all: still waiting, still not an account.
    expect(advanceSignIn(watching, { ...ended, checkedAt: null }, opened + 1_000).state).toBe(
      'checking',
    );
    // An unreadable stamp cannot end the wait either.
    expect(
      advanceSignIn(watching, { ...ended, checkedAt: 'not a date' }, opened + 1_000).state,
    ).toBe('checking');
  });

  it('stops waiting as soon as the host check has answered', () => {
    const watching = advanceSignIn(undefined, open, opened);
    const rechecked = { ...ended, checkedAt: new Date(opened + 2_000).toISOString() };
    expect(advanceSignIn(watching, rechecked, opened + 2_100)).toEqual(NOT_SIGNING_IN);
    // Whatever that check said is what the card then shows: a signed-out answer
    // ends the wait exactly as a signed-in one does.
    expect(
      advanceSignIn(watching, { ...rechecked, authentication: 'signed-out', models: [] }, opened + 2_100),
    ).toEqual(NOT_SIGNING_IN);
  });

  it('gives up waiting after a bounded time rather than holding the card open', () => {
    const watching = advanceSignIn(undefined, open, opened);
    const stale = { ...ended, checkedAt: CHECKED };
    const settling = advanceSignIn(watching, stale, opened + 1_000);
    expect(advanceSignIn(settling, stale, opened + 1_000 + SIGN_IN_SETTLE_MS - 1).state).toBe(
      'checking',
    );
    // The budget is spent and no check ever answered. The card takes its
    // controls back, and the person is told that rather than left with a
    // silently settled card.
    const spent = advanceSignIn(settling, stale, opened + 1_000 + SIGN_IN_SETTLE_MS);
    expect(signingIn(spent)).toBe(false);
    expect(signInSentence(spent, 'OpenCode')).toBe(
      'Nectovia could not confirm the OpenCode sign-in. Check it again.',
    );
  });

  it('ends a window that is never reported closed, and does not begin it again', () => {
    const watching = advanceSignIn(undefined, open, opened);
    // Still open one tick before the bound, over at it.
    expect(signingIn(advanceSignIn(watching, open, opened + SIGN_IN_WINDOW_MS - 1))).toBe(true);
    const spent = advanceSignIn(watching, open, opened + SIGN_IN_WINDOW_MS);
    expect(signingIn(spent)).toBe(false);
    // The same window is still open, and it must not arm a second wait on the
    // next poll: that would hide the card's controls again for another budget,
    // for ever, without the person asking for anything.
    expect(signingIn(advanceSignIn(spent, open, opened + SIGN_IN_WINDOW_MS + 1_000))).toBe(false);
  });

  it('ends a wait the host answers, even after that wait was given up on', () => {
    const watching = advanceSignIn(undefined, open, opened);
    const stale = { ...ended, checkedAt: CHECKED };
    // The window closed, and then nothing answered for a minute.
    const settling = advanceSignIn(watching, stale, opened + 1_000);
    const spent = advanceSignIn(settling, stale, opened + 60_000);
    expect(signingIn(spent)).toBe(false);
    // A check that answered after this wait began clears it altogether, so the
    // line about an unconfirmed sign-in goes when the record moves on.
    const answered = advanceSignIn(
      spent,
      { ...ended, checkedAt: new Date(opened + 61_000).toISOString() },
      opened + 61_100,
    );
    expect(answered).toEqual(NOT_SIGNING_IN);
    expect(signInSentence(answered, 'OpenCode')).toBe('');
  });

  it('gives a second window its own wait, so the first check cannot answer for it', () => {
    const first = advanceSignIn(undefined, open, opened);
    const settling = advanceSignIn(first, { ...ended, checkedAt: CHECKED }, opened + 1_000);
    expect(settling.state).toBe('checking');
    // A new window opens before the first check has landed.
    const second = advanceSignIn(settling, open, opened + 2_000);
    expect(second).toMatchObject({ state: 'open', startedAtMs: opened + 2_000 });
    // The first window's check now answers. It is older than this wait began,
    // so it settles nothing: this window's own check is still to come.
    const firstAnswer = { ...ended, checkedAt: new Date(opened + 1_500).toISOString() };
    expect(advanceSignIn(second, firstAnswer, opened + 2_100).state).toBe('checking');
  });

  it('is not started or ended by a payload that reports no window at all', () => {
    expect(advanceSignIn(undefined, base, opened)).toEqual(NOT_SIGNING_IN);
    const watching = advanceSignIn(undefined, open, opened);
    // An older status payload carries no `signInWindow`, so it says nothing
    // about the window and cannot end the wait on its own.
    expect(advanceSignIn(watching, base, opened + 1_000)).toEqual(watching);
  });

  it('keeps one wait per route and drops the routes that settled', () => {
    const watches = advanceWatches({}, [open, { ...base, engine: 'cursor', signInWindow: 'running' }], opened);
    expect(Object.keys(watches).sort()).toEqual(['cursor', 'opencode']);
    // One route's window ended and its check answered; the other is untouched.
    const after = advanceWatches(
      watches,
      [{ ...ended, checkedAt: new Date(opened + 2_000).toISOString() }],
      opened + 2_100,
    );
    expect(Object.keys(after)).toEqual(['cursor']);
  });

  it('says a window is open, then that its check is running, and never that it worked', () => {
    const watching = advanceSignIn(undefined, open, opened);
    expect(signInSentence(watching, 'OpenCode')).toBe(
      'The OpenCode sign-in window is open on this computer. Finish it there, or close it.',
    );
    const settling = advanceSignIn(watching, { ...ended, checkedAt: CHECKED }, opened + 1_000);
    expect(signInSentence(settling, 'OpenCode')).toBe(
      'The OpenCode sign-in window closed. Nectovia is checking this service again.',
    );
    expect(signInSentence(settling, 'OpenCode')).not.toMatch(/signed in|connected|ready/i);
    expect(signInSentence(NOT_SIGNING_IN, 'OpenCode')).toBe('');
    expect(signingIn(undefined)).toBe(false);
  });
});

describe('what a failed action says about itself', () => {
  const diagnostic: SetupDiagnostic = {
    buildId: 'build-1',
    engine: 'opencode',
    candidateSource: 'managed',
    installedVersion: '1.18.4',
    accountRoute: 'opencode:opencode-go',
    selectedModel: 'opencode-go/glm-5.2',
    stage: 'model-list',
    code: 'NO_MODELS',
    correlationId: 'correlation-1',
    lastVerifiedAt: null,
    at: CHECKED,
  };

  it('reads the code, the stage and the ambiguity the host sent with the error', () => {
    const failure = attemptFailure('The provider refused this request.', {
      error: 'The provider refused this request.',
      code: 'PROVIDER_DENIED',
      ambiguous: true,
      stage: 'dispatch',
    });
    expect(failure).toEqual({
      message: 'The provider refused this request.',
      code: 'PROVIDER_DENIED',
      stage: 'dispatch',
      ambiguous: true,
    });
    // Nothing is invented from a payload that carries none of it.
    expect(attemptFailure('It failed.')).toEqual({
      message: 'It failed.',
      code: '',
      stage: null,
      ambiguous: false,
    });
    // A stage this build does not know is not a stage.
    expect(attemptFailure('It failed.', { stage: 'teleport' }).stage).toBeNull();
  });

  it('treats a collision with the host own check as nothing to report', () => {
    expect(benignConflict(attemptFailure('Already checking.', { code: 'REQUEST_ACTIVE' }))).toBe(
      true,
    );
    expect(benignConflict(attemptFailure('The provider refused.', { code: 'PROVIDER_DENIED' }))).toBe(
      false,
    );
  });

  it('sends a changed binding to the installations, never to a sign-in', () => {
    const failure = attemptFailure('The installation you chose has changed.', {
      code: 'BINDING_CHANGED',
      stage: 'runtime-verification',
    });
    expect(installationConflict(failure)).toBe(true);
    expect(installationConflict(undefined)).toBe(false);
    const sentence = attemptSentence(attemptStage(failure, base)!);
    expect(sentence).toContain('checking the version and integrity of the installation');
    expect(sentence).toContain('Check the installation, or install the compatible copy.');
    expect(sentence).not.toMatch(/sign in/i);
  });

  it('prefers the stage that travelled with the error over the one on the record', () => {
    const failure = attemptFailure('The provider refused.', {
      code: 'PROVIDER_DENIED',
      stage: 'provider-auth',
    });
    expect(attemptStage(failure, { ...base, diagnostic })).toEqual({
      stage: 'provider-auth',
      code: 'PROVIDER_DENIED',
    });
    // No stage on the error: the host record still answers.
    expect(attemptStage(attemptFailure('It failed.'), { ...base, diagnostic })).toEqual({
      stage: 'model-list',
      code: 'NO_MODELS',
    });
    expect(attemptStage(undefined, base)).toBeNull();
  });

  it('names the stage and its action in one sentence, and omits an absent code', () => {
    expect(attemptSentence({ stage: 'provider-auth', code: 'PROVIDER_DENIED' })).toBe(
      'The last attempt stopped while the provider checking the account (PROVIDER_DENIED). The provider refused this account for this route. Check the account this route uses.',
    );
    expect(attemptSentence({ stage: 'dispatch', code: '' })).toBe(
      'The last attempt stopped while sending the request. The request reached the provider and did not finish.',
    );
  });
});

describe('what the screen treats as a connected route', () => {
  it('needs the installation, the version, the account and a model list', () => {
    expect(connected(base)).toBe(true);
    // An old check does not remove an account, and no clock enters this.
    expect(connected({ ...base, checkedAt: '1999-01-01T00:00:00.000Z' })).toBe(true);
    expect(connected({ ...base, installation: 'corrupt' })).toBe(false);
    expect(connected({ ...base, compatibility: 'unsupported' })).toBe(false);
    expect(connected({ ...base, authentication: 'signed-out' })).toBe(false);
    expect(connected({ ...base, models: [] })).toBe(false);
    expect(connected({ ...base, repair: 'selected-changed' })).toBe(false);
    // An account on another route is a real account, and not this one.
    expect(
      connected({ ...base, routeIssue: { required: 'opencode-go', connected: ['zen'] } }),
    ).toBe(false);
  });

  it('renders a record that carries none of the optional fields', () => {
    const old = placeholderConnection('devin');
    expect(() => setupStates(old)).not.toThrow();
    expect(verified(old)).toBe(false);
    expect(connected(old)).toBe(false);
    expect(repairText(old)).toBe('');
    expect(showsCandidates(old)).toBe(false);
    expect(routeIssueSentences(old, 'Devin')).toEqual([]);
  });
});
