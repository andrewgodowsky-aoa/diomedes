/**
 * The desktop's "Reach this computer from your phone" setting, one per business
 * (relay plan steps 1 and 2, 2026-09-26).
 *
 *   GET /api/account/organizations/:id/phone-relay   this view
 *   PUT /api/account/organizations/:id/phone-relay   { enabled: boolean } turns it on or off
 *
 * The desktop never listens. While the setting is on, it dials out to the
 * business's relay and proves a key only this computer holds. Turning it off,
 * or signing out, closes the connection and removes this computer's record.
 */

export type PhoneRelayState = 'off' | 'connecting' | 'reachable' | 'error';

export interface PhoneRelayView {
  organizationId: string;
  /** Whether the business's plan includes phone access. */
  included: boolean;
  /** This computer is registered for the signed-in person and this business. */
  enabled: boolean;
  /** Whether the switch works for this person on this computer now. */
  canChange: boolean;
  /** This computer's name, as the phone shows it. */
  label: string;
  state: PhoneRelayState;
  /** One plain sentence: why the switch can't be used, or what went wrong. Null when there's nothing to say. */
  sentence: string | null;
}

export interface PhoneRelayChange {
  enabled: boolean;
}
