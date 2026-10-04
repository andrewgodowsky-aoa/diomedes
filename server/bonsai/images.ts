import { createHash } from 'node:crypto';
import { imageMediaType, MODEL_IMAGE_LIMIT, type ModelImage } from '../../shared/bonsai.js';
import { ApiError } from '../paths.js';

/** Validate the file bytes as well as the extension before advertising a model-readable image. */
export function inspectModelImage(name: string, bytes: Uint8Array): ModelImage {
  const mediaType = imageMediaType(name), buffer = Buffer.from(bytes);
  if (!mediaType || !buffer.length || buffer.length > MODEL_IMAGE_LIMIT)
    throw new ApiError(415, 'Choose a PNG, JPEG or WebP image no larger than 4 MB.');
  const valid = mediaType === 'image/png'
    ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === 'image/jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
      : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new ApiError(415, 'The image bytes do not match the file type.');
  return { path: name, sha: createHash('sha256').update(buffer).digest('hex'), mediaType, bytes: buffer.length };
}
