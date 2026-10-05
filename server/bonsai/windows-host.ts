import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { LocalModelDescriptor, LocalModelProfile, LocalModelStatus } from '../../shared/local-model.js';
import { localScriptsRefusal } from './descriptor.js';
import { probeLocalModel } from './probe.js';
import { LocalModelError, type LocalModelHost, type LocalModelLease } from './runtime.js';

const statusSchema = z.object({
  state: z.enum(['missing', 'unloaded', 'starting', 'ready', 'busy', 'insufficient-memory', 'error']),
  installed: z.boolean(),
  mode: z.string().max(32).nullable(),
  model: z.string().max(200).nullable().optional(),
  contextTokens: z.number().int().positive().nullable().optional(),
  owned: z.boolean(),
  detail: z.string().max(4000),
});

/** This build's record of a worker it started. */
export const LOCAL_MODEL_OWNERSHIP = 'local-model-ownership.json';
/** The same record as an earlier build named it. A worker that build started is still honored. */
export const EARLIER_OWNERSHIP = 'bonsai-ownership.json';
/** The environment variable that carries the checked descriptor to the host script. */
export const DESCRIPTOR_VARIABLE = 'NECTOVIA_LOCAL_MODEL';

/**
 * The local model's lifecycle on Windows. Its status is read from its own server (`probe.ts`);
 * starting, switching and the lease go through `resources/bonsai-host.ps1`, which runs the
 * descriptor's own start and stop scripts and nothing else.
 */
export class WindowsLocalModelHost implements LocalModelHost {
  private readonly powershell: string | undefined;
  constructor(
    private readonly dataDir: string,
    private readonly script: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly fetch?: typeof globalThis.fetch,
  ) {
    // A start script may use PowerShell 7.4's per-process environment. Prefer a normal installation.
    this.powershell = [env.NECTOVIA_LOCAL_MODEL_POWERSHELL, env.NECTOVIA_BONSAI_POWERSHELL,
      path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
      ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'pwsh.exe')),
      path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')]
      .find((file): file is string => !!file && existsSync(file));
  }

  inspect(descriptor: LocalModelDescriptor): Promise<LocalModelStatus> {
    return probeLocalModel(descriptor, { fetch: this.fetch });
  }

  /** Starts or switches the worker only with `start: true`, the person's explicit Start. */
  acquire(profile: LocalModelProfile, options: { start?: boolean } = {}, descriptor?: LocalModelDescriptor): Promise<LocalModelLease> {
    if (!descriptor) return Promise.reject(new LocalModelError('missing', "The local model isn't installed on this computer."));
    if (process.platform !== 'win32')
      return Promise.reject(new LocalModelError('error', 'Starting the local model needs Windows.'));
    // Checked again here, just before anything runs: the folder may have changed since it was read.
    const scripts = localScriptsRefusal(descriptor);
    if (scripts) return Promise.reject(new LocalModelError('error', scripts));
    const powershell = this.powershell;
    if (!powershell)
      return Promise.reject(new LocalModelError('error',
        'The local model needs PowerShell 7.4 or newer. Set NECTOVIA_LOCAL_MODEL_POWERSHELL to its installed executable.'));
    const start = options.start === true;
    const checked = {
      folder: descriptor.folder,
      baseUrl: descriptor.baseUrl,
      serverRoot: descriptor.serverRoot,
      healthUrl: descriptor.healthUrl,
      model: descriptor.model,
      startScript: descriptor.lifecycle.startScript,
      stopScript: descriptor.lifecycle.stopScript,
      modeParameter: descriptor.lifecycle.modeParameter,
      profiles: descriptor.profiles.map(item => ({
        mode: item.mode, contextTokens: item.contextTokens, images: item.inputModalities.includes('image'),
      })),
    };
    return new Promise((resolve, reject) => {
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.script,
        '-Mode', profile.mode,
        '-OwnershipFile', path.join(this.dataDir, LOCAL_MODEL_OWNERSHIP),
        '-EarlierOwnershipFile', path.join(this.dataDir, EARLIER_OWNERSHIP),
        ...(start ? [] : ['-NoStart'])],
      // The checked descriptor travels as one JSON value in the environment, never on a command line.
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, [DESCRIPTOR_VARIABLE]: JSON.stringify(checked) } });
      let output = '', errors = '', answered = false, released = false;
      const leaseLost = new AbortController();
      const timer = setTimeout(() => {
        child.kill();
        reject(new LocalModelError('error', 'The local model did not become ready. Check its logs.'));
      }, 220_000);
      // A descendant can inherit a pipe after the helper exits. Only this process owns the lease;
      // waiting for `close` (pipe EOF) can hang forever even though that lease is already released.
      const exited = new Promise<void>(done => child.once('exit', () => { clearTimeout(timer); done(); }));
      const fail = (error: Error) => { clearTimeout(timer); child.kill(); reject(error); };
      child.once('error', fail);
      child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-4000); });
      child.stdout.on('data', bytes => {
        output += String(bytes);
        if (output.length > 16_384) return fail(new LocalModelError('error', 'The local model helper returned too much output.'));
        const newline = output.indexOf('\n');
        if (answered || newline < 0) return;
        try {
          const status = statusSchema.parse(JSON.parse(output.slice(0, newline)));
          answered = true;
          clearTimeout(timer);
          if (status.state !== 'ready') return fail(new LocalModelError(status.state, status.detail));
          resolve({ status, signal: leaseLost.signal, release: async () => {
            released = true;
            if (child.exitCode === null && !child.killed) child.stdin.end('\n');
            const timeout = setTimeout(() => child.kill(), 5000);
            try { await exited; } finally {
              clearTimeout(timeout); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
            }
          } });
        } catch { fail(new LocalModelError('error', 'The local model helper returned an invalid status.')); }
      });
      child.once('exit', code => {
        if (answered && !released)
          leaseLost.abort(new LocalModelError('error', 'The local model lost its process lease. This request stopped.'));
        // Give already-buffered status/error output a turn to arrive before diagnosing an early exit.
        setImmediate(() => {
          if (!answered) reject(new LocalModelError('error', errors.trim() || `The local model helper exited before the model was ready (${code}).`));
          child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        });
      });
      child.stdin.on('error', () => { /* A closed helper already reports its exit above. */ });
    });
  }
}
