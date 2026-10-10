/**
 * An in-memory stand-in for the slice of agentfs-sdk 0.6.4 the workspace
 * adapter uses (`server/files/agentfs-workspace.ts`), so TS05's scenarios run
 * without the SDK, which this repository cannot ship.
 *
 * It keeps the SDK's observable rules, as measured on 0.6.4: POSIX paths
 * rooted at `/` (a path without the slash is read from the root, and `.` and
 * `..` are plain names, so they are not found), `writeFile` creating parent
 * folders, ENOENT, ENOTDIR and EISDIR as `code`, links reported by `lstat` and
 * refused with ENOSYS when read, a key-value store, a tool-call log and the
 * chunk size a database stores (`fs_config`), read as the SDK reads it. Its
 * whole state is written to the database path on every change, so a test can
 * copy, damage or reopen "the database" the way it would the real file.
 *
 * It proves the adapter's own logic. What the real SDK does is proven by the
 * same scenarios run against the installed SDK (`NCTS_TURSO_NODE_MODULES`).
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentFsHandle, AgentFsSdk, AgentFsStats, AgentFsToolCall } from '../../server/files/agentfs-workspace.js';

interface Saved {
  files: Record<string, string>;
  dirs: string[];
  links: Record<string, string>;
  kv: Record<string, unknown>;
  tools: AgentFsToolCall[];
  /** The database's own settings. The SDK stores its chunk size here and writes with whatever it finds. */
  config?: { chunk_size?: string };
}

const fault = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });

function normalize(value: string) {
  return `/${value.split('/').filter(Boolean).join('/')}`;
}
const parentOf = (value: string) => (value.lastIndexOf('/') <= 0 ? '/' : value.slice(0, value.lastIndexOf('/')));

const stats = (kind: 'file' | 'dir' | 'link', size: number): AgentFsStats => ({
  size,
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'link',
});

/** One open "database": what the SDK's `AgentFS.open({ path })` returns, with the same parts. */
class DoubleHandle {
  private closed = false;
  constructor(
    private readonly file: string,
    private readonly saved: Saved,
  ) {}

  private save() {
    if (this.closed) throw fault('EBADF', 'the database is closed');
    fsSync.writeFileSync(this.file, JSON.stringify(this.saved));
  }
  private read() {
    if (this.closed) throw fault('EBADF', 'the database is closed');
    return this.saved;
  }
  private kind(target: string): 'file' | 'dir' | 'link' | null {
    const saved = this.read();
    if (target === '/' || saved.dirs.includes(target)) return 'dir';
    if (target in saved.files) return 'file';
    if (target in saved.links) return 'link';
    return null;
  }

  readonly fs = {
    readFile: async (value: string): Promise<Buffer> => {
      const target = normalize(value);
      const kind = this.kind(target);
      if (kind === 'dir') throw fault('EISDIR', `'${target}'`);
      if (kind === 'link') throw fault('ENOSYS', `symbolic links not supported yet, '${target}'`);
      if (kind !== 'file') throw fault('ENOENT', `no such file, '${target}'`);
      return Buffer.from(this.read().files[target], 'base64');
    },
    writeFile: async (value: string, data: string | Buffer): Promise<void> => {
      const target = normalize(value);
      if (this.kind(target) === 'dir') throw fault('EISDIR', `'${target}'`);
      const saved = this.read();
      for (let folder = parentOf(target); folder !== '/'; folder = parentOf(folder)) {
        if (folder in saved.files || folder in saved.links) throw fault('ENOTDIR', `'${folder}'`);
        if (!saved.dirs.includes(folder)) saved.dirs.push(folder);
      }
      delete saved.links[target];
      saved.files[target] = (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).toString('base64');
      this.save();
    },
    readdir: async (value: string): Promise<string[]> => {
      const target = normalize(value);
      const kind = this.kind(target);
      if (kind === null) throw fault('ENOENT', `no such directory, '${target}'`);
      if (kind !== 'dir') throw fault('ENOTDIR', `'${target}'`);
      const saved = this.read();
      const prefix = target === '/' ? '/' : `${target}/`;
      const names = new Set<string>();
      for (const item of [...Object.keys(saved.files), ...saved.dirs, ...Object.keys(saved.links)])
        if (item.startsWith(prefix) && item !== target) names.add(item.slice(prefix.length).split('/')[0]);
      return [...names].sort();
    },
    lstat: async (value: string): Promise<AgentFsStats> => {
      const target = normalize(value);
      const kind = this.kind(target);
      if (kind === null) throw fault('ENOENT', `no such file or directory, '${target}'`);
      const saved = this.read();
      return stats(kind, kind === 'file' ? Buffer.from(saved.files[target], 'base64').byteLength : 0);
    },
    unlink: async (value: string): Promise<void> => {
      const target = normalize(value);
      const saved = this.read();
      if (target in saved.files) delete saved.files[target];
      else if (target in saved.links) delete saved.links[target];
      else throw fault('ENOENT', `'${target}'`);
      this.save();
    },
    symlink: async (destination: string, value: string): Promise<void> => {
      const target = normalize(value);
      if (this.kind(target) !== null) throw fault('EEXIST', `'${target}'`);
      this.read().links[target] = destination;
      this.save();
    },
    getChunkSize: (): number => Number.parseInt(this.saved.config?.chunk_size ?? '4096', 10) || 4096,
    statfs: async () => {
      const saved = this.read();
      const bytesUsed = Object.values(saved.files).reduce((sum, data) => sum + Buffer.from(data, 'base64').byteLength, 0);
      return { inodes: Object.keys(saved.files).length + saved.dirs.length + Object.keys(saved.links).length + 1, bytesUsed };
    },
  };

  readonly kv = {
    get: async <T = unknown>(key: string): Promise<T | undefined> => this.read().kv[key] as T | undefined,
    set: async (key: string, value: unknown): Promise<void> => {
      this.read().kv[key] = JSON.parse(JSON.stringify(value));
      this.save();
    },
    list: async (prefix: string) =>
      Object.entries(this.read().kv)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    delete: async (key: string): Promise<void> => {
      delete this.read().kv[key];
      this.save();
    },
  };

  readonly tools = {
    record: async (name: string, startedAt: number, completedAt: number, parameters?: unknown, result?: unknown, error?: string) => {
      const saved = this.read();
      const id = saved.tools.length + 1;
      saved.tools.push({
        id,
        name,
        parameters,
        result,
        error,
        status: error ? 'error' : 'success',
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: (completedAt - startedAt) * 1000,
      });
      this.save();
      return id;
    },
    getRecent: async (since: number, limit?: number) =>
      this.read()
        .tools.filter((call) => call.started_at > since)
        .sort((a, b) => b.started_at - a.started_at)
        .slice(0, limit ?? 100),
  };

  async close() {
    this.closed = true;
  }
}

/** The double, shaped like the adapter's loaded SDK. Versions name what it stands in for. */
export function agentFsDouble(): AgentFsSdk {
  return {
    version: '0.6.4',
    engineVersion: '0.4.4',
    async open({ path: file }): Promise<AgentFsHandle> {
      await fs.mkdir(path.dirname(file), { recursive: true });
      let saved: Saved;
      try {
        saved = JSON.parse(await fs.readFile(file, 'utf8')) as Saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        saved = { files: {}, dirs: [], links: {}, kv: {}, tools: [], config: { chunk_size: '4096' } };
        await fs.writeFile(file, JSON.stringify(saved));
      }
      return new DoubleHandle(file, saved);
    },
  };
}
