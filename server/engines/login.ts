import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExternalEngine } from '../../shared/types.js';
import type { EngineConnection } from '../../shared/engines.js';
import { killOwnedProcess } from '../integrations.js';
import { engineEnvironment, EngineError } from './process.js';

const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function loginCommand(engine: ExternalEngine): string[] {
  if (engine === 'claude-code')
    return ['--safe-mode', '--setting-sources', '', 'auth', 'login', '--claudeai'];
  if (engine === 'opencode') return ['auth', 'login', '--pure', '--provider', 'opencode-go'];
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
export class NativeLogin {
  private active = new Map<
    ExternalEngine,
    { child: ChildProcess; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly root: string,
    private readonly launch: (
      file: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcess = spawn,
  ) {}
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
        detail: 'The native sign-in window is already open. Finish or cancel it, then recheck.',
      };
    const cwd = path.join(this.root, engine);
    await fs.mkdir(cwd, { recursive: true });
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
    const caption =
      'Complete sign-in in this native tool, then use Check sign-in and models in Diomedes.';
    const script =
      `$ErrorActionPreference='Stop'\nSet-Location -LiteralPath ${psQuote(cwd)}\nWrite-Host ${psQuote(caption)}\n` +
      `& ${psQuote(connection.location)} @(${loginCommand(engine).map(psQuote).join(',')})\n` +
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
    const timer = setTimeout(() => {
      void this.stop(engine);
    }, 600_000);
    timer.unref();
    this.active.set(engine, { child, timer });
    child.once('exit', () => {
      clearTimeout(timer);
      this.active.delete(engine);
    });
    return { detail: caption };
  }
  async stop(engine: ExternalEngine) {
    const item = this.active.get(engine);
    if (!item) return { detail: 'No native sign-in window is running.' };
    this.active.delete(engine);
    clearTimeout(item.timer);
    await killOwnedProcess(item.child);
    return {
      detail: 'The native sign-in window was closed. Recheck to see whether sign-in completed.',
    };
  }
  async close() {
    for (const engine of this.active.keys()) await this.stop(engine);
  }
}
