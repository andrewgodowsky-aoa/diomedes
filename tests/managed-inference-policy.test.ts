import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIConnections } from '../client/AISetup';
import { ManagedInferencePolicy } from '../client/ManagedInferencePolicy';
import { useAccount } from '../client/AccountGate';
import { AccountSettings } from '../client/AccountSettings';
import { ROLE_CAPABILITIES, type AccessView } from '../shared/access';
import type { AccountStateView } from '../shared/accounts';
import { MODEL_API_NAMES } from '../shared/model-api';
import { defaults } from '../server/store';

vi.mock('../client/AccountGate', async (original) => ({
  ...await original<typeof import('../client/AccountGate')>(),
  useAccount: vi.fn(() => null),
}));

const accountState = (free = false): AccountStateView => ({
  v: 1,
  backend: { kind: 'faux', label: 'Fixture', url: null, reason: null, signIn: 'password' },
  browser: null, signedIn: true, person: { id: 'person', name: 'Owner', email: 'owner@example.test' },
  remember: false, protectedStorage: false, workspaces: [],
  plan: { agent: free ? 'free' : 'paid', plansUrl: 'https://example.test/plans', notice: false },
  remembered: [], signedInAt: null,
});

function signIn(state: AccountStateView) {
  vi.mocked(useAccount).mockReturnValue({ state, refresh: async () => {}, signOut: async () => {}, apply: () => {} });
}

beforeEach(() => vi.mocked(useAccount).mockReturnValue(null));

describe('managed inference commercial presentation', () => {
  it('presents the managed path before external tools and keeps owner provider configuration collapsed', () => {
    const html = renderToStaticMarkup(createElement(AIConnections, { settings: defaults(), save: async () => {}, ownerRoutes: true }));
    expect(html.indexOf('Nectovia-managed AI')).toBeLessThan(html.indexOf('External AI tools'));
    expect(html).toContain('<details><summary>Advanced: provider accounts and routing</summary>');
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain(`aria-label="${MODEL_API_NAMES['aws-bedrock']}"`);
  });

  it('does not turn Advanced information into customer provider authority', () => {
    const html = renderToStaticMarkup(createElement(AIConnections, { settings: defaults(), save: async () => {}, ownerRoutes: false }));
    expect(html).toContain('Advanced: organization-owned API or cloud account');
    expect(html).not.toContain(`aria-label="${MODEL_API_NAMES['aws-bedrock']}"`);
    expect(html).not.toContain('aria-label="Tiers"');
  });

  it('preserves free external-engine setup without implying included managed usage', () => {
    signIn(accountState(true));
    const html = renderToStaticMarkup(createElement(AIConnections, { settings: defaults(), save: async () => {}, ownerRoutes: false }));
    expect(html).not.toContain('aria-label="Nectovia-managed AI"');
    expect(html).toContain('External AI tools');
    expect(html).toContain('cannot supply pooled inference');
  });

  it('describes a customer rate and bounded authorization without a payment or activation control', () => {
    const html = renderToStaticMarkup(createElement(ManagedInferencePolicy));
    expect(html).toContain('Nectovia&#x27;s current usage rate');
    expect(html).toContain('monthly spending cap');
    expect(html).toContain('never starts automatically');
    expect(html).toContain('does not authorize extra monthly spending');
    expect(html).not.toMatch(/<button|<input|<form|provider cost|markup|\$0\./i);
    expect(html).toContain('cannot fund shared organization-wide');
    expect(html).toContain('does not use your included Nectovia allowance');
  });

  it('keeps account billing policy within the server-granted plan visibility', () => {
    const state = accountState();
    const access: AccessView = {
      v: 1, organizationId: 'org', planLabel: 'Business', state: 'active', validUntil: null,
      role: 'owner', roleLabel: 'Owner', capabilities: ROLE_CAPABILITIES.owner,
      planId: 'business', validFrom: null, revision: 1, checkedAt: '2026-09-28T00:00:00Z',
      features: ['nectovia-agent', 'managed-inference'], grants: [],
      agent: { included: true, reason: 'Included' },
    };
    state.workspaces = [{ organization: { id: 'org', name: 'Business' }, role: 'owner', roleLabel: 'Owner', capabilities: ROLE_CAPABILITIES.owner, access }];
    signIn(state);
    expect(renderToStaticMarkup(createElement(AccountSettings))).toContain('aria-label="Nectovia-managed AI"');
    state.workspaces[0] = { ...state.workspaces[0], role: 'member', roleLabel: 'Employee', capabilities: ROLE_CAPABILITIES.member };
    expect(renderToStaticMarkup(createElement(AccountSettings))).not.toContain('aria-label="Nectovia-managed AI"');
  });
});
