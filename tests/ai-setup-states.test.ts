import { describe, expect, it } from 'vitest';
import { CONNECTION_TTL_MS } from '../shared/connection-policy.js';
import type { EngineCandidate, EngineConnection } from '../shared/engines.js';
import {
  checkedSentence,
  compatibilityText,
  connected,
  contextText,
  placeholderConnection,
  primaryControl,
  provenanceText,
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

  it('separates a found installation that failed its integrity check', () => {
    const corrupt = setupStates({ ...base, installation: 'corrupt' })[0];
    expect(corrupt.value).toBe('no');
    expect(corrupt.text).toBe('Found, failed its integrity check');
    expect(setupStates({ ...base, installation: 'missing' })[0].text).toBe('Not found');
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
      label: 'Install compatible copy for Diomedes',
    });
    expect(label('repair')).toMatchObject({
      intent: 'install',
      label: 'Repair with a compatible copy for Diomedes',
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
      'No installation on this computer matches the version Diomedes supports.',
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
    expect(sourceText('managed')).toBe("Diomedes's private copy");
    expect(sourceText('system')).toBe('Your own installation');
    expect(sourceText('manual')).toContain('pointed Diomedes at');
  });

  it('says plainly that an unverified copy has an unproven publisher', () => {
    expect(provenanceText('unverified')).toBe(
      'Your own copy; Diomedes did not verify its publisher.',
    );
    expect(provenanceText('reviewed-release')).toContain('verified these bytes');
  });

  it('names a WSL copy and a desktop application as what they are', () => {
    expect(contextText('wsl')).toBe('WSL');
    expect(contextText('desktop-app')).toBe('Desktop application');
    expect(contextText('windows-native')).toBe('Windows command line');
    expect(compatibilityText('unsupported')).toBe('Unsupported version');
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
