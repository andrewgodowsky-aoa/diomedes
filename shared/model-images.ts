/**
 * Images a model may receive with a message: exact project bytes, never a URL. Whether a model
 * takes images at all is its catalogue entry's `inputModalities`, which the host supplies; these
 * are only the bounds every such model shares. Client and server share it.
 */

/** Exact source bytes remain in the existing project version store, never in a URL from a model. */
export type ModelImage = {
  path: string;
  sha: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
};
export const MODEL_IMAGE_LIMIT = 4 * 1024 * 1024;
export const MODEL_IMAGE_COUNT = 4;
export function imageMediaType(name: string): ModelImage['mediaType'] | null {
  const extension = name.split('.').at(-1)?.toLowerCase();
  return extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg'
    ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : null;
}
