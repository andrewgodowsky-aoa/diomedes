/**
 * The spend-exposure ledger for a bring-your-own model connection: how much of
 * an owner-approved cap one connection has put at risk on the company's own
 * provider account. The first such connection is a direct AWS Bedrock route
 * that the company's own AWS account pays for.
 *
 *   <data>/spend-exposure/<connectionId>.json   one connection's approved cap
 *                                               and every call it reserved
 *
 * This is not the managed allowance and never touches it. `payerForRoute` in
 * `shared/managed-usage.ts` returns `debitsAllowance: false` for a BYO route,
 * because the provider bills the company directly. What the company still
 * needs is a bound on what one connection may spend before a person looks
 * again, and that bound is what this ledger enforces.
 *
 * Four rules carry the weight.
 *
 * 1. Reserve before sending. Every paid call holds a conservative ceiling
 *    (`ceilingCost`) before it is dispatched, so two concurrent calls cannot
 *    each assume the other will be cheap.
 * 2. Unknown is not zero. A call whose outcome or usage is unknown stays
 *    `uncertain` and keeps counting at its ceiling. It is never settled at zero
 *    and never released, because the request may already have cost money.
 * 3. Restarting refunds nothing. A change is on disk before it is visible, and
 *    `init()` turns every hold that was in flight when the process stopped into
 *    `uncertain`, so reopening the app cannot reset exposure.
 * 4. One attempt, one hold. A reservation id is derived from the connection and
 *    the attempt's identity, and an id that exists in any state refuses a
 *    second hold, so the same attempt is never dispatched twice.
 *
 * Money is integer micro-USD made only by `micro()`, and a hold moves only
 * through `reservationTransition`. Both belong to `shared/managed-usage.ts`, so
 * this module cannot grow a second money rule or a second state table.
 *
 * Every change builds the next file, writes it with `jsonWrite` (temp file,
 * fsync, atomic rename) and only then swaps it into memory. Editing memory
 * first would leave memory ahead of disk whenever a write fails; here a failed
 * write leaves memory exactly equal to disk, and the refused change is simply
 * absent. Records held in memory are frozen and every read returns a copy, so
 * neither this module nor a caller can change a record without writing it.
 *
 * Changes run one at a time through a single in-process promise chain, across
 * every connection. That is sufficient because the data folder already belongs
 * to one process (`service.lock`, see `server/lock.ts`): no other process
 * writes these files while this one runs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_MONEY_MICRO_USD,
  formatMoney,
  micro,
  reservationTransition,
  sumMoney,
  type MicroUsd,
  type ReservationEvent,
  type ReservationState,
} from '../shared/managed-usage.js';
import { digest } from './harness/policy.js';
import { absent } from './paths.js';
import { jsonWrite, readJson } from './store.js';

// --- the contract -------------------------------------------------------------

/** Integer micro-USD per 1,000,000 tokens: $0.22 per million tokens is 220000. */
export interface ModelRateBand {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * One model's list prices on one route. `version` is recorded on every hold,
 * and settling refuses a card with another version: a call is priced under the
 * terms it was reserved under, or not at all.
 */
export interface ModelRateCard {
  version: string;
  route: string;
  modelId: string;
  /** Where the figures came from, so a person can check them. */
  source: string;
  /** The largest input, in tokens, still priced at the short band. Inclusive. */
  shortContextMaxInputTokens: number;
  short: ModelRateBand;
  long: ModelRateBand;
}

/** What the provider reported one call used. */
export interface ProviderUsage {
  /** Total input, including the cache-read and cache-write tokens. */
  inputTokens: number;
  /** Part of `inputTokens`. */
  cacheReadTokens: number;
  /** Part of `inputTokens`. */
  cacheWriteTokens: number;
  /** Total output, including reasoning. */
  outputTokens: number;
  /** Part of `outputTokens` and priced as output; kept so a person can see it. */
  reasoningTokens: number;
}

/** Which call is about to be sent. Persisted before the request leaves. */
export interface ExposureAttempt {
  runId: string;
  stepId: string;
  /** 1 for the first try. A retry is a new attempt with the next number. */
  attempt: number;
  /** sha256 of the request as it will be sent: 64 lower-case hex characters. */
  requestDigest: string;
}

/** One hold on the cap, from before the call until what it cost is known. */
export interface ExposureReservation {
  /** `exp-` and the first 40 hex of `digest({ connectionId, attempt })`. */
  id: string;
  connectionId: string;
  route: string;
  modelId: string;
  rateCardVersion: string;
  attempt: ExposureAttempt;
  /** The conservative ceiling held while the call is in flight or unknown. */
  maxMicroUsd: MicroUsd;
  state: ReservationState;
  createdAt: string;
  /** When the hold reached a final state: settled, released or written off. */
  resolvedAt: string | null;
  uncertainAt: string | null;
  uncertainReason: string | null;
  /** What the call cost at list price, set only when it settles. May exceed the ceiling. */
  settledMicroUsd: MicroUsd | null;
  usage: ProviderUsage | null;
  band: 'short' | 'long' | null;
  overCeiling: boolean;
  providerRequestId: string | null;
  reconciledFrom: 'response' | 'owner-entry' | 'write-off' | null;
  note: string | null;
}

/** The owner's approved cap for one connection. Replaced, never edited. */
export interface ExposureAllowance {
  connectionId: string;
  capMicroUsd: MicroUsd;
  approvedAt: string;
  approvedBy: string;
  note: string;
  revision: number;
}

export interface ExposureSummary {
  connectionId: string;
  capMicroUsd: MicroUsd;
  settledMicroUsd: MicroUsd;
  pendingMicroUsd: MicroUsd;
  uncertainMicroUsd: MicroUsd;
  writtenOffMicroUsd: MicroUsd;
  /** settled + pending ceilings + uncertain ceilings + written-off ceilings. */
  exposureMicroUsd: MicroUsd;
  /** max(0, cap - exposure). */
  availableMicroUsd: MicroUsd;
  /** max(0, exposure - cap): how far a lowered cap sits below what is already out. */
  overCapMicroUsd: MicroUsd;
  counts: Record<ReservationState, number>;
}

/** Every refusal this module makes. `status` is the HTTP status a route should answer with. */
export class SpendExposureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SpendExposureError';
  }
}

// --- validation ---------------------------------------------------------------

const refuse = (code: string, message: string, status = 400) =>
  new SpendExposureError(code, message, status);

/** A connection id names a file, so it is held to a pattern that cannot leave its folder. */
const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * Windows device names. They pass the pattern, but on Windows `nul.json` can
 * name the null device rather than a file, and a cap written there would be
 * lost without an error.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const RESERVATION_ID = /^exp-[0-9a-f]{40}$/;
/** Lower case only, so one request cannot have two spellings and two identities. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LABEL_MAX = 200;
const NOTE_MAX = 2000;
const STATES: readonly ReservationState[] = Object.freeze([
  'pending',
  'settled',
  'released',
  'uncertain',
  'written-off',
]);
const RECONCILED_FROM: readonly string[] = Object.freeze(['response', 'owner-entry', 'write-off']);
const USAGE_KEYS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
] as const;
const RATE_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;
const TOKENS_PER_RATE = 1_000_000n;
const SWEEP_REASON = 'The process stopped while this call may have been in flight.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isMoney = (value: unknown): value is MicroUsd =>
  isCount(value) && value <= MAX_MONEY_MICRO_USD;
const isLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= LABEL_MAX;
const isTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

function connectionIdOf(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTION_ID.test(value) || WINDOWS_DEVICE.test(value))
    throw refuse(
      'invalid_connection',
      'A connection id is 1 to 64 lower-case letters, digits and hyphens, starting with a letter or digit. It names a file, so nothing else is accepted.',
    );
  return value;
}

/** Free text a person wrote: a reason, a note, a name. Blank is refused unless `optional`. */
function textOf(value: unknown, what: string, max: number, optional = false): string {
  if (typeof value !== 'string' || value.length > max || (!optional && value.trim() === ''))
    throw refuse(
      'invalid_input',
      `${what} must be ${optional ? '' : 'non-empty '}text of at most ${max} characters.`,
    );
  return value;
}

/** An amount of money through `micro()`, refused under this module's own code. */
function moneyOf(value: unknown, code: string, what: string): MicroUsd {
  try {
    return micro(value as number);
  } catch (error) {
    throw refuse(code, `${what} ${error instanceof Error ? error.message : 'is not an amount.'}`);
  }
}

/** A computed amount, refused rather than wrapped when it is too large to represent. */
function moneyFrom(amount: bigint, code: string, what: string): MicroUsd {
  if (amount > BigInt(MAX_MONEY_MICRO_USD))
    throw refuse(
      code,
      `${what} comes to more than ${formatMoney(micro(MAX_MONEY_MICRO_USD))}, which this ledger does not represent.`,
    );
  return micro(Number(amount));
}

/** Integer division rounded up, for amounts that are never negative. */
const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;

function attemptProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'there is no attempt.';
  for (const key of ['runId', 'stepId'] as const)
    if (!isLabel(value[key]))
      return `${key} must be non-empty text of at most ${LABEL_MAX} characters.`;
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1)
    return 'attempt must be a whole number, 1 or more.';
  if (typeof value.requestDigest !== 'string' || !SHA256_HEX.test(value.requestDigest))
    return 'requestDigest must be the sha256 of the request, as 64 lower-case hex characters.';
  return null;
}

/** Only the four identity fields: an extra key must never change which attempt this is. */
const pickAttempt = (attempt: ExposureAttempt): ExposureAttempt => ({
  runId: attempt.runId,
  stepId: attempt.stepId,
  attempt: attempt.attempt,
  requestDigest: attempt.requestDigest,
});

function attemptOf(value: unknown): ExposureAttempt {
  const problem = attemptProblem(value);
  if (problem) throw refuse('invalid_attempt', `That attempt cannot be recorded: ${problem}`);
  return pickAttempt(value as ExposureAttempt);
}

/** Validate before calling: `digest` accepts only plain JSON values. */
const reservationIdFor = (connectionId: string, attempt: ExposureAttempt): string =>
  `exp-${digest({ connectionId, attempt: pickAttempt(attempt) }).slice(0, 40)}`;

function usageProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'there is no usage record.';
  for (const key of USAGE_KEYS)
    if (!isCount(value[key])) return `${key} must be a whole number of tokens, zero or more.`;
  const usage = value as unknown as ProviderUsage;
  if (BigInt(usage.cacheReadTokens) + BigInt(usage.cacheWriteTokens) > BigInt(usage.inputTokens))
    return 'cache reads and cache writes are part of the input, so together they cannot exceed it.';
  if (usage.reasoningTokens > usage.outputTokens)
    return 'reasoning is part of the output, so it cannot exceed it.';
  return null;
}

const pickUsage = (usage: ProviderUsage): ProviderUsage => ({
  inputTokens: usage.inputTokens,
  cacheReadTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  outputTokens: usage.outputTokens,
  reasoningTokens: usage.reasoningTokens,
});

// --- pricing ------------------------------------------------------------------

/**
 * A rate card this module can price with, or a refusal. Every rate is a whole
 * number of micro-USD per million tokens, zero or more, and the short-band
 * boundary is a positive whole number of tokens. Returns a fresh copy holding
 * only the known fields.
 */
export function validateRateCard(card: ModelRateCard): ModelRateCard {
  const bad = (why: string) => refuse('invalid_rate_card', `That rate card cannot be used: ${why}`);
  if (!isRecord(card)) throw bad('it is not a rate card.');
  const label = (value: unknown, what: string, max: number): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > max)
      throw bad(`its ${what} must be non-empty text of at most ${max} characters.`);
    return value;
  };
  const band = (value: unknown, what: string): ModelRateBand => {
    if (!isRecord(value)) throw bad(`it has no ${what} band.`);
    for (const key of RATE_KEYS)
      if (!isCount(value[key]))
        throw bad(
          `its ${what} ${key} rate must be a whole number of micro-USD per million tokens, zero or more.`,
        );
    const rates = value as unknown as ModelRateBand;
    return {
      input: rates.input,
      cacheWrite: rates.cacheWrite,
      cacheRead: rates.cacheRead,
      output: rates.output,
    };
  };
  const boundary = (card as unknown as Record<string, unknown>).shortContextMaxInputTokens;
  if (!Number.isSafeInteger(boundary) || (boundary as number) <= 0)
    throw bad('its short-context boundary must be a positive whole number of tokens.');
  return {
    version: label(card.version, 'version', LABEL_MAX),
    route: label(card.route, 'route', LABEL_MAX),
    modelId: label(card.modelId, 'model id', LABEL_MAX),
    source: label(card.source, 'source', NOTE_MAX),
    shortContextMaxInputTokens: boundary as number,
    short: band(card.short, 'short'),
    long: band(card.long, 'long'),
  };
}

/** Price usage under a card that has already been validated. */
function price(
  card: ModelRateCard,
  value: unknown,
): { microUsd: MicroUsd; band: 'short' | 'long'; usage: ProviderUsage } {
  const problem = usageProblem(value);
  if (problem) throw refuse('invalid_usage', `That usage cannot be priced: ${problem}`);
  const usage = pickUsage(value as ProviderUsage);
  const band = usage.inputTokens <= card.shortContextMaxInputTokens ? 'short' : 'long';
  const rates = card[band];
  const noCache = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const total =
    BigInt(noCache) * BigInt(rates.input) +
    BigInt(usage.cacheReadTokens) * BigInt(rates.cacheRead) +
    BigInt(usage.cacheWriteTokens) * BigInt(rates.cacheWrite) +
    BigInt(usage.outputTokens) * BigInt(rates.output);
  return {
    microUsd: moneyFrom(ceilDiv(total, TOKENS_PER_RATE), 'invalid_usage', 'That usage'),
    band,
    usage,
  };
}

/**
 * What one call cost at list price. Every term is summed in exact integer
 * arithmetic and rounded up once at the end: rounding each term separately
 * would overstate a many-term call, and rounding down would understate it.
 * Usage whose parts do not add up is refused (`invalid_usage`) rather than
 * repaired, because any repair would be a guess about money.
 */
export function usageCost(
  card: ModelRateCard,
  usage: ProviderUsage,
): { microUsd: MicroUsd; band: 'short' | 'long' } {
  const { microUsd, band } = price(validateRateCard(card), usage);
  return { microUsd, band };
}

/**
 * The most a call inside `bound` can cost: every input token at the dearest
 * input rate (plain, cache write or cache read) and every output token at the
 * output rate, rounded up.
 *
 * A bound that stays inside the short band can only produce short-band usage,
 * so it is priced at short rates. A bound past the boundary can produce usage
 * in either band, so it takes the dearer of the two bands for each rate. With
 * a card whose long band costs at least as much as its short band, which is
 * how long-context pricing works, that is exactly the long band; the extra
 * step keeps the ceiling honest even for a card where it does not.
 */
export function ceilingCost(
  card: ModelRateCard,
  bound: { maxInputTokens: number; maxOutputTokens: number },
): MicroUsd {
  const valid = validateRateCard(card);
  if (!isRecord(bound) || !isCount(bound.maxInputTokens) || !isCount(bound.maxOutputTokens))
    throw refuse(
      'invalid_bound',
      'A call bound is a whole number of input tokens and of output tokens, zero or more.',
    );
  const bands =
    bound.maxInputTokens > valid.shortContextMaxInputTokens
      ? [valid.short, valid.long]
      : [valid.short];
  const inputRate = Math.max(
    ...bands.flatMap((rates) => [rates.input, rates.cacheWrite, rates.cacheRead]),
  );
  const outputRate = Math.max(...bands.map((rates) => rates.output));
  const total =
    BigInt(bound.maxInputTokens) * BigInt(inputRate) +
    BigInt(bound.maxOutputTokens) * BigInt(outputRate);
  return moneyFrom(ceilDiv(total, TOKENS_PER_RATE), 'invalid_bound', 'That bound');
}

// --- stored records -----------------------------------------------------------

/** One connection's file, exactly as written. */
interface StoredExposure {
  v: 1;
  allowance: ExposureAllowance | null;
  reservations: ExposureReservation[];
}

const emptyStored = (): StoredExposure => ({ v: 1, allowance: null, reservations: [] });

function freezeReservation(reservation: ExposureReservation): ExposureReservation {
  Object.freeze(reservation.attempt);
  if (reservation.usage) Object.freeze(reservation.usage);
  return Object.freeze(reservation);
}

function freezeStored(stored: StoredExposure): StoredExposure {
  if (stored.allowance) Object.freeze(stored.allowance);
  stored.reservations.forEach(freezeReservation);
  Object.freeze(stored.reservations);
  return Object.freeze(stored);
}

const corrupt = (name: string, why: string) =>
  refuse(
    'corrupt_ledger',
    `The spend exposure file ${name} cannot be trusted, so nothing was loaded: ${why}`,
    500,
  );

function readAllowance(
  value: unknown,
  connectionId: string,
  bad: (why: string) => SpendExposureError,
): ExposureAllowance {
  if (!isRecord(value)) throw bad('its cap is not a record.');
  if (value.connectionId !== connectionId) throw bad('its cap belongs to another connection.');
  if (!isMoney(value.capMicroUsd)) throw bad('its cap is not a whole number of micro-USD.');
  if (
    !isTime(value.approvedAt) ||
    typeof value.approvedBy !== 'string' ||
    typeof value.note !== 'string'
  )
    throw bad('its cap has no readable approval.');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
    throw bad('its cap has no revision.');
  return {
    connectionId,
    capMicroUsd: value.capMicroUsd,
    approvedAt: value.approvedAt,
    approvedBy: value.approvedBy,
    note: value.note,
    revision: value.revision as number,
  };
}

function readReservation(
  value: unknown,
  connectionId: string,
  bad: (why: string) => SpendExposureError,
): ExposureReservation {
  if (!isRecord(value)) throw bad('is not a record.');
  const attemptIssue = attemptProblem(value.attempt);
  if (attemptIssue) throw bad(`has an attempt that cannot be read: ${attemptIssue}`);
  const attempt = pickAttempt(value.attempt as ExposureAttempt);
  if (value.connectionId !== connectionId) throw bad('belongs to another connection.');
  if (value.id !== reservationIdFor(connectionId, attempt))
    throw bad('has an id that does not match its attempt.');
  for (const key of ['route', 'modelId', 'rateCardVersion'] as const)
    if (!isLabel(value[key])) throw bad(`has no ${key}.`);
  if (!isMoney(value.maxMicroUsd) || value.maxMicroUsd <= 0) throw bad('has no usable ceiling.');
  if (!STATES.includes(value.state as ReservationState)) throw bad('is in no known state.');
  if (!isTime(value.createdAt)) throw bad('has no readable creation time.');
  for (const key of ['resolvedAt', 'uncertainAt'] as const)
    if (value[key] !== null && !isTime(value[key])) throw bad(`has an unreadable ${key}.`);
  for (const key of ['uncertainReason', 'providerRequestId', 'note'] as const)
    if (value[key] !== null && typeof value[key] !== 'string')
      throw bad(`has an unreadable ${key}.`);
  if (value.settledMicroUsd !== null && !isMoney(value.settledMicroUsd))
    throw bad('has a settled amount that is not a whole number of micro-USD.');
  if (value.usage !== null && usageProblem(value.usage))
    throw bad('has usage that does not add up.');
  if (value.band !== null && value.band !== 'short' && value.band !== 'long')
    throw bad('has an unknown band.');
  if (typeof value.overCeiling !== 'boolean')
    throw bad('does not say whether it went over its ceiling.');
  if (value.reconciledFrom !== null && !RECONCILED_FROM.includes(value.reconciledFrom as string))
    throw bad('has an unknown reconciliation source.');
  // The two facts the numbers depend on: a settled hold counts its amount, and
  // an uncertain one records when it became so. Reading either as absent would
  // count a real call as free.
  if (value.state === 'settled' && value.settledMicroUsd === null)
    throw bad('is settled with no amount.');
  if ((value.state === 'uncertain' || value.state === 'written-off') && value.uncertainAt === null)
    throw bad('is uncertain with no record of when it became so.');
  return {
    id: value.id as string,
    connectionId,
    route: value.route as string,
    modelId: value.modelId as string,
    rateCardVersion: value.rateCardVersion as string,
    attempt,
    maxMicroUsd: value.maxMicroUsd,
    state: value.state as ReservationState,
    createdAt: value.createdAt,
    resolvedAt: value.resolvedAt as string | null,
    uncertainAt: value.uncertainAt as string | null,
    uncertainReason: value.uncertainReason as string | null,
    settledMicroUsd: value.settledMicroUsd as MicroUsd | null,
    usage: value.usage === null ? null : pickUsage(value.usage as ProviderUsage),
    band: value.band as 'short' | 'long' | null,
    overCeiling: value.overCeiling,
    providerRequestId: value.providerRequestId as string | null,
    reconciledFrom: value.reconciledFrom as ExposureReservation['reconciledFrom'],
    note: value.note as string | null,
  };
}

/**
 * One file, checked field by field. A file from another version, one filed
 * under the wrong name, or one whose rows do not add up is refused whole:
 * reading part of a money record, or guessing at the rest, is how exposure
 * would quietly reset.
 */
function readStored(raw: unknown, connectionId: string, name: string): StoredExposure {
  const bad = (why: string) => corrupt(name, why);
  if (!isRecord(raw) || raw.v !== 1) throw bad('it was not written by this version of the ledger.');
  if (!('allowance' in raw) || !Array.isArray(raw.reservations))
    throw bad('it is missing its cap or its reservations.');
  const allowance = raw.allowance === null ? null : readAllowance(raw.allowance, connectionId, bad);
  const seen = new Set<string>();
  const reservations = raw.reservations.map((row: unknown, index: number) => {
    const reservation = readReservation(row, connectionId, (why) =>
      bad(`reservation ${index + 1} ${why}`),
    );
    if (seen.has(reservation.id)) throw bad(`reservation ${reservation.id} appears twice.`);
    seen.add(reservation.id);
    return reservation;
  });
  if (!allowance && reservations.length > 0)
    throw bad('it records reservations with no approved cap.');
  return freezeStored({ v: 1, allowance, reservations });
}

function summarize(connectionId: string, stored: StoredExposure): ExposureSummary {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<
    ReservationState,
    number
  >;
  for (const reservation of stored.reservations) counts[reservation.state] += 1;
  const ceilings = (state: ReservationState) =>
    sumMoney(
      stored.reservations
        .filter((reservation) => reservation.state === state)
        .map((reservation) => reservation.maxMicroUsd),
    );
  const settled = sumMoney(
    stored.reservations
      .filter((reservation) => reservation.state === 'settled')
      .map((reservation) => {
        // Unreachable through this module, and refused on load; counting a
        // missing amount as zero would be the silent free call this prevents.
        if (reservation.settledMicroUsd === null)
          throw corrupt(
            `${connectionId}.json`,
            `reservation ${reservation.id} is settled with no amount.`,
          );
        return reservation.settledMicroUsd;
      }),
  );
  const pending = ceilings('pending');
  const uncertain = ceilings('uncertain');
  const writtenOff = ceilings('written-off');
  const exposure = sumMoney([settled, pending, uncertain, writtenOff]);
  const cap = stored.allowance?.capMicroUsd ?? micro(0);
  return {
    connectionId,
    capMicroUsd: cap,
    settledMicroUsd: settled,
    pendingMicroUsd: pending,
    uncertainMicroUsd: uncertain,
    writtenOffMicroUsd: writtenOff,
    exposureMicroUsd: exposure,
    availableMicroUsd: micro(Math.max(0, cap - exposure)),
    overCapMicroUsd: micro(Math.max(0, exposure - cap)),
    counts,
  };
}

/**
 * Move a hold through the contract's state table. The table's own wording is
 * the refusal: it already explains, for example, why an uncertain hold cannot
 * be released.
 */
function transition(reservation: ExposureReservation, event: ReservationEvent): ReservationState {
  try {
    return reservationTransition(reservation.state, event);
  } catch (error) {
    throw refuse(
      'illegal_transition',
      error instanceof Error
        ? error.message
        : `A ${reservation.state} hold cannot be changed that way.`,
      409,
    );
  }
}

interface Located {
  connectionId: string;
  stored: StoredExposure;
  reservation: ExposureReservation;
}

// --- the ledger ---------------------------------------------------------------

export class SpendExposure {
  private readonly clock: () => Date;
  private files = new Map<string, StoredExposure>();
  private ready = false;
  private loading: Promise<void> | null = null;
  /** The one queue every change waits in. It never rejects, so one failure cannot jam it. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    options: { clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  private get root() {
    return path.join(this.dataDir, 'spend-exposure');
  }

  private filePath(connectionId: string) {
    return path.join(this.root, `${connectionId}.json`);
  }

  /**
   * Load every connection's file, then mark each hold that was in flight when
   * the process stopped as `uncertain` and write that down before anything
   * else can run. A missing folder is a fresh install. Calling this again
   * returns the first load rather than repeating the sweep, which would turn
   * this process's own live calls into uncertain ones.
   */
  init(): Promise<void> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const loaded = new Map<string, StoredExposure>();
    const entries = (await this.entries())
      .filter((entry) => entry.name.endsWith('.json'))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const connectionId = entry.name.slice(0, -'.json'.length);
      if (!entry.isFile || !CONNECTION_ID.test(connectionId) || WINDOWS_DEVICE.test(connectionId))
        throw corrupt(entry.name, 'it is not named for a connection.');
      let raw: unknown;
      try {
        raw = await readJson<unknown>(path.join(this.root, entry.name), () => {
          throw corrupt(entry.name, 'it disappeared while it was being read.');
        });
      } catch (error) {
        if (error instanceof SyntaxError) throw corrupt(entry.name, 'it is not valid JSON.');
        throw error;
      }
      loaded.set(connectionId, readStored(raw, connectionId, entry.name));
    }
    let at: string | null = null;
    for (const [connectionId, stored] of loaded) {
      if (!stored.reservations.some((reservation) => reservation.state === 'pending')) continue;
      at ??= this.stamp();
      const sweptAt = at;
      const next: StoredExposure = {
        v: 1,
        allowance: stored.allowance,
        reservations: stored.reservations.map((reservation) =>
          reservation.state === 'pending'
            ? {
                ...reservation,
                state: transition(reservation, 'lose'),
                uncertainAt: sweptAt,
                uncertainReason: SWEEP_REASON,
              }
            : reservation,
        ),
      };
      await this.save(connectionId, next);
      loaded.set(connectionId, next);
    }
    this.files = loaded;
    this.ready = true;
  }

  private async entries(): Promise<{ name: string; isFile: boolean }[]> {
    try {
      const found = await fs.readdir(this.root, { withFileTypes: true });
      return found.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
  }

  private assertReady() {
    if (!this.ready)
      throw refuse(
        'not_initialized',
        'The spend exposure ledger has not been loaded yet. Call init() first.',
        500,
      );
  }

  private stamp(): string {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
      throw refuse(
        'invalid_clock',
        'The ledger clock did not give a readable time, so nothing was recorded.',
        500,
      );
    return now.toISOString();
  }

  /** Run one change after every change queued before it. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Write a connection's next file. Memory is not touched here. */
  private async save(connectionId: string, next: StoredExposure): Promise<void> {
    freezeStored(next);
    try {
      await jsonWrite(this.filePath(connectionId), next);
    } catch (error) {
      const failure = refuse(
        'persist_failed',
        `The spend exposure record could not be saved, so nothing changed. ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
      failure.cause = error;
      throw failure;
    }
  }

  /** Write, then swap: memory changes only once the file on disk says the same. */
  private async commit(connectionId: string, next: StoredExposure): Promise<void> {
    await this.save(connectionId, next);
    this.files.set(connectionId, next);
  }

  private locate(id: unknown): Located | null {
    if (typeof id !== 'string' || !RESERVATION_ID.test(id)) return null;
    for (const [connectionId, stored] of this.files) {
      const reservation = stored.reservations.find((item) => item.id === id);
      if (reservation) return { connectionId, stored, reservation };
    }
    return null;
  }

  private located(id: string): Located {
    const found = this.locate(id);
    if (!found)
      throw refuse('unknown_reservation', 'No hold with that id exists in this ledger.', 404);
    return found;
  }

  private async replace(found: Located, next: ExposureReservation): Promise<ExposureReservation> {
    await this.commit(found.connectionId, {
      v: 1,
      allowance: found.stored.allowance,
      reservations: found.stored.reservations.map((item) => (item.id === next.id ? next : item)),
    });
    return structuredClone(next);
  }

  /**
   * Approve a cap, or replace the approved one with the next revision. A cap
   * may be lowered below what is already out; nothing new then fits, and
   * nothing already recorded is removed.
   */
  async setCap(
    connectionId: string,
    capMicroUsd: MicroUsd,
    meta: { approvedBy: string; note: string },
  ): Promise<ExposureAllowance> {
    this.assertReady();
    return this.exclusive(async () => {
      const id = connectionIdOf(connectionId);
      const cap = moneyOf(capMicroUsd, 'invalid_cap', 'That cap cannot be approved.');
      const approvedBy = textOf(meta?.approvedBy, 'Who approved the cap', LABEL_MAX);
      const note = textOf(meta?.note, 'The approval note', NOTE_MAX, true);
      const current = this.files.get(id) ?? emptyStored();
      const allowance: ExposureAllowance = {
        connectionId: id,
        capMicroUsd: cap,
        approvedAt: this.stamp(),
        approvedBy,
        note,
        revision: (current.allowance?.revision ?? 0) + 1,
      };
      await this.commit(id, { v: 1, allowance, reservations: current.reservations });
      return structuredClone(allowance);
    });
  }

  /** The approved cap, or null when none was ever approved. */
  allowance(connectionId: string): ExposureAllowance | null {
    this.assertReady();
    const allowance = this.files.get(connectionIdOf(connectionId))?.allowance ?? null;
    return allowance ? structuredClone(allowance) : null;
  }

  /**
   * The numbers a person sees. A connection with no approved cap reads as a
   * zero cap, which admits nothing; `allowance()` returning null is how a
   * caller tells "never approved" from "approved at zero".
   */
  summary(connectionId: string): ExposureSummary {
    this.assertReady();
    const id = connectionIdOf(connectionId);
    return summarize(id, this.files.get(id) ?? emptyStored());
  }

  /** Every hold this connection ever made, oldest first. */
  list(connectionId: string): ExposureReservation[] {
    this.assertReady();
    const stored = this.files.get(connectionIdOf(connectionId));
    return (stored?.reservations ?? []).map((reservation) => structuredClone(reservation));
  }

  get(id: string): ExposureReservation | null {
    this.assertReady();
    const found = this.locate(id);
    return found ? structuredClone(found.reservation) : null;
  }

  /**
   * Hold `maxMicroUsd` before a call is sent. The hold is on disk before this
   * resolves, so a call dispatched after it can never be forgotten by a
   * restart. The same attempt is refused in any state, including after it
   * settled: sending it again would spend twice under one record.
   */
  async reserve(input: {
    connectionId: string;
    route: string;
    modelId: string;
    card: ModelRateCard;
    attempt: ExposureAttempt;
    maxMicroUsd: MicroUsd;
  }): Promise<ExposureReservation> {
    this.assertReady();
    return this.exclusive(async () => {
      const connectionId = connectionIdOf(input?.connectionId);
      const card = validateRateCard(input.card);
      if (input.route !== card.route || input.modelId !== card.modelId)
        throw refuse(
          'invalid_rate_card',
          `That rate card prices ${card.modelId} on ${card.route}, not the call being reserved.`,
        );
      const attempt = attemptOf(input.attempt);
      const maxMicroUsd = moneyOf(
        input.maxMicroUsd,
        'invalid_ceiling',
        'That ceiling cannot be held.',
      );
      if (maxMicroUsd <= 0)
        throw refuse(
          'invalid_ceiling',
          'A hold must be more than zero. A paid call with no ceiling is exactly what this ledger exists to refuse.',
        );
      const id = reservationIdFor(connectionId, attempt);
      if (this.locate(id))
        throw refuse(
          'attempt_exists',
          'This attempt already has a hold, so it is not sent again. A retry is a new attempt with the next number.',
          409,
        );
      const current = this.files.get(connectionId);
      if (!current?.allowance)
        throw refuse(
          'no_allowance',
          'No spending cap has been approved for this connection, so no paid call can be sent on it.',
          402,
        );
      const available = summarize(connectionId, current).availableMicroUsd;
      if (maxMicroUsd > available)
        throw refuse(
          'insufficient_exposure',
          `This call needs a ${formatMoney(maxMicroUsd)} hold, and only ${formatMoney(available)} of the approved cap is available. Settle or resolve calls already out, or ask the owner to raise the cap.`,
          402,
        );
      const reservation: ExposureReservation = {
        id,
        connectionId,
        route: card.route,
        modelId: card.modelId,
        rateCardVersion: card.version,
        attempt,
        maxMicroUsd,
        state: 'pending',
        createdAt: this.stamp(),
        resolvedAt: null,
        uncertainAt: null,
        uncertainReason: null,
        settledMicroUsd: null,
        usage: null,
        band: null,
        overCeiling: false,
        providerRequestId: null,
        reconciledFrom: null,
        note: null,
      };
      await this.commit(connectionId, {
        v: 1,
        allowance: current.allowance,
        reservations: [...current.reservations, reservation],
      });
      return structuredClone(reservation);
    });
  }

  /**
   * Record what a completed call cost from the usage the provider reported.
   * A cost above the hold still settles at the real figure, flagged
   * `overCeiling`: the list-price cost is the truth, and hiding it would be
   * worse than exceeding the ceiling. Usage that does not add up is refused
   * and the hold stays pending; the caller then marks it uncertain.
   */
  async settle(
    id: string,
    input: { usage: ProviderUsage; card: ModelRateCard; providerRequestId: string | null },
  ): Promise<ExposureReservation> {
    this.assertReady();
    return this.exclusive(async () => {
      const card = validateRateCard(input?.card);
      const priced = price(card, input.usage);
      const providerRequestId =
        input.providerRequestId === null
          ? null
          : textOf(input.providerRequestId, 'The provider request id', LABEL_MAX);
      const found = this.located(id);
      const state = transition(found.reservation, 'settle');
      if (card.version !== found.reservation.rateCardVersion)
        throw refuse(
          'rate_card_changed',
          `This call was reserved under rate card ${found.reservation.rateCardVersion}, not ${card.version}. It is priced under the terms it was reserved under.`,
          409,
        );
      if (card.route !== found.reservation.route || card.modelId !== found.reservation.modelId)
        throw refuse(
          'invalid_rate_card',
          `That rate card prices ${card.modelId} on ${card.route}, not the call being settled.`,
        );
      return this.replace(found, {
        ...found.reservation,
        state,
        resolvedAt: this.stamp(),
        settledMicroUsd: priced.microUsd,
        usage: priced.usage,
        band: priced.band,
        overCeiling: priced.microUsd > found.reservation.maxMicroUsd,
        providerRequestId,
        reconciledFrom: 'response',
      });
    });
  }

  /**
   * Return a hold for a call that was provably never sent. Only a pending hold
   * can be released; once a call may have reached the provider its hold is
   * uncertain, and an uncertain hold is never released.
   */
  async release(id: string, reason: string): Promise<ExposureReservation> {
    this.assertReady();
    return this.exclusive(async () => {
      const note = textOf(reason, 'The reason for releasing a hold', NOTE_MAX);
      const found = this.located(id);
      const state = transition(found.reservation, 'release');
      return this.replace(found, { ...found.reservation, state, resolvedAt: this.stamp(), note });
    });
  }

  /** Park a hold whose outcome or usage is unknown. Its ceiling keeps counting. */
  async markUncertain(id: string, reason: string): Promise<ExposureReservation> {
    this.assertReady();
    return this.exclusive(async () => {
      const uncertainReason = textOf(reason, 'The reason a call is uncertain', NOTE_MAX);
      const found = this.located(id);
      const state = transition(found.reservation, 'lose');
      return this.replace(found, {
        ...found.reservation,
        state,
        uncertainAt: this.stamp(),
        uncertainReason,
      });
    });
  }

  /**
   * Settle an uncertain hold at the amount the owner found, for example on the
   * provider's bill. The owner's figure is the record, even above the ceiling.
   */
  async reconcile(
    id: string,
    input: { microUsd: MicroUsd; note: string },
  ): Promise<ExposureReservation> {
    this.assertReady();
    return this.exclusive(async () => {
      const settledMicroUsd = moneyOf(
        input?.microUsd,
        'invalid_amount',
        'That amount cannot be recorded.',
      );
      const note = textOf(input.note, 'The reconciliation note', NOTE_MAX);
      const found = this.located(id);
      const state = transition(found.reservation, 'reconcile');
      return this.replace(found, {
        ...found.reservation,
        state,
        resolvedAt: this.stamp(),
        settledMicroUsd,
        overCeiling: settledMicroUsd > found.reservation.maxMicroUsd,
        reconciledFrom: 'owner-entry',
        note,
      });
    });
  }

  /**
   * Close an uncertain hold nobody can price. Its ceiling keeps counting in
   * exposure: giving up on knowing the cost is not evidence the call was free.
   */
  async writeOff(id: string, input: { note: string }): Promise<ExposureReservation> {
    this.assertReady();
    return this.exclusive(async () => {
      const note = textOf(input?.note, 'The write-off note', NOTE_MAX);
      const found = this.located(id);
      const state = transition(found.reservation, 'write-off');
      return this.replace(found, {
        ...found.reservation,
        state,
        resolvedAt: this.stamp(),
        reconciledFrom: 'write-off',
        note,
      });
    });
  }
}
