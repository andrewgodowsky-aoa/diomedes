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
      efficient: { route: 'aws-bedrock', model: 'us.openai.gpt-5.6-luna' },
      focused: { route: 'google-vertex', model: 'gemini-3.8-flash' },
      thorough: { route: 'aws-bedrock', model: '' },
    });
    const services = { 'aws-bedrock': true, workStyle: 'efficient' } as Record<string, boolean | string>;
    expect(withTierDraft(services, draft)).toEqual(services);
  });

  it('writes a changed route and model, and every value it writes passes the host’s check', () => {
    const draft = tierDraftFrom({});
    draft.thorough = { route: 'aws-bedrock', model: ' us.openai.gpt-6-sol-once-qualified ' };
    draft.efficient = { route: 'openrouter', model: 'vendor/model-a' };
    draft.focused = { route: 'google-vertex', model: 'gemini-3.5-flash' };
    const next = withTierDraft({ azureOld: true }, draft);
    expect(next).toEqual({
      azureOld: true,
      thoroughModel: 'us.openai.gpt-6-sol-once-qualified',
      efficientRoute: 'openrouter',
      efficientModel: 'vendor/model-a',
      focusedModel: 'gemini-3.5-flash',
    });
    for (const [key, value] of Object.entries(next)) if (key !== 'azureOld') expect(tierSettingRefusal(key, value)).toBeNull();
    // A route this build does not know yet is never written: Focused keeps its default route.
    expect(Object.values(next)).not.toContain('google-vertex');
    expect(tierMapFrom(next).focused).toEqual({ route: 'google-vertex', model: 'gemini-3.5-flash' });
    // Returning a tier to its default removes what was saved for it.
    expect(withTierDraft(next, tierDraftFrom({}))).toEqual({ azureOld: true });
  });

  it('lists this build’s company accounts, and keeps a tier’s own route listed even before it lands', () => {
    expect(tierRouteChoices('aws-bedrock').map((c) => c.name)).toEqual(['AWS Bedrock', 'Azure OpenAI', 'OpenRouter']);
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
    expect(html).toContain('Meant for GPT-6 Sol on AWS Bedrock, which is not qualified yet.');
    expect(html).toMatch(/<details[^>]*><summary>Advanced: owner testing<\/summary>/);
    expect(html).toContain('No pin: the tier map decides');
  });
});
