import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { killOwnedProcess } from '../integrations.js';

export class EngineError extends Error {
  readonly status = 503;
  constructor(
    readonly code: string,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
export const stopped = () =>
  new EngineError(
    'CANCELLED',
    'The request was stopped. A dispatched request may still consume usage.',
    true,
  );
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
  private readonly abort = () => this.fail(stopped());
  constructor(private readonly options: ProcessOptions) {
    if (options.signal?.aborted) throw stopped();
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
      () =>
        this.fail(
          new EngineError(
            'TIMEOUT',
            'The tool did not finish within the time limit. Recheck before starting another request.',
            true,
          ),
        ),
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
