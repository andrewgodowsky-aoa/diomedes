/**
 * The configuration HTTP surface.
 *
 * A person's screen compiles, reviews, activates and rolls back a business
 * setup through these routes. The routes own almost nothing on purpose:
 * parsing, refusing malformed input before it reaches the service, and the
 * store lock. Every authority question — who may configure, whether a
 * candidate is safe, whether activation wins its compare-and-set — is answered
 * by `ConfigurationService`, because a rule that lives in two places disagrees
 * with itself exactly when it matters.
 *
 * Mutating routes run inside `store.locked()`, matching the workspace routes:
 * staging, activating and rolling back all write durable state the store
 * already serializes, and the per-route lock is what stops two concurrent
 * compiles from reading the same manifest list and staging the same revision
 * twice. The view is a read and queues behind nothing.
 *
 * The screen may name at most a variant. A proposal is built here, from the
 * recorded answers, by the host — a proposal received over HTTP would be
 * exactly the model-authored executable setup the contract refuses, whatever
 * its sender claims to be.
 */
import type { Express, Request, Response } from 'express';
import { readyForProposal } from '../shared/business-setup.js';
import type { KnownAgent } from '../shared/configuration.js';
import {
  WEEKLY_BRIEF_VARIANTS,
  compileProposal,
  variantFor,
  type PackVariantId,
} from '../shared/packs.js';
import type { AgentRegistry } from './agents.js';
import type { ConfigurationService } from './configuration.js';
import { ApiError } from './paths.js';
import type { Store } from './store.js';
import type { WorkspaceService } from './workspaces.js';

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

const organizationId = (req: Request) => String(req.params.organizationId ?? '');

/** The variants this build offers, read from the pack rather than repeated here. */
const VARIANT_IDS: readonly string[] = Object.keys(WEEKLY_BRIEF_VARIANTS);

const invalidActivation = () =>
  new ApiError(
    400,
    'Provide the revision, the active revision it was read against, and an activation id of up to 120 characters.',
    { code: 'invalid_activation' },
  );

const whole = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 1;

/**
 * Parse-and-refuse only. Whether the revision exists, is still staged, is
 * ready, and matches the current active revision is the service's
 * compare-and-set, never a second copy of it here.
 */
function requireActivationInput(
  value: Record<string, unknown>,
  key: 'revision' | 'toRevision',
): { target: number; expectedActiveRevision: number | null; activationId: string } {
  const revision = value[key];
  const expected = value.expectedActiveRevision;
  const id = typeof value.activationId === 'string' ? value.activationId : '';
  if (!whole(revision)) throw invalidActivation();
  if (expected !== null && !whole(expected)) throw invalidActivation();
  if (id.trim() === '' || id.length > 120) throw invalidActivation();
  return { target: revision, expectedActiveRevision: expected, activationId: id };
}

export function mountConfigurationRoutes(
  app: Express,
  store: Store,
  workspaces: WorkspaceService,
  configuration: ConfigurationService,
  agents: AgentRegistry,
) {
  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };

  // Unlocked: the view is answered from memory. A stale screen stays safe
  // because activation compares against the expected active revision, not
  // because reads are serialized.
  app.get(
    '/api/workspace/organizations/:organizationId/configuration',
    route(async (req) => configuration.view(organizationId(req)), false),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/configuration/compile',
    route(async (req) => {
      const value = body(req);
      // The body may only ever carry a variant choice, and every other field is
      // refused before anything is read — including one shaped exactly like a
      // proposal. The host builds proposals from the recorded answers; a
      // proposal arriving over HTTP would be the model-generated executable
      // setup the contract refuses.
      for (const key of Object.keys(value))
        if (key !== 'variantId')
          throw new ApiError(
            400,
            'This route accepts a variant choice and nothing else. A setup proposal is built here from the recorded answers, never received from a caller.',
            { code: 'invalid_compile_body' },
          );
      const id = organizationId(req);
      // Authority first. Reading the intake would otherwise answer "switch to
      // that workspace first" to somebody who is not in this business at all.
      configuration.assertMayConfigure(id);
      const setup = workspaces.setupView(id);
      if (!readyForProposal(setup.answers))
        throw new ApiError(
          409,
          'This business has not finished its questionnaire yet. Answer the remaining questions, then compile the setup again.',
          { code: 'setup_incomplete' },
        );
      // The answers pick a variant by default. The caller may only choose
      // between the variants this build offers, never name a new one.
      let variantId = variantFor(setup.answers);
      if (value.variantId !== undefined) {
        const requested = String(value.variantId);
        if (!VARIANT_IDS.includes(requested))
          throw new ApiError(400, 'Choose one of the setup variants this build offers.', {
            code: 'invalid_variant',
          });
        variantId = requested as PackVariantId;
      }
      // Connected connections and team execution come from the same live
      // context the validator will read, so the compiler and the validator
      // cannot hold different beliefs about what this machine can do.
      const context = await configuration.context(id);
      // Live Agent facts, straight from the registry. Its short cache means
      // this and the validator's own read are the same revision of the truth.
      const { agents: live } = await agents.list();
      const knownAgents = new Map<string, KnownAgent>(
        live.map((item) => [
          item.id,
          {
            version: item.version,
            digest: item.digest,
            requires: item.requires,
            permissionCeiling: item.permissionCeiling,
          },
        ]),
      );
      const proposal = compileProposal({
        organizationId: id,
        tenantId: context.tenantId,
        answers: setup.answers,
        // The digest rides with the answer snapshot, so the proposal and the
        // gate that approved it are formed from exactly the same bytes.
        answersDigest: setup.digest,
        previousConfigurationDigest: configuration.active(id)?.digest ?? null,
        variantId,
        agents: knownAgents,
        teamExecutionAvailable: context.teamExecutionAvailable,
        connectedConnections: context.connectedConnections,
        at: new Date().toISOString(),
        by: workspaces.currentPerson().id,
      });
      await configuration.stage(id, proposal);
      return configuration.view(id);
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/configuration/activate',
    route(async (req) => {
      // The activation id is the caller's idempotency key: repeating it is how
      // a retried request stays safe, replaying the recorded result instead of
      // preparing anything a second time.
      const { target, expectedActiveRevision, activationId } = requireActivationInput(
        body(req),
        'revision',
      );
      const id = organizationId(req);
      await configuration.activate(id, {
        revision: target,
        expectedActiveRevision,
        activationId,
      });
      return configuration.view(id);
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/configuration/rollback',
    route(async (req) => {
      const { target, expectedActiveRevision, activationId } = requireActivationInput(
        body(req),
        'toRevision',
      );
      const id = organizationId(req);
      await configuration.rollback(id, {
        toRevision: target,
        expectedActiveRevision,
        activationId,
      });
      return configuration.view(id);
    }),
  );
}
