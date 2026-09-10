import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineCatalog, EngineModel } from '../shared/types';

/**
 * What an engine can be asked to run, read from the engine's own list rather
 * than a list written into this app. Codex keeps its catalogue in CODEX_HOME,
 * refreshed by the same runtime Diomedes starts, so the picker follows the
 * account: a model that appears for the person's ChatGPT plan appears here, and
 * one that is withdrawn stops being offered without a Diomedes release.
 *
 * Every field is projected and bounded. The cache on disk is a few hundred
 * kilobytes and carries instruction text Diomedes has no business forwarding,
 * so only the slug, name, one sentence and the reasoning ladder cross over.
 */

const MAX_MODELS = 40;
const MAX_EFFORTS = 12;
const MAX_TEXT = 240;

function codexHome(): string {
  const set = process.env.CODEX_HOME?.trim();
  return set ? set : path.join(os.homedir(), '.codex');
}

export function codexCachePath(): string {
  return path.join(codexHome(), 'models_cache.json');
}

function text(value: unknown, limit = MAX_TEXT): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** Project one cache entry, or null when it is not a usable listed model. */
function projectModel(raw: unknown): EngineModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const slug = text(m.slug, 120);
  if (!slug) return null;
  // 'list' is the runtime's own word for a model it offers in its picker;
  // anything else is internal or withdrawn and must not be offered here.
  if (m.visibility !== 'list') return null;
  const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
  const efforts: EngineModel['efforts'] = [];
  for (const level of levels.slice(0, MAX_EFFORTS)) {
    if (!level || typeof level !== 'object') continue;
    const id = text((level as Record<string, unknown>).effort, 40);
    if (id) efforts.push({ id, description: text((level as Record<string, unknown>).description) });
  }
  const fallback = text(m.default_reasoning_level, 40);
  return {
    slug,
    name: text(m.display_name, 120) || slug,
    description: text(m.description),
    // Only offer a default the model actually supports, so a stale cache entry
    // cannot preselect an effort the runtime would reject.
    defaultEffort: efforts.some((e) => e.id === fallback) ? fallback : (efforts[0]?.id ?? null),
    efforts,
  };
}

let cached: { key: string; catalog: EngineCatalog } | null = null;
const externalCatalogs = new Map<string, EngineCatalog>();
/** Only a completed, bounded adapter inspection supplies these catalogues. */
export function recordEngineCatalog(catalog: EngineCatalog): void {
  externalCatalogs.set(catalog.engine, structuredClone(catalog));
}

/** The Codex catalogue, or an empty one with a plain sentence saying why. */
export function codexCatalog(): EngineCatalog {
  const file = codexCachePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {
      engine: 'codex',
      models: [],
      detail: 'Codex has not written its list yet. It appears after the next Codex run.',
    };
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (cached?.key === key) return cached.catalog;
  let models: EngineModel[] = [];
  let detail: string;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = (parsed as { models?: unknown })?.models;
    const rows = Array.isArray(list) ? list : [];
    models = rows
      .map(projectModel)
      .filter((m): m is EngineModel => m !== null)
      // The runtime's own ordering: lower priority first, best model at the top.
      .sort((a, b) => order(rows, a) - order(rows, b))
      .slice(0, MAX_MODELS);
    detail = models.length
      ? 'Read from the list Codex keeps for this account.'
      : 'Codex reported no choices for this account.';
  } catch {
    models = [];
    detail = 'Codex list could not be read. It is rewritten after the next Codex run.';
  }
  const catalog: EngineCatalog = { engine: 'codex', models, detail };
  cached = { key, catalog };
  return catalog;
}

function order(rows: unknown[], model: EngineModel): number {
  const row = rows.find(
    (r) => r && typeof r === 'object' && (r as Record<string, unknown>).slug === model.slug,
  ) as Record<string, unknown> | undefined;
  const priority = row?.priority;
  return typeof priority === 'number' ? priority : Number.MAX_SAFE_INTEGER;
}

/** Only Codex reports a catalogue in this version; the rest say so plainly. */
export function engineCatalog(engine: string): EngineCatalog {
  if (engine === 'codex') return codexCatalog();
  const external = externalCatalogs.get(engine);
  if (external) return structuredClone(external);
  if (engine === 'sample')
    return { engine, models: [], detail: 'Sample work is deterministic and has no choices.' };
  return { engine, models: [], detail: 'This engine does not report its choices to Diomedes yet.' };
}

/** True when the engine offers this pair, so a stale saved choice is never sent. */
export function isKnownChoice(engine: string, model: string, effort: string | null): boolean {
  const found = engineCatalog(engine).models.find((m) => m.slug === model);
  if (!found) return false;
  return effort === null || found.efforts.some((e) => e.id === effort);
}

/** Reset between tests; the catalogue is otherwise cached on the file's mtime. */
export function forgetCatalog(): void {
  cached = null;
}
