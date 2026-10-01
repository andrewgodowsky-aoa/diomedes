import { describe, expect, it } from 'vitest';
import { MANAGED_PROVIDERS } from '../services/control-plane/src/managed-providers';
import { DEMO_ROUTES, DEMO_POLICY } from '../services/control-plane/src/faux/seed';
import { GPT6_LUNA, MANAGED_LUNA, MODEL_API_NAMES } from '../shared/model-api';
import { ROUTE_CAPABILITIES } from '../shared/capabilities';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';

/** "us.openai.gpt-5.6-luna" -> "GPT-5.6 Luna". Independent of the shared table on purpose. */
const labelOf = (model: string): string => {
  const m = /gpt-(\d+(?:\.\d+)?)-luna$/.exec(model);
  if (!m) throw new Error(`not a Luna model id: ${model}`);
  return `GPT-${m[1]} Luna`;
};
const lunaIds = (ids: string[]) => ids.filter((id) => /gpt-\d+(?:\.\d+)?-luna$/.test(id));
const versions = (text: string) => [...text.matchAll(/GPT-(\d+(?:\.\d+)?) Luna/g)].map((m) => m[1]);

describe('Luna route labels', () => {
  it('the desktop AWS route sends the model the registry serves', () => {
    expect(AWS_LUNA_MODEL).toBe(MANAGED_LUNA.model);
    expect(MANAGED_PROVIDERS.some((r) => r.provider === 'aws-bedrock' && r.model === AWS_LUNA_MODEL)).toBe(true);
  });

  it('client constants label the model they send', () => {
    expect(MANAGED_LUNA.label).toBe(labelOf(MANAGED_LUNA.model));
    expect(GPT6_LUNA.label).toBe(labelOf(GPT6_LUNA.model));
    expect(versions(MODEL_API_NAMES['aws-bedrock'])).toEqual([versions(labelOf(AWS_LUNA_MODEL))[0]]);
  });

  it('the capability record names the model the route sends', () => {
    const name = ROUTE_CAPABILITIES['aws-bedrock'].name;
    expect(versions(name)).toEqual(versions(labelOf(AWS_LUNA_MODEL)));
  });

  it('every seeded Luna route is labelled for its own model id', () => {
    for (const r of DEMO_ROUTES.filter((x) => lunaIds([x.model]).length)) {
      expect(r.label, r.id).toBe(labelOf(r.model));
    }
  });

  it('the seed policy note names the model of the route it publishes', () => {
    for (const tier of Object.values(DEMO_POLICY.tiers)) {
      const route = DEMO_ROUTES.find((r) => r.id === tier)!;
      expect(route, tier).toBeTruthy();
      expect(DEMO_POLICY.note).toContain(labelOf(route.model));
      expect(versions(DEMO_POLICY.note)).toEqual(versions(labelOf(route.model)));
    }
  });

  it('every registry Luna model is one the routes name consistently', () => {
    const served = lunaIds(MANAGED_PROVIDERS.map((r) => r.model));
    expect(served).toContain(MANAGED_LUNA.model);
    expect(served).toContain(GPT6_LUNA.model);
  });

  it('no two sources name different Luna models for the route that is sent', () => {
    const seen = new Set([
      ...versions(MODEL_API_NAMES['aws-bedrock']),
      ...versions(ROUTE_CAPABILITIES['aws-bedrock'].name),
      ...versions(MANAGED_LUNA.label),
      ...versions(DEMO_POLICY.note),
    ]);
    expect([...seen]).toEqual(versions(labelOf(AWS_LUNA_MODEL)));
  });
});
