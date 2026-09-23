/**
 * The recorded-artifact step, as both sides read it (artifacts v2, frozen item 5). The server
 * writes one pure `transform` step per artifact in an answered conversation message
 * (`server/harness/artifact-steps.ts`); the Console reads them back from the run
 * (`client/console/artifact-evidence.ts`). A step is an index entry and a digest, never the
 * source: the turn text stays the only thing the panel draws.
 */

/** Every recorded-artifact step id starts with this. */
export const ARTIFACT_STEP_PREFIX = 'artifact.v1:';
/** At most this many are recorded for one message; the panel still reads the rest from the text. */
export const MAX_RECORDED_ARTIFACTS = 16;

/** One recorded artifact: an index entry, never the source. */
export interface RecordedArtifact {
  v: 1;
  /** The key the panel indexes it by in its thread: `artifactKey(threadId, turnId, blockIndex)`. */
  artifactId: string;
  /** The id the model declared on the artifact's first line, if any. */
  declaredId: string | null;
  kind: string;
  /** The fence language as written, lower-cased; '' for a table. */
  lang: string;
  /**
   * The artifact's own title (declared, the heading above it, or a visual's own), or null when it
   * has none. The panel numbers an untitled artifact among its whole thread's, which one answer
   * cannot know, so no number is ever recorded; a reader shows the panel's name for it.
   */
  title: string | null;
  /**
   * Lowercase hex SHA-256 of the UTF-8 bytes of the artifact's source as the panel shows and
   * copies it (`ArtifactRecord.source`): the fence body as written, or a table's own lines.
   */
  sha256: string;
  /** Where it sits in the answer: the block's index among the answer's parsed blocks. */
  blockIndex: number;
  /** The thread turn that shows the answer, as the host projects it. */
  turnId: string;
  /** The model turn step, in the same run, that wrote the answer. */
  turnStepId: string;
  sourceMessageId: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max;

/** The input of a recorded-artifact step, or null for anything that is not one exactly. */
export function recordedArtifactOf(input: unknown): RecordedArtifact | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    value.v !== 1 ||
    !text(value.artifactId) ||
    !(value.declaredId === null || text(value.declaredId, 64)) ||
    !text(value.kind, 32) ||
    !text(value.lang, 64) ||
    !(value.title === null || text(value.title, 512)) ||
    !text(value.sha256, 64) ||
    !HEX64.test(value.sha256) ||
    !Number.isSafeInteger(value.blockIndex) ||
    (value.blockIndex as number) < 0 ||
    !text(value.turnId) ||
    !text(value.turnStepId) ||
    !text(value.sourceMessageId)
  )
    return null;
  return {
    v: 1,
    artifactId: value.artifactId,
    declaredId: value.declaredId as string | null,
    kind: value.kind,
    lang: value.lang,
    title: value.title as string | null,
    sha256: value.sha256,
    blockIndex: value.blockIndex as number,
    turnId: value.turnId,
    turnStepId: value.turnStepId,
    sourceMessageId: value.sourceMessageId,
  };
}

/** The artifacts one run recorded, in the order it recorded them: only steps that succeeded. */
export function recordedArtifactsOf(run: {
  steps: readonly { intent: { stepId: string; input: unknown }; state: string }[];
}): RecordedArtifact[] {
  const found: RecordedArtifact[] = [];
  for (const step of run.steps) {
    if (!step.intent.stepId.startsWith(ARTIFACT_STEP_PREFIX) || step.state !== 'succeeded') continue;
    const recorded = recordedArtifactOf(step.intent.input);
    if (recorded) found.push(recorded);
  }
  return found;
}
