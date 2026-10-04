import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { BonsaiProfile, BonsaiStatus } from '../../shared/bonsai.js';
import { BonsaiError, type BonsaiHost, type BonsaiLease } from './runtime.js';

const statusSchema = z.object({
  state: z.enum(['missing', 'unloaded', 'starting', 'ready', 'busy', 'insufficient-memory', 'error']),
  installed: z.boolean(), mode: z.enum(['Gaming', 'Full']).nullable(), owned: z.boolean(), detail: z.string().max(4000),
});
export class WindowsBonsaiHost implements BonsaiHost {
  readonly root: string;
  readonly configured: boolean;
  private readonly powershell: string | undefined;
  constructor(private readonly dataDir: string, private readonly script: string, env = process.env) {
    this.root = env.NECTOVIA_BONSAI_HOME?.trim() || 'F:\\Bonsai-2';
    // Start-Bonsai uses PowerShell 7.4's per-process environment. Prefer a normal installation;
    // the existing Bonsai setup on this machine was verified with Codex's bundled PowerShell.
    this.powershell = [env.NECTOVIA_BONSAI_POWERSHELL,
      path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
      ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'pwsh.exe')),
      path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')]
      .find((file): file is string => !!file && existsSync(file));
    this.configured = process.platform === 'win32' && ['installation.json', 'nectovia-connection.json', 'Start-Bonsai.ps1', 'Stop-Bonsai.ps1']
      .every(file => existsSync(path.join(this.root, file)));
  }
  async inspect(): Promise<BonsaiStatus> {
    if (!this.configured) return { state: 'missing', installed: false, mode: null, owned: false, detail: 'Bonsai is not installed on this computer.' };
    const lease = await this.open('Status');
    await lease.release();
    return lease.status;
  }
  acquire(profile: BonsaiProfile): Promise<BonsaiLease> { return this.open('Acquire', profile.mode); }

  private open(action: 'Status' | 'Acquire', mode: 'Gaming' | 'Full' = 'Gaming'): Promise<BonsaiLease> {
    if (!this.configured) return Promise.reject(new BonsaiError('missing', 'Bonsai is not installed on this computer.'));
    const powershell = this.powershell;
    if (!powershell) return Promise.reject(new BonsaiError('error', 'Bonsai needs PowerShell 7.4 or newer. Set NECTOVIA_BONSAI_POWERSHELL to its installed executable.'));
    return new Promise((resolve, reject) => {
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.script,
        '-Action', action, '-Mode', mode, '-Root', this.root,
        '-OwnershipFile', path.join(this.dataDir, 'bonsai-ownership.json')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '', answered = false, released = false;
      const leaseLost = new AbortController();
      const timer = setTimeout(() => { child.kill(); reject(new BonsaiError('error', 'Bonsai did not become ready. Check its launcher logs.')); }, action === 'Status' ? 15_000 : 220_000);
      // A descendant can inherit a pipe after the helper exits. Only this process owns the lease;
      // waiting for `close` (pipe EOF) can hang forever even though that lease is already released.
      const exited = new Promise<void>(done => child.once('exit', () => { clearTimeout(timer); done(); }));
      const fail = (error: Error) => { clearTimeout(timer); child.kill(); reject(error); };
      child.once('error', fail);
      child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-4000); });
      child.stdout.on('data', bytes => {
        output += String(bytes);
        if (output.length > 16_384) return fail(new BonsaiError('error', 'The Bonsai launcher returned too much output.'));
        const newline = output.indexOf('\n');
        if (answered || newline < 0) return;
        try {
          const status = statusSchema.parse(JSON.parse(output.slice(0, newline)));
          answered = true;
          clearTimeout(timer);
          if (action === 'Acquire' && status.state !== 'ready') return fail(new BonsaiError(status.state, status.detail));
          resolve({ status, signal: leaseLost.signal, release: async () => {
            released = true;
            if (child.exitCode === null && !child.killed) child.stdin.end('\n');
            const timeout = setTimeout(() => child.kill(), 5000);
            try { await exited; } finally {
              clearTimeout(timeout); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
            }
          } });
        } catch { fail(new BonsaiError('error', 'The Bonsai launcher returned an invalid status.')); }
      });
      child.once('exit', code => {
        if (answered && !released && action === 'Acquire')
          leaseLost.abort(new BonsaiError('error', 'Bonsai lost its process lease. This request stopped.'));
        // Give already-buffered status/error output a turn to arrive before diagnosing an early exit.
        setImmediate(() => {
          if (!answered) reject(new BonsaiError('error', errors.trim() || `Bonsai launcher exited before readiness (${code}).`));
          child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        });
      });
      child.stdin.on('error', () => { /* A closed launcher already reports its exit above. */ });
    });
  }
}
