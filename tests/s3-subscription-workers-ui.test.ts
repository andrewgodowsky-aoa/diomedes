/**
 * S3's two pieces of UI, as plain data and static markup: the loop start's consent naming the
 * person's own coding tools and the command that echoes what they confirmed, and Settings' "Your
 * coding tools". The server side, and a cross-check of the dialog's sentence against the start's
 * own, is in `s3-subscription-workers.test.ts`; the browser runs are in `native-loop-ui.spec.ts`
 * and `settings-usage.spec.ts`.
 */
import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LOOP_START_CHANGED_CHOICES,
  loopStartCommand,
  loopToolConsent,
  loopToolConsentRefusal,
  loopToolConsentText,
  loopToolNames,
  retainAfterFailure,
  retainLoopStartCommand,
} from '../client/console/loop-start-model';
import {
  CODING_TOOLS_SECTION,
  DEFAULT_KEEP_PERCENT,
  chooseTool,
  codingToolsForm,
  codingToolsOffered,
  codingToolsWrite,
  consentChanged,
  keepPercent,
  moveTool,
} from '../client/coding-tools-view';
import { CodingTools } from '../client/CodingTools';
import {
  SUBSCRIPTION_WORKERS_CONSENT,
  SUBSCRIPTION_WORKERS_CONSENT_REVISION,
  type SubscriptionWorkersPreference,
  type SubscriptionWorkersView,
} from '../shared/subscription-workers';
import { SUBSCRIPTION_WORKERS_UNAVAILABLE } from '../server/subscription-workers';

const REVISION = SUBSCRIPTION_WORKERS_CONSENT_REVISION;

// --- the loop start ------------------------------------------------------------------------------

const base = () => ({
  commandId: 'console-loop-s3',
  taskId: 'linen-task',
  goal: ' Check the linen order. ',
  route: 'nectovia',
  sources: ['order.md'],
  consent: true,
  maxTurns: null,
});
const BOTH = { revision: REVISION, engines: ['codex', 'claude-code'] };
const CODEX = { revision: REVISION, engines: ['codex'] };

describe('the loop start sends the tools a person confirmed, only when given', () => {
  test('no confirmation given: the command is exactly as before', () => {
    for (const workerConsent of [undefined, null]) {
      const command = loopStartCommand({ ...base(), workerConsent });
      expect(command).not.toHaveProperty('workerConsent');
      expect(Object.keys(command).sort()).toEqual(['commandId', 'consent', 'goal', 'protocolVersion', 'route', 'sources', 'taskId']);
    }
  });

  test('given: it goes alongside the consent, detached from the dialog’s own lists', () => {
    const engines = ['codex', 'claude-code'];
    const command = loopStartCommand({ ...base(), workerConsent: { revision: REVISION, engines } });
    expect(command).toEqual({
      protocolVersion: 1,
      commandId: 'console-loop-s3',
      taskId: 'linen-task',
      goal: 'Check the linen order.',
      route: 'nectovia',
      sources: ['order.md'],
      consent: true,
      workerConsent: { revision: REVISION, engines: ['codex', 'claude-code'] },
    });
    engines.push('opencode');
    expect(command.workerConsent?.engines).toEqual(['codex', 'claude-code']);
  });
});

describe('the retained command when the tools a person confirmed change', () => {
  test('after a lost answer, a resend must repeat the exact command, its confirmed tools included', () => {
    const sent = retainLoopStartCommand(null, loopStartCommand({ ...base(), workerConsent: BOTH }));
    const kept = retainAfterFailure(sent, null);
    expect(kept).toBe(sent);
    expect(retainLoopStartCommand(kept, loopStartCommand({ ...base(), workerConsent: BOTH }))).toBe(sent);
    expect(() => retainLoopStartCommand(kept, loopStartCommand({ ...base(), workerConsent: CODEX }))).toThrow(LOOP_START_CHANGED_CHOICES);
    expect(() => retainLoopStartCommand(kept, loopStartCommand({ ...base(), workerConsent: null }))).toThrow(LOOP_START_CHANGED_CHOICES);
  });

  test('after the start asks again naming the tools, the new confirmation goes out under the same command id', () => {
    const sent = retainLoopStartCommand(null, loopStartCommand({ ...base(), workerConsent: BOTH }));
    const refusal = loopToolConsentRefusal(409, {
      error: `${loopToolConsentText(['Codex'])} Confirm before sending.`,
      consentRequired: true,
      workerConsent: CODEX,
    });
    expect(refusal).not.toBeNull();
    const kept = retainAfterFailure(sent, refusal);
    expect(kept).toBeNull();
    const next = retainLoopStartCommand(kept, loopStartCommand({ ...base(), workerConsent: refusal!.workerConsent }));
    expect(next.commandId).toBe(sent.commandId);
    expect(next.workerConsent).toEqual(CODEX);
  });

  test('a plain consent refusal keeps today’s rule: the command stays and a changed one is refused', () => {
    const sent = retainLoopStartCommand(null, loopStartCommand({ ...base(), route: 'openrouter', consent: false }));
    const refusal = loopToolConsentRefusal(409, {
      error: 'Your goal and the files the loop reads will be sent to the selected service. Confirm before sending.',
      consentRequired: true,
    });
    expect(refusal).toBeNull();
    const kept = retainAfterFailure(sent, refusal);
    expect(kept).toBe(sent);
    expect(() => retainLoopStartCommand(kept, loopStartCommand({ ...base(), route: 'openrouter' }))).toThrow(LOOP_START_CHANGED_CHOICES);
  });

  test('only a 409 asking for consent with the tools to echo is read as one', () => {
    const body = { error: 'Confirm before sending.', consentRequired: true, workerConsent: CODEX };
    expect(loopToolConsentRefusal(409, body)).toEqual({ text: 'Confirm before sending.', workerConsent: CODEX });
    for (const [status, value] of [
      [400, body],
      [409, { ...body, consentRequired: false }],
      [409, { ...body, error: '' }],
      [409, { ...body, workerConsent: null }],
      [409, { ...body, workerConsent: { revision: REVISION, engines: [] } }],
      [409, { ...body, workerConsent: { revision: '', engines: ['codex'] } }],
      [409, { ...body, workerConsent: { revision: REVISION, engines: ['codex', 7] } }],
      [409, null],
      [409, 'Confirm before sending.'],
    ] as const)
      expect(loopToolConsentRefusal(status, value)).toBeNull();
  });
});

describe('the consent a Nectovia start asks for names the person’s tools', () => {
  test('tools are joined as the start route joins them', () => {
    expect(loopToolNames(['Codex'])).toBe('Codex');
    expect(loopToolNames(['Codex', 'Claude Code'])).toBe('Codex or Claude Code');
    expect(loopToolNames(['Codex', 'Claude Code', 'OpenCode'])).toBe('Codex, Claude Code or OpenCode');
    expect(loopToolConsentText(['Claude Code', 'OpenCode'])).toBe(
      'Your goal and the files the loop reads will be sent to Nectovia, and a task it hands off goes to Claude Code or OpenCode with the files it needs, signed in with your own account.',
    );
  });

  test('only a project whose start would ask a tool changes the consent; the server’s own sentence wins once it asks', () => {
    for (const view of [null, { kind: 'off' as const }, { kind: 'unavailable' as const, reason: 'No coding tool is chosen.' }])
      expect(loopToolConsent(view, null)).toBeNull();
    const candidates = { kind: 'candidates' as const, engines: ['codex', 'claude-code'] as const, names: ['Codex', 'Claude Code'], consentRevision: REVISION };
    expect(loopToolConsent(candidates, null)).toEqual({ text: loopToolConsentText(['Codex', 'Claude Code']), workerConsent: BOTH });
    expect(loopToolConsent({ ...candidates, names: ['Codex'] }, null)).toBeNull();
    const asked = { text: 'The server’s sentence. Confirm before sending.', workerConsent: CODEX };
    expect(loopToolConsent(candidates, asked)).toBe(asked);
    expect(loopToolConsent(null, asked)).toBe(asked);
  });
});

// --- Settings: Your coding tools -----------------------------------------------------------------

const TOOLS = [
  { route: 'claude-code', name: 'Claude Code' },
  { route: 'codex', name: 'Codex' },
  { route: 'opencode', name: 'OpenCode' },
] as const;

const view = (overrides: Partial<SubscriptionWorkersView> = {}): SubscriptionWorkersView => ({
  available: true,
  signedIn: true,
  preference: null,
  consent: { revision: REVISION, text: SUBSCRIPTION_WORKERS_CONSENT },
  tools: TOOLS,
  ...overrides,
});

const preference = (overrides: Partial<SubscriptionWorkersPreference> = {}): SubscriptionWorkersPreference => ({
  version: 1,
  personId: 'person_a',
  scope: { kind: 'personal' },
  enabled: true,
  engines: ['codex', 'opencode'],
  reserve: { kind: 'none' },
  whenUnavailable: 'pause',
  consentRevision: REVISION,
  updatedAt: '2026-10-03T12:00:00.000Z',
  ...overrides,
});

/** The section's static markup with React's escapes read back, so its sentences read as written. */
const render = (value: SubscriptionWorkersView) =>
  renderToStaticMarkup(createElement(CodingTools, { view: value, onSaved: () => {} }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const inputAfter = (html: string, label: string) => html.match(new RegExp(`<span>${label}</span><input[^>]*>`))?.[0] ?? '';
const inputWith = (html: string, marker: string) => html.match(new RegExp(`<input[^>]*${marker}[^>]*>`))?.[0] ?? '';

describe('Settings offers "Your coding tools" only in a build that offers it', () => {
  test('the rail has the section only when the server says the build offers it', () => {
    expect(CODING_TOOLS_SECTION).toBe('Your coding tools');
    expect(codingToolsOffered(undefined)).toBe(false);
    expect(codingToolsOffered(null)).toBe(false);
    expect(codingToolsOffered(view({ available: false }))).toBe(false);
    expect(codingToolsOffered(view({ available: false, signedIn: false }))).toBe(false);
    expect(codingToolsOffered(view({ signedIn: false }))).toBe(true);
    expect(codingToolsOffered(view())).toBe(true);
  });

  test('not offered: nothing at all, not even a line saying so', () => {
    for (const value of [view({ available: false }), view({ available: false, signedIn: false }), view({ available: false, preference: preference() })]) {
      const html = render(value);
      expect(html).toBe('');
      expect(html).not.toContain(SUBSCRIPTION_WORKERS_UNAVAILABLE);
    }
  });

  test('offered and signed out: only the line asking to sign in', () => {
    expect(render(view({ signedIn: false }))).toBe('<p class="prose">Sign in to choose your coding tools.</p>');
  });
});

describe('Settings: what "Your coding tools" shows', () => {
  test('a person with nothing saved: the copy, every tool by the server’s name, and Nectovia preselected', () => {
    const html = render(view());
    for (const text of [
      'Nectovia can hand a task in your Personal work to a coding tool you already pay for. That task runs on your plan, not your Nectovia credits.',
      SUBSCRIPTION_WORKERS_CONSENT,
      '<span>I understand</span>',
      '<span>Hand tasks to my coding tools</span>',
      'Tools to use, first choice at the top',
      "Keep part of each tool's limit for your own work",
      'No. Use a tool whenever it can take the task.',
      'Yes, keep ',
      "% of each tool's limit for me.",
      "A tool that doesn't report how much of its limit is left won't get tasks while you keep a share.",
      'When none of your tools can take a task',
      'Nectovia does it with your Nectovia credits',
      'Hold the work until one of your tools can take it',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('has changed');
    expect(html).not.toMatch(/[—–]/);
    // The tools in the server's order, each with its own move buttons.
    expect([...html.matchAll(/data-tool="([^"]+)"/g)].map((match) => match[1])).toEqual(['claude-code', 'codex', 'opencode']);
    for (const name of ['Claude Code', 'Codex', 'OpenCode'])
      for (const way of ['up', 'down']) expect(html).toContain(`aria-label="Move ${name} ${way}"`);
    expect(html).toMatch(/<button[^>]*aria-label="Move Claude Code up"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="Move OpenCode down"[^>]*disabled=""/);
    // Off, unconfirmed, so it can't be turned on yet.
    expect(inputAfter(html, 'I understand')).not.toContain('checked');
    expect(inputAfter(html, 'Hand tasks to my coding tools')).toContain('disabled=""');
    expect(inputAfter(html, 'Hand tasks to my coding tools')).not.toContain('checked');
    expect(inputWith(html, 'value="single-agent"')).toContain('checked=""');
    expect(inputWith(html, 'value="pause"')).not.toContain('checked');
    expect(inputWith(html, 'type="number"')).toContain(`value="${DEFAULT_KEEP_PERCENT}"`);
    expect(inputWith(html, 'type="number"')).toContain(`aria-label="Share of each tool's limit to keep, in percent"`);
  });

  test('saved on: the person’s tools lead in their order, the agreement stands, and their choices show', () => {
    const html = render(view({ preference: preference({ reserve: { kind: 'provider-window', keepPercent: 35 } }) }));
    expect([...html.matchAll(/data-tool="([^"]+)"/g)].map((match) => match[1])).toEqual(['codex', 'opencode', 'claude-code']);
    expect(inputAfter(html, 'I understand')).toContain('checked=""');
    expect(inputAfter(html, 'I understand')).toContain('disabled=""');
    expect(inputAfter(html, 'Hand tasks to my coding tools')).toContain('checked=""');
    expect(inputAfter(html, 'Hand tasks to my coding tools')).not.toContain('disabled');
    expect(inputWith(html, 'value="pause"')).toContain('checked=""');
    expect(inputWith(html, 'type="number"')).toContain('value="35"');
    expect(html).not.toContain('has changed');
  });

  test('saved on under an older consent: it says so, unticks I understand and shows it off until confirmed', () => {
    const stale = view({ preference: preference({ consentRevision: '2026-01-01.1' }) });
    expect(consentChanged(stale)).toBe(true);
    const html = render(stale);
    expect(html).toContain('What handing tasks to your coding tools sends has changed. Read it again and confirm.');
    expect(inputAfter(html, 'I understand')).not.toContain('checked');
    expect(inputAfter(html, 'I understand')).not.toContain('disabled');
    expect(inputAfter(html, 'Hand tasks to my coding tools')).not.toContain('checked');
    expect(inputAfter(html, 'Hand tasks to my coding tools')).toContain('disabled=""');
    // Turned off under an older consent, there's nothing held to confirm.
    expect(consentChanged(view({ preference: preference({ enabled: false, consentRevision: '2026-01-01.1' }) }))).toBe(false);
  });
});

describe('Settings: what a change to "Your coding tools" saves', () => {
  test('nothing saved: off, no tools, no reserve and Nectovia carrying on, in the server’s order', () => {
    expect(codingToolsForm(view())).toEqual({
      on: false,
      order: ['claude-code', 'codex', 'opencode'],
      chosen: [],
      reserve: { kind: 'none' },
      whenUnavailable: 'single-agent',
    });
  });

  test('turning it on saves the consent shown now; off keeps what was saved, or names the shown one', () => {
    const fresh = view();
    const ticked = chooseTool(codingToolsForm(fresh), 'codex', true);
    expect(codingToolsWrite({ ...ticked, on: true }, fresh)).toEqual({
      enabled: true,
      engines: ['codex'],
      reserve: { kind: 'none' },
      whenUnavailable: 'single-agent',
      consentRevision: REVISION,
    });
    expect(codingToolsWrite(ticked, fresh).consentRevision).toBe(REVISION);
    const stale = view({ preference: preference({ consentRevision: '2026-01-01.1' }) });
    const form = codingToolsForm(stale);
    expect(form.on).toBe(false);
    expect(codingToolsWrite(form, stale)).toMatchObject({ enabled: false, consentRevision: '2026-01-01.1' });
    expect(codingToolsWrite({ ...form, on: true }, stale)).toMatchObject({ enabled: true, consentRevision: REVISION });
  });

  test('the saved order is the person’s order; a tool keeps its place when ticked or moved', () => {
    const fresh = view();
    let form = codingToolsForm(fresh);
    form = chooseTool(form, 'opencode', true);
    form = chooseTool(form, 'claude-code', true);
    expect(codingToolsWrite(form, fresh).engines).toEqual(['claude-code', 'opencode']);
    form = { ...form, order: moveTool(form.order, 'opencode', -1) };
    expect(form.order).toEqual(['claude-code', 'opencode', 'codex']);
    form = { ...form, order: moveTool(form.order, 'opencode', -1) };
    expect(codingToolsWrite(form, fresh).engines).toEqual(['opencode', 'claude-code']);
    expect(moveTool(form.order, 'opencode', -1)).toEqual(form.order);
    expect(moveTool(form.order, 'codex', 1)).toEqual(form.order);
    form = chooseTool(form, 'opencode', false);
    expect(codingToolsWrite(form, fresh).engines).toEqual(['claude-code']);
    // After a save answers, the tools stay where they were on screen.
    const saved = view({ preference: preference({ engines: ['claude-code'] }) });
    expect(codingToolsForm(saved, form.order).order).toEqual(form.order);
    expect(codingToolsForm(saved).order).toEqual(['claude-code', 'codex', 'opencode']);
  });

  test('the share kept is a whole number from 1 to 90', () => {
    expect(keepPercent('1')).toBe(1);
    expect(keepPercent(' 35 ')).toBe(35);
    expect(keepPercent('90')).toBe(90);
    for (const typed of ['', '0', '91', '100', '2.5', '-5', 'ten', '1e1']) expect(keepPercent(typed)).toBeNull();
  });
});
