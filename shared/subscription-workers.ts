/**
 * Subscription workers (subscription-aware orchestration S3, IMPLEMENTATION.md 4.4).
 *
 * A person may let their Personal Nectovia lead hand a bounded task to one of their own coding
 * tools, on their own plan. This file is that choice's record, the consent it was given under
 * and the reserve rule. The host resolves the worker from this record, the signed-in person and
 * the project's owner; a request never names it.
 *
 * - Off by default. Connecting a tool never turns it on.
 * - Personal work only. A project a business owns never uses it (D13), so `payerForRoute`'s
 *   refusal of a person's subscription for company work is untouched.
 * - Automations never reach it: the scheduler starts only deterministic procedures, never a loop
 *   (D12; `server/automation-scheduler.ts`). A future Automations feeder into the Work start path
 *   must turn this choice off for its starts.
 *
 * Pure: no clock of its own, no disk, no request. Client and server share it.
 */
import { z } from 'zod';
import type { UsageWindow } from './types.js';
import { EXTERNAL_WORKER_ROUTES, type ExternalWorkerRoute } from './team-delegation.js';

export const SUBSCRIPTION_WORKERS_VERSION = 1 as const;

/** Changes whenever the consent below changes; a preference saved under another revision is asked again. */
export const SUBSCRIPTION_WORKERS_CONSENT_REVISION = '2026-10-03.1';

/** What the person agrees to when they turn subscription workers on. */
export const SUBSCRIPTION_WORKERS_CONSENT =
  'A task Nectovia hands off goes to your coding tool with the files it needs. It runs through the tool’s own coding interface, signed in with your account, never through a chat app. Your plan’s limits and terms apply.';

/** What a Nectovia lead does when none of the person's tools can take a task. */
export type WhenUnavailable = 'pause' | 'single-agent';

/** Part of a tool's usage limit the person keeps for their own work. Only a tool that reports its limit can honor it. */
export type SubscriptionReserve =
  | { readonly kind: 'none' }
  | { readonly kind: 'provider-window'; readonly keepPercent: number };

export interface SubscriptionWorkersPreference {
  readonly version: typeof SUBSCRIPTION_WORKERS_VERSION;
  /** Who turned it on. Another person signed in on this computer reads it as off. */
  readonly personId: string;
  readonly scope: { readonly kind: 'personal' };
  readonly enabled: boolean;
  /** In the order the person prefers them. The first one that's ready takes the task. */
  readonly engines: readonly ExternalWorkerRoute[];
  readonly reserve: SubscriptionReserve;
  readonly whenUnavailable: WhenUnavailable;
  readonly consentRevision: string;
  readonly updatedAt: string;
}

export const subscriptionReserveSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('provider-window'), keepPercent: z.number().int().min(1).max(90) }),
]);

/** What `PUT /api/settings/subscription-workers` takes. Who and when come from the host. */
export const subscriptionWorkersWriteSchema = z.strictObject({
  enabled: z.boolean(),
  engines: z
    .array(z.enum(EXTERNAL_WORKER_ROUTES))
    .max(EXTERNAL_WORKER_ROUTES.length)
    .refine((list) => new Set(list).size === list.length, { message: 'Name each tool once.' }),
  reserve: subscriptionReserveSchema,
  // Required: the Settings panel preselects 'single-agent', today's behavior, and the person may change it.
  whenUnavailable: z.enum(['pause', 'single-agent']),
  consentRevision: z.string().min(1).max(40),
});
export type SubscriptionWorkersWrite = z.infer<typeof subscriptionWorkersWriteSchema>;

/** The stored record, as the settings file keeps it. Anything else on disk reads as no preference. */
export const subscriptionWorkersPreferenceSchema = z.strictObject({
  version: z.literal(SUBSCRIPTION_WORKERS_VERSION),
  personId: z.string().min(1).max(200),
  scope: z.strictObject({ kind: z.literal('personal') }),
  enabled: z.boolean(),
  engines: z.array(z.enum(EXTERNAL_WORKER_ROUTES)).max(EXTERNAL_WORKER_ROUTES.length),
  reserve: subscriptionReserveSchema,
  whenUnavailable: z.enum(['pause', 'single-agent']),
  consentRevision: z.string().min(1).max(40),
  updatedAt: z.string().min(1).max(40),
});

/** A coding tool a task may go to, by the name the server gives it (`routeName`). */
export interface SubscriptionWorkerTool {
  readonly route: ExternalWorkerRoute;
  readonly name: string;
}

/** What `GET /api/settings/subscription-workers` answers: everything the Settings section shows. */
export interface SubscriptionWorkersView {
  /** The launch gate and the engine port, both. False: the build doesn't offer it. */
  readonly available: boolean;
  readonly signedIn: boolean;
  /** The signed-in person's own preference. Someone else's reads as none. */
  readonly preference: SubscriptionWorkersPreference | null;
  /** What the person agrees to when they turn it on, and its revision. */
  readonly consent: { readonly revision: string; readonly text: string };
  /** Every tool a task may go to. */
  readonly tools: readonly SubscriptionWorkerTool[];
}

/**
 * What the person's own Nectovia start in one project would do with their tools, as
 * `GET /api/projects/:id/subscription-workers` answers it: nothing; these tools in the person's
 * order, named, with the consent revision a start echoes in `workerConsent`; or nothing, for a
 * reason the preference gives.
 */
export type SubscriptionWorkerStartView =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'candidates';
      readonly engines: readonly ExternalWorkerRoute[];
      /** `engines` by name, in the same order. */
      readonly names: readonly string[];
      readonly consentRevision: string;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * What a Nectovia lead was admitted with, kept on its run so its labels and its reserve come from
 * the run and never from later settings (N21).
 */
export interface SubscriptionWorkerRecord {
  readonly state: 'attached' | 'unavailable';
  /** The tool that took the worker role, when one did. */
  readonly route: ExternalWorkerRoute | null;
  /** Why no tool took it, when none did. */
  readonly reason: string | null;
  readonly reserve: SubscriptionReserve;
  readonly consentRevision: string;
}

/** How fresh a tool's usage reading must be to decide a reserve. An older one reads as not met (N29). */
export const RESERVE_READING_MAX_AGE_MS = 5 * 60_000;

/** A tool's usage limits as one admission read them. */
export interface UsageReading {
  readonly windows: readonly UsageWindow[];
  readonly at: string;
}

/**
 * Why a reserve stops a tool from taking a task, or null when it doesn't. The tightest window
 * decides, and a reading that's missing, empty or stale reads as not met, never as plenty left.
 */
export function reserveRefusal(
  reserve: SubscriptionReserve,
  reading: UsageReading | null | undefined,
  now: number,
  name: string,
): string | null {
  if (reserve.kind === 'none') return null;
  const at = reading ? Date.parse(reading.at) : Number.NaN;
  if (!reading || reading.windows.length === 0 || !Number.isFinite(at) || now - at > RESERVE_READING_MAX_AGE_MS)
    return `You keep ${reserve.keepPercent}% of ${name}’s usage limit for your own work, and ${name} hasn’t reported how much is left, so it wasn’t given this task.`;
  const used = Math.max(...reading.windows.map((window) => window.usedPercent));
  const left = Math.max(0, Math.floor(100 - used));
  if (left <= reserve.keepPercent)
    return `You keep ${reserve.keepPercent}% of ${name}’s usage limit for your own work, and ${left}% is left, so it wasn’t given this task.`;
  return null;
}
