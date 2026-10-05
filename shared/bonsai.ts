import type { EngineModel } from './types.js';

/** Profile identity is distinct from the model alias sent to the local server. */
export const BONSAI_ROUTE = 'bonsai' as const;
export const BONSAI_MODEL = 'bonsai-2-27b';
export const BONSAI_ACCOUNT = 'bonsai:local';
export const BONSAI_BASE_URL = 'http://127.0.0.1:18082';
export const BONSAI_EFFORTS = [
  { id: 'medium', label: 'Medium', description: 'More reasoning.' },
  { id: 'xhigh', label: 'Extra', description: 'Extended reasoning within this profile\'s output limit.' },
] as const;
export type BonsaiMode = 'Gaming' | 'Full';
export type BonsaiProfileId = 'bonsai-gaming' | 'bonsai-full';
export interface BonsaiProfile extends EngineModel {
  slug: BonsaiProfileId;
  mode: BonsaiMode;
  model: typeof BONSAI_MODEL;
  engineLabel: 'Nectovia';
  contextTokens: number;
  maxOutputTokens: number;
  callTimeoutMs: number;
  turnTimeoutMs: number;
  inputModalities: readonly ('text' | 'image')[];
}
export const BONSAI_PROFILES: readonly BonsaiProfile[] = [
  { slug: 'bonsai-gaming', name: 'Bonsai Gaming', mode: 'Gaming', model: BONSAI_MODEL,
    engineLabel: 'Nectovia', description: 'PrismML Ternary Bonsai 2 27B. Text only, 16K context.',
    contextTokens: 16_384, maxOutputTokens: 4_096, inputModalities: ['text'],
    callTimeoutMs: 120_000, turnTimeoutMs: 480_000,
    defaultEffort: 'medium', efforts: BONSAI_EFFORTS.map(e => ({ ...e })) },
  { slug: 'bonsai-full', name: 'Bonsai Full', mode: 'Full', model: BONSAI_MODEL,
    engineLabel: 'Nectovia', description: 'PrismML Ternary Bonsai 2 27B. Text and images, 128K context.',
    contextTokens: 131_072, maxOutputTokens: 32_768, inputModalities: ['text', 'image'],
    callTimeoutMs: 900_000, turnTimeoutMs: 1_800_000,
    defaultEffort: 'xhigh', efforts: BONSAI_EFFORTS.map(e => ({ ...e })) },
];
export const bonsaiProfile = (id: unknown): BonsaiProfile | undefined =>
  BONSAI_PROFILES.find(profile => profile.slug === id);

export type BonsaiState = 'missing' | 'unloaded' | 'starting' | 'ready' | 'busy' | 'insufficient-memory' | 'error';
export interface BonsaiStatus {
  state: BonsaiState;
  installed: boolean;
  mode: BonsaiMode | null;
  owned: boolean;
  detail: string;
}
export interface LocalModelsView {
  route: typeof BONSAI_ROUTE;
  kind: 'local';
  status: BonsaiStatus;
  models: readonly BonsaiProfile[];
}

// The image bounds live in a module that names no model, so the client can share them.
export { imageMediaType, MODEL_IMAGE_COUNT, MODEL_IMAGE_LIMIT, type ModelImage } from './model-images.js';

/** The reskin renders each field separately and preserves the existing agent/effort controls. */
export function bonsaiSelectionFields(model: string, effort: string | null, agentLabel: string) {
  const profile = bonsaiProfile(model);
  if (!profile) return null;
  const level = BONSAI_EFFORTS.find(item => item.id === (effort ?? profile.defaultEffort));
  return { engine: profile.engineLabel, profile: profile.name,
    effort: level?.label ?? effort ?? '', agent: agentLabel,
    contextTokens: profile.contextTokens, inputModalities: profile.inputModalities };
}
