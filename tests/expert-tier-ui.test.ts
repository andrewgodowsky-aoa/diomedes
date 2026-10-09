import { describe, expect, it } from 'vitest';
import { tierEntries } from '../client/console/ask-row';
import { EXPERT_NOT_INCLUDED } from '../shared/access';
import { WORK_STYLE_DESCRIPTIONS } from '../shared/work-style';

describe('Expert selection and access', () => {
  it.each([false, true])('the composer uses the host access decision: %s', available => {
    expect(tierEntries(null, null, false, false, available).find(e => e.id === 'expert')).toMatchObject({ name: 'Expert', bars: 4, disabled: !available });
  });
  it('lists Expert last of the four tiers, disabled until the host says the account has it', () => {
    const closed = tierEntries(null, null, false, false, false);
    expect(closed.map(e => e.id)).toEqual(['efficient', 'focused', 'thorough', 'expert']);
    expect(closed.filter(e => e.disabled).map(e => e.id)).toEqual(['expert']);
    expect(tierEntries(null, null, false, false, true).some(e => e.disabled)).toBe(false);
  });
  it('shows the host reason on a closed Expert row, and the description once it is open', () => {
    const closed = tierEntries(null, null, false, false, false, EXPERT_NOT_INCLUDED).find(e => e.id === 'expert');
    expect(closed?.sub).toBe(EXPERT_NOT_INCLUDED);
    expect(tierEntries(null, null, false, false, false).find(e => e.id === 'expert')?.sub).toBe(WORK_STYLE_DESCRIPTIONS.expert);
    expect(tierEntries(null, null, false, false, true, EXPERT_NOT_INCLUDED).find(e => e.id === 'expert')?.sub).toBe(WORK_STYLE_DESCRIPTIONS.expert);
  });
});
