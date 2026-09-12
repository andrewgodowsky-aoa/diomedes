import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { engineEnvironment } from '../engines/process.js';

// Local hardware detection: report what this computer has so a later screen can
// recommend a local model honestly. Detection only — nothing is installed,
// started or downloaded, and every command run is disclosed verbatim.

export interface HardwareReport {
  readonly checkedAt: string;
  readonly os: { platform: string; release: string; arch: string };
  readonly cpu: { model: string; cores: number };
  readonly memory: { totalBytes: number; availableBytes: number };
  readonly gpus: {
    name: string;
    vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';
    vramBytes: number | null;
    driver: string | null;
    backend: 'cuda' | 'vulkan' | 'metal' | 'cpu' | 'unknown';
    measured: boolean;
  }[];
  readonly disks: { mount: string; freeBytes: number | null }[];
  readonly existingRuntimes: {
    id: 'ollama' | 'llama-server' | 'lm-studio';
    found: boolean;
    location: string | null;
    version: string | null;
  }[];
  readonly disclosure: string[];
  readonly unsupported: string[];
}

export interface HardwareProbeDeps {
  capture: typeof import('../engines/process.js').capture;
  platform?: NodeJS.Platform;
  osInfo?: () => {
    release: string;
    arch: string;
    cpuModel: string;
    cores: number;
    totalMem: number;
    freeMem: number;
  };
  now?: () => string;
}

const CONSENT_MESSAGE = 'Confirm the local discovery disclosure before checking this computer.';
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/;
const DISK_LIMIT = 8;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 4096;
const GPU_MAX_BYTES = 16384;

type CaptureResult = Awaited<ReturnType<HardwareProbeDeps['capture']>>;
type Run = (file: string, args: string[], maxBytes?: number) => Promise<CaptureResult>;

const defaultOsInfo = () => ({
  release: os.release(),
  arch: os.arch(),
  cpuModel: os.cpus()[0]?.model ?? 'unknown',
  cores: os.cpus().length,
  totalMem: os.totalmem(),
  freeMem: os.freemem(),
});

function vendorFor(name: string): HardwareReport['gpus'][number]['vendor'] {
  const lower = name.toLowerCase();
  if (lower.includes('nvidia') || lower.includes('geforce') || lower.includes('quadro'))
    return 'nvidia';
  if (lower.includes('amd') || lower.includes('radeon')) return 'amd';
  if (lower.includes('intel') || lower.includes('arc') || lower.includes('iris') || lower.includes('uhd'))
    return 'intel';
  if (lower.includes('apple')) return 'apple';
  return 'unknown';
}

async function nvidiaGpus(run: Run): Promise<HardwareReport['gpus'] | null> {
  let stdout: string;
  try {
    const result = await run(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      GPU_MAX_BYTES,
    );
    if (result.code !== 0) return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  // nounits reports memory.total in MiB; convert to bytes once, here.
  const gpus = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, mib, driver] = line.split(',').map((part) => part.trim());
      const mibValue = Number(mib);
      return {
        name: name || 'unknown',
        vendor: 'nvidia' as const,
        vramBytes: Number.isFinite(mibValue) ? Math.round(mibValue * 1024 * 1024) : null,
        driver: driver || null,
        backend: 'cuda' as const,
        measured: true,
      };
    });
  return gpus.length ? gpus : null;
}

async function windowsVideoControllers(run: Run): Promise<HardwareReport['gpus'] | null> {
  let stdout: string;
  try {
    const result = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json',
      ],
      GPU_MAX_BYTES,
    );
    if (result.code !== 0) return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  // ConvertTo-Json returns a bare object for a single controller, an array otherwise.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const gpus = rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const record = row as Record<string, unknown>;
      const name = typeof record.Name === 'string' ? record.Name : 'unknown';
      const ram = Number(record.AdapterRAM);
      return {
        name,
        vendor: vendorFor(name),
        vramBytes: Number.isFinite(ram) && ram > 0 ? ram : null,
        driver: typeof record.DriverVersion === 'string' ? record.DriverVersion : null,
        backend: 'unknown' as const,
        measured: false,
      };
    });
  return gpus.length ? gpus : null;
}

async function readDisks(
  run: Run,
  platform: NodeJS.Platform,
): Promise<HardwareReport['disks'] | null> {
  if (platform === 'win32') {
    try {
      const result = await run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free | ConvertTo-Json',
      ]);
      if (result.code !== 0) return null;
      const parsed: unknown = JSON.parse(result.stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const disks = rows
        .filter((row) => row && typeof row === 'object')
        .map((row) => {
          const record = row as Record<string, unknown>;
          const free = Number(record.Free);
          return {
            mount: typeof record.Name === 'string' ? `${record.Name}:` : 'unknown',
            freeBytes: Number.isFinite(free) && free >= 0 ? free : null,
          };
        })
        .filter((disk) => disk.mount !== 'unknown');
      return disks.slice(0, DISK_LIMIT);
    } catch {
      return null;
    }
  }
  try {
    const result = await run('df', ['-k']);
    if (result.code !== 0) return null;
    // df -k reports free space in 1K blocks; Available is the fourth column on
    // both Linux and macOS, and the mount is always the last field.
    const disks = result.stdout
      .split('\n')
      .slice(1)
      .map((line): { mount: string; freeBytes: number } | null => {
        const parts = line.trim().split(/\s+/);
        const free = Number(parts[3]);
        const mount = parts[parts.length - 1];
        if (!Number.isFinite(free) || mount === undefined || parts.length < 6) return null;
        return { mount, freeBytes: free * 1024 };
      })
      .filter((disk): disk is { mount: string; freeBytes: number } => disk !== null);
    return disks.slice(0, DISK_LIMIT);
  } catch {
    return null;
  }
}

async function runtimeLocation(
  run: Run,
  platform: NodeJS.Platform,
  name: string,
): Promise<string | null> {
  try {
    const result = await run(platform === 'win32' ? 'where.exe' : 'which', [name]);
    if (result.code !== 0) return null;
    return result.stdout.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function runtimeVersion(run: Run, location: string): Promise<string | null> {
  try {
    const result = await run(location, ['--version']);
    if (result.code !== 0) return null;
    return VERSION_PATTERN.exec(result.stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

// Presence check only: LM Studio is never launched to learn more about it.
async function lmStudioLocation(): Promise<string | null> {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  const dir = path.join(base, 'LM-Studio');
  try {
    return (await fs.stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export async function detectHardware(
  consent: boolean,
  deps: HardwareProbeDeps,
): Promise<HardwareReport> {
  if (!consent) throw new Error(CONSENT_MESSAGE);
  const platform = deps.platform ?? process.platform;
  const info = (deps.osInfo ?? defaultOsInfo)();
  const disclosure: string[] = [];
  const unsupported: string[] = [];
  const env = engineEnvironment();
  // Disclose before running, so the record shows the command even when its
  // probe fails or times out.
  const run: Run = async (file, args, maxBytes = PROBE_MAX_BYTES) => {
    disclosure.push([file, ...args].join(' '));
    return deps.capture({
      file,
      args,
      cwd: process.cwd(),
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes,
    });
  };

  const gpus: HardwareReport['gpus'] = [];
  if (platform === 'win32') {
    const nvidia = await nvidiaGpus(run);
    if (nvidia) {
      gpus.push(...nvidia);
    } else {
      unsupported.push('nvidia-smi did not answer, so NVIDIA CUDA capability is not verified.');
      const controllers = await windowsVideoControllers(run);
      if (controllers) {
        gpus.push(...controllers);
        unsupported.push(
          'Windows AdapterRAM is unreliable above 4 GB, so fallback GPU memory values are not trusted.',
        );
      } else {
        unsupported.push('Windows video controller enumeration failed, so no GPU is claimed.');
      }
    }
    if (gpus.some((gpu) => gpu.vendor !== 'nvidia'))
      unsupported.push('AMD and Intel GPU acceleration is not verified by this check.');
  } else {
    unsupported.push('GPU detection is implemented for Windows only, so no GPU is claimed here.');
  }

  const disks = await readDisks(run, platform);
  if (!disks) unsupported.push('Disk free space could not be read, so no disk claim is made.');

  const existingRuntimes: HardwareReport['existingRuntimes'] = [];
  for (const id of ['ollama', 'llama-server'] as const) {
    const location = await runtimeLocation(run, platform, id);
    const version = location ? await runtimeVersion(run, location) : null;
    if (location && !version)
      unsupported.push(
        `${id} was found but its version could not be read, so no version is claimed.`,
      );
    existingRuntimes.push({ id, found: location !== null, location, version });
  }
  if (platform === 'win32') {
    const location = await lmStudioLocation();
    existingRuntimes.push({ id: 'lm-studio', found: location !== null, location, version: null });
  } else {
    existingRuntimes.push({ id: 'lm-studio', found: false, location: null, version: null });
    unsupported.push('LM Studio detection is implemented for Windows only, so none is claimed here.');
  }

  return {
    checkedAt: deps.now ? deps.now() : new Date().toISOString(),
    os: { platform, release: info.release, arch: info.arch },
    cpu: { model: info.cpuModel, cores: info.cores },
    memory: { totalBytes: info.totalMem, availableBytes: info.freeMem },
    gpus,
    disks: disks ?? [],
    existingRuntimes,
    disclosure,
    unsupported,
  };
}
