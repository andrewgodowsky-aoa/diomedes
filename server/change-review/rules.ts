/**
 * The review rules: deterministic classification only.
 *
 * A rule reads change entries (and, where it needs content, bounded text the
 * service supplies) and emits flags with stable reason codes plus facts with
 * structured params. A rule that matches nothing emits nothing — the review
 * never turns silence into a claim about safety.
 *
 * Every flag names the rule and rules version that produced it, so a future
 * reader can tell "the evidence changed" from "the rules changed".
 */

import {
  CHANGE_REVIEW_RULES_VERSION,
  escapeVisible,
  type ChangeEntry,
  type ChangeEvidenceRef,
  type ReviewFact,
  type ReviewFlag,
  type StructuredFieldChange,
} from '../../shared/change-manifest.js';
import { containsSecretLikeText } from '../../shared/business-setup.js';

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m;
const TRAILING_WS = /[ \t]+$/m;
const INVISIBLE_CHARS = /[‎‏‪-‮⁦-⁩﻿]/;
/** Content checks read at most this much of a file's new text. */
export const CONTENT_SCAN_LIMIT = 512 * 1024;
/** Files at or above this size earn the oversized flag. */
export const OVERSIZED_BYTES = 1024 * 1024;

export interface RuleInput {
  readonly changes: readonly ChangeEntry[];
  /**
   * Bounded access to a changed file's before/after text where evidence
   * retains it — recorded objects or small worktree reads. Returns null when
   * the content is unavailable (binary, oversized, gone); rules then classify
   * without content facts.
   */
  readonly textFor: (path: string, side: 'before' | 'after') => string | null;
  readonly coverage: {
    readonly skipped: readonly { path: string; reason: string }[];
    readonly blocked: readonly { path: string; reason: string }[];
    readonly unavailable: readonly { path: string; reason: string }[];
  };
  /** Sessions stopped with effects that may still land. */
  readonly uncertainEffects: readonly string[];
  readonly checks: readonly { id: string; state: string; inputDigest: string | null }[];
  readonly currentInputDigest: string | null;
  /**
   * Evidence refs describing the baseline/listing state itself — the typed
   * record a "nothing changed" or coverage claim resolves to.
   */
  readonly baselineEvidence: readonly ChangeEvidenceRef[];
}

interface PathRule {
  readonly code: string;
  readonly text: string;
  readonly match: (path: string) => boolean;
}

const PATH_RULES: readonly PathRule[] = [
  {
    code: 'lockfile-changed',
    text: 'A dependency lockfile changed.',
    match: (p) =>
      /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|go\.sum|gemfile\.lock|composer\.lock)$/i.test(
        p,
      ),
  },
  {
    code: 'config-changed',
    text: 'Configuration changed.',
    match: (p) =>
      /(^|\/)([^/]*\.env[^/]*|[^/]*config[^/]*\.(json|yaml|yml|toml|ini)|settings\.[^/]+|\.editorconfig|\.npmrc|\.nvmrc|tsconfig[^/]*\.json|dockerfile|docker-compose[^/]*)$/i.test(
        p,
      ),
  },
  {
    code: 'ci-changed',
    text: 'A CI or deployment definition changed.',
    match: (p) =>
      /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.|azure-pipelines|jenkinsfile|\.circleci\/|deploy\/|\.do\/|vercel\.json|netlify\.toml|fly\.toml|render\.yaml)/i.test(
        p,
      ),
  },
  {
    code: 'auth-path-changed',
    text: 'Authentication-related paths changed.',
    match: (p) => /auth|login|logout|session|oauth|sso|token|credential|password/i.test(p),
  },
  {
    code: 'permission-path-changed',
    text: 'Permission-related paths changed.',
    match: (p) => /permission|rbac|acl|policy|scope|grant|role|privileg|access[-_]?control/i.test(p),
  },
  {
    code: 'migration-changed',
    text: 'A database schema or migration changed.',
    match: (p) => /(^|\/)migrations?\/|schema\.(sql|prisma|graphql)|\.sql$/i.test(p),
  },
  {
    code: 'api-surface-changed',
    text: 'An API surface definition changed.',
    match: (p) => /openapi|swagger|\.proto$|\.graphql$|schema\.json$|api[-_]?spec/i.test(p),
  },
  {
    code: 'executable-changed',
    text: 'A script or program file changed.',
    match: (p) => /\.(sh|bash|bat|cmd|ps1|exe|dll|so|dylib|bin)$/i.test(p),
  },
  {
    code: 'test-file-changed',
    text: 'A test file changed.',
    match: (p) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$/i.test(p),
  },
];

function isDependencyManifest(path: string): boolean {
  return /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|gemfile|pom\.xml|build\.gradle[^/]*|composer\.json|csproj|[^/]+\.csproj)$/i.test(
    path,
  );
}

function topArea(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts[0] : '(project root)';
}

function fact(
  id: string,
  code: string,
  templateId: string,
  params: Record<string, string | number | boolean | null>,
  evidence: readonly ChangeEvidenceRef[],
): ReviewFact {
  return { id, code, templateId, params, evidence };
}

export interface RuleOutput {
  readonly flags: readonly ReviewFlag[];
  readonly facts: readonly ReviewFact[];
}

/**
 * Run every rule over the collected changes. Deterministic in: entries and
 * coverage. Deterministic out: flags in fixed order, facts in fixed order.
 */
export function runRules(input: RuleInput): RuleOutput {
  const flags: ReviewFlag[] = [];
  const facts: ReviewFact[] = [];
  const flag = (
    code: string,
    severity: 'attention' | 'info',
    text: string,
    paths: readonly string[],
    evidence: readonly ChangeEvidenceRef[],
    ruleSuffix = '',
  ) =>
    flags.push({
      code,
      ruleId: `cr-${code}${ruleSuffix}`,
      severity,
      text,
      paths,
      evidence,
    });
  const ruleEvidence = (code: string): ChangeEvidenceRef[] => [
    { kind: 'rule', ruleId: `cr-${code}`, rulesVersion: CHANGE_REVIEW_RULES_VERSION },
  ];

  const fileChanges = input.changes.filter((c) => c.source !== 'structured');
  const structured = input.changes.filter((c) => c.source === 'structured');
  const recorded = fileChanges.filter((c) => c.attribution === 'recorded');
  const observed = fileChanges.filter((c) => c.attribution === 'observed');
  const changedOnly = fileChanges.filter((c) => c.kind !== 'unchanged');

  // --- headline facts -------------------------------------------------------
  if (changedOnly.length === 0 && structured.every((c) => c.fields.every((f) => f.kind === 'unchanged'))) {
    facts.push(
      fact('f-no-changes', 'no-changes', 'no-changes', {}, [
        ...ruleEvidence('no-changes'),
        ...input.baselineEvidence,
      ]),
    );
  } else if (fileChanges.length) {
    const count = (kind: ChangeEntry['kind']) => changedOnly.filter((c) => c.kind === kind).length;
    const evidence = changedOnly.flatMap((c) => c.evidence.slice(0, 2));
    facts.push(
      fact(
        'f-files',
        'files-changed',
        'files-changed',
        {
          total: changedOnly.length,
          added: count('added'),
          modified: count('modified'),
          deleted: count('deleted'),
          renamed: count('renamed'),
          observed: observed.length,
          recorded: recorded.length,
        },
        evidence.slice(0, 8),
      ),
    );
    const addedLines = changedOnly.reduce((n, c) => n + (c.addedLines ?? 0), 0);
    const removedLines = changedOnly.reduce((n, c) => n + (c.removedLines ?? 0), 0);
    const counted = changedOnly.filter((c) => c.addedLines !== null || c.removedLines !== null);
    if (counted.length) {
      facts.push(
        fact(
          'f-lines',
          'lines-changed',
          'lines-changed',
          { added: addedLines, removed: removedLines, counted: counted.length },
          counted.flatMap((c) => c.evidence.slice(0, 1)).slice(0, 6),
        ),
      );
    }
    // Where the work concentrated: top-level areas, most-changed first.
    const areas = new Map<string, number>();
    for (const change of changedOnly)
      areas.set(topArea(change.path), (areas.get(topArea(change.path)) ?? 0) + 1);
    const ordered = [...areas.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ordered.length)
      facts.push(
        fact(
          'f-areas',
          'focus-areas',
          'focus-areas',
          { areas: ordered.slice(0, 5).map(([area]) => escapeVisible(area)).join(', ') },
          changedOnly.slice(0, 5).flatMap((c) => c.evidence.slice(0, 1)),
        ),
      );
    const kept = recorded.filter((c) => c.settled === 'kept').length;
    const undone = recorded.filter((c) => c.settled === 'undone').length;
    const waiting = recorded.filter((c) => c.settled === 'waiting').length;
    if (kept + undone + waiting > 0)
      facts.push(
        fact(
          'f-settled',
          'changes-settled',
          'changes-settled',
          { kept, undone, waiting },
          recorded
            .filter((c) => c.settled !== null)
            .flatMap((c) => c.evidence.slice(0, 1))
            .slice(0, 6),
        ),
      );
  }

  // --- structural flags -----------------------------------------------------
  for (const change of changedOnly) {
    const evidence = change.evidence.length ? change.evidence : ruleEvidence(change.kind);
    if (change.kind === 'added')
      flag('file-added', 'info', `A file was added: ${escapeVisible(change.path)}`, [change.path], evidence);
    if (change.kind === 'deleted')
      flag('file-deleted', 'attention', `A file was deleted: ${escapeVisible(change.path)}`, [change.path], evidence);
    if (change.kind === 'renamed')
      flag(
        'file-renamed',
        'info',
        `A file was renamed: ${escapeVisible(change.renamedFrom ?? '?')} → ${escapeVisible(change.path)}`,
        [change.path],
        evidence,
      );
    if (change.binary)
      flag('binary-changed', 'info', `A binary file changed: ${escapeVisible(change.path)}`, [change.path], evidence);
    if ((change.sizeAfter ?? 0) >= OVERSIZED_BYTES)
      flag('oversized-file', 'info', `A large file changed: ${escapeVisible(change.path)}`, [change.path], evidence);
    for (const rule of PATH_RULES)
      if (rule.match(change.path))
        flag(rule.code, 'attention', rule.text, [change.path], evidence, '');
  }

  // --- file-mode transitions (real Git mode evidence, never filename guesses) ---
  for (const change of changedOnly) {
    if (change.modeBefore === change.modeAfter) continue;
    const before = change.modeBefore ?? 'untracked';
    const after = change.modeAfter ?? 'gone';
    const paths = [change.path];
    const evidence = change.evidence.length ? change.evidence : ruleEvidence('file-mode-changed');
    if (change.modeAfter === '100755' && change.modeBefore !== '100755')
      flag(
        'executable-bit-set',
        'attention',
        `A file became executable: ${escapeVisible(change.path)} — its Git mode changed ${before} → ${after}.`,
        paths,
        evidence,
      );
    else if (change.modeBefore === '100755')
      flag(
        'executable-bit-cleared',
        'info',
        `A file lost its executable bit: ${escapeVisible(change.path)} — Git mode ${before} → ${after}.`,
        paths,
        evidence,
      );
    else
      flag(
        'file-mode-changed',
        'info',
        `A file's Git mode changed: ${escapeVisible(change.path)} (${before} → ${after}).`,
        paths,
        evidence,
      );
    facts.push(
      fact(
        `f-mode-${change.path}`,
        'file-mode-changed',
        'file-mode-changed',
        { path: escapeVisible(change.path), before, after },
        evidence,
      ),
    );
  }

  // --- dependency manifests --------------------------------------------------
  for (const change of changedOnly.filter((c) => isDependencyManifest(c.path))) {
    const beforeText = input.textFor(change.path, 'before');
    const afterText = input.textFor(change.path, 'after');
    const detail = dependencyDelta(beforeText, afterText);
    const code =
      change.kind === 'deleted' || (afterText === null && beforeText !== null)
        ? 'dependency-removed'
        : change.kind === 'added' || (beforeText === null && afterText !== null)
          ? 'dependency-added'
          : detail.added.length && !detail.removed.length
            ? 'dependency-added'
            : detail.removed.length && !detail.added.length
              ? 'dependency-removed'
              : 'dependency-changed';
    const names = [...detail.added, ...detail.removed, ...detail.changed].slice(0, 6);
    flag(
      code,
      'attention',
      `${dependencyText(code)} in ${escapeVisible(change.path)}${names.length ? `: ${names.map(escapeVisible).join(', ')}` : ''}`,
      [change.path],
      change.evidence,
    );
    if (names.length)
      facts.push(
        fact(
          `f-dep-${change.path}`,
          code,
          'dependency-detail',
          { path: escapeVisible(change.path), names: names.map(escapeVisible).join(', ') },
          change.evidence.slice(0, 4),
        ),
      );
  }

  // --- content-level flags ---------------------------------------------------
  for (const change of changedOnly) {
    if (change.kind === 'deleted' || change.binary) continue;
    const after = input.textFor(change.path, 'after');
    if (after === null) continue;
    const scan = after.slice(0, CONTENT_SCAN_LIMIT);
    if (after.length > CONTENT_SCAN_LIMIT)
      flag(
        'content-scan-truncated',
        'info',
        `Only the first ${Math.floor(CONTENT_SCAN_LIMIT / 1024)} KB of ${escapeVisible(change.path)} was scanned for markers.`,
        [change.path],
        change.evidence,
      );
    if (CONFLICT_MARKER.test(scan))
      flag('conflict-markers', 'attention', `Merge conflict markers are present in ${escapeVisible(change.path)}.`, [change.path], change.evidence);
    if (TRAILING_WS.test(scan))
      flag('trailing-whitespace', 'info', `Trailing whitespace appears in ${escapeVisible(change.path)}.`, [change.path], change.evidence);
    if (INVISIBLE_CHARS.test(scan))
      flag('invisible-characters', 'attention', `Invisible or bidirectional characters appear in ${escapeVisible(change.path)}.`, [change.path], change.evidence);
    if (PEM_PRIVATE_KEY.test(scan) || containsSecretLikeText(scan))
      flag('credential-like-text', 'attention', `Credential-like text appears in ${escapeVisible(change.path)}.`, [change.path], change.evidence);
    if (INVISIBLE_CHARS.test(change.path))
      flag('invisible-characters', 'attention', `A path contains invisible or bidirectional characters: ${escapeVisible(change.path)}`, [change.path], change.evidence);
  }

  // --- attribution and coverage ------------------------------------------------
  if (observed.length) {
    flag(
      'outside-changes',
      'attention',
      `${observed.length} ${observed.length === 1 ? 'file changed' : 'files changed'} while this task ran without a recorded Diomedes write.`,
      observed.map((c) => c.path),
      observed.flatMap((c) => c.evidence.slice(0, 1)).slice(0, 8),
    );
  }
  if (input.coverage.blocked.length)
    flag(
      'blocked-paths',
      'attention',
      `${input.coverage.blocked.length} ${input.coverage.blocked.length === 1 ? 'path was' : 'paths were'} blocked and not inspected.`,
      input.coverage.blocked.map((note) => note.path),
      ruleEvidence('blocked-paths'),
    );
  if (input.coverage.unavailable.length)
    flag(
      'unavailable-files',
      'attention',
      `${input.coverage.unavailable.length} ${input.coverage.unavailable.length === 1 ? 'file could' : 'files could'} not be read during comparison.`,
      input.coverage.unavailable.map((note) => note.path),
      ruleEvidence('unavailable-files'),
    );
  if (input.coverage.skipped.length)
    flag(
      'uninspected-paths',
      'info',
      `${input.coverage.skipped.length} ${input.coverage.skipped.length === 1 ? 'entry was' : 'entries were'} not inspected (hidden, linked or generated folders).`,
      input.coverage.skipped.slice(0, 12).map((note) => note.path),
      ruleEvidence('uninspected-paths'),
    );
  if (input.uncertainEffects.length)
    flag(
      'uncertain-effects',
      'attention',
      'The run was stopped while effects may still have been in flight.',
      [],
      ruleEvidence('uncertain-effects'),
    );

  // --- check staleness ----------------------------------------------------------
  const stale = input.checks.filter(
    (check) =>
      (check.state === 'passed' || check.state === 'failed') &&
      check.inputDigest !== null &&
      input.currentInputDigest !== null &&
      check.inputDigest !== input.currentInputDigest,
  );
  for (const check of stale)
    flag(
      'check-stale-input',
      'info',
      `The check "${check.id}" ran against an earlier version of this change set.`,
      [],
      [{ kind: 'check', checkId: check.id }],
    );

  // --- structured (business) records ---------------------------------------------
  for (const entry of structured) {
    for (const field of entry.fields) {
      if (field.kind === 'unchanged') continue;
      const evidence: ChangeEvidenceRef[] = [
        { kind: 'structured', recordId: entry.id, fieldPath: field.path },
      ];
      const codes = field.flagCodes.length ? field.flagCodes : ['field-changed'];
      for (const code of codes) {
        const policy = structuredFlagPolicy(code, field, entry.path);
        flag(code, policy.severity, policy.text, [field.path], evidence);
      }
      facts.push(
        fact(
          `f-field-${entry.id}:${field.path}`,
          field.kind === 'collection' ? 'collection-changed' : 'field-changed',
          field.kind === 'collection' ? 'collection-changed' : 'field-changed',
          {
            record: entry.path,
            label: field.label,
            before: field.before === null ? null : escapeVisible(field.before),
            after: field.after === null ? null : escapeVisible(field.after),
            added: field.added.map(escapeVisible).join(', ') || null,
            removed: field.removed.map(escapeVisible).join(', ') || null,
            addedMore: Math.max(0, field.addedTotal - field.added.length),
            removedMore: Math.max(0, field.removedTotal - field.removed.length),
            addedTotal: field.addedTotal,
            removedTotal: field.removedTotal,
            valueTruncated: field.valueTruncated,
            sensitive: field.sensitive,
          },
          evidence,
        ),
      );
    }
    const unchanged = entry.fields.filter((f) => f.kind === 'unchanged' && !f.sensitive);
    if (unchanged.length)
      facts.push(
        fact(
          `f-unchanged-${entry.id}`,
          'fields-unchanged',
          'fields-unchanged',
          {
            record: entry.path,
            labels: unchanged.map((f) => f.label).join(', '),
            count: unchanged.length,
          },
          unchanged
            .slice(0, 6)
            .map((f) => ({ kind: 'structured', recordId: entry.id, fieldPath: f.path }) as const),
        ),
      );
  }

  return { flags, facts };
}

// --- the deterministic severity policy ------------------------------------------

/**
 * How a structured field change is classified. `info` is the default — an
 * ordinary state change worth reporting. `attention` is reserved for what the
 * descriptor flagged as consequential: who receives something, where it goes,
 * whether it runs, who can change it, and credentials. The flag text always
 * states the concrete reason — never a bare "changed".
 */
function structuredFlagPolicy(
  code: string,
  field: StructuredFieldChange,
  record: string,
): { severity: 'attention' | 'info'; text: string } {
  const members = (names: readonly string[], total: number): string => {
    const listed = names.map(escapeVisible).join(', ');
    return total > names.length ? `${listed} (+${total - names.length} more)` : listed;
  };
  const deltas: string[] = [];
  if (field.addedTotal > 0)
    deltas.push(
      `${members(field.added, field.addedTotal)} ${field.addedTotal === 1 ? 'was' : 'were'} added`,
    );
  if (field.removedTotal > 0)
    deltas.push(
      `${members(field.removed, field.removedTotal)} ${field.removedTotal === 1 ? 'was' : 'were'} removed`,
    );
  const deltaText = deltas.join('; ');
  const scalar = `${escapeVisible(field.before ?? '—')} → ${escapeVisible(field.after ?? '—')}`;

  switch (code) {
    case 'permission-set-changed': {
      // Access changes get their own wording: expansion and contraction are
      // stated apart, and the added/removed principals are named.
      if (field.addedTotal > 0 && field.removedTotal === 0)
        return {
          severity: 'attention',
          text: `${field.label} expanded — ${deltaText}. Access to ${escapeVisible(record)} grew.`,
        };
      if (field.removedTotal > 0 && field.addedTotal === 0)
        return {
          severity: 'attention',
          text: `${field.label} narrowed — ${deltaText}. Access to ${escapeVisible(record)} shrank.`,
        };
      return {
        severity: 'attention',
        text: `${field.label} changed — ${deltaText}. Access to ${escapeVisible(record)} changed.`,
      };
    }
    case 'recipient-list-changed':
      return {
        severity: 'attention',
        text: `${field.label} changed — ${deltaText || 'the list changed'}. Who receives ${escapeVisible(record)} changed.`,
      };
    case 'connector-changed':
      return {
        severity: 'attention',
        text:
          field.kind === 'collection'
            ? `${field.label} changed — ${deltaText}. What feeds ${escapeVisible(record)} changed.`
            : `${field.label} changed: ${scalar}. Where ${escapeVisible(record)} goes changed.`,
      };
    case 'automation-toggled':
      return {
        severity: 'attention',
        text: `${escapeVisible(record)} was turned ${field.after === 'On' ? 'on' : 'off'}.`,
      };
    case 'credential-changed':
      return {
        severity: 'attention',
        text: `${field.label} changed — the value is recorded, never shown.`,
      };
    default:
      return { severity: 'info', text: `${field.label} changed in ${escapeVisible(record)}.` };
  }
}

function dependencyText(code: string): string {
  return code === 'dependency-added'
    ? 'A dependency was added'
    : code === 'dependency-removed'
      ? 'A dependency was removed'
      : 'Dependencies changed';
}

interface DependencyDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** package.json dependency sets, compared by name only — versions stay in evidence. */
function dependencyDelta(before: string | null, after: string | null): DependencyDelta {
  const empty: DependencyDelta = { added: [], removed: [], changed: [] };
  if (before === null && after === null) return empty;
  const names = (text: string | null): Map<string, string> => {
    if (text === null) return new Map();
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const out = new Map<string, string>();
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const section = parsed[key];
        if (section && typeof section === 'object')
          for (const [name, version] of Object.entries(section))
            out.set(name, typeof version === 'string' ? version : '');
      }
      return out;
    } catch {
      return new Map();
    }
  };
  const was = names(before);
  const now = names(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, version] of now)
    if (!was.has(name)) added.push(name);
    else if (was.get(name) !== version) changed.push(name);
  for (const name of was.keys()) if (!now.has(name)) removed.push(name);
  return { added, removed, changed };
}
