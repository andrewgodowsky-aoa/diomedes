/**
 * The owner's tier map (owner decisions 2026-09-23): a customer chooses only a
 * tier, and the owner's map decides which route and which model serve it. Pure
 * functions only; the HTTP seams are covered in work-style-home, team-any-route
 * and provider-setup-routes.
 */
import { describe, expect, test } from 'vitest';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { resolveTeamMemberModel, type TeamRouteCandidate } from '../shared/team-routes.js';
import {
  DEFAULT_TIER_MAP,
  OWNER_PIN_MODEL_KEY,
  OWNER_PIN_ROUTE_KEY,
  ownerPinFrom,
  resolveTier,
  TIER_AWS_LUNA_MODEL,
  TIER_GEMINI_FLASH_MODEL,
  TIER_SETTING_KEYS,
  TIER_VERTEX_ROUTE,
  tierMapFrom,
  tierRouteName,
  tierSettingRefusal,
  type TierRouteState,
} from '../shared/tier-map.js';
import type { EngineModel } from '../shared/types.js';

const levels = ['low', 'medium', 'high'].map((id) => ({ id, description: '' }));
const model = (slug: string, efforts = levels): EngineModel => ({
  slug,
  name: slug,
  description: '',
  defaultEffort: efforts.length ? 'low' : null,
  efforts,
});

/** Every route ready, each listing exactly the models given. */
const connected =
  (lists: Record<string, EngineModel[]>, ready: readonly string[] = Object.keys(lists)) =>
  (route: string): TierRouteState => ({
    ready: ready.includes(route),
    models: lists[route] ?? [],
    savedModel: lists[route]?.[0]?.slug ?? null,
  });

describe('the owner’s defaults', () => {
  test('Efficient is the AWS Luna the code pins, Focused is Gemini 3.8 Flash on Google Vertex AI, Thorough has no model', () => {
    expect(TIER_AWS_LUNA_MODEL).toBe(AWS_LUNA_MODEL);
    expect(DEFAULT_TIER_MAP).toEqual({
      efficient: { route: 'aws-bedrock', model: AWS_LUNA_MODEL },
      focused: { route: 'google-vertex', model: 'gemini-3.8-flash' },
      thorough: { route: 'aws-bedrock', model: null },
    });
    expect(TIER_VERTEX_ROUTE).toBe('google-vertex');
    expect(TIER_GEMINI_FLASH_MODEL).toBe('gemini-3.8-flash');
    expect(tierMapFrom(undefined)).toEqual(DEFAULT_TIER_MAP);
    expect(tierMapFrom({})).toEqual(DEFAULT_TIER_MAP);
    // A route this build does not have yet is still named for a person.
    expect(tierRouteName('google-vertex')).toBe('Google Vertex AI');
    expect(tierRouteName('aws-bedrock')).toBe('AWS Bedrock');
  });
});

describe('what the host accepts as a tier setting', () => {
  test('a tier maps only to a company-account route this build has, and a model id as the route lists it', () => {
    expect(TIER_SETTING_KEYS).toEqual([
      'efficientRoute',
      'efficientModel',
      'focusedRoute',
      'focusedModel',
      'thoroughRoute',
      'thoroughModel',
      'ownerPinRoute',
      'ownerPinModel',
    ]);
    expect(tierSettingRefusal('focusedRoute', 'azure-openai')).toBeNull();
    expect(tierSettingRefusal('focusedRoute', 'openrouter')).toBeNull();
    expect(tierSettingRefusal('thoroughRoute', 'aws-bedrock')).toBeNull();
    // Subscription engines and made-up routes are not tier targets.
    for (const bad of ['codex', 'claude-code', 'sample', 'nonsense', '', 3, null])
      expect(tierSettingRefusal('efficientRoute', bad)).toMatch(/^Efficient runs on a company account/);
    expect(tierSettingRefusal('focusedModel', 'gemini-3.8-flash')).toBeNull();
    expect(tierSettingRefusal('efficientModel', 'us.openai.gpt-5.6-luna')).toBeNull();
    expect(tierSettingRefusal('thoroughModel', 'vendor/model-a')).toBeNull();
    for (const bad of ['', ' ', 'a b', '-lead', 'x'.repeat(121), 7])
      expect(tierSettingRefusal('thoroughModel', bad)).toMatch(/^Enter the model id/);
    expect(tierSettingRefusal(OWNER_PIN_ROUTE_KEY, 'codex')).toBeNull();
    expect(tierSettingRefusal(OWNER_PIN_ROUTE_KEY, 'sample')).toMatch(/owner testing/);
    expect(tierSettingRefusal(OWNER_PIN_MODEL_KEY, 'gpt-6-luna')).toBeNull();
    expect(tierSettingRefusal('somethingElse', 'x')).toBe('That is not a tier setting.');
  });

  test('a saved route replaces the default model unless one is saved with it', () => {
    const map = tierMapFrom({
      focusedRoute: 'azure-openai',
      efficientModel: 'us.openai.gpt-6-luna-when-qualified',
      thoroughRoute: 'openrouter',
      thoroughModel: 'vendor/model-a',
    });
    expect(map.focused).toEqual({ route: 'azure-openai', model: null });
    expect(map.efficient).toEqual({ route: 'aws-bedrock', model: 'us.openai.gpt-6-luna-when-qualified' });
    expect(map.thorough).toEqual({ route: 'openrouter', model: 'vendor/model-a' });
    // A saved route that is not a company-account route is ignored, never trusted.
    expect(tierMapFrom({ focusedRoute: 'codex' }).focused).toEqual(DEFAULT_TIER_MAP.focused);
  });

  test('the owner pin is read only when it names a real route', () => {
    expect(ownerPinFrom({})).toBeNull();
    expect(ownerPinFrom({ ownerPinRoute: 'sample' })).toBeNull();
    expect(ownerPinFrom({ ownerPinRoute: 'nonsense' })).toBeNull();
    expect(ownerPinFrom({ ownerPinRoute: 'openrouter' })).toEqual({ route: 'openrouter', model: null });
    expect(ownerPinFrom({ ownerPinRoute: 'aws-bedrock', ownerPinModel: AWS_LUNA_MODEL })).toEqual({
      route: 'aws-bedrock',
      model: AWS_LUNA_MODEL,
    });
  });
});

describe('each tier resolves to its mapped route and model', () => {
  const map = tierMapFrom({ thoroughModel: 'us.openai.gpt-6-sol-when-qualified' });
  const lists = {
    'aws-bedrock': [model(AWS_LUNA_MODEL), model('us.openai.gpt-6-sol-when-qualified')],
    'google-vertex': [model('gemini-3.8-flash')],
  };

  test('the route and the model come from the map, and the level from the tier and the mode', () => {
    const run = (style: 'efficient' | 'focused' | 'thorough', mode: 'ask' | 'plan' | 'fix' = 'ask') =>
      resolveTier({ style, mode, map, state: connected(lists) });
    expect(run('efficient')).toMatchObject({ outcome: 'run', route: 'aws-bedrock', model: AWS_LUNA_MODEL, effort: 'low', ownerPin: false });
    expect(run('focused')).toMatchObject({ outcome: 'run', route: 'google-vertex', model: 'gemini-3.8-flash', effort: 'medium' });
    expect(run('thorough')).toMatchObject({ outcome: 'run', route: 'aws-bedrock', model: 'us.openai.gpt-6-sol-when-qualified', effort: 'high' });
    expect(run('efficient', 'plan').outcome === 'run' && run('efficient', 'plan')).toMatchObject({ effort: 'medium' });
    expect(run('focused').reason).toBe('Focused: gemini-3.8-flash on Google Vertex AI.');
  });

  test('the level does not move with the words of one message', () => {
    const long = 'Please review this.\n'.repeat(40);
    const greeting = resolveTier({ style: 'focused', mode: 'ask', map, state: connected(lists), hints: { text: 'hello' } });
    const demanding = resolveTier({ style: 'focused', mode: 'ask', map, state: connected(lists), hints: { text: long } });
    expect(greeting).toMatchObject({ outcome: 'run', model: 'gemini-3.8-flash', effort: 'medium', kind: 'greeting' });
    expect(demanding).toMatchObject({ outcome: 'run', model: 'gemini-3.8-flash', effort: 'medium', kind: 'demanding' });
  });

  test('a route that has listed nothing yet runs the mapped model and leaves the check to admission', () => {
    const resolved = resolveTier({ style: 'efficient', mode: 'ask', map, state: connected({ 'aws-bedrock': [] }) });
    expect(resolved).toMatchObject({ outcome: 'run', route: 'aws-bedrock', model: AWS_LUNA_MODEL, effort: null });
  });
});

describe('a tier that cannot run is refused by name, never moved', () => {
  test('a mapped route that is not connected names the route and AI setup, and offers no other route', () => {
    // AWS and OpenRouter are ready; Focused's Google Vertex AI is not.
    const state = connected({ 'aws-bedrock': [model(AWS_LUNA_MODEL)], openrouter: [model('vendor/model-a')] });
    const refused = resolveTier({ style: 'focused', mode: 'ask', map: DEFAULT_TIER_MAP, state });
    expect(refused).toMatchObject({ outcome: 'refuse', route: 'google-vertex', model: 'gemini-3.8-flash' });
    expect(refused.reason).toBe(
      'Focused runs on Google Vertex AI (gemini-3.8-flash), which is not connected and turned on. Connect Google Vertex AI in AI setup. Nectovia does not move this work to another provider.',
    );
    const offline = resolveTier({
      style: 'efficient',
      mode: 'ask',
      map: DEFAULT_TIER_MAP,
      state: connected({ 'aws-bedrock': [model(AWS_LUNA_MODEL)] }, []),
    });
    expect(offline).toMatchObject({ outcome: 'refuse', route: 'aws-bedrock' });
    expect(offline.reason).toContain('Connect AWS Bedrock in AI setup');
  });

  test('Thorough, meant for GPT-6 Sol, has no model until the owner chooses one', () => {
    const refused = resolveTier({
      style: 'thorough',
      mode: 'ask',
      map: DEFAULT_TIER_MAP,
      state: connected({ 'aws-bedrock': [model(AWS_LUNA_MODEL)] }),
    });
    expect(refused).toMatchObject({ outcome: 'refuse', model: null });
    expect(refused.reason).toBe(
      'Thorough is meant for GPT-6 Sol on AWS Bedrock, which is not qualified yet. Choose the Thorough model in AI setup.',
    );
    expect(refused.reason).not.toContain(AWS_LUNA_MODEL);
  });

  test('a model the mapped route does not list is refused, not replaced', () => {
    const map = tierMapFrom({ efficientRoute: 'openrouter', efficientModel: 'vendor/model-b' });
    const refused = resolveTier({
      style: 'efficient',
      mode: 'ask',
      map,
      state: connected({ openrouter: [model('vendor/model-a', [])] }),
    });
    expect(refused).toMatchObject({ outcome: 'refuse', route: 'openrouter', model: 'vendor/model-b' });
    expect(refused.reason).toContain('which that connection does not offer');
  });
});

describe('the owner-testing pin', () => {
  const lists = { 'aws-bedrock': [model(AWS_LUNA_MODEL)], openrouter: [model('vendor/model-a', [])] };
  test('wins over every tier, says it is owner testing, and uses the route’s saved model when it names none', () => {
    for (const style of ['efficient', 'focused', 'thorough'] as const) {
      const resolved = resolveTier({
        style,
        mode: 'ask',
        map: DEFAULT_TIER_MAP,
        state: connected(lists),
        pin: { route: 'openrouter', model: null },
      });
      expect(resolved).toMatchObject({ outcome: 'run', route: 'openrouter', model: 'vendor/model-a', ownerPin: true });
      expect(resolved.reason).toBe('Owner testing: vendor/model-a on OpenRouter, for every tier.');
    }
  });

  test('a pin to a route that is not ready is refused, not ignored', () => {
    const resolved = resolveTier({
      style: 'efficient',
      mode: 'ask',
      map: DEFAULT_TIER_MAP,
      state: connected(lists, ['aws-bedrock']),
      pin: { route: 'openrouter', model: 'vendor/model-a' },
    });
    expect(resolved).toMatchObject({ outcome: 'refuse', route: 'openrouter', ownerPin: true });
    expect(resolved.reason).toContain('clear the pin under Advanced');
  });
});

describe('team “Nectovia chooses” follows the tier map', () => {
  const aws: TeamRouteCandidate = {
    route: 'aws-bedrock',
    models: [model(AWS_LUNA_MODEL)],
    savedModel: AWS_LUNA_MODEL,
    routeDefaultAllowed: false,
  };
  const openrouter: TeamRouteCandidate = {
    route: 'openrouter',
    models: [model('vendor/gpt-6-sol', [])],
    savedModel: 'vendor/gpt-6-sol',
    routeDefaultAllowed: false,
  };
  const map = tierMapFrom({ focusedRoute: 'openrouter', focusedModel: 'vendor/gpt-6-sol' });

  test('a member runs its tier’s mapped route and model, whichever candidate comes first', () => {
    const member = resolveTeamMemberModel({ role: 'member', style: 'efficient', candidates: [openrouter, aws], tiers: { map } });
    expect(member).toMatchObject({
      outcome: 'run',
      route: 'aws-bedrock',
      model: AWS_LUNA_MODEL,
      effort: 'low',
      selection: { by: 'nectovia', style: 'efficient', substituted: false },
    });
    const lead = resolveTeamMemberModel({ role: 'lead', style: 'efficient', candidates: [aws, openrouter], tiers: { map } });
    expect(lead).toMatchObject({ outcome: 'run', route: 'openrouter', model: 'vendor/gpt-6-sol', selection: { style: 'focused' } });
    expect(lead.outcome === 'run' && lead.selection.reason).toMatch(/The lead works a tier above\.$/);
  });

  test('a tier whose route is not among the connected candidates is a question naming the route', () => {
    const refused = resolveTeamMemberModel({ role: 'member', style: 'focused', candidates: [aws], tiers: { map: DEFAULT_TIER_MAP } });
    expect(refused).toEqual({
      outcome: 'ask',
      reason:
        'Focused runs on Google Vertex AI (gemini-3.8-flash), which is not connected and turned on. Connect Google Vertex AI in AI setup. Nectovia does not move this work to another provider.',
    });
  });
});
