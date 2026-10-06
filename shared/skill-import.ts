/**
 * Inspect supplied SKILL.md text without installing, loading or authorizing it.
 * Format reference: https://agentskills.io/specification (checked 2026-10-06).
 *
 * This is deliberately a YAML subset: one-line plain/quoted string fields and
 * a two-space metadata string map. Unsupported syntax is reported, never
 * guessed. Directory-name matching, files, resources, licenses and runtime
 * compatibility are not verified. An inspected document still needs mapping
 * and the existing pack/Runtime/Trust paths before it could be used.
 */
export const SKILL_INSPECTION_MAX_BYTES = 64 * 1024;
export const SKILL_INSPECTION_FRONTMATTER_MAX_BYTES = 8 * 1024;

export interface SkillInspectionIssue {
  readonly kind: 'invalid' | 'unsupported';
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly field?: string;
}

/** Publisher-supplied data only. No entry here is an execution setting. */
export interface InspectedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** The experimental allowed-tools text, not permissions or a tool allowlist. */
  readonly requestedTools?: string;
  /** Exact text after the closing frontmatter delimiter and its line ending. */
  readonly body: string;
}

export interface SkillInspection {
  /** Inspected means only that the supported syntax and field checks passed. */
  readonly status: 'inspected' | 'unsupported' | 'refused';
  readonly document: InspectedSkillDocument | null;
  readonly unsupportedFields: readonly { readonly field: string; readonly value: string }[];
  readonly issues: readonly SkillInspectionIssue[];
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
const protectedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const knownFields = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
const keyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Only ASCII spaces are syntax whitespace in this subset. Tabs are refused. */
const trimSpaces = (value: string) => value.replace(/^ +| +$/g, '');

/** Refuse implicit scalar types equally in plain values and metadata keys. */
function implicitScalar(value: string): boolean {
  return (
    /^(?:true|false|null|yes|no|on|off|~|[+-]?\.(?:inf|nan))$/i.test(value) ||
    /^[+-]?(?:0[xob][0-9a-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d+)?)$/i.test(value) ||
    /^[+-]?\d[\d_]*(?::[0-5]?\d)+(?:\.\d+)?$/.test(value) ||
    /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?: *(?:Z|[+-]\d{1,2}(?::\d{2})?))?)?$/.test(
      value,
    )
  );
}

function invalidText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

type Scalar = { readonly value: string } | { readonly issue: SkillInspectionIssue };

function scalar(text: string, line: number, field: string): Scalar {
  const issue = (kind: SkillInspectionIssue['kind'], code: string, message: string): Scalar => ({
    issue: { kind, code, message, line, field },
  });
  const unsupported = () =>
    issue('unsupported', 'unsupported-syntax', 'Use a supported single-line string value.');
  const quotedError = () =>
    issue('invalid', 'invalid-string', 'The quoted string is not closed or has trailing content.');
  let value: string;
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?: +#.*)?$/.exec(text);
    if (!match) return quotedError();
    value = match[1].replaceAll("''", "'");
  } else if (text.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?: +#.*)?$/.exec(text);
    if (!match) return quotedError();
    try {
      value = JSON.parse(match[1]) as string;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return unsupported();
    }
  } else {
    value = trimSpaces(text.replace(/ +#.*$/, ''));
    if (!value || value.startsWith('#'))
      return issue('invalid', 'missing-string', 'A string value is required.');
    if (
      /^[!&*\[\]{}|>@`%"']/.test(value) ||
      /^(?:[-?:](?: |$)|---$|\.\.\.$)/.test(value) ||
      /:(?: |$)/.test(value)
    )
      return unsupported();
    // Do not accidentally turn a YAML boolean, number, date or null into text.
    if (implicitScalar(value)) return unsupported();
  }
  if (invalidText(value))
    return issue(
      'invalid',
      'invalid-text',
      'The string contains NUL or an unpaired Unicode surrogate.',
    );
  return { value };
}

/** Pure inspection of already-supplied text. Does not read paths or follow body links. */
export function inspectSkillDocument(content: string): SkillInspection {
  const issues: SkillInspectionIssue[] = [];
  const unsupportedFields: { field: string; value: string }[] = [];
  const finish = (document: InspectedSkillDocument | null): SkillInspection => ({
    status: issues.some((issue) => issue.kind === 'invalid')
      ? 'refused'
      : issues.length
        ? 'unsupported'
        : 'inspected',
    document,
    unsupportedFields,
    issues,
  });
  const stop = (
    kind: SkillInspectionIssue['kind'],
    code: string,
    message: string,
    line?: number,
    field?: string,
  ) => {
    issues.push({
      kind,
      code,
      message,
      ...(line === undefined ? {} : { line }),
      ...(field === undefined ? {} : { field }),
    });
    return finish(null);
  };

  // Bound allocation before UTF-8 encoding; a code unit never takes less than one byte.
  if (content.length > SKILL_INSPECTION_MAX_BYTES || bytes(content) > SKILL_INSPECTION_MAX_BYTES)
    return stop(
      'invalid',
      'document-too-large',
      'The document exceeds the 64 KiB inspection limit.',
    );
  if (invalidText(content))
    return stop(
      'invalid',
      'invalid-text',
      'The document contains NUL or an unpaired Unicode surrogate.',
    );
  const opening = /^---\r?\n/.exec(content);
  if (!opening)
    return stop(
      'invalid',
      'missing-frontmatter',
      'The document must start with a frontmatter delimiter on its own line.',
    );

  const lines: string[] = [];
  let offset = opening[0].length;
  let body: string | undefined;
  let headerEnd = offset;
  while (offset <= content.length) {
    const newline = content.indexOf('\n', offset);
    const end = newline < 0 ? content.length : newline;
    const raw = content.slice(offset, end);
    const line = newline >= 0 && raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '---') {
      headerEnd = offset;
      body = content.slice(newline < 0 ? end : end + 1);
      break;
    }
    lines.push(line);
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (body === undefined)
    return stop(
      'invalid',
      'unclosed-frontmatter',
      'The frontmatter needs an exact closing delimiter on its own line.',
    );
  if (bytes(content.slice(opening[0].length, headerEnd)) > SKILL_INSPECTION_FRONTMATTER_MAX_BYTES)
    return stop(
      'invalid',
      'frontmatter-too-large',
      'The frontmatter exceeds the 8 KiB inspection limit.',
    );

  const fields = new Map<string, string>();
  const metadata = new Map<string, string>();
  const seen = new Set<string>();
  let inMetadata = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 2;
    if (/[\u0001-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/.test(raw))
      return stop(
        'unsupported',
        'unsupported-syntax',
        'Tabs, control characters, nonstandard line separators and literal YAML noncharacters are unsupported in frontmatter.',
        line,
      );
    if (/^ *(?:#.*)?$/.test(raw)) continue;
    const indented = raw.startsWith(' ');
    if (indented && (!inMetadata || !/^  [^ ]/.test(raw)))
      return stop(
        'unsupported',
        'unsupported-syntax',
        'Only two-space metadata entries may be indented.',
        line,
      );
    const entry = indented ? raw.slice(2) : raw;
    const match = /^([^:]+):(?: +(.*)|$)/.exec(entry);
    if (!match || !keyPattern.test(match[1]))
      return stop(
        'unsupported',
        'unsupported-syntax',
        'Use an unquoted simple field name followed by a colon and a string.',
        line,
      );
    const key = match[1];
    const field = indented ? `metadata.${key}` : key;
    if (protectedKeys.has(key))
      return stop(
        'invalid',
        'protected-key',
        'Prototype-related keys are not accepted.',
        line,
        field,
      );
    if (indented && implicitScalar(key))
      return stop(
        'unsupported',
        'unsupported-syntax',
        'Implicit YAML scalar keys are unsupported in a metadata string map.',
        line,
        field,
      );
    if ((indented ? metadata : seen).has(key))
      return stop(
        'invalid',
        'duplicate-field',
        'The same field occurs more than once.',
        line,
        field,
      );
    if (!indented) {
      seen.add(key);
      inMetadata = key === 'metadata';
      if (inMetadata) {
        if (match[2] !== undefined && trimSpaces(match[2]))
          return stop(
            'unsupported',
            'unsupported-syntax',
            'Metadata must be a two-space string map.',
            line,
            field,
          );
        continue;
      }
    }
    const parsed = scalar(trimSpaces(match[2] ?? ''), line, field);
    if ('issue' in parsed) {
      // An empty nested value would introduce another YAML container.
      issues.push(
        indented && parsed.issue.code === 'missing-string'
          ? {
              ...parsed.issue,
              kind: 'unsupported',
              code: 'unsupported-syntax',
              message: 'Nested metadata containers are unsupported.',
            }
          : parsed.issue,
      );
      return finish(null);
    }
    if (indented) metadata.set(key, parsed.value);
    else fields.set(key, parsed.value);
  }

  const name = fields.get('name');
  const description = fields.get('description');
  const compatibility = fields.get('compatibility');
  const invalidField = (field: string, message: string) =>
    issues.push({ kind: 'invalid', code: 'invalid-field', field, message });
  if (!name || name.length > 64 || !namePattern.test(name))
    invalidField('name', 'Use 1-64 lowercase ASCII letters, numbers and single interior hyphens.');
  if (!description?.trim() || [...description].length > 1024)
    invalidField('description', 'Description must contain 1-1024 characters and cannot be blank.');
  if (compatibility !== undefined && (!compatibility.trim() || [...compatibility].length > 500))
    invalidField(
      'compatibility',
      'Compatibility must contain 1-500 characters and cannot be blank.',
    );
  if (seen.has('metadata') && !metadata.size)
    invalidField('metadata', 'Metadata must contain a supported string mapping.');
  if (issues.length) return finish(null);

  for (const [field, value] of fields) {
    if (knownFields.has(field)) continue;
    unsupportedFields.push({ field, value });
    issues.push({
      kind: 'unsupported',
      code: 'unsupported-field',
      field,
      message: 'This field has no mapping in the inspector.',
    });
  }
  const requestedTools = fields.get('allowed-tools');
  if (requestedTools !== undefined)
    issues.push({
      kind: 'unsupported',
      code: 'tool-requests-unmapped',
      field: 'allowed-tools',
      message: 'Tool requests are retained as text only. Runtime and Trust still decide authority.',
    });

  return finish({
    name: name!,
    description: description!,
    body,
    ...(fields.has('license') ? { license: fields.get('license')! } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(seen.has('metadata') ? { metadata: Object.fromEntries(metadata) } : {}),
    ...(requestedTools !== undefined ? { requestedTools } : {}),
  });
}
