import { describe, expect, it } from 'vitest';
import { EXPERT_FEATURE, MANAGED_PLAN_IDS, managedGrantFeatures, planTemplate } from '../shared/access.js';
import { expertPlanCheckIn, resolveCheckIns, checkInAmountsSchema } from '../shared/job-check-ins.js';
import { WORK_STYLES, resolveWorkStyle } from '../shared/work-style.js';
import { JOB_TIERS } from '../shared/managed-usage.js';
import { ROUTING_TIERS, routingConfigurationSchema } from '../shared/routing-policy.js';
import { DEFAULT_TIER_MAP, resolveTier } from '../shared/tier-map.js';
import { styleAbove } from '../shared/team-routes.js';
import { DEFAULT_ESCALATION } from '../shared/escalation-controls.js';
import { tierResponse } from '../shared/expert-tier-wire.js';

const at = Date.parse('2026-10-06T20:00:00Z');
const grant = (planId = 'managed-small') => ({ planId, features: planTemplate(planId)!.features,
  state: 'active', validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z' });

describe('Expert is the Managed fourth tier', () => {
  it('uses the same tier in style, routing and accounting', () => {
    expect(WORK_STYLES).toEqual(['efficient', 'focused', 'thorough', 'expert']);
    expect(JOB_TIERS).toEqual(WORK_STYLES);
    expect(ROUTING_TIERS).toEqual(WORK_STYLES);
  });
  it.each(MANAGED_PLAN_IDS)('%s includes Expert for both product surfaces', (planId) => {
    expect(planTemplate(planId)!.features).toContain(EXPERT_FEATURE);
    const old = { ...grant(planId), features: grant(planId).features.filter(f => f !== EXPERT_FEATURE) };
    expect(managedGrantFeatures(old)).toContain(EXPERT_FEATURE);
    expect(old.features).not.toContain(EXPERT_FEATURE);
  });
  it.each(['business', 'workflow-starter', 'service-agreement', 'internal-test'])('%s cannot acquire Expert by injecting a feature', (planId) => {
    expect(managedGrantFeatures({ ...grant(planId), features: [...grant(planId).features, EXPERT_FEATURE] })).not.toContain(EXPERT_FEATURE);
  });
  it('does not broaden a custom limited Managed grant or combine partial grants', () => {
    expect(managedGrantFeatures({ planId: 'managed-small', features: ['nectovia-agent'] })).not.toContain(EXPERT_FEATURE);
    expect(managedGrantFeatures({ planId: 'managed-small', features: ['managed-inference', EXPERT_FEATURE] })).not.toContain(EXPERT_FEATURE);
  });
  it.each([['managed-small', 750], ['managed-standard', 850], ['managed-plus', 1_000]] as const)('scales %s by its included API allowance', (planId, amount) => {
    expect(expertPlanCheckIn([grant(planId)], at)).toBe(amount);
    expect(resolveCheckIns(null, null, amount).credits.expert).toBe(amount);
    expect(resolveCheckIns(null, null, amount).source.expert).toBe('plan');
  });
  it('does not count revoked, future, expired or malformed grants', () => {
    for (const change of [{ state: 'revoked' }, { validFrom: '2026-11-01T00:00:00Z' },
      { validUntil: '2026-10-06T20:00:00Z' }, { validUntil: 'invalid' }]) {
      expect(expertPlanCheckIn([{ ...grant(), ...change }], at)).toBeUndefined();
    }
  });
  it('preserves explicit staff and business check-in precedence', () => {
    const defaults = { version: 1, amounts: { efficient: 100, focused: 250, thorough: 500, expert: 900 } };
    expect(resolveCheckIns(defaults, null, 750).credits.expert).toBe(900);
    const override = { efficient: null, focused: null, thorough: null, expert: 800 };
    expect(resolveCheckIns(defaults, override, 1_000).credits.expert).toBe(800);
  });
  it('never treats a manual pin or a direct-provider mapping as Expert access', () => {
    expect(resolveWorkStyle({ style: 'expert', mode: 'ask', route: 'codex', availableModels: [],
      pin: { model: 'owner-choice' } }).outcome).toBe('ask');
    expect(resolveTier({ style: 'expert', mode: 'build', map: DEFAULT_TIER_MAP,
      pin: { route: 'azure-openai', model: 'owner-choice' }, state: () => ({ ready: true, models: [], savedModel: null }) }).outcome).toBe('refuse');
  });
  it('keeps existing automatic escalation below Expert', () => {
    expect(styleAbove('thorough')).toBe('thorough');
    expect(DEFAULT_ESCALATION.tiers).not.toContain('expert');
  });
  it('reads historical records without inventing an Expert route or staff amount', () => {
    const route = { primary: null, backups: [], fallbackEnabled: false, maxAttempts: 1,
      cost: { sameOrLower: true, maxAttemptMicroUsd: null, qualityFloor: 0 } };
    expect(routingConfigurationSchema.parse({ efficient: route, focused: route, thorough: route }).expert).toBeUndefined();
    expect(checkInAmountsSchema.parse({ efficient: 100, focused: 250, thorough: 500 }).expert).toBeUndefined();
  });
  it('negotiates strict old-client replies without changing stored records', () => {
    const record = { tiers: { efficient: null, expert: { model: 'qualified' } }, amounts: { expert: 850 } };
    expect(tierResponse(record, false)).toEqual({ tiers: { efficient: null }, amounts: {} });
    expect(tierResponse(record, true)).toBe(record);
    expect(record.amounts.expert).toBe(850);
  });
});
