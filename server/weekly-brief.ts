/**
 * The weekly brief: a draft whose every claim carries its source.
 *
 * An active configuration names some approved export files; this reads them,
 * works out what changed since the previous brief, and produces a draft in
 * which every claim carries a reference to the source it came from. The draft
 * is saved through the existing recorded writer and left for a person to read.
 * Nothing is sent, published or applied, and that constraint is the feature:
 * a brief that quietly invents a number is worse than no brief.
 *
 * Composition is deterministic with no model call, no network and no clock
 * beyond the `at` the caller hands in. Change detection reuses the `diff`
 * package the store already depends on rather than a second, local differ.
 * A free-text summariser was rejected on purpose: it could phrase a claim no
 * source supports, while a differ can only repeat lines it actually read.
 *
 * Reads go through `store.current()`, the side-effect-free read path.
 * `store.readDocument()` would also work, but it records first-seen and
 * outside-change history entries, and a brief must leave exactly one recorded
 * write behind it rather than a trail of observations.
 */

import { diffLines } from 'diff';
import type { ConfigurationManifest } from '../shared/configuration.js';
import { ApiError, relativeName } from './paths.js';
import { hash, type Store } from './store.js';
import { checkExport, fileReferences } from './file-imports.js';
import { IMPORT_MAX_TOTAL_BYTES } from '../shared/file-imports.js';

export interface BriefSource {
  readonly id: string;
  readonly label: string;
  /** Project-relative path, as the store knows it. */
  readonly path: string;
  readonly text: string;
}

export interface BriefClaim {
  readonly text: string;
  /** Source ids this claim rests on. Never empty. */
  readonly sources: readonly string[];
}

export interface BriefSection {
  readonly heading: string;
  readonly claims: readonly BriefClaim[];
}

export interface BriefDraft {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly configurationRevision: number;
  readonly variantId: string;
  readonly title: string;
  readonly sections: readonly BriefSection[];
  /** The rendered draft. Derived from `sections`; never written by hand. */
  readonly markdown: string;
  readonly sources: readonly {
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly sha: string;
  }[];
  /** Selected sources that produced no claim. Named, not hidden. */
  readonly unused: readonly string[];
  /** Selected sources that could not be read. Named, not hidden. */
  readonly missing: readonly string[];
  readonly producedAt: string;
}

/** A path slug, so a reference reads like the file it came from. */
function slugFor(selected: string): string {
  const base = selected.split('/').pop() ?? selected;
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const folder = selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';
  const slug = `${folder} ${stem}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'source' : slug;
}

/** A short display name derived from the path, never from file contents. */
function prettyFor(selected: string): string {
  const base = selected.split('/').pop() ?? selected;
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const words = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (words === '') return selected;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The only way to build a claim. It takes the source as its first argument
 * and freezes the id into `sources` at construction, so a claim without a
 * source id is structurally impossible rather than merely discouraged. Never
 * construct a `BriefClaim` literal anywhere else.
 */
function claimFor(source: BriefSource, text: string): BriefClaim {
  return { text: text.trim(), sources: Object.freeze([source.id]) };
}

/** One blank-line-separated line list with a trailing newline, or empty. */
function canonical(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * What the previous brief already reported, recovered from its own markdown.
 * Claim lines render as `- <text> [id]` under per-source headings, ahead of
 * the `## Sources` list, so only that region is parsed: the Sources list and
 * the unused/missing sections that follow it are fellow `- ` lines and must
 * not be mistaken for reported claims.
 */
function reportedText(previous: string | null): string {
  if (previous === null) return '';
  const lines = previous.split('\n');
  const end = lines.findIndex((line) => line.trim() === '## Sources');
  const body = end === -1 ? lines : lines.slice(0, end);
  const reported: string[] = [];
  for (const line of body) {
    const match = /^- (.*) \[[^\]]+\]$/.exec(line.trimEnd());
    if (match) reported.push(match[1] ?? '');
  }
  return canonical(reported.join('\n'));
}

/**
 * The source lines the previous brief did not already report. Both sides are
 * canonicalised first so a trailing newline alone never reads as a change.
 */
function addedLines(reported: string, text: string): string[] {
  const added: string[] = [];
  for (const part of diffLines(reported, canonical(text))) {
    if (!part.added) continue;
    for (const line of part.value.split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '') added.push(trimmed);
    }
  }
  return added;
}

const approvedScope = (manifest: ConfigurationManifest) =>
  manifest.proposal.contextScopes.find((scope) => scope.kind === 'approved-files') ?? null;

const outputFor = (manifest: ConfigurationManifest) => manifest.proposal.expectedOutputs[0] ?? null;

export function composeBrief(input: {
  manifest: ConfigurationManifest;
  sources: readonly BriefSource[];
  /** The previous brief's markdown, when there is one. */
  previous: string | null;
  at: string;
}): BriefDraft {
  const manifest = input.manifest;
  const scope = approvedScope(manifest);
  const selected = scope ? [...scope.selection] : [];
  const byPath = new Map(input.sources.map((source) => [source.path, source]));
  // A selected path with no readable source was either missing on disk or
  // unreadable as text. It is named, never silently dropped.
  const missing = selected.filter((selection) => !byPath.has(selection));
  const reported = reportedText(input.previous);
  const sections: BriefSection[] = [];
  const unused: string[] = [];
  for (const source of input.sources) {
    const added = addedLines(reported, source.text);
    // Unchanged since the previous brief: named in `unused`, no claim.
    if (added.length === 0) {
      unused.push(source.id);
      continue;
    }
    sections.push({ heading: source.label, claims: added.map((line) => claimFor(source, line)) });
  }
  const output = outputFor(manifest);
  const base = {
    organizationId: manifest.organizationId,
    tenantId: manifest.tenantId,
    configurationRevision: manifest.revision,
    variantId: manifest.proposal.template.variantId,
    title: output ? output.label : 'Weekly brief',
    sections,
    sources: input.sources.map((source) => ({
      id: source.id,
      label: source.label,
      path: source.path,
      sha: hash(source.text)!,
    })),
    unused,
    missing,
    producedAt: input.at,
  };
  return { ...base, markdown: renderBrief(base) };
}

export function renderBrief(draft: Omit<BriefDraft, 'markdown'>): string {
  const lines: string[] = [`# ${draft.title}`, ''];
  if (draft.sections.length === 0)
    lines.push('There is nothing new in the approved exports since the previous brief.', '');
  for (const section of draft.sections) {
    lines.push(`## ${section.heading}`, '');
    for (const claim of section.claims) lines.push(`- ${claim.text} [${claim.sources.join(', ')}]`);
    lines.push('');
  }
  const byId = new Map(draft.sources.map((source) => [source.id, source]));
  if (draft.unused.length > 0) {
    lines.push(
      '## Unchanged since the previous brief',
      '',
      'The following selected sources match what the previous brief already reported, so they add no claims:',
      '',
    );
    for (const id of draft.unused) {
      const source = byId.get(id);
      lines.push(source ? `- ${source.label} (${source.path})` : `- ${id}`);
    }
    lines.push('');
  }
  if (draft.missing.length > 0) {
    lines.push(
      '## Sources that could not be read',
      '',
      'The following selected files could not be read. They are named here so none is silently dropped:',
      '',
    );
    for (const path of draft.missing)
      lines.push(`- ${path} could not be read, so it is not part of this brief.`);
    lines.push('');
  }
  lines.push('## Sources', '');
  for (const source of draft.sources)
    lines.push(`- [${source.id}] ${source.label} — ${source.path} (SHA-256: ${source.sha})`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export class WeeklyBriefService {
  constructor(private readonly store: Store) {}

  /** Read the manifest's selected files out of a project and compose. */
  async gather(projectId: string, manifest: ConfigurationManifest): Promise<BriefSource[]> {
    const scope = approvedScope(manifest);
    if (!scope) return [];
    const seen = new Map<string, number>();
    const sources: BriefSource[] = [];
    for (const selection of scope.selection) {
      let text: string | null;
      try {
        text = await this.store.current(projectId, selection);
      } catch {
        // Unreadable here means named in `missing` at composition, not a
        // failed brief: one locked file must not stop the rest being read.
        continue;
      }
      if (text === null) continue;
      const slug = slugFor(selection);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      sources.push({
        id: count === 0 ? slug : `${slug}-${count + 1}`,
        label: `${scope.label}: ${prettyFor(selection)}`,
        path: selection,
        text,
      });
    }
    return sources;
  }

  /** Compose and save through the recorded writer, leaving it for review. */
  async run(input: {
    projectId: string;
    manifest: ConfigurationManifest;
    at: string;
    /** Explicit per-run selection. Omission preserves the configured legacy sources. */
    sources?: unknown;
  }): Promise<{ draft: BriefDraft; entryId: string; destination: string }> {
    let manifest = structuredClone(input.manifest);
    if (manifest.state !== 'active')
      throw new ApiError(
        409,
        'This setup is not the active one, so no brief was prepared from it. Activate it first, or run the brief for the setup that is active.',
        { code: 'brief_not_active' },
      );
    if (!manifest.readiness.ready)
      throw new ApiError(
        409,
        'This setup is not ready, so no brief was prepared from it. Read its blocking problems first.',
        { code: 'brief_not_ready' },
      );
    const output = outputFor(manifest);
    if (!output)
      throw new ApiError(
        409,
        'This setup names nowhere to put the brief, so nothing was prepared.',
        { code: 'brief_no_destination' },
      );
    // Refused before anything is written: an escaping destination never
    // reaches the writer. The previous brief is read from the same
    // destination this run writes, so change detection compares against
    // what the last run actually left behind, and `expected` is the digest
    // of that text — the form `writeRecorded` compares `hash(before)` against.
    const destination = relativeName(output.destination);
    let sources: BriefSource[];
    if (input.sources !== undefined) {
      const references = fileReferences(input.sources).map((ref) => ({
        ...ref,
        path: relativeName(ref.path),
      }));
      const scope = approvedScope(manifest);
      if (!scope) throw new ApiError(409, 'This setup does not accept approved export files.');
      if (references.some((ref) => ref.path.toLowerCase() === destination.toLowerCase()))
        throw new ApiError(400, 'The brief destination cannot also be a source.');
      // A per-run choice by the same authorized workspace operator. No saved
      // configuration, project grant or provider consent is changed.
      manifest = {
        ...manifest,
        proposal: {
          ...manifest.proposal,
          contextScopes: manifest.proposal.contextScopes.map((item) =>
            item === scope ? { ...item, selection: references.map((ref) => ref.path) } : item,
          ),
        },
      };
      sources = [];
      for (const [index, ref] of references.entries()) {
        const text = await this.store.current(input.projectId, ref.path);
        if (text === null || hash(text) !== ref.sha)
          throw new ApiError(
            409,
            `${ref.path} changed or disappeared. Choose it again before preparing the brief.`,
          );
        checkExport(ref.path, text);
        sources.push({
          id: `${slugFor(ref.path)}-${index + 1}`,
          label: `${scope.label}: ${prettyFor(ref.path)}`,
          path: ref.path,
          text,
        });
      }
      if (
        sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0) >
        IMPORT_MAX_TOTAL_BYTES
      )
        throw new ApiError(413, 'Choose no more than 4 MB of exports for one brief.');
    } else sources = await this.gather(input.projectId, manifest);
    const previous = await this.store.current(input.projectId, destination);
    const draft = composeBrief({ manifest, sources, previous, at: input.at });
    if (input.sources !== undefined) {
      for (const source of sources)
        if (hash(await this.store.current(input.projectId, source.path)) !== hash(source.text))
          throw new ApiError(
            409,
            `${source.path} changed while the brief was being prepared. Choose it again.`,
          );
    }
    const entry = await this.store.writeRecorded(
      input.projectId,
      [{ path: destination, text: draft.markdown, expected: hash(previous) }],
      {
        kind: 'weekly-brief',
        review: true,
        sentence: `Diomedes drafted ${output.label} from the approved exports for your review.`,
        label: output.label,
      },
    );
    return { draft, entryId: entry.id, destination };
  }
}
