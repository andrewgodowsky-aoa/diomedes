import { describe, expect, it } from 'vitest';
import { readyLines, signedInLine } from '../client/Setup.js';
import { defaults } from '../server/store.js';
import { ACCESS_CONTRACT_VERSION, AGENT_FEATURE, AGENT_NOT_INCLUDED_REASON, ROLE_CAPABILITIES } from '../shared/access.js';
import { ACCOUNT_VIEW_VERSION, type AccountStateView, type AccountWorkspaceView } from '../shared/accounts.js';
import { activeBusinessIncludesAgent } from '../shared/onboarding.js';
import type { Settings } from '../shared/types.js';
import type { MemberRole } from '../shared/workspaces.js';

// The ready page (board D06) and the welcome's signed-in line (board D01).

const INCLUDED = "Nectovia's own AI, included with your plan.";
const CREDITS = "Nectovia's own AI, for your Personal work, on the credits you bought.";
const NONE = 'None yet, so Nectovia shows sample work until you sign in to one.';
const NECTOVIA_VIEW = 'The Nectovia view. The switch at the top moves to Work.';
const WORK_VIEW = 'The Work view. The Nectovia view comes with a paid plan.';

function settings(patch: Partial<Settings> = {}): Settings {
  const base = defaults();
  return { ...base, ...patch, onboarding: { ...base.onboarding, resumeAt: 'ready', aiSkipped: true } };
}

function business(id: string, included: boolean | null, role: MemberRole = 'owner'): AccountWorkspaceView {
  const capabilities = ROLE_CAPABILITIES[role];
  return {
    organization: { id, name: `Business ${id}` },
    role,
    roleLabel: 'Business owner',
    capabilities,
    access:
      included === null
        ? null
        : {
            v: ACCESS_CONTRACT_VERSION,
            organizationId: id,
            role,
            roleLabel: 'Business owner',
            capabilities,
            state: included ? 'active' : 'none',
            planLabel: included ? 'Business' : null,
            planId: included ? 'business' : null,
            features: included ? [AGENT_FEATURE] : [],
            agent: { included, reason: included ? '' : AGENT_NOT_INCLUDED_REASON },
            validFrom: null,
            validUntil: null,
            revision: 1,
            grants: null,
            checkedAt: '2026-09-25T00:00:00.000Z',
          },
  };
}

function account(
  workspaces: AccountWorkspaceView[],
  plan: Partial<AccountStateView['plan']> = {},
  person: AccountStateView['person'] = { id: 'p-1', name: 'Frank Ruiz', email: 'frank@example.com' },
): AccountStateView {
  return {
    v: ACCOUNT_VIEW_VERSION,
    backend: { kind: 'faux', label: 'Test accounts', url: null, reason: null, signIn: 'password' },
    browser: null,
    signedIn: true,
    person,
    remember: false,
    protectedStorage: false,
    workspaces,
    plan: { agent: 'unknown', plansUrl: 'https://example.com/plans', notice: false, ...plan },
    remembered: [],
    signedInAt: null,
  };
}

describe('the ready page names what will answer', () => {
  it("says Nectovia's own AI is included when the business this person is in includes it", () => {
    const value = settings({ activeWorkspace: { kind: 'business', organizationId: 'org-a' } });
    const state = account([business('org-a', true)], { agent: 'paid' });
    expect(activeBusinessIncludesAgent(value, state.workspaces)).toBe(true);
    const lines = readyLines(value, state);
    expect(lines.ai).toBe(INCLUDED);
    expect(lines.view).toBe(NECTOVIA_VIEW);
  });

  it('says credits bought without a plan open it for Personal work', () => {
    const value = settings({ activeWorkspace: { kind: 'personal' } });
    const lines = readyLines(value, account([], { agent: 'free', payAsYouGo: true }));
    expect(lines.ai).toBe(CREDITS);
    expect(lines.view).toBe(NECTOVIA_VIEW);
  });

  it('says none yet, and opens Work, on the free version with nothing signed in', () => {
    const lines = readyLines(settings({ activeWorkspace: { kind: 'personal' } }), account([], { agent: 'free' }));
    expect(lines.ai).toBe(NONE);
    expect(lines.view).toBe(WORK_VIEW);
  });

  it('never promises Nectovia on a guess', () => {
    // Personal while a business elsewhere includes it, a business without it, one the service
    // hasn't answered for, and no account service at all.
    for (const [value, state] of [
      [settings({ activeWorkspace: { kind: 'personal' } }), account([business('org-a', true)])],
      [settings({ activeWorkspace: { kind: 'business', organizationId: 'org-b' } }), account([business('org-b', false)])],
      [settings({ activeWorkspace: { kind: 'business', organizationId: 'org-c' } }), account([business('org-c', null)])],
      [settings({ activeWorkspace: { kind: 'business', organizationId: 'org-a' } }), null],
    ] as const) {
      expect(readyLines(value, state).ai).toBe(NONE);
    }
  });

  it('names a default engine of their own beside Nectovia, and on its own on the free version', () => {
    const own = { services: { 'claude-code': true, defaultEngine: 'claude-code' } } as Partial<Settings>;
    const inBusiness = settings({ ...own, activeWorkspace: { kind: 'business', organizationId: 'org-a' } });
    expect(readyLines(inBusiness, account([business('org-a', true)])).ai).toBe(`${INCLUDED} Claude Code is your default.`);
    const free = settings({ ...own, activeWorkspace: { kind: 'personal' } });
    expect(readyLines(free, account([], { agent: 'free' })).ai).toBe('Claude Code is your default.');
  });

  it('opens the view finishing actually opens, not the one new settings start in', () => {
    // New settings start in Work, and the first finish moves a person to the Nectovia view.
    const fresh = settings();
    expect(fresh.view).not.toBe('conversation');
    expect(readyLines(fresh, account([], { agent: 'paid' })).view).toBe(NECTOVIA_VIEW);
    // Someone running setup again keeps the view they chose.
    const again = { ...fresh, view: 'architect' as const, onboarding: { ...fresh.onboarding, completedAt: '2026-10-01T00:00:00.000Z' } };
    expect(readyLines(again, account([], { agent: 'paid' })).view).toBe('The Work view.');
  });

  it("reads the detail and file answers back in the boards' words", () => {
    const lines = readyLines(settings({ detail: 'guided' }), null);
    expect(lines.detail).toBe('Guided: plain words, fewer numbers, and an explanation on everything that needs a decision.');
    expect(lines.files).toBe('A job waits for your OK before it changes files.');
    const other = settings({ detail: 'technical', permissions: { ...defaults().permissions, changingFiles: false } });
    expect(readyLines(other, null).detail).toBe('Technical: engines, models, logs, version numbers and developer tools where they apply.');
    expect(readyLines(other, null).files).toBe(
      'A job changes files without waiting. Changes it proposes still wait for your review.',
    );
  });
});

describe('the welcome says who is signed in', () => {
  it('names the person, their role and the business they are acting in', () => {
    const value = settings({ activeWorkspace: { kind: 'business', organizationId: 'org-a' } });
    expect(signedInLine(account([business('org-a', true)]), value)).toBe(
      'Signed in as Frank Ruiz, owner of Business org-a.',
    );
    expect(signedInLine(account([business('org-a', true, 'admin')]), value)).toBe(
      'Signed in as Frank Ruiz, manager of Business org-a.',
    );
    expect(signedInLine(account([business('org-a', true, 'member')]), value)).toBe(
      'Signed in as Frank Ruiz, employee of Business org-a.',
    );
  });

  it('names the person alone in Personal, and nobody without an account', () => {
    const personal = settings({ activeWorkspace: { kind: 'personal' } });
    expect(signedInLine(account([business('org-a', true)]), personal)).toBe('Signed in as Frank Ruiz.');
    const unnamed = account([], {}, { id: 'p-2', name: '', email: 'pat@example.com' });
    expect(signedInLine(unnamed, personal)).toBe('Signed in as pat@example.com.');
    expect(signedInLine(null, personal)).toBeNull();
  });
});
