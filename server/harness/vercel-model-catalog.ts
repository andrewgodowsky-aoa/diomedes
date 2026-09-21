import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { copy, HarnessError } from './policy.js';
import {
  bedrockRegionSchema,
  validateBedrockCredentials,
  type BedrockCredentials,
} from './vercel-model-adapter.js';

const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,199}$/);
const foundationSchema = z.object({
  modelSummaries: z
    .array(
      z.object({
        modelId,
        modelName: z.string().min(1).max(200),
        providerName: z.string().min(1).max(100),
        inputModalities: z.array(z.string()).max(10),
        outputModalities: z.array(z.string()).max(10),
        inferenceTypesSupported: z.array(z.string()).max(10),
        responseStreamingSupported: z.boolean(),
        modelLifecycle: z.object({ status: z.string().min(1).max(40) }),
      }),
    )
    .max(2000),
});
const profilesSchema = z.object({
  inferenceProfileSummaries: z
    .array(
      z.object({
        inferenceProfileId: modelId,
        inferenceProfileName: z.string().min(1).max(200),
        status: z.string().max(40),
        type: z.enum(['SYSTEM_DEFINED', 'APPLICATION']),
        models: z
          .array(z.object({ modelArn: z.string().max(2048) }))
          .min(1)
          .max(50),
      }),
    )
    .max(1000),
  nextToken: z.string().min(1).max(2048).optional(),
});

export interface BedrockCatalogModel {
  id: string;
  name: string;
  provider: string;
  scope: 'regional' | 'cross-region';
  lifecycle: string;
  inputModalities: string[];
  streaming: boolean;
  /** Discovery is not a successful inference probe or authorization to use this model. */
  access: 'unverified';
}
export interface BedrockCatalogSnapshot {
  accountRoute: string;
  region: string;
  state: 'fresh' | 'stale' | 'unavailable';
  fetchedAt: number | null;
  models: BedrockCatalogModel[];
  error: 'catalog_unavailable' | 'catalog_requires_sigv4' | null;
}

/** Account/region-scoped inventory. Refreshing discovery never replaces the chosen model. */
export class BedrockModelCatalog {
  private readonly credentials: BedrockCredentials;
  private readonly region: string;
  private readonly accountRoute: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly fetch: typeof globalThis.fetch;
  private nextRefreshAt = 0;
  private snapshot: BedrockCatalogSnapshot;
  private pending: Promise<BedrockCatalogSnapshot> | null = null;

  constructor(options: {
    accountRoute: string;
    region: string;
    credentials: BedrockCredentials;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.credentials = validateBedrockCredentials(options.credentials);
    this.region = bedrockRegionSchema.parse(options.region);
    this.accountRoute = z.string().min(1).max(200).parse(options.accountRoute);
    this.ttlMs = z
      .number()
      .int()
      .min(1)
      .max(86_400_000)
      .parse(options.ttlMs ?? 3_600_000);
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.snapshot = {
      accountRoute: this.accountRoute,
      region: this.region,
      state: 'unavailable',
      fetchedAt: null,
      models: [],
      error: null,
    };
  }

  async get(forceRefresh = false): Promise<BedrockCatalogSnapshot> {
    if (this.pending) return copy(await this.pending);
    if (!forceRefresh && this.now() < this.nextRefreshAt) return copy(this.snapshot);
    this.pending = this.refresh().finally(() => {
      this.pending = null;
    });
    return copy(await this.pending);
  }

  private async refresh(): Promise<BedrockCatalogSnapshot> {
    if (this.credentials.kind !== 'sigv4') {
      this.snapshot = { ...this.snapshot, error: 'catalog_requires_sigv4' };
      this.nextRefreshAt = this.now() + this.ttlMs;
      return this.snapshot;
    }
    const signer = new AwsClient({
      ...this.credentials,
      service: 'bedrock',
      region: this.region,
      retries: 0,
    });
    const signal = AbortSignal.timeout(15_000);
    const read = async (pathname: string) => {
      const request = await signer.sign(`https://bedrock.${this.region}.amazonaws.com${pathname}`, {
        method: 'GET',
        signal,
        redirect: 'error',
      });
      const response = await this.fetch(request);
      if (!response.ok) {
        await response.body?.cancel();
        throw new HarnessError('catalog_unavailable', 'AWS model discovery is unavailable.');
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new HarnessError('catalog_unavailable', 'AWS model discovery returned no data.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_048_576) {
            await reader.cancel();
            throw new HarnessError(
              'catalog_unavailable',
              'AWS model discovery exceeded its response limit.',
            );
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    };
    try {
      const foundation = foundationSchema.parse(
        await read('/foundation-models?byOutputModality=TEXT'),
      );
      const models = new Map<string, BedrockCatalogModel>();
      const textModels = foundation.modelSummaries.filter((model) =>
        model.outputModalities.includes('TEXT'),
      );
      for (const model of textModels) {
        if (!model.inferenceTypesSupported.includes('ON_DEMAND')) continue;
        models.set(model.modelId, {
          id: model.modelId,
          name: model.modelName,
          provider: model.providerName,
          scope: 'regional',
          lifecycle: model.modelLifecycle.status,
          inputModalities: model.inputModalities,
          streaming: model.responseStreamingSupported,
          access: 'unverified',
        });
      }
      let token: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 10)
          throw new HarnessError(
            'catalog_unavailable',
            'AWS model discovery exceeded its page limit.',
          );
        const query = new URLSearchParams({
          maxResults: '1000',
          type: 'SYSTEM_DEFINED',
          ...(token ? { nextToken: token } : {}),
        });
        const profiles = profilesSchema.parse(await read(`/inference-profiles?${query}`));
        for (const profile of profiles.inferenceProfileSummaries) {
          if (profile.type !== 'SYSTEM_DEFINED' || profile.status !== 'ACTIVE') continue;
          const baseIds = new Set(
            profile.models.map((model) => model.modelArn.split(':foundation-model/').at(-1)),
          );
          const base = textModels.find((model) => baseIds.has(model.modelId));
          if (!base || baseIds.size !== 1) continue;
          models.set(profile.inferenceProfileId, {
            id: profile.inferenceProfileId,
            name: profile.inferenceProfileName,
            provider: base.providerName,
            scope: 'cross-region',
            lifecycle: base.modelLifecycle.status,
            inputModalities: base.inputModalities,
            streaming: base.responseStreamingSupported,
            access: 'unverified',
          });
        }
        token = profiles.nextToken;
        if (!token) break;
        if (seen.has(token))
          throw new HarnessError('catalog_unavailable', 'AWS model discovery repeated a page.');
        seen.add(token);
      }
      const at = this.now();
      this.snapshot = {
        accountRoute: this.accountRoute,
        region: this.region,
        state: 'fresh',
        fetchedAt: at,
        models: [...models.values()].sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        ),
        error: null,
      };
      this.nextRefreshAt = at + this.ttlMs;
    } catch {
      // Discovery is advisory. A failed refresh retains its dated prior inventory and exposes failure.
      // Provider errors may contain credentials, so only this closed error code crosses the boundary.
      this.snapshot = {
        ...this.snapshot,
        state: this.snapshot.fetchedAt === null ? 'unavailable' : 'stale',
        error: 'catalog_unavailable',
      };
      this.nextRefreshAt = this.now() + Math.min(this.ttlMs, 30_000);
    }
    return this.snapshot;
  }
}
