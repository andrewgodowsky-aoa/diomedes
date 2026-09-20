import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { killOwnedProcess } from '../integrations.js';
import type { SetupStage } from '../../shared/engines.js';

export class EngineError extends Error {
  readonly status = 503;
  /**
   * Where in the connection attempt this failed, when the thrower knows. A 401
   * from the owned loopback server and a 401 from the upstream account carry the
   * same code and different stages, and only the stage picks the right recovery.
   */
  stage?: SetupStage;
  constructor(
    readonly code: string,
    message: string,
    readonly ambiguous = false,
    stage?: SetupStage,
  ) {
    super(message);
    this.name = 'EngineError';
    if (stage) this.stage = stage;
  }
}
/** Tag a failure with the stage it crossed, keeping the innermost stage already set. */
export function atStage<T>(error: T, stage: SetupStage): T {
  if (error instanceof EngineError && !error.stage) error.stage = stage;
  return error;
}
/** A tool that never started reports that from whichever read first notices. */
const STARTUP_CODES = ['LAUNCH_FAILED', 'PROCESS_EXITED', 'TIMEOUT'];
/**
 * The stage an untagged failure belongs to. The child fails asynchronously, so
 * these codes name where they happened wherever they surface; a cleanup fault
 * carries the failure it is reported with, or stands alone.
 */
export function staged<T>(error: T, phase: SetupStage, primary?: unknown): T {
  if (!(error instanceof EngineError) || error.stage) return error;
  if (primary instanceof EngineError && primary.stage) return atStage(error, primary.stage);
  if (error.code === 'CLEANUP_FAILED') return atStage(error, 'cleanup');
  if (error.code === 'AUTH_REQUIRED') return atStage(error, 'provider-auth');
  const starting = phase === 'launch' || phase === 'local-handshake';
  return atStage(error, starting && STARTUP_CODES.includes(error.code) ? 'launch' : phase);
}
export const stopped = () =>
  new EngineError(
    'CANCELLED',
    'The request was stopped. A dispatched request may still consume usage.',
    true,
  );
/**
 * Whether an abort came from a deadline the host imposed rather than from a
 * person pressing stop. `AbortSignal.timeout()` aborts with a `TimeoutError`
 * DOMException and `AbortSignal.any()` carries the reason of whichever signal
 * fired first, which is exactly how a consented connection test receives its
 * budget (`server/engines/service.ts`, `AbortSignal.any([AbortSignal.timeout
 * (TEST_TIMEOUT_MS), caller])`). Every other reason — a bare `abort()`, which
 * carries an `AbortError`, or a string a caller chose — is the person.
 */
export function abortedByDeadline(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { name?: unknown }).name === 'TimeoutError'
  );
}
/**
 * The failure an external abort deserves, shared so every route answers the
 * same way. A host deadline is a TIMEOUT carrying the caller's own timeout
 * sentence; anything else stays the person's own cancellation. Neither moves
 * the `ambiguous` truth — after dispatch a request may still consume usage —
 * and neither changes what is delivered to the child: the abort still is.
 */
export function abortFailure(reason: unknown, timeoutDetail: string): EngineError {
  return abortedByDeadline(reason)
    ? new EngineError('TIMEOUT', timeoutDetail, true)
    : stopped();
}
/** The sentence an owned process uses whenever a time limit, not a person, ended it. */
export const PROCESS_TIMEOUT_DETAIL =
  'The tool did not finish within the time limit. Recheck before starting another request.';

// --- what a failure payload says it is ---------------------------------------------------------
//
// A refusal is read from the fields a payload actually uses to say what went
// wrong, never from the payload serialised and searched for a word. Serialising
// let an elapsed time of 403, a token count, a line number or a stack trace
// decide what a person was told, and `auth` inside `authority` sent someone with
// an enterprise certificate problem to sign in again.

/** Keys whose value is a machine-readable identity for the failure. */
const IDENTITY_KEYS = new Set(['name', 'code', 'type', 'kind', 'subtype', 'errortype', 'errorcode']);
/** Keys whose value is an HTTP status. */
const STATUS_KEYS = new Set(['status', 'statuscode', 'httpstatus']);
/** Keys whose value is free text somebody wrote for a person to read. */
const TEXT_KEYS = new Set(['message', 'detail', 'description', 'errormessage', 'error', 'reason']);
/** An identity compared without punctuation: `ProviderAuthError` and `provider_auth_error` are one word. */
const asIdentity = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** What a failure payload said about itself, gathered from its named fields only. */
export interface FailureFacts {
  /** Machine-readable identities, punctuation removed. */
  identities: string[];
  /** HTTP statuses the payload named as such. */
  statuses: number[];
  /** Free text, matched only with whole words. */
  texts: string[];
}

/**
 * Read a payload's named fields, to a bounded depth and node count so a hostile
 * or merely enormous payload cannot cost more than a glance. A bare string —
 * `errors: ['rate_limit_error']`, `error: 'unauthorized'` — counts as both an
 * identity and text, because tools use it as both.
 */
export function failureFacts(value: unknown): FailureFacts {
  const facts: FailureFacts = { identities: [], statuses: [], texts: [] };
  let budget = 96;
  const bare = (item: string) => {
    facts.identities.push(asIdentity(item));
    facts.texts.push(item.slice(0, 512));
  };
  const visit = (node: unknown, depth: number) => {
    if (budget <= 0 || depth > 4) return;
    if (typeof node === 'string') return bare(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 16)) {
        if (budget-- <= 0) return;
        if (typeof item === 'string') bare(item);
        else visit(item, depth + 1);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [rawKey, item] of Object.entries(node as Record<string, unknown>)) {
      if (budget-- <= 0) return;
      const key = rawKey.toLowerCase();
      if (typeof item === 'number') {
        if (STATUS_KEYS.has(key)) facts.statuses.push(item);
      } else if (typeof item === 'string') {
        if (STATUS_KEYS.has(key) && /^\d{3}$/.test(item)) facts.statuses.push(Number(item));
        if (IDENTITY_KEYS.has(key) || key === 'error') facts.identities.push(asIdentity(item));
        if (TEXT_KEYS.has(key)) facts.texts.push(item.slice(0, 512));
      } else visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return facts;
}

/** An identity that denotes the account refusing the work. Never matched against free text. */
const DENIAL_IDENTITY =
  /unauthori[sz]ed|unauthenticated|notauthenticated|forbidden|autherror|authrequired|authfailed|authenticat|invalidapikey|missingapikey|invalidcredential|missingcredential|permissiondenied|loginrequired|signinrequired/;
/** Free text that plainly says the account would not authorise the work. */
const DENIAL_TEXT =
  /\bunauthori[sz]ed\b|\bunauthenticated\b|\bforbidden\b|\bauthenticat(e|es|ed|ing|ion)\b|\b(sign|log)[- ]?in (is )?required\b|\bapi key\b|\binvalid credentials?\b|\bpermission denied\b/i;
/** An identity that denotes a service or allowance limit. */
const LIMIT_IDENTITY = /ratelimit|usagelimit|quota|toomanyrequests|overloaded|insufficient/;
/** Free text that plainly says a limit, not merely a word that appears near one. */
const LIMIT_TEXT =
  /\brate.?limit(ed|s|ing)?\b|\bquota (exceeded|reached|limit)\b|\busage limit\b|\btoo many requests\b|\boverloaded\b|\bout of (credits?|quota)\b|\binsufficient (quota|credit|balance|funds)\b/i;

/** Denied by the account, limited by the service, or neither — never a guess. */
export type FailureKind = 'denied' | 'limited' | 'unknown';

/**
 * What a failure says it is. A status the payload named, or the caller already
 * holds, is the strongest evidence; then an identity; then whole words in text
 * a person wrote. A payload that says neither is `unknown`, which every adapter
 * reports as its own plain provider fault rather than a guessed instruction.
 */
export function failureKind(value: unknown, status?: number): FailureKind {
  const facts = failureFacts(value);
  const statuses = status === undefined ? facts.statuses : [status, ...facts.statuses];
  if (statuses.some((code) => code === 401 || code === 403)) return 'denied';
  if (statuses.some((code) => code === 429)) return 'limited';
  const hit = (identity: RegExp, free: RegExp) =>
    facts.identities.some((value) => identity.test(value)) ||
    facts.texts.some((value) => free.test(value));
  if (hit(LIMIT_IDENTITY, LIMIT_TEXT)) return 'limited';
  if (hit(DENIAL_IDENTITY, DENIAL_TEXT)) return 'denied';
  return 'unknown';
}
const cleanupDetail =
  'The native process could not be confirmed stopped. Wait before trying this route again.';
export function cleanupFailed(primary?: unknown): EngineError {
  if (primary instanceof EngineError)
    return new EngineError(primary.code, `${primary.message} ${cleanupDetail}`, true);
  return new EngineError('CLEANUP_FAILED', cleanupDetail, true);
}
export function engineEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NODE_EXTRA_CA_CERTS)$/i;
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => allowed.test(key) && value !== undefined),
  );
}
/** A PowerShell single-quoted literal: the only escape is a doubled quote. */
export const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** Only fixed launch arguments cross cmd.exe. Prompts and protocol data use stdin. */
export function launchCommand(file: string, args: string[], platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  if ([file, ...args].some((part) => /["&|<>^%!\r\n\0]/.test(part)))
    throw new EngineError(
      'UNSUPPORTED_SHIM',
      'This Windows shim contains unsupported command characters. Select a native executable.',
    );
  return {
    file: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', `"${[file, ...args].map((part) => `"${part}"`).join(' ')}"`],
    verbatim: true,
  };
}
export interface ProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}
export class EngineProcess {
  private readonly child;
  private readonly timer;
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private lines: string[] = [];
  private bytes = 0;
  private failure?: Error;
  private ended = false;
  private wake?: () => void;
  private closing?: Promise<void>;
  exitCode: number | null = null;
  closed = false;
  private readonly abort = () =>
    this.fail(abortFailure(this.options.signal?.reason, PROCESS_TIMEOUT_DETAIL));
  constructor(private readonly options: ProcessOptions) {
    if (options.signal?.aborted) throw abortFailure(options.signal.reason, PROCESS_TIMEOUT_DETAIL);
    const command = launchCommand(options.file, options.args);
    this.child = spawn(command.file, command.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.once('error', () => {
      this.ended = true;
      this.fail(
        new EngineError(
          'LAUNCH_FAILED',
          'The tool could not start. Recheck its installation and dependencies.',
        ),
      );
    });
    this.child.stdin.on('error', () =>
      this.fail(new EngineError('PROCESS_EXITED', 'The tool stopped accepting requests.', true)),
    );
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
      if (this.bytes > (options.maxBytes ?? 2_000_000)) {
        this.fail(new EngineError('OUTPUT_LIMIT', 'The tool exceeded the response limit.', true));
        return;
      }
      this.pending += this.decoder.write(chunk);
      let end: number;
      while ((end = this.pending.indexOf('\n')) >= 0) {
        this.lines.push(this.pending.slice(0, end).replace(/\r$/, ''));
        this.pending = this.pending.slice(end + 1);
      }
      this.wake?.();
    });
    // Drained and dropped: an unread stderr pipe can block the child once its buffer fills.
    this.child.stderr.on('data', () => undefined);
    this.child.once('close', (code) => {
      this.exitCode = code;
      this.ended = true;
      this.pending += this.decoder.end();
      if (this.pending) this.lines.push(this.pending);
      this.pending = '';
      this.wake?.();
    });
    this.timer = setTimeout(
      () => this.fail(new EngineError('TIMEOUT', PROCESS_TIMEOUT_DETAIL, true)),
      options.timeoutMs ?? 120_000,
    );
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.wake?.();
  }
  send(frame: unknown) {
    if (this.failure) throw this.failure;
    if (this.ended || this.closed)
      throw new EngineError('PROCESS_EXITED', 'The tool has exited.', true);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  endInput(text?: string) {
    this.child.stdin.end(text);
  }
  async nextLine(): Promise<string | null> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.lines.length) return this.lines.shift()!;
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
  async next(): Promise<Record<string, unknown>> {
    for (;;) {
      const line = await this.nextLine();
      if (line === null)
        throw new EngineError(
          'PROCESS_EXITED',
          'The tool exited before completing its structured response.',
          true,
        );
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new EngineError('PROTOCOL_ERROR', 'The tool returned an unsupported response.', true);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new EngineError('PROTOCOL_ERROR', 'The tool returned an unsupported response.', true);
      return value as Record<string, unknown>;
    }
  }
  async close(primary?: unknown): Promise<void> {
    this.closing ??= (async () => {
      clearTimeout(this.timer);
      this.options.signal?.removeEventListener('abort', this.abort);
      if (!this.ended) await killOwnedProcess(this.child);
      this.closed = true;
    })();
    try {
      await this.closing;
    } catch {
      throw cleanupFailed(primary ?? this.failure);
    }
  }
}
export const openProcess = (options: ProcessOptions) => new EngineProcess(options);
export type ProcessFactory = typeof openProcess;
export async function capture(
  options: ProcessOptions,
  input?: string,
): Promise<{ stdout: string; code: number | null }> {
  const process = openProcess(options);
  let primary: unknown;
  try {
    process.endInput(input);
    const lines: string[] = [];
    let line: string | null;
    while ((line = await process.nextLine()) !== null) lines.push(line);
    return { stdout: lines.join('\n'), code: process.exitCode };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await process.close(primary);
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
