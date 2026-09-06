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

export function rejectForbidden(absolute: string) {
  const normalized = path.resolve(absolute);
  const pieces = normalized.split(/[\\/]+/).map((part) => part.toLowerCase());
  if (
    pieces.some(
      (part) => blocked.has(part) || privateNames.has(part) || part.startsWith('.env.'),
    ) ||
    /^f:[\\/]localai(?:[\\/]|$)/i.test(normalized)
  ) {
    throw new ApiError(403, 'This folder or file is private and cannot be opened by Diomedes.');
  }
}

/** Reject links at every existing component, including Windows junctions. */
export async function safeAbsolute(absolute: string) {
  const result = path.resolve(absolute);
  rejectForbidden(result);
  const parsed = path.parse(result);
  let current = parsed.root;
  for (const component of result.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new ApiError(403, 'Linked folders and files cannot be opened by Diomedes.');
    } catch (error) {
      if (!absent(error)) throw error;
    }
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
  /\.md$/i.test(name)
    ? 'markdown'
    : /\.(txt|json|csv|js|jsx|ts|tsx|css|html|py|toml|yaml|yml|xml|log|ini|bat|ps1|sh|sql)$/i.test(
          name,
        )
      ? 'text'
      : 'unsupported';
