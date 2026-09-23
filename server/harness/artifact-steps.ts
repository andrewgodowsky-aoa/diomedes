/**
 * Recorded artifacts, as index-only evidence (artifacts v2, frozen item 5; draft (c)).
 *
 * When a conversation message's answer holds artifacts, the driver that answered it records one
 * pure `transform` step per artifact in the conversation run, right after the decision phase:
 * which artifact it is, its kind and title, the SHA-256 of its source, and a pointer to the model
 * turn it came from. The source is never stored. The answer the turn recorded stays the only
 * thing the panel draws; these steps only let a reader see when what a thread shows is no longer
 * what the model wrote.
 *
 * The existing `transform` kind carries them, so the run contract is unchanged, and a `transform`
 * step charges no model call, tool call or unit. The application writes them, so they carry its
 * origin, naming the model turn they came from as the producer; the model's own attribution stays
 * on that turn step (Pillar 07).
 */
import { createHash } from 'node:crypto';
import { applicationOrigin } from '../../shared/attribution.js';
import { indexArtifacts } from '../../shared/artifacts.js';
import { projectedTurnIds, turnIdentityText } from '../../shared/conversation-turn-id.js';
import type { HarnessRun, Json } from '../../shared/harness.js';
import { ARTIFACT_STEP_PREFIX, MAX_RECORDED_ARTIFACTS, type RecordedArtifact } from '../../shared/recorded-artifact.js';
import { digest } from './policy.js';
import type { StepDefinition } from './run-service.js';

export { ARTIFACT_STEP_PREFIX, MAX_RECORDED_ARTIFACTS, type RecordedArtifact };

/** The lowercase hex SHA-256 of a text's UTF-8 bytes. */
export const sourceDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The steps that record the artifacts in one answered message, oldest block first. `answer` is
 * the text the thread shows: the answer with its decision block removed, as the host projects it,
 * so an artifact written after the decision block, which the person never sees, is not recorded.
 */
export function artifactSteps(input: {
  runId: string;
  threadId: string;
  commandId: string;
  sourceMessageId: string;
  turnStepId: string;
  answer: string;
}): StepDefinition[] {
  const turnId = projectedTurnIds(sourceDigest(turnIdentityText(input.runId, input.commandId))).assistant;
  const { list } = indexArtifacts(input.threadId, [{ id: turnId, role: 'assistant', text: input.answer }]);
  return list.slice(0, MAX_RECORDED_ARTIFACTS).map((record) => {
    const recorded: RecordedArtifact = {
      v: 1,
      artifactId: record.key,
      declaredId: record.declaredId,
      kind: record.kind,
      lang: record.lang,
      title: record.title,
      sha256: sourceDigest(record.source),
      blockIndex: record.blockIndex,
      turnId,
      turnStepId: input.turnStepId,
      sourceMessageId: input.sourceMessageId,
    };
    return {
      id: `${ARTIFACT_STEP_PREFIX}${digest({ sourceMessageId: input.sourceMessageId, blockIndex: record.blockIndex }).slice(0, 40)}`,
      version: '1',
      kind: 'transform',
      effect: 'pure',
      name: `Artifact ${record.kind}`,
      input: recorded as unknown as Json,
      cost: 0,
      // Pure, so an attempt a crash left running is simply made again.
      maxAttempts: 3,
      destination: 'local',
      origin: { ...applicationOrigin(), producerId: input.turnStepId },
    };
  });
}

/**
 * What a replay of one message may still record, given the steps this build reads from its
 * answer. With none of the message's artifacts recorded: all of them, the case of a crash after
 * the answer was saved. With some recorded: the ones not yet written (what a crash between two of
 * them left), and only while this build reads every recorded block exactly as its step says. When
 * a parser change reads a recorded block differently (another digest, kind, title or position),
 * nothing is written, so a retried command is never refused as a conflict and a record is never
 * rewritten. A change that leaves every recorded block as it was can still add what it newly
 * reads, which the text holds too.
 */
export function unrecordedArtifacts(
  run: HarnessRun,
  sourceMessageId: string,
  steps: readonly StepDefinition[],
): StepDefinition[] {
  const recorded = run.steps.filter(
    (step) =>
      step.intent.stepId.startsWith(ARTIFACT_STEP_PREFIX) &&
      (step.intent.input as { sourceMessageId?: unknown } | null)?.sourceMessageId === sourceMessageId,
  );
  const sameReading = recorded.every((step) => {
    const definition = steps.find((candidate) => candidate.id === step.intent.stepId);
    return definition !== undefined && digest(definition.input ?? null) === digest(step.intent.input);
  });
  if (!sameReading) return [];
  return steps.filter(
    (definition) => recorded.find((step) => step.intent.stepId === definition.id)?.state !== 'succeeded',
  );
}
