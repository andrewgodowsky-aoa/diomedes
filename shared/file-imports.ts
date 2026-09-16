/** Local text-export imports. A reference names the exact bytes selected. */
export const IMPORT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json'] as const;
export const IMPORT_MAX_FILES = 8;
export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_TOTAL_BYTES = 4 * IMPORT_MAX_BYTES;
export interface FileReference {
  path: string;
  sha: string;
}
export interface ImportCandidate extends FileReference {
  name: string;
  bytes: number;
}
export interface ImportListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  files: { name: string; path: string; bytes: number }[];
}
export function importableName(name: string): boolean {
  return IMPORT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
}
