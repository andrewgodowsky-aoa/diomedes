import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadyNote } from '../client/Setup.js';
import { defaults } from '../server/store.js';
import { ACCESS_CONTRACT_VERSION, AGENT_FEATURE, AGENT_NOT_INCLUDED_REASON, ROLE_CAPABILITIES } from '../shared/access.js';
import type { AccountWorkspaceView } from '../shared/accounts.js';
import { AGENT_READY_SENTENCE, activeBusinessIncludesAgent } from '../shared/onboarding.js';
import type { Settings } from '../shared/types.js';

const SAMPLE = 'No usable service is connected, so Nectovia uses sample work on this computer.';

function settings(patch: Partial<Settings> = {}, skipped = true): Settings {
  const base = defaults();
  return { ...base, ...patch, onboarding: { ...base.onboarding, resumeAt: 'ready', aiSkipped: skipped } };
}

function business(id: string, included: boolean | null): AccountWorkspaceView {
  const capabilities = ROLE_CAPABILITIES.owner;
  return {
    organization: { id, name: `Business ${id}` },
    role: 'owner',
    roleLabel: 'Business owner',
    capabilities,
    access:
      included === null
        ? null
        : {
            v: ACCESS_CONTRACT_VERSION,
            organizationId: id,
            role: 'owner',
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

const render = (value: Settings, workspaces: readonly AccountWorkspaceView[] | null) =>
  renderToStaticMarkup(createElement(ReadyNote, { settings: value, workspaces }));

describe('the ready page names what will answer', () => {
  it('says the Nectovia Agent is ready when the business this person is in includes it', () => {
    const value = settings({ activeWorkspace: { kind: 'business', organizationId: 'org-a' } });
    const workspaces = [business('org-a', true)];
    expect(activeBusinessIncludesAgent(value, workspaces)).toBe(true);
    const markup = render(value, workspaces);
    expect(markup).toContain(AGENT_READY_SENTENCE);
    expect(AGENT_READY_SENTENCE).toBe('The Nectovia Agent is ready and included with your plan.');
    expect(markup).not.toContain('sample work');
    expect(markup).not.toContain('AI setup was skipped');
  });

  it('keeps the sample sentence for someone with no Agent and no connected tool', () => {
    // Personal, even while a business elsewhere includes the Agent: the gate answers for the
    // business the person is acting in, so the page does too.
    const personal = settings({ activeWorkspace: { kind: 'personal' } });
    const elsewhere = [business('org-a', true)];
    expect(activeBusinessIncludesAgent(personal, elsewhere)).toBe(false);
    const markup = render(personal, elsewhere);
    expect(markup).toContain(`AI setup was skipped. ${SAMPLE}`);
    expect(markup).not.toContain('Nectovia Agent');

    // A business without the Agent, one whose plan the service has not answered, and no
    // account service at all read the same way.
    for (const [value, workspaces] of [
      [settings({ activeWorkspace: { kind: 'business', organizationId: 'org-b' } }), [business('org-b', false)]],
      [settings({ activeWorkspace: { kind: 'business', organizationId: 'org-c' } }), [business('org-c', null)]],
      [settings({ activeWorkspace: { kind: 'business', organizationId: 'org-a' } }, false), null],
    ] as const) {
      expect(activeBusinessIncludesAgent(value, workspaces)).toBe(false);
      const plain = render(value, workspaces);
      expect(plain).toContain(SAMPLE);
      expect(plain).not.toContain('Nectovia Agent');
    }
  });

  it('still names a connected tool beside the Agent, and never the sample', () => {
    const value = settings({
      activeWorkspace: { kind: 'business', organizationId: 'org-a' },
      services: { codex: true, defaultEngine: 'codex' },
    }, false);
    const markup = render(value, [business('org-a', true)]);
    expect(markup).toContain(AGENT_READY_SENTENCE);
    expect(markup).toContain('Codex is your selected default.');
    expect(markup).not.toContain('sample work');
  });
});
