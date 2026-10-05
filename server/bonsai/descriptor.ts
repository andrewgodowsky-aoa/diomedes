import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL_MODEL_DESCRIPTOR,
  LocalModelDescriptorError,
  parseLocalModelDescriptor,
  type LocalModelDescriptor,
  type LocalModelFolder,
} from '../../shared/local-model.js';

/**
 * The local model this computer has, as its folder's descriptor says (DIO-201): none when no folder
 * is set, so the option stays hidden; `invalid` with the sentence that says what is wrong; or a
 * descriptor that passed every check. `key` changes whenever the folder or the file does.
 */
export type LocalModelSetup =
  | { kind: 'none' }
  | { kind: 'invalid'; folder: LocalModelFolder; detail: string }
  | { kind: 'ready'; folder: LocalModelFolder; descriptor: LocalModelDescriptor; key: string };

export interface LocalModelSource {
  /** Reads the folder's descriptor again whenever the folder or the file changes. */
  read(): LocalModelSetup;
}

type Env = Readonly<Record<string, string | undefined>>;
/** A descriptor is a few kilobytes. Anything this large is not one. */
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

/** A full path on this computer: a drive or a share on Windows. */
export function isFullLocalPath(value: string): boolean {
  return process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value) : path.isAbsolute(value);
}

/**
 * The local model's folder: the Settings field first, then `NECTOVIA_LOCAL_MODEL_HOME`, then the
 * older `NECTOVIA_BONSAI_HOME`. Null when none of them is set.
 */
export function localModelFolder(setting: unknown, env: Env): LocalModelFolder | null {
  if (typeof setting === 'string' && setting.trim()) return { path: setting.trim(), source: 'settings' };
  const fromEnvironment = env.NECTOVIA_LOCAL_MODEL_HOME?.trim() || env.NECTOVIA_BONSAI_HOME?.trim();
  return fromEnvironment ? { path: fromEnvironment, source: 'environment' } : null;
}

function inside(child: string, folder: string): boolean {
  const relative = path.relative(folder, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Where the descriptor's start and stop scripts really resolve to: each must be a `.ps1` file inside
 * the folder after every link, junction and short name is followed (decision 11). Null when both
 * are, else the sentence that names the field.
 */
export function localScriptsRefusal(descriptor: LocalModelDescriptor): string | null {
  let root: string;
  try {
    root = fs.realpathSync.native(descriptor.folder);
  } catch {
    return `${descriptor.folder} can't be read.`;
  }
  const scripts = [
    ['lifecycle.startScript', descriptor.lifecycle.startScript],
    ['lifecycle.stopScript', descriptor.lifecycle.stopScript],
  ] as const;
  for (const [field, script] of scripts) {
    let real: string;
    try {
      real = fs.realpathSync.native(script);
    } catch {
      return `${field} in ${LOCAL_MODEL_DESCRIPTOR} names ${script}, which does not exist.`;
    }
    if (!/\.ps1$/i.test(real) || !inside(real, root) || !fs.statSync(real).isFile())
      return `${field} in ${LOCAL_MODEL_DESCRIPTOR} must be a .ps1 file inside ${descriptor.folder}.`;
  }
  return null;
}

/** Reads `nectovia-connection.json` from the folder Settings or the environment names. */
export class FolderLocalModelSource implements LocalModelSource {
  private cached: { stamp: string; setup: LocalModelSetup } | null = null;

  constructor(private readonly options: { setting(): unknown; env: Env }) {}

  read(): LocalModelSetup {
    const folder = localModelFolder(this.options.setting(), this.options.env);
    if (!folder) return { kind: 'none' };
    const invalid = (detail: string): LocalModelSetup => ({ kind: 'invalid', folder, detail });
    if (!isFullLocalPath(folder.path))
      return invalid(folder.source === 'settings'
        ? 'The local model folder must be a full path, such as F:\\Models\\Local.'
        : `The local model folder ${folder.path} must be a full path.`);
    const root = path.resolve(folder.path);
    const file = path.join(root, LOCAL_MODEL_DESCRIPTOR);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return invalid(`There is no ${LOCAL_MODEL_DESCRIPTOR} in ${root}.`);
    }
    if (!stat.isFile()) return invalid(`There is no ${LOCAL_MODEL_DESCRIPTOR} in ${root}.`);
    if (stat.size > MAX_DESCRIPTOR_BYTES) return invalid(`${LOCAL_MODEL_DESCRIPTOR} in ${root} is larger than 64 KB.`);
    const stamp = `${folder.source}\n${root}\n${stat.mtimeMs}\n${stat.size}`;
    if (this.cached?.stamp === stamp) return this.cached.setup;
    const setup = this.load(folder, root, file, stamp);
    this.cached = { stamp, setup };
    return setup;
  }

  private load(folder: LocalModelFolder, root: string, file: string, stamp: string): LocalModelSetup {
    const invalid = (detail: string): LocalModelSetup => ({ kind: 'invalid', folder, detail });
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return invalid(`${LOCAL_MODEL_DESCRIPTOR} in ${root} is not valid JSON.`);
    }
    let descriptor: LocalModelDescriptor;
    try {
      descriptor = parseLocalModelDescriptor(raw, root);
    } catch (error) {
      if (error instanceof LocalModelDescriptorError) return invalid(error.message);
      throw error;
    }
    const scripts = localScriptsRefusal(descriptor);
    return scripts ? invalid(scripts) : { kind: 'ready', folder, descriptor, key: stamp };
  }
}

