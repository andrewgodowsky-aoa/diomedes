/**
 * The owner's tier form in AI setup: what it writes into Settings, and that
 * the owner-testing pin sits behind Advanced and is labelled as such.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import { TierSetup } from '../client/TierSetup';
import {
  ownerPinDraft,
  tierDraftFrom,
  tierRouteChoices,
  withOwnerPin,
  withTierDraft,
} from '../client/tier-setup-view';
import { tierMapFrom, tierSettingRefusal } from '../shared/tier-map';

describe('the tier form', () => {
  it('starts from the owner’s defaults and saves nothing for a tier left on its default', () => {
    const draft = tierDraftFrom({});
    expect(draft).toEqual({
      efficient: { route: 'azure-openai', model: 'gpt-6.1-sol' },
      focused: { route: 'aws-bedrock', model: 'us.moonshotai.kimi-k3' },
      thorough: { route: 'azure-openai', model: 'gpt-6.1-sol' },
    });
    const services = { 'aws-bedrock': true, workStyle: 'efficient' } as Record<string, boolean | string>;
    expect(withTierDraft(services, draft)).toEqual(services);
  });

  it('writes a changed route and model, and every value it writes passes the host’s check', () => {
    const draft = tierDraftFrom({});
    draft.thorough = { route: 'aws-bedrock', model: ' us.openai.gpt-6-sol-once-qualified ' };
    draft.efficient = { route: 'openrouter', model: 'vendor/model-a' };
    draft.focused = { route: 'aws-bedrock', model: 'us.moonshotai.kimi-k3-next' };
    const next = withTierDraft({ azureOld: true }, draft);
    expect(next).toEqual({
      azureOld: true,
      thoroughRoute: 'aws-bedrock',
      thoroughModel: 'us.openai.gpt-6-sol-once-qualified',
      efficientRoute: 'openrouter',
      efficientModel: 'vendor/model-a',
      focusedModel: 'us.moonshotai.kimi-k3-next',
    });
    for (const [key, value] of Object.entries(next)) if (key !== 'azureOld') expect(tierSettingRefusal(key, value)).toBeNull();
    // A tier's default route is never written: Focused keeps AWS Bedrock by default.
    expect(next.focusedRoute).toBeUndefined();
    expect(tierMapFrom(next).focused).toEqual({ route: 'aws-bedrock', model: 'us.moonshotai.kimi-k3-next' });
    // Returning a tier to its default removes what was saved for it.
    expect(withTierDraft(next, tierDraftFrom({}))).toEqual({ azureOld: true });
  });

  it('lists this build’s company accounts, Google Vertex AI among them', () => {
    expect(tierRouteChoices('aws-bedrock').map((c) => c.name)).toEqual([
      'AWS Bedrock',
      'Azure OpenAI',
      'OpenRouter',
      'Google Vertex AI',
    ]);
    expect(tierRouteChoices('google-vertex').map((c) => c.name)).toEqual([
      'AWS Bedrock',
      'Azure OpenAI',
      'OpenRouter',
      'Google Vertex AI',
    ]);
  });

  it('sets and clears the owner-testing pin', () => {
    const pinned = withOwnerPin({ keep: true }, 'openrouter', ' vendor/model-a ');
    expect(pinned).toEqual({ keep: true, ownerPinRoute: 'openrouter', ownerPinModel: 'vendor/model-a' });
    expect(ownerPinDraft(pinned)).toEqual({ route: 'openrouter', model: 'vendor/model-a' });
    expect(withOwnerPin(pinned, '', 'ignored')).toEqual({ keep: true });
  });

  it('renders the tiers as owner configuration, with the pin under Advanced labelled as owner testing', () => {
    const html = renderToStaticMarkup(
      createElement(TierSetup, { settings: defaults(), save: async () => undefined }),
    );
    expect(html).toContain('aria-label="Tiers"');
    expect(html).toContain('aria-label="Efficient account"');
    expect(html).toContain('aria-label="Thorough model"');
    expect(html).toContain('GPT-6.1 Sol on Azure AI Foundry, at high reasoning.');
    expect(html).toMatch(/<details[^>]*><summary>Advanced: owner testing<\/summary>/);
    expect(html).toContain('No pin: the tier map decides');
  });
});
