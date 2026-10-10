/**
 * OA2: starting an outside agent inside its box.
 *
 * The MXC SDK is not an app dependency yet. It is about 100 MB with two native
 * modules (`koffi`, `node-pty`), and the desktop package does not rebuild
 * native modules for Electron, so adding it is its own packaging decision. Until
 * then the host loads it from a folder it is given, and anything that cannot
 * load it is refused as `containment_unavailable`: an outside agent never runs
 * outside a box.
 *
 * Streaming stdio from a box needs Node 24.21 or later (Electron 44.5.1 and up
 * carry it); `run` alone works earlier, but an agent turn streams.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { containerRequest, refuseOutside, runLayout, type ContainedAgentPlan, type ContainerRequest } from './container-request.js';

export const MIN_STREAMING_NODE = [24, 21, 0] as const;

/** A process running in a box, as this host uses it. */
export interface ContainedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
  /** The SDK's own record of what the box refused, once the process has settled. */
  denials(): unknown;
}

/** The one call this host makes into the SDK. Tests give a fake. */
export interface ContainmentPort {
  spawn(request: ContainerRequest): Promise<ContainedProcess>;
}

export function nodeSupportsStreaming(version: string = process.versions.node): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < MIN_STREAMING_NODE.length; i++) {
    const have = parts[i] ?? 0;
    if (have !== MIN_STREAMING_NODE[i]) return have > MIN_STREAMING_NODE[i];
  }
  return true;
}

interface MxcModule {
  spawn(request: unknown): Promise<{
    standardInput: Writable | null;
    standardOutput: Readable | null;
    standardError: Readable | null;
    outputMetadata: unknown;
    wait(): Promise<{ exitCode: number; timedOut: boolean }>;
    kill(): void;
  }>;
}

/**
 * The SDK at `sdkDir` (a folder holding `dist/v1/index.js`), as a port. Refuses
 * on a Node too old to stream, a platform other than Windows, or a folder that
 * does not hold the SDK.
 */
export async function loadMxc(sdkDir: string, version: string = process.versions.node): Promise<ContainmentPort> {
  if (process.platform !== 'win32') throw refuseOutside('containment_unavailable', 'Outside agents run in a box on Windows only so far.');
  if (!nodeSupportsStreaming(version))
    throw refuseOutside('containment_unavailable', `The box needs Node ${MIN_STREAMING_NODE.join('.')} or later to stream; this is ${version}.`);
  let mxc: MxcModule;
  try {
    mxc = (await import(pathToFileURL(path.join(sdkDir, 'dist', 'v1', 'index.js')).href)) as MxcModule;
  } catch {
    throw refuseOutside('containment_unavailable', 'The containment component is not installed on this computer.');
  }
  if (typeof mxc.spawn !== 'function') throw refuseOutside('containment_unavailable', 'The containment component is not one this host knows.');
  return {
    async spawn(request) {
      const child = await mxc.spawn(request);
      const { standardInput: stdin, standardOutput: stdout, standardError: stderr } = child;
      if (!stdin || !stdout || !stderr) {
        child.kill();
        throw refuseOutside('containment_unavailable', 'The box did not hand back the agent’s input and output.');
      }
      return { stdin, stdout, stderr, wait: () => child.wait(), kill: () => child.kill(), denials: () => child.outputMetadata };
    },
  };
}

/** Make a run's folders, then start the plan's agent in its box. */
export async function launchContained(port: ContainmentPort, plan: ContainedAgentPlan): Promise<{ request: ContainerRequest; process: ContainedProcess }> {
  const request = containerRequest(plan);
  const layout = runLayout(request.filesystem.readwritePaths[0]!);
  for (const folder of [layout.home, layout.local, layout.roaming, layout.temp, layout.work]) await fs.mkdir(folder, { recursive: true });
  return { request, process: await port.spawn(request) };
}
