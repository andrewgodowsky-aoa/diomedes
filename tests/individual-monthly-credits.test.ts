import { describe, expect, it } from 'vitest';
import { individualIncludesMonthlyCredits } from '../shared/individual-plan.js';

const features = ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay', 'managed-inference'];
const combinations = Array.from({ length: 32 }, (_, mask) => ({
  mask,
  features: features.filter((_, index) => (mask & (1 << index)) !== 0),
  // Only the complete original offer (15) and its current superset (31) fund the plan.
  included: mask === 15 || mask === 31,
}));

describe('complete Individual monthly-credit eligibility', () => {
  it.each(combinations)('feature subset $mask includes credits: $included', ({ features, included }) => {
    expect(individualIncludesMonthlyCredits({ planId: 'individual', features })).toBe(included);
  });

  it.each([null, 'business', 'internal-test'])('never uses the Individual feature set for plan %s', planId => {
    expect(individualIncludesMonthlyCredits({ planId, features })).toBe(false);
  });

  it('recognizes complete grants regardless of feature order or duplicates', () => {
    expect(individualIncludesMonthlyCredits({ planId: 'individual', features: [...features].reverse().concat('nectovia-agent') })).toBe(true);
  });
});
