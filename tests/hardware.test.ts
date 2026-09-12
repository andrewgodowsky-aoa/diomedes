import { describe, expect, it } from 'vitest';
import { detectHardware, type HardwareProbeDeps } from '../server/local/hardware.js';

interface CaptureCall {
  file: string;
  args: string[];
}

const GPU_JSON = 'NVIDIA GeForce RTX 4070, 12288, 566.36\n';
const DISK_JSON = '[{"Name":"C","Free":123456789},{"Name":"D","Free":999}]\n';
const CIM_JSON =
  '[{"Name":"AMD Radeon RX 7900 XTX","AdapterRAM":4294967296,"DriverVersion":"31.0.2"}]';

function makeDeps(
  responses: Record<string, string | Error>,
  overrides: Partial<HardwareProbeDeps> = {},
) {
  const calls: CaptureCall[] = [];
  const capture: HardwareProbeDeps['capture'] = async (options) => {
    const joined = [options.file, ...options.args].join(' ');
    calls.push({ file: options.file, args: options.args });
    for (const [needle, response] of Object.entries(responses)) {
      if (joined.includes(needle)) {
        if (response instanceof Error) throw response;
        return { stdout: response, code: 0 };
      }
    }
    return { stdout: '', code: 1 };
  };
  const deps: HardwareProbeDeps = {
    capture,
    platform: 'win32',
    osInfo: () => ({
      release: '10.0.22631',
      arch: 'x64',
      cpuModel: 'Test CPU',
      cores: 8,
      totalMem: 34359738368,
      freeMem: 8589934592,
    }),
    now: () => '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
  return { deps, calls };
}

describe('detectHardware', () => {
  it('refuses to run anything without consent', async () => {
    const { deps, calls } = makeDeps({});
    await expect(detectHardware(false, deps)).rejects.toThrow(
      'Confirm the local discovery disclosure before checking this computer.',
    );
    expect(calls).toEqual([]);
  });

  it('reports an nvidia-smi GPU as measured CUDA with bytes', async () => {
    const { deps } = makeDeps({ nvidia: GPU_JSON, 'Get-PSDrive': DISK_JSON });
    const report = await detectHardware(true, deps);
    expect(report.gpus).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4070',
        vendor: 'nvidia',
        vramBytes: 12288 * 1024 * 1024,
        driver: '566.36',
        backend: 'cuda',
        measured: true,
      },
    ]);
  });

  it('falls back to the Windows video controller list when nvidia-smi fails', async () => {
    const { deps } = makeDeps({
      nvidia: new Error('LAUNCH_FAILED'),
      Win32_VideoController: CIM_JSON,
      'Get-PSDrive': DISK_JSON,
    });
    const report = await detectHardware(true, deps);
    expect(report.gpus).toEqual([
      {
        name: 'AMD Radeon RX 7900 XTX',
        vendor: 'amd',
        vramBytes: 4294967296,
        driver: '31.0.2',
        backend: 'unknown',
        measured: false,
      },
    ]);
    expect(report.unsupported).toEqual(
      expect.arrayContaining([
        expect.stringContaining('nvidia-smi'),
        expect.stringContaining('AdapterRAM'),
        expect.stringContaining('AMD and Intel'),
      ]),
    );
  });

  it('reports a missing runtime as not found', async () => {
    const { deps } = makeDeps({
      nvidia: new Error('LAUNCH_FAILED'),
      Win32_VideoController: new Error('LAUNCH_FAILED'),
      'Get-PSDrive': DISK_JSON,
    });
    const report = await detectHardware(true, deps);
    expect(report.existingRuntimes.find((runtime) => runtime.id === 'ollama')).toEqual({
      id: 'ollama',
      found: false,
      location: null,
      version: null,
    });
  });

  it('reads a runtime version from PATH', async () => {
    const { deps } = makeDeps({
      nvidia: new Error('LAUNCH_FAILED'),
      Win32_VideoController: new Error('LAUNCH_FAILED'),
      'Get-PSDrive': DISK_JSON,
      'where.exe ollama': 'C:\\Tools\\ollama.exe\n',
      'ollama.exe --version': 'ollama version is 0.5.7\n',
    });
    const report = await detectHardware(true, deps);
    expect(report.existingRuntimes.find((runtime) => runtime.id === 'ollama')).toEqual({
      id: 'ollama',
      found: true,
      location: 'C:\\Tools\\ollama.exe',
      version: '0.5.7',
    });
  });

  it('discloses every command it ran', async () => {
    const { deps, calls } = makeDeps({ nvidia: GPU_JSON, 'Get-PSDrive': DISK_JSON });
    const report = await detectHardware(true, deps);
    expect(report.disclosure).toEqual(calls.map((call) => [call.file, ...call.args].join(' ')));
    expect(report.disclosure.some((line) => line.startsWith('nvidia-smi '))).toBe(true);
  });

  it('keeps total and available memory as separate numbers', async () => {
    const { deps } = makeDeps({ nvidia: GPU_JSON, 'Get-PSDrive': DISK_JSON });
    const report = await detectHardware(true, deps);
    expect(report.memory.totalBytes).toBe(34359738368);
    expect(report.memory.availableBytes).toBe(8589934592);
    expect(report.memory.availableBytes).not.toBe(report.memory.totalBytes);
    expect(report.cpu).toEqual({ model: 'Test CPU', cores: 8 });
  });
});
