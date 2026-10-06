/**
 * A model that runs on this computer, described by the folder it is installed in (DIO-201).
 *
 * A local model is a folder holding `nectovia-connection.json`, which the model's installer
 * writes. Nectovia reads it and never edits it: the model's name and server address, its profiles
 * and the scripts that start and stop it. What the ask box shows comes from that file and from the
 * running server (`server/bonsai/probe.ts`): the model's name from the server's model list, the
 * context from the running profile and the state from a health check. Nothing here names a model.
 *
 * Client and server share this module, so it reads no files. The server adds the checks that need
 * the disk, such as where a script really resolves to (`server/bonsai/descriptor.ts`).
 */
import { z } from 'zod';
import type { EngineModel } from './types.js';
import { AGENT_NAME } from './agent-name.js';
import { formatTokens } from './context-accounting.js';

/**
 * The route id saved threads, work and settings carry. It keeps the value it was first saved with
 * (DIO-201 decision 6), so no saved record needs a migration.
 */
export const LOCAL_MODEL_ROUTE = 'bonsai' as const;
/** The account route local work runs under. A saved value too, so it keeps its first spelling. */
export const LOCAL_MODEL_ACCOUNT = 'bonsai:local';
/** The file a local model's installer writes into its folder. */
export const LOCAL_MODEL_DESCRIPTOR = 'nectovia-connection.json';

/** The reasoning levels a local profile offers. The local chat template reads the level by name. */
export const LOCAL_MODEL_EFFORTS = [
  { id: 'medium', label: 'Medium', description: 'More reasoning.' },
  { id: 'xhigh', label: 'Extra', description: "Extended reasoning within this profile's output limit." },
] as const;
const DEFAULT_EFFORT = 'medium';

export interface LocalEffortBudget {
  thinking: boolean;
  reasoningTokens: number;
  outputTokens: number;
}
export interface LocalMeasuredRates {
  occupiedContextTokens: number;
  prefillTokensPerSecond: number;
  decodeTokensPerSecond: number;
}

/** One of the descriptor's profiles, as an entry in the local route's catalogue. */
export interface LocalModelProfile extends EngineModel {
  /** `local:` and the profile's name in lower case: `local:gaming`. */
  slug: string;
  /** The profile's name in the descriptor, which is also the value its start script takes. */
  mode: string;
  engineLabel: string;
  contextTokens: number;
  maxOutputTokens: number;
  callTimeoutMs: number;
  turnTimeoutMs: number;
  effortBudgets?: Record<'medium' | 'xhigh', LocalEffortBudget>;
  measuredRates?: LocalMeasuredRates;
  qualifiedTaskTotalWindow?: number;
  configuredTotalWindow?: number;
  inputModalities: readonly ('text' | 'image')[];
}

/** A descriptor that passed every check this module can make. */
export interface LocalModelDescriptor {
  /** The folder the descriptor was read from. */
  folder: string;
  /** The integration's label: the descriptor's `name`. */
  name: string;
  /** The model id the descriptor declares. The running server must list it. */
  model: string;
  /** The OpenAI-compatible base, with no trailing slash: `http://127.0.0.1:8080/v1`. */
  baseUrl: string;
  /** The server's own root, the base without its `/v1`, where llama.cpp answers `/props`. */
  serverRoot: string;
  healthUrl: string;
  profiles: readonly LocalModelProfile[];
  lifecycle: {
    startScript: string;
    stopScript: string;
    /** The start script's parameter that takes the profile's name, without its dash: `Mode`. */
    modeParameter: string;
  };
}

export type LocalModelState = 'missing' | 'unloaded' | 'starting' | 'ready' | 'busy' | 'insufficient-memory' | 'error';

/** The local model's state, from its health check and what its server reports. */
export interface LocalModelStatus {
  state: LocalModelState;
  installed: boolean;
  /**
   * The running profile's name: the descriptor profile whose context is the one the server runs.
   * Null while nothing runs, or when the server runs a context no profile declares.
   */
  mode: string | null;
  /** The model id the server lists, while it answers. */
  model?: string | null;
  /** The context the server runs, as it reports it, while it answers. */
  contextTokens?: number | null;
  owned: boolean;
  detail: string;
}

/** Where the local model's folder came from. */
export interface LocalModelFolder {
  path: string;
  source: 'settings' | 'environment';
}

/** What `GET /api/ai/local-models` answers. */
export interface LocalModelsView {
  route: typeof LOCAL_MODEL_ROUTE;
  kind: 'local';
  /** The descriptor's name, or null when no descriptor was read. */
  name: string | null;
  folder: LocalModelFolder | null;
  status: LocalModelStatus;
  models: readonly LocalModelProfile[];
}

/** A descriptor this module refused. The message is the sentence a person reads. */
export class LocalModelDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalModelDescriptorError';
  }
}

// Read only what is used. Every object strips the keys it does not name, so an installer may
// write more than this without the descriptor being refused.
const effortBudgetSchema = z.object({
  thinking: z.boolean(),
  reasoningTokens: z.number().int().min(0).max(1_000_000),
  outputTokens: z.number().int().min(1).max(1_000_000),
});
const profileSchema = z.object({
  contextTokens: z.number().int().min(512).max(10_000_000),
  inputModalities: z.array(z.string()).min(1).max(8),
  outputTokens: z.number().int().min(1).max(1_000_000),
  defaultReasoningEffort: z.string().max(40).optional(),
  effortBudgets: z.strictObject({ medium: effortBudgetSchema, xhigh: effortBudgetSchema }).optional(),
  measuredRates: z.object({
    occupiedContextTokens: z.number().int().min(1).max(10_000_000),
    prefillTokensPerSecond: z.number().positive().max(10_000_000),
    decodeTokensPerSecond: z.number().positive().max(10_000_000),
  }).optional(),
  qualifiedTaskTotalWindow: z.number().int().min(512).max(10_000_000).optional(),
  configuredTotalWindow: z.number().int().min(512).max(10_000_000).optional(),
});
const descriptorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
  openaiCompatibleBaseUrl: z.string().max(400),
  profiles: z.record(z.string(), profileSchema),
  lifecycle: z.object({
    startScript: z.string().min(1).max(400),
    startModeArgument: z.string().min(1).max(200),
    stopScript: z.string().min(1).max(400),
    healthUrl: z.string().max(400),
  }),
});

const FILE = LOCAL_MODEL_DESCRIPTOR;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** A profile name is also a script argument and part of a slug, so it is kept plain. */
const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_PROFILES = 8;
/** Characters Windows refuses in a file name, plus control characters. */
const BAD_NAME = /[<>:"|?*\u0000-\u001f]/;
const MINUTE = 60_000;

const refuse = (sentence: string): never => {
  throw new LocalModelDescriptorError(sentence);
};

/** Plain `http` on this computer, with nothing but a host, a port and a path. */
function loopback(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url;
}

/**
 * A script named by the descriptor, as a path inside its folder, or null when it is not a `.ps1`
 * file there. A relative name is read from the folder. Judged by its spelling here; the server
 * also checks where it really resolves to. The path keeps the folder's own separator, so a folder
 * on a computer that writes `/` is read the same way.
 */
export function localScriptPath(value: string, folder: string): string | null {
  const sep = folder.trim().startsWith('/') ? '/' : '\\';
  const text = value.trim().replace(/[\\/]/g, sep);
  const root = folder.trim().replace(/[\\/]/g, sep).replace(/[\\/]+$/, '');
  if (!root || !/\.ps1$/i.test(text)) return null;
  let relative = text;
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith(sep)) {
    if (!text.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) return null;
    relative = text.slice(root.length + 1);
  }
  const parts = relative.split(sep);
  if (parts.some((part) => !part || part === '.' || part === '..' || BAD_NAME.test(part))) return null;
  return `${root}${sep}${parts.join(sep)}`;
}

/** The slug a profile name is listed under. */
export const localProfileSlug = (name: string): string => `local:${name.toLowerCase()}`;

/**
 * Profile slugs saved before profiles came from the descriptor, and the profile each meant. Threads,
 * settings and work saved with them keep working wherever the descriptor has that profile.
 */
const SAVED_PROFILES: Readonly<Record<string, string>> = { 'bonsai-gaming': 'Gaming', 'bonsai-full': 'Full' };

/** A saved profile slug as it is listed now. Any other value is returned as it is. */
export function localSlug(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const saved = SAVED_PROFILES[value];
  return saved ? localProfileSlug(saved) : value;
}

/** The descriptor's profile a slug names, including a slug saved before profiles came from it. */
export function findLocalProfile(
  descriptor: Pick<LocalModelDescriptor, 'profiles'> | null | undefined,
  value: unknown,
): LocalModelProfile | undefined {
  const slug = localSlug(value);
  return slug ? descriptor?.profiles.find((profile) => profile.slug === slug) : undefined;
}

/** Why a slug names no profile, in a sentence a person can act on. */
export function localProfileRefusal(value: unknown): string {
  const saved = typeof value === 'string' ? SAVED_PROFILES[value] : undefined;
  return saved
    ? `The local model has no ${saved} profile now. Choose one of its profiles.`
    : LOCAL_MODEL_UNKNOWN_PROFILE;
}
export const LOCAL_MODEL_UNKNOWN_PROFILE = 'Choose a local model profile.';

/**
 * How long one call and one turn on a profile may take. The descriptor names no deadline, so they
 * follow the profile's output allowance: fifteen minutes for each 32,768 output tokens, at least
 * two minutes a call, and a turn of up to four calls, never more than thirty minutes.
 */
export function localDeadlines(outputTokens: number): { callTimeoutMs: number; turnTimeoutMs: number } {
  const callTimeoutMs = Math.min(30 * MINUTE, Math.max(2 * MINUTE, Math.ceil((outputTokens / 32_768) * 15 * MINUTE)));
  return { callTimeoutMs, turnTimeoutMs: Math.min(30 * MINUTE, 4 * callTimeoutMs) };
}

/** NC-MEM-LC section 8 terms, kept separate from serialization admission. */
export function localContextBudget(profile: LocalModelProfile, options: {
  nativeTotalWindow?: number; outputReserve?: number;
} = {}) {
  const nativeTotalWindow = Math.min(profile.contextTokens, options.nativeTotalWindow ?? profile.contextTokens);
  const qualifiedTaskTotalWindow = profile.qualifiedTaskTotalWindow ?? profile.contextTokens;
  const configuredTotalWindow = profile.configuredTotalWindow ?? profile.contextTokens;
  const totalWindow = Math.min(nativeTotalWindow, qualifiedTaskTotalWindow, configuredTotalWindow);
  const outputReserve = options.outputReserve ?? profile.maxOutputTokens;
  const protocolAndNextToolReserve = 2_048;
  const safetyMargin = 1_024;
  const inputRoom = Math.max(0, totalWindow - outputReserve - protocolAndNextToolReserve - safetyMargin);
  // 2.49883 bytes/token on the ledger; four adds margin. These are not token counts.
  const sourceBytes = Math.min(8_000_000, inputRoom * 4);
  const requestBytes = Math.min(24_000_000, sourceBytes * 2 + 64_000);
  return { nativeTotalWindow, qualifiedTaskTotalWindow, configuredTotalWindow,
    totalWindow, outputReserve, protocolAndNextToolReserve, safetyMargin, inputRoom,
    sourceBytes, sourceChars: sourceBytes, toolChars: sourceBytes,
    turnChars: sourceBytes + 16_384, requestBytes, templateResponseBytes: requestBytes,
    transcriptBytes: Math.min(24_000_000, requestBytes * 2 + 2_097_152),
    responseBytes: Math.min(24_000_000, Math.max(1_048_576, outputReserve * 1_024)) };
}

/** A local allowance in the KB the fixed limits already use (128 KB is 128,000 bytes), rounded down. */
export const localKilobytes = (bytes: number) => `${Math.floor(bytes / 1_000).toLocaleString('en-US')} KB`;

/** The refusal for selected sources past the local profile's reading allowance, in each surface's own verb. */
export const localSourceRefusal = (verb: 'Select no more than' | 'Choose less than', bytes: number) =>
  `${verb} ${localKilobytes(bytes)} of source text for this local model profile.`;

/** Rates affect time only; they do not qualify other tasks or widen their input room. */
export function localCallCeiling(profile: Pick<LocalModelProfile, 'measuredRates' | 'callTimeoutMs'>,
  promptTokens: number, outputTokens: number): number {
  if (!profile.measuredRates) return profile.callTimeoutMs;
  const rates = profile.measuredRates;
  return Math.max(profile.callTimeoutMs, Math.ceil(1_500 *
    (promptTokens / rates.prefillTokensPerSecond + outputTokens / rates.decodeTokensPerSecond)) + 30_000);
}

/** What a profile takes and holds, in the words the ask row uses. */
const profileLine = (images: boolean, context: number) =>
  `${images ? 'Text and images' : 'Text only'}, ${formatTokens(context)} context.`;

/**
 * Checks a parsed `nectovia-connection.json` and returns the descriptor, or throws a
 * `LocalModelDescriptorError` whose sentence names the field. `folder` is the absolute folder the
 * file was read from: the start and stop scripts must be `.ps1` files inside it.
 */
export function parseLocalModelDescriptor(raw: unknown, folder: string): LocalModelDescriptor {
  const parsed = descriptorSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.map(String).join('.') ?? '';
    refuse(field ? `${FILE} has no valid ${field}.` : `${FILE} is not a local model description.`);
  }
  const value = parsed.data!;
  const base = loopback(value.openaiCompatibleBaseUrl);
  if (!base)
    refuse(`openaiCompatibleBaseUrl in ${FILE} must be plain http on this computer: 127.0.0.1, localhost or [::1].`);
  const health = loopback(value.lifecycle.healthUrl);
  if (!health || health.origin !== base!.origin)
    refuse(`lifecycle.healthUrl in ${FILE} must be on the same address as openaiCompatibleBaseUrl.`);
  const startScript = localScriptPath(value.lifecycle.startScript, folder);
  if (!startScript) refuse(`lifecycle.startScript in ${FILE} must be a .ps1 file inside ${folder}.`);
  const stopScript = localScriptPath(value.lifecycle.stopScript, folder);
  if (!stopScript) refuse(`lifecycle.stopScript in ${FILE} must be a .ps1 file inside ${folder}.`);
  const modeParameter = /^\s*-([A-Za-z][A-Za-z0-9]{0,39})(?![A-Za-z0-9])/.exec(value.lifecycle.startModeArgument)?.[1];
  if (!modeParameter)
    refuse(`lifecycle.startModeArgument in ${FILE} must start with the start script's parameter, such as -Mode.`);

  const entries = Object.entries(value.profiles);
  if (!entries.length) refuse(`profiles in ${FILE} lists no profile.`);
  if (entries.length > MAX_PROFILES) refuse(`profiles in ${FILE} lists more than ${MAX_PROFILES} profiles.`);
  const seen = new Set<string>();
  const profiles = entries.map(([name, profile]): LocalModelProfile => {
    if (!PROFILE_NAME.test(name))
      refuse(`profiles in ${FILE} has a profile named "${name.slice(0, 40)}". A profile name starts with a letter and uses only letters, digits, - and _.`);
    const slug = localProfileSlug(name);
    if (seen.has(slug)) refuse(`profiles in ${FILE} has two profiles named "${name}".`);
    seen.add(slug);
    if (!profile.inputModalities.includes('text'))
      refuse(`profiles.${name}.inputModalities in ${FILE} must include text.`);
    if (profile.outputTokens >= profile.contextTokens)
      refuse(`profiles.${name}.outputTokens in ${FILE} must be smaller than its contextTokens.`);
    for (const field of ['qualifiedTaskTotalWindow', 'configuredTotalWindow'] as const) {
      const window = profile[field];
      if (window !== undefined && (window > profile.contextTokens || window <= profile.outputTokens))
        refuse(`profiles.${name}.${field} in ${FILE} must exceed outputTokens and not exceed contextTokens.`);
    }
    if (profile.measuredRates && profile.measuredRates.occupiedContextTokens > profile.contextTokens)
      refuse(`profiles.${name}.measuredRates.occupiedContextTokens in ${FILE} must not exceed contextTokens.`);
    if (profile.effortBudgets) for (const effort of ['medium', 'xhigh'] as const) {
      const budget = profile.effortBudgets[effort];
      if (budget.outputTokens > profile.outputTokens)
        refuse(`profiles.${name}.effortBudgets.${effort}.outputTokens in ${FILE} must not exceed the profile's outputTokens.`);
      if (budget.reasoningTokens >= budget.outputTokens || (!budget.thinking && budget.reasoningTokens !== 0))
        refuse(`profiles.${name}.effortBudgets.${effort}.reasoningTokens in ${FILE} must leave room for an answer and be zero when thinking is off.`);
    }
    const inputModalities: ('text' | 'image')[] = profile.inputModalities.includes('image') ? ['text', 'image'] : ['text'];
    const defaultEffort = LOCAL_MODEL_EFFORTS.some((level) => level.id === profile.defaultReasoningEffort)
      ? profile.defaultReasoningEffort!
      : DEFAULT_EFFORT;
    const deadlines = localDeadlines(profile.outputTokens);
    if (profile.measuredRates) {
      deadlines.callTimeoutMs = localCallCeiling({ ...deadlines, measuredRates: profile.measuredRates },
        profile.contextTokens, profile.outputTokens);
      deadlines.turnTimeoutMs = 4 * deadlines.callTimeoutMs;
      if (deadlines.turnTimeoutMs > 2_147_483_647 - 60_000)
        refuse(`profiles.${name}.measuredRates in ${FILE} imply a deadline beyond the supported timer limit.`);
    }
    return {
      slug,
      name: `${value.model} ${name}`,
      mode: name,
      engineLabel: AGENT_NAME,
      description: profileLine(inputModalities.includes('image'), profile.contextTokens),
      contextTokens: profile.contextTokens,
      maxOutputTokens: profile.outputTokens,
      inputModalities,
      ...deadlines,
      ...(profile.effortBudgets ? { effortBudgets: profile.effortBudgets } : {}),
      ...(profile.measuredRates ? { measuredRates: profile.measuredRates } : {}),
      ...(profile.qualifiedTaskTotalWindow !== undefined ? { qualifiedTaskTotalWindow: profile.qualifiedTaskTotalWindow } : {}),
      ...(profile.configuredTotalWindow !== undefined ? { configuredTotalWindow: profile.configuredTotalWindow } : {}),
      defaultEffort,
      efforts: LOCAL_MODEL_EFFORTS.map((level) => ({ ...level })),
    };
  });
  const path = base!.pathname.replace(/\/+$/, '');
  return {
    folder,
    name: value.name,
    model: value.model,
    baseUrl: `${base!.origin}${path}`,
    serverRoot: `${base!.origin}${path.replace(/\/v1$/i, '')}`,
    healthUrl: health!.href,
    profiles,
    lifecycle: { startScript: startScript!, stopScript: stopScript!, modeParameter: modeParameter! },
  };
}

/**
 * The profiles as the ask row lists them: named for the model the server lists while it runs, and
 * with the running profile's context as the server reports it. The others keep what the
 * descriptor declares.
 */
export function localModelCatalog(descriptor: LocalModelDescriptor, status: LocalModelStatus | null): LocalModelProfile[] {
  const running = status !== null && (status.state === 'ready' || status.state === 'busy');
  const served = running && status.model ? status.model : null;
  return descriptor.profiles.map((profile) => {
    const loaded = running && status.mode === profile.mode && typeof status.contextTokens === 'number';
    const contextTokens = loaded ? status.contextTokens! : profile.contextTokens;
    return {
      ...profile,
      name: served ? `${served} ${profile.mode}` : profile.name,
      description: profileLine(profile.inputModalities.includes('image'), contextTokens),
      contextTokens,
      inputModalities: [...profile.inputModalities],
      efforts: profile.efforts.map((level) => ({ ...level })),
    };
  });
}
