import type { DocumentInfo } from '../../shared/types';
import { TASK_SOURCE_LIMITS } from '../../shared/task-sources';
import { imageMediaType, MODEL_IMAGE_LIMIT } from '../../shared/model-images';

/** Image capability is supplied by the host for the selected profile. All other sources retain their text limits. */
export function modelAttachmentProblem(file: Pick<DocumentInfo, 'path' | 'kind' | 'size'>,
  images = false): string | null {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (images && imageMediaType(file.path))
    return file.size > MODEL_IMAGE_LIMIT ? `${name} is larger than the 4 MB image limit. Remove it to send.` : null;
  if (!['markdown', 'text', 'plan'].includes(file.kind))
    return `${name} is not a text document, so a message cannot carry it to an engine. It stays in Files; remove it to send.`;
  if (file.size > TASK_SOURCE_LIMITS.bytes)
    return `${name} is larger than the 128 KB a message can carry. Remove it to send.`;
  return null;
}
