/**
 * The inspector's view of one piece of work, as ordered rows.
 *
 * `evidenceFor` in `shared/execution.ts` answers each question the harness
 * contract asks. This turns those answers into the rows a person reads, and it
 * exists as its own function for one reason: the order is part of the meaning.
 * A person opening an inspector is asking "who did this, under what, and can I
 * see it was checked" — so the rows run identity, worker, model, setup,
 * authority, money, effect, and end on who filled each of the four roles.
 *
 * The rule the whole file serves is that an unknown row still appears. Hiding
 * a row nobody could answer makes an incomplete record look complete, and the
 * gap that matters most — nobody reviewed this — is exactly the one a tidy
 * screen would hide. So every row is present, and an unknown one carries the
 * reason it is unknown as its text.
 */
import type { EvidenceView, Known } from './execution.js';

export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
  /** True when this is an honest gap. The screen shows it dimmed, never blank. */
  readonly unknown: boolean;
  /** True for an identifier, which reads better in the inspector's code style. */
  readonly code: boolean;
}

/** The fixed order. Changing it changes what the inspector is saying first. */
export const EVIDENCE_ORDER = Object.freeze([
  'Person',
  'Business',
  'Worker',
  'Team',
  'Handed over',
  'Model',
  'Runtime',
  'Chosen',
  'Setup',
  'Rules',
  'Permission',
  'Paid by',
  'Reserved',
  'Change',
  'Checked',
  'Proposed by',
  'Reviewed by',
  'Written by',
  'Checked by',
] as const);

const row = (label: string, known: Known<string>, code = false): EvidenceRow =>
  known.known
    ? { label, value: known.value, unknown: false, code }
    : { label, value: known.why, unknown: true, code: false };

const plainChoice = (
  agent: EvidenceView['choice']['agent'],
  model: EvidenceView['choice']['model'],
): string => {
  const worker =
    agent === 'manual' ? 'The worker was picked by hand' : 'Diomedes picked the worker';
  const runtime =
    model === 'manual'
      ? 'the model was picked by hand'
      : model === 'automatic'
        ? 'Diomedes picked the model'
        : 'the model was whatever the route runs by default';
  return `${worker}; ${runtime}.`;
};

export function evidenceRows(view: EvidenceView): readonly EvidenceRow[] {
  return Object.freeze([
    row('Person', view.person, true),
    row('Business', view.organization, true),
    row('Worker', view.agent),
    row('Team', view.team, true),
    row('Handed over', view.handoff, true),
    row('Model', view.model, true),
    row('Runtime', view.runtime, true),
    {
      label: 'Chosen',
      value: plainChoice(view.choice.agent, view.choice.model),
      unknown: false,
      code: false,
    },
    row('Setup', view.configuration),
    row('Rules', view.rules, true),
    row('Permission', view.authority),
    row('Paid by', view.payer),
    row('Reserved', view.reservation, true),
    row('Change', view.effect),
    row('Checked', view.verification),
    row('Proposed by', view.roles.proposer),
    row('Reviewed by', view.roles.reviewer),
    row('Written by', view.roles.writer),
    row('Checked by', view.roles.verifier),
  ]);
}
