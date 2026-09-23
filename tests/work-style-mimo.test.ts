import { describe, expect, it } from 'vitest';
import type { EngineModel } from '../shared/types.js';
import { logicalModelOf, resolveWorkStyle, STYLE_LEADS, WORK_STYLES } from '../shared/work-style.js';

// MiMo 2.6 on the OpenCode Go route is a manual candidate (2026-09-23). Its
// presence in a route's catalogue must never change what a Work Style picks,
// and an explicit pin must run exactly that slug or ask, never a neighbour.
const model = (slug: string, name: string): EngineModel => ({
  slug,
  name,
  description: '',
  efforts: [],
  defaultEffort: null,
});
// Names and order as the live OpenCode Go catalogue reported them.
const flash = model('opencode-go/mimo-v2.6-flash', 'MiMo-V2.6-Flash');
const pro = model('opencode-go/mimo-v2.6-pro', 'MiMo-V2.6-Pro');
const older = [model('opencode-go/mimo-v2.5', 'MiMo V2.5'), model('opencode-go/mimo-v2.5-pro', 'MiMo V2.5 Pro')];
const luna = model('opencode-go/gpt-5.6-luna', 'GPT-5.6 Luna');
const route = 'opencode';

describe('MiMo 2.6 is manual-only on every Work Style', () => {
  it('is no logical model, so no style can lead with it', () => {
    for (const m of [flash, pro, ...older]) expect(logicalModelOf(m)).toBeNull();
    for (const style of WORK_STYLES) expect(STYLE_LEADS[style]).not.toContain(expect.stringMatching(/mimo/i));
  });

  it('leaves Efficient on Luna when MiMo is listed first', () => {
    const result = resolveWorkStyle({
      style: 'efficient',
      mode: 'ask',
      route,
      availableModels: [flash, pro, ...older, luna],
    });
    expect(result).toMatchObject({ outcome: 'run', model: luna.slug, logical: 'luna', substituted: false });
  });

  it.each(WORK_STYLES)('never picks MiMo for %s when MiMo is all the route lists', (style) => {
    const result = resolveWorkStyle({
      style,
      mode: 'ask',
      route,
      availableModels: [flash, pro, ...older],
    });
    expect(result.model ?? '').not.toMatch(/mimo/i);
  });

  it.each([flash, pro])('runs an explicit %s pin as exactly that slug', (pinned) => {
    const result = resolveWorkStyle({
      style: 'efficient',
      mode: 'ask',
      route,
      availableModels: [flash, pro, ...older, luna],
      pin: { model: pinned.slug },
    });
    expect(result).toMatchObject({
      outcome: 'run',
      model: pinned.slug,
      selection: 'manual',
      substituted: false,
      logical: null,
    });
  });

  it('asks rather than substituting when a pinned MiMo 2.6 is no longer listed', () => {
    const result = resolveWorkStyle({
      style: 'efficient',
      mode: 'ask',
      route,
      // The catalogue bundled in opencode 1.18.4 lists only MiMo V2.5.
      availableModels: [...older, luna],
      pin: { model: flash.slug },
    });
    expect(result).toMatchObject({ outcome: 'ask', model: null, substituted: false });
  });

  it('does not carry an OpenCode Go pin to a route that lists a different MiMo slug', () => {
    const result = resolveWorkStyle({
      style: 'efficient',
      mode: 'ask',
      route: 'openrouter',
      availableModels: [model('xiaomi/mimo-v2.6-flash', 'MiMo-V2.6-Flash')],
      pin: { model: flash.slug },
    });
    expect(result).toMatchObject({ outcome: 'ask', model: null, substituted: false });
  });
});
