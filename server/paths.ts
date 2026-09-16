import path from 'node:path';
import fs from 'node:fs/promises';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const blocked = new Set([
  '.git',
  'node_modules',
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.omp',
  'memories',
]);
const privateNames = new Set([
  'auth.json',
  '.credentials.json',
  'credentials.json',
  '.env',
  'soul.md',
  'id_rsa',
  'id_ed25519',
]);
export const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
export const isContained = (root: string, candidate: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

// Windows 8.3 aliases (NODEMO~1, CREDEN~1.JSO) can name guarded entries while
// evading literal-component checks. Treat any component whose name portion is
// 1-8 non-space characters ending in ~digits as a plausible short name, while
// ordinary tilde filenames (notes~backup.md, main.py~, file.txt~1) stay valid.
const plausibleDosShortName = (part: string) => {
  const [name = ''] = part.split('.');
  return name.length > 0 && name.length <= 8 && /^\S*~\d{1,4}$/.test(name);
};

const componentsOf = (normalized: string) =>
  normalized.split(/[\\/]+/).map((part) => part.toLowerCase());

/**
 * Does this path carry a component shaped like an 8.3 alias?
 *
 * The shape alone says nothing about what the component names. `NODEMO~1` may
 * be node_modules; `RUNNER~1` is an ordinary Windows profile, and on a machine
 * whose account name runs past eight characters it is where `%TEMP%` lives.
 * Only expanding it answers which, and expanding needs the filesystem, so this
 * predicate exists to decide whether that work is worth doing.
 */
const carriesShortName = (normalized: string) =>
  componentsOf(normalized).some(plausibleDosShortName);

export function rejectForbidden(absolute: string) {
  const normalized = path.resolve(absolute);
  const pieces = componentsOf(normalized);
  if (
    pieces.some(
      (part) =>
        blocked.has(part) ||
        privateNames.has(part) ||
        part.startsWith('.env.') ||
        plausibleDosShortName(part),
    ) ||
    /^f:[\\/]localai(?:[\\/]|$)/i.test(normalized)
  ) {
    throw new ApiError(403, 'This folder or file is private and cannot be opened by Diomedes.');
  }
}

/** Reject links at every existing component, including Windows junctions. */
export async function safeAbsolute(absolute: string) {
  const result = path.resolve(absolute);
  // A path carrying no 8.3 alias is judged on its literal name, before any
  // filesystem work happens. One that does carry an alias cannot be judged
  // until the alias is expanded, which is what the tail of this function does.
  const aliased = carriesShortName(result);
  if (!aliased) rejectForbidden(result);
  const parsed = path.parse(result);
  let current = parsed.root;
  let deepest = parsed.root;
  for (const component of result.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new ApiError(403, 'Linked folders and files cannot be opened by Diomedes.');
      deepest = current;
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  if (aliased) {
    // What an alias names is what the guard has to judge. Expanding the part
    // that exists turns NODEMO~1 back into node_modules and leaves RUNNER~1 as
    // the ordinary profile it is. A component past the deepest existing one
    // aliases nothing, so it stays in the tail and is judged on its shape.
    let expanded: string;
    try {
      expanded = path.join(await fs.realpath(deepest), path.relative(deepest, result));
    } catch {
      // An alias that cannot be expanded cannot be cleared.
      throw new ApiError(403, 'This folder or file is private and cannot be opened by Diomedes.');
    }
    rejectForbidden(expanded);
  }
  return result;
}

export function relativeName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  )
    throw new ApiError(400, 'Choose a file inside this project.');
  const pieces = value.replaceAll('\\', '/').split('/');
  if (
    pieces.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[:<>"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
    )
  )
    throw new ApiError(400, 'This file name cannot be used.');
  rejectForbidden(path.join(path.parse(process.cwd()).root, ...pieces));
  return pieces.join('/');
}

export async function projectFile(root: string, input: unknown) {
  const relative = relativeName(input);
  const absolute = path.resolve(root, relative);
  if (!isContained(root, absolute)) throw new ApiError(403, 'Choose a file inside this project.');
  await safeAbsolute(root);
  await safeAbsolute(absolute);
  return { relative, absolute };
}

export async function readTextOrNull(absolute: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new ApiError(403, 'This path is not a regular file.');
    if (stat.size > MAX_TEXT_BYTES)
      throw new ApiError(413, 'This file is larger than the 8 MB text limit.');
    const bytes = await fs.readFile(absolute);
    if (bytes.includes(0)) throw new ApiError(415, 'This file cannot be edited as text.');
    // Preserve a BOM as a literal character so hashing and History objects
    // round-trip the original UTF-8 bytes, including BOM and CRLF newlines.
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ApiError(415, 'This file is not UTF-8 text.');
    }
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

export const textKind = (name: string): 'markdown' | 'text' | 'unsupported' =>
  /\.(md|markdown)$/i.test(name)
    ? 'markdown'
    : /\.(txt|json|csv|tsv|js|jsx|ts|tsx|css|html|py|toml|yaml|yml|xml|log|ini|bat|ps1|sh|sql)$/i.test(
          name,
        )
      ? 'text'
      : 'unsupported';
