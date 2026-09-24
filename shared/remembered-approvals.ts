/**
 * Remembered approvals (work order D5, Andrew 2026-09-24): the pure rules both
 * the host and the Console read.
 *
 * Learning only offers. A remembered approval exists only after the person
 * clicks, either "Go ahead and remember in this project" on an exact approval
 * or "Stop asking" on a learned offer. What it covers is an exact pattern:
 * the same procedure, the same tool and action, the same destination or
 * recipients and the same connection, in the same project. Anything outside
 * that pattern asks again.
 *
 * Nothing here grants authority. The classifier decides only whether an
 * action may ever be *offered* for remembering; the host re-checks it before
 * it records a grant and again before a grant covers anything.
 */
import type { Destination, Effect, StepIntent } from './harness.js';
import { AGENT_NAME } from './agent-name.js';

/**
 * Identical exact approvals in one project before Diomedes offers to stop
 * asking. A product constant to tune with evidence (D5), deliberately not a
 * person's setting or a request field: changing it can never create a grant.
 */
export const REMEMBER_OFFER_THRESHOLD = 3;

export type RememberRoute = 'approve-and-remember' | 'learned-offer';

/** Why an action always asks. `unrecognised` is the conservative default. */
export type AlwaysAskCategory = 'moves-money' | 'destroys-data' | 'changes-access' | 'unrecognised';

export const ALWAYS_ASK_REASON: Record<AlwaysAskCategory, string> = {
  'moves-money': 'Payments and moving money always ask.',
  'destroys-data': 'Deleting or destroying data always asks.',
  'changes-access': 'Changing credentials, members or permissions always asks.',
  unrecognised: `${AGENT_NAME} cannot tell this action is safe to remember, so it always asks.`,
};

/**
 * Exactly what one remembered approval covers. Every field is compared whole:
 * a new recipient, a wider action or a different connection is a different
 * pattern, so it asks again.
 */
export interface ApprovalPattern {
  readonly kind: 'harness-step';
  readonly projectId: string;
  /** The procedure (capability) the step belongs to. */
  readonly procedure: string;
  /** The tool the step calls. */
  readonly tool: string;
  readonly action: {
    readonly kind: StepIntent['kind'];
    readonly permission: string;
    readonly effect: Effect;
  };
  readonly destination: {
    readonly kind: Destination;
    /** Files for a local write; `to:`/`cc:`/`bcc:`/`url:` recipients for a send. Sorted. */
    readonly targets: readonly string[];
  };
  /** The engine and account route the action acts through. */
  readonly connection: { readonly engine: string; readonly accountRoute: string | null };
}

export type Classification =
  | { rememberable: true }
  | { rememberable: false; category: AlwaysAskCategory; reason: string };

const MONEY = new Set([
  'pay',
  'payment',
  'payments',
  'payout',
  'payouts',
  'charge',
  'charges',
  'refund',
  'refunds',
  'transfer',
  'transfers',
  'wire',
  'purchase',
  'purchases',
  'buy',
  'checkout',
  'billing',
  'bill',
  'bills',
  'invoice',
  'invoices',
  'money',
  'funds',
  'spend',
  'spending',
  'order',
  'orders',
  'subscribe',
  'subscription',
  'price',
  'pricing',
  'card',
  'bank',
  'withdraw',
  'deposit',
]);
const DESTROY = new Set([
  'delete',
  'deletes',
  'deleting',
  'remove',
  'removes',
  'destroy',
  'erase',
  'purge',
  'drop',
  'truncate',
  'wipe',
  'trash',
  'unlink',
  'rm',
  'rmdir',
  'reset',
  'overwrite',
  'shred',
  'clear',
  'revoke',
  'cancel',
  'uninstall',
]);
const ACCESS = new Set([
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'key',
  'keys',
  'apikey',
  'member',
  'members',
  'membership',
  'invite',
  'invites',
  'role',
  'roles',
  'permission',
  'permissions',
  'grant',
  'grants',
  'access',
  'auth',
  'oauth',
  'login',
  'signin',
  'share',
  'sharing',
  'admin',
  'owner',
  'owners',
  'user',
  'users',
  'account',
  'accounts',
  'seat',
  'seats',
  'policy',
  'policies',
]);

/**
 * Permissions an action may be remembered under at all, and on which
 * destination. Anything else is `unrecognised` and always asks, so a new tool
 * is never rememberable until someone decides it should be.
 */
const REMEMBERABLE: Record<string, { destination: Destination; effects: readonly Effect[] }> = {
  // A recorded, reviewable local write: the before and after are in History.
  'write-project-file': { destination: 'local', effects: ['idempotent'] },
  // Sending an email or a report is the case Andrew named (D5).
  'send-email': { destination: 'external', effects: ['idempotent', 'non-idempotent'] },
  'send-message': { destination: 'external', effects: ['idempotent', 'non-idempotent'] },
  'send-report': { destination: 'external', effects: ['idempotent', 'non-idempotent'] },
  'deliver-report': { destination: 'external', effects: ['idempotent', 'non-idempotent'] },
};

const words = (value: string | null | undefined) =>
  (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const always = (category: AlwaysAskCategory): Classification => ({
  rememberable: false,
  category,
  reason: ALWAYS_ASK_REASON[category],
});

/**
 * Whether an exact approval may ever be offered for remembering. Conservative:
 * any money, destruction or access word anywhere in the procedure, tool or
 * permission name, a deletion in the input, or any shape not on the short
 * allowlist above, always asks.
 */
export function classifyApproval(input: {
  procedure: string;
  tool: string | null | undefined;
  permission: string | null;
  effect: Effect;
  destination: Destination;
  targets: readonly string[];
  deletes: boolean;
}): Classification {
  const vocabulary = new Set([
    ...words(input.procedure),
    ...words(input.tool),
    ...words(input.permission),
  ]);
  const has = (list: Set<string>) => [...vocabulary].some((word) => list.has(word));
  if (has(MONEY)) return always('moves-money');
  if (input.deletes || has(DESTROY)) return always('destroys-data');
  // The permission name itself is checked against the allowlist below, so a
  // plain `write-project-file` does not trip the access words on its own.
  if (has(ACCESS)) return always('changes-access');
  if (!input.tool || !input.permission) return always('unrecognised');
  const allowed = REMEMBERABLE[input.permission];
  if (
    !allowed ||
    allowed.destination !== input.destination ||
    !allowed.effects.includes(input.effect) ||
    !input.targets.length
  )
    return always('unrecognised');
  return { rememberable: true };
}

const RECIPIENT_FIELDS = ['to', 'cc', 'bcc', 'recipients', 'url', 'channel'] as const;

const strings = (value: unknown): string[] | null => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value as string[];
  return null;
};

/**
 * The destination an intent names: its files for a local write, its recipients
 * for a send. `null` when the input names a destination in a shape this cannot
 * read, which makes the step unrecognised rather than guessed at.
 */
export function intentTargets(intent: Pick<StepIntent, 'input' | 'destination'>): {
  targets: string[];
  deletes: boolean;
} | null {
  const input = intent.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const targets: string[] = [];
  if (record.files !== undefined) {
    const files = strings(record.files);
    if (!files) return null;
    targets.push(...files.map((file) => `file:${file}`));
  }
  for (const field of RECIPIENT_FIELDS) {
    if (record[field] === undefined) continue;
    const values = strings(record[field]);
    if (!values) return null;
    const label = field === 'recipients' ? 'to' : field;
    targets.push(...values.map((value) => `${label}:${value.trim().toLowerCase()}`));
  }
  const deletes =
    record.delete === true ||
    record.deletes === true ||
    (Object.hasOwn(record, 'text') && record.text === null);
  return { targets: [...new Set(targets)].sort(), deletes };
}

/** The classifier for a harness step, as the Console reads it from a Need. */
export function classifyIntent(procedure: string, intent: StepIntent): Classification {
  const read = intentTargets(intent);
  if (!read) return always('unrecognised');
  return classifyApproval({
    procedure,
    tool: intent.name,
    permission: intent.permission,
    effect: intent.effect,
    destination: intent.destination,
    targets: read.targets,
    deletes: read.deletes,
  });
}

const targetText = (targets: readonly string[]) =>
  targets
    .map((target) => target.replace(/^(file|to|url|channel):/, '').replace(/^(cc|bcc):/, '$1 '))
    .join(', ');

/** The exact action in the person's words, e.g. "Write Harness report.md (Format a fixture report)". */
export function describePattern(pattern: ApprovalPattern, procedureLabel?: string): string {
  const verb =
    pattern.destination.kind === 'external'
      ? `Send to ${targetText(pattern.destination.targets)}`
      : `Write ${targetText(pattern.destination.targets)}`;
  return `${verb} (${procedureLabel ?? pattern.procedure})`;
}

/** The offer, asked once. */
export function offerQuestion(what: string, approvals: number): string {
  return `You've approved “${what}” ${approvals} times in this project. Stop asking?`;
}

const day = (at: string) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * How an action taken under a remembered approval is shown. It names whose
 * approval and since when, so it never reads as a fresh click.
 */
export function rememberedAttribution(grant: { acceptedBy: string; acceptedAt: string }): string {
  return `Ran under a remembered approval — ${grant.acceptedBy}, since ${day(grant.acceptedAt)}.`;
}
