import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExternalEngine } from '../../shared/types.js';
import type { EngineConnection } from '../../shared/engines.js';
import { killOwnedProcess } from '../integrations.js';
import { engineEnvironment, EngineError, psQuote } from './process.js';
import { cursorCommand, resolveCursorEntry } from './cursor.js';
import { resolveDevinEntry, startDevinLogin } from './devin.js';

export function loginCommand(engine: ExternalEngine): string[] {
  if (engine === 'claude-code')
    return ['--safe-mode', '--setting-sources', '', 'auth', 'login', '--claudeai'];
  if (engine === 'opencode') return ['auth', 'login', '--pure', '--provider', 'opencode-go'];
  if (engine === 'cursor') return ['login'];
  if (engine === 'devin')
    throw new EngineError(
      'LOGIN_UNSUPPORTED',
      'Devin signs in through its ACP browser flow, not a console command.',
    );
  throw new EngineError(
    'LOGIN_UNSUPPORTED',
    'Direct OpenAI API access uses the native OMP models.yml configuration, not OAuth login.',
  );
}
export async function prepareOmpConfiguration(root: string): Promise<string> {
  const directory = path.join(root, 'oh-my-pi', 'native-profile');
  await fs.mkdir(directory, { recursive: true });
  // Create only. Existing native credentials are never read or overwritten.
  try {
    await fs.writeFile(
      path.join(directory, 'models.yml'),
      '# Configure a literal OpenAI apiKey using the linked native OMP documentation.\nproviders: {}\n',
      { flag: 'wx' },
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return directory;
}
/**
 * How a native sign-in ended. It says what happened to the window, never what
 * the native tool decided: an exit code is not evidence of a signed-in account.
 */
export type SignInOutcome = 'exited' | 'stopped' | 'timed-out';
export interface NativeLoginOptions {
  /**
   * Called once per started sign-in, after the native process has actually
   * ended. The host uses it to ask for one fresh inspection; that inspection's
   * own answer is what a screen shows.
   */
  onFinished?: (engine: ExternalEngine, outcome: SignInOutcome) => void | Promise<void>;
}
interface SignInSession {
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  /** Claimed by whichever ending happens first, before the process is killed. */
  outcome?: SignInOutcome;
  finished: boolean;
}
export class NativeLogin {
  private active = new Map<ExternalEngine, SignInSession>();
  constructor(
    private readonly root: string,
    private readonly launch: (
      file: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcess = spawn,
    private readonly options: NativeLoginOptions = {},
  ) {}
  /** Whether this instance was given a host that re-checks when a window ends. */
  private get rechecks() {
    return this.options.onFinished !== undefined;
  }
  /** Whether a native sign-in window Diomedes opened is still running. */
  state(engine: ExternalEngine): 'idle' | 'running' {
    return this.active.has(engine) ? 'running' : 'idle';
  }
  private track(engine: ExternalEngine, child: ChildProcess): SignInSession {
    const session: SignInSession = {
      child,
      timer: setTimeout(() => {
        void this.end(engine, session, 'timed-out').catch(() => {});
      }, 600_000),
      finished: false,
    };
    session.timer.unref();
    this.active.set(engine, session);
    // The exit code is deliberately ignored. A window that ended only asks for
    // a fresh check; whether the right account is signed in is the check's answer.
    child.once('exit', () => this.finish(engine, session, 'exited'));
    return session;
  }
  /** The window is gone. Forget it, then report it once. */
  private finish(engine: ExternalEngine, session: SignInSession, outcome: SignInOutcome) {
    session.outcome ??= outcome;
    if (this.active.get(engine) === session) this.active.delete(engine);
    if (session.finished) return;
    session.finished = true;
    clearTimeout(session.timer);
    const report = this.options.onFinished;
    if (!report) return;
    // The re-check runs on the host's own time: a failure inside it belongs to
    // the host that recorded it, and never leaves this route marked signing in.
    void Promise.resolve()
      .then(() => report(engine, session.outcome!))
      .catch(() => {});
  }
  /** Close a window Diomedes opened, naming why before the process can exit. */
  private async end(engine: ExternalEngine, session: SignInSession, outcome: SignInOutcome) {
    session.outcome ??= outcome;
    if (this.active.get(engine) === session) this.active.delete(engine);
    clearTimeout(session.timer);
    await killOwnedProcess(session.child);
    this.finish(engine, session, outcome);
  }
  async start(connection: EngineConnection, consent: boolean) {
    if (!consent)
      throw new EngineError('CONSENT_REQUIRED', 'Confirm opening the native sign-in tool.');
    if (process.platform !== 'win32')
      throw new EngineError(
        'LOGIN_UNSUPPORTED',
        'Run the native tool sign-in on your platform, then recheck here.',
      );
    if (
      connection.installation !== 'found' ||
      connection.compatibility !== 'supported' ||
      !connection.location
    )
      throw new EngineError(
        'NOT_INSTALLED',
        'Check this tool and its compatibility before signing in.',
      );
    const engine = connection.engine;
    if (engine === 'oh-my-pi') {
      const directory = await prepareOmpConfiguration(this.root);
      const child = spawn(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'),
        [directory],
        { windowsHide: true, stdio: 'ignore', shell: false },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () =>
          reject(
            new EngineError('LOGIN_FAILED', 'The native configuration folder could not open.'),
          ),
        );
      });
      child.unref();
      return {
        detail:
          'Opened the separate native OMP profile. Edit models.yml using the linked documentation to set providers.openai.apiKey to your literal OpenAI API key, then recheck. Diomedes does not read this file. API billing is separate from ChatGPT. Credential helper commands are native tool authority; do not add them to this profile.',
      };
    }
    if (this.active.has(engine))
      return {
        detail: this.rechecks
          ? 'The native sign-in window is already open. Finish or cancel it; Diomedes checks this service again when it closes.'
          : 'The native sign-in window is already open. Finish or cancel it, then recheck.',
      };
    const cwd = path.join(this.root, engine);
    await fs.mkdir(cwd, { recursive: true });
    if (engine === 'devin') {
      // Devin ACP authenticates its own process and never reuses the native CLI
      // sign-in, so login starts the browser flow instead of a console window.
      const entry = await resolveDevinEntry(connection.location);
      const { child, done } = startDevinLogin(entry, cwd);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () =>
          reject(new EngineError('LOGIN_FAILED', 'The Devin sign-in could not start.')),
        );
      });
      const session = this.track(engine, child);
      // The browser flow settling is this sign-in ending, either way; closing
      // the ACP child after it is cleanup, not a person cancelling.
      done.then(
        () => this.end(engine, session, 'exited'),
        () => this.end(engine, session, 'exited'),
      ).catch(() => {});
      return {
        detail: this.rechecks
          ? 'Complete the Devin sign-in in the browser window that opened. Diomedes checks this service again when the sign-in finishes.'
          : 'Complete the Devin sign-in in the browser window that opened, then use Check sign-in and models in Diomedes.',
      };
    }
    const env = engineEnvironment();
    if (engine === 'opencode') {
      const nativeHome = process.env.USERPROFILE ?? process.env.HOME;
      if (!nativeHome)
        throw new EngineError('LOGIN_UNSUPPORTED', 'The native user profile could not be located.');
      env.XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(nativeHome, '.local', 'share');
      for (const key of [
        'HOME',
        'USERPROFILE',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
      ]) {
        env[key] = path.join(cwd, 'login', key.toLowerCase());
        await fs.mkdir(env[key]!, { recursive: true });
      }
      env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
      env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
    }
    const caption = this.rechecks
      ? 'Complete sign-in in this native tool. Diomedes checks this service again when this window closes.'
      : 'Complete sign-in in this native tool, then use Check sign-in and models in Diomedes.';
    const command =
      engine === 'cursor'
        ? cursorCommand(await resolveCursorEntry(connection.location), loginCommand(engine))
        : { file: connection.location, args: loginCommand(engine) };
    const script =
      `$ErrorActionPreference='Stop'\nSet-Location -LiteralPath ${psQuote(cwd)}\nWrite-Host ${psQuote(caption)}\n` +
      `& ${psQuote(command.file)} @(${command.args.map(psQuote).join(',')})\n` +
      `if ($LASTEXITCODE -ne 0) { Write-Host 'Sign-in did not complete. Recheck the native tool.'; Read-Host 'Press Enter to close' | Out-Null }`;
    const child = this.launch(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { cwd, env, detached: true, windowsHide: false, stdio: 'ignore', shell: false },
    );
    // A visible console is intentional only after the user requests native sign-in.
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () =>
        reject(new EngineError('LOGIN_FAILED', 'The native sign-in window could not open.')),
      );
    });
    this.track(engine, child);
    return { detail: caption };
  }
  async stop(engine: ExternalEngine) {
    const session = this.active.get(engine);
    if (!session) return { detail: 'No native sign-in window is running.' };
    await this.end(engine, session, 'stopped');
    return {
      detail: this.rechecks
        ? 'The native sign-in window was closed. Diomedes is checking this service again.'
        : 'The native sign-in window was closed. Recheck to see whether sign-in completed.',
    };
  }
  async close() {
    for (const engine of this.active.keys()) await this.stop(engine);
  }
}
