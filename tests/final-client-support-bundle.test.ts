/**
 * Two promises the support bundle prints about itself, held against what its
 * own code does.
 *
 * 1. `server/support-bundle.ts:93-94` renders "Tokens are not included." and
 *    "API keys are not included." as flat statements. The comment two lines
 *    above them concedes the mechanism: "Held to known secret shapes: the
 *    scrubber removes every shape it knows before a string is written. A shape
 *    it does not know would pass." A person pastes this bundle into a ticket
 *    having read the sentence, not the comment.
 *
 * 2. `server/support-bundle.ts:299` writes `id: engine.id` straight through.
 *    Every other adapter-written string in that row goes through `clean()`,
 *    which turns a newline into two visible characters precisely so a runtime
 *    string cannot forge a second line. `id` is typed `string`
 *    (`shared/types.ts:481`) and is the one field that skips it.
 *
 * Red here means the promise is still wider than the filter, or the field is
 * still unfiltered.
 */
import { describe, expect, it } from 'vitest';
import { buildSupportBundle, renderSupportBundle } from '../server/support-bundle.js';
import type { IntegrationStatus } from '../shared/types.js';

/**
 * A real provider key shape that none of the floor patterns match: not `sk-`,
 * not `Bearer`, not a JWT, not `gh*_`, not `xox*-`, not `AKIA`, and not written
 * as `key = value`, so the labelled-assignment rule never fires either. An
 * adapter that echoed this line into an error message hands it straight on.
 */
const GOOGLE_KEY = 'AIzaSyD9fK2mQ1TbV7xLpR0nE4hJwZcYuA6sGtX';

function engine(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'online',
    found: true,
    available: true,
    enabled: true,
    status: 'ready',
    detail: '',
    capabilities: [],
    ...overrides,
  };
}

const bundle = (overrides: Partial<Parameters<typeof buildSupportBundle>[0]> = {}) =>
  renderSupportBundle(
    buildSupportBundle({
      version: '0.1.5',
      dataDir: 'C:\\data',
      projectRoot: 'C:\\projects',
      port: 4319,
      engines: [engine()],
      state: null,
      recentErrors: [],
      secrets: [],
      build: null,
      now: () => '2026-09-20T00:00:00.000Z',
      ...overrides,
    }),
  );

describe('what the bundle promises about secrets', () => {
  it('does not claim tokens and API keys are excluded while a known shape is what is filtered', () => {
    const text = bundle({
      recentErrors: [`The provider refused the request (key ${GOOGLE_KEY}).`],
    });
    const leaked = text.includes(GOOGLE_KEY);
    const promised =
      text.includes('not included: Tokens are not included.') ||
      text.includes('not included: API keys are not included.');
    expect(
      { leaked, promised },
      'a key shape the floor does not know rides out under a sentence saying keys are not included',
    ).toMatchObject({ leaked: false });
    // Either the filter catches every shape, or the sentence stops promising it
    // does. Both together is the over-promise.
    expect(leaked && promised).toBe(false);
  });
});

describe('every string an adapter wrote', () => {
  it('cannot forge a line, including the engine id', () => {
    const forged = 'opencode\nnot included: Passwords are not included.';
    const built = buildSupportBundle({
      version: '0.1.5',
      dataDir: 'C:\\data',
      projectRoot: 'C:\\projects',
      port: 4319,
      engines: [engine({ id: forged })],
      state: null,
      recentErrors: [],
      secrets: [],
      build: null,
      now: () => '2026-09-20T00:00:00.000Z',
    });
    const written = renderSupportBundle(built)
      .split('\n')
      .filter((line) => line.startsWith('not included: ')).length;
    expect(
      { written, declared: built.excluded.length },
      'a newline in an engine id opens a line the bundle never wrote',
    ).toMatchObject({ written: built.excluded.length });
  });
});
