/**
 * The Console's "Reach this computer from your phone" row, drawn for each
 * answer the desktop gives: one switch and one line that says one thing, and a
 * business without phone access sees only why.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhoneRelaySwitch } from '../client/AccountSettings';
import { LINK_SENTENCES } from '../server/relay/link';
import { PHONE_RELAY_SENTENCES } from '../server/relay/service';
import { PHONE_RELAY_NOT_INCLUDED_REASON } from '../shared/access';
import type { PhoneRelayView } from '../shared/phone-relay';

const off: PhoneRelayView = {
  organizationId: 'org_juniper', included: true, enabled: false, canChange: true, label: 'FRONT-COUNTER', state: 'off', sentence: null,
};
const draw = (view: PhoneRelayView, extra: { busy?: boolean; error?: string } = {}) =>
  renderToStaticMarkup(createElement(PhoneRelaySwitch, { view, ...extra }));
/** What a person reads. */
const read = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const times = (html: string, phrase: string) => read(html).split(phrase).length - 1;
const input = (html: string) => /<input[^>]*>/.exec(html)?.[0] ?? '';

describe('the phone access row in Settings, Account', () => {
  it('shows a business without phone access only why, with nothing to switch', () => {
    const html = draw({ ...off, included: false, canChange: false, sentence: PHONE_RELAY_NOT_INCLUDED_REASON });
    expect(html).not.toContain('<input');
    expect(read(html)).toBe(PHONE_RELAY_NOT_INCLUDED_REASON);
  });

  it("names the computer and its state in one line: off, connecting, reachable", () => {
    const lines = {
      off: 'Reach this computer from your phone Your phone will see this computer as FRONT-COUNTER.',
      connecting: 'Reach this computer from your phone Connecting FRONT-COUNTER to the relay…',
      reachable: 'Reach this computer from your phone FRONT-COUNTER is connected and shows as online.',
    } as const;
    for (const state of ['off', 'connecting', 'reachable'] as const) {
      const html = draw({ ...off, enabled: state !== 'off', state });
      expect(read(html)).toBe(lines[state]);
      expect(input(html)).toContain('role="switch"');
      expect(input(html).includes('checked=""')).toBe(state !== 'off');
      expect(input(html)).not.toContain('disabled');
      expect(html).not.toContain('role="alert"');
    }
  });

  it('says an error once, as an alert, in place of the state', () => {
    const html = draw({ ...off, enabled: true, state: 'error', sentence: PHONE_RELAY_SENTENCES.role });
    expect(read(html)).toBe(`Reach this computer from your phone ${PHONE_RELAY_SENTENCES.role}`);
    expect(html).toContain('role="alert"');
    // Still on, so it can be turned off.
    expect(input(html)).toContain('checked=""');
    expect(input(html)).not.toContain('disabled');

    // The plan was withdrawn while it was on: the reason, once, and the switch to turn it off.
    const withdrawn = draw({ ...off, included: false, enabled: true, state: 'error', sentence: PHONE_RELAY_NOT_INCLUDED_REASON });
    expect(times(withdrawn, PHONE_RELAY_NOT_INCLUDED_REASON)).toBe(1);
    expect(input(withdrawn)).not.toContain('disabled');

    // A change that didn't go through replaces the line rather than adding a second.
    const refused = draw(off, { error: 'This business already lets phones reach 50 computers. Stop one first.' });
    expect(read(refused)).toBe('Reach this computer from your phone This business already lets phones reach 50 computers. Stop one first.');
    expect(refused).toContain('role="alert"');
  });

  it("disables the switch for an Employee and says who can turn it on; a stop from elsewhere is said once and isn't an alert", () => {
    const employee = draw({ ...off, canChange: false, sentence: PHONE_RELAY_SENTENCES.role });
    expect(input(employee)).toContain('disabled');
    expect(read(employee)).toBe(`Reach this computer from your phone ${PHONE_RELAY_SENTENCES.role}`);
    expect(employee).not.toContain('role="alert"');

    const stopped = draw({ ...off, sentence: LINK_SENTENCES.stoppedElsewhere });
    expect(input(stopped)).not.toContain('disabled');
    expect(times(stopped, LINK_SENTENCES.stoppedElsewhere)).toBe(1);
    expect(stopped).not.toContain('role="alert"');

    expect(input(draw(off, { busy: true }))).toContain('disabled');
  });
});
