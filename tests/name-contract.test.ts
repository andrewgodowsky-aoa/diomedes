import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Brand } from '../client/components';
import { NectoviaMark, NectoviaGlyph } from '../client/console/NectoviaMark';
import {
  PRODUCT_NAME,
  applicationOrigin,
  directOrigin,
  formatOrigin,
  speakerName,
} from '../client/attribution-display';
import { formatOrigin as formatRecordedOrigin } from '../shared/attribution';
import { routeDisplayName } from '../shared/engines';

// The name contract (contract §1, A2, A3). The product a person reads about is
// Nectovia; the company is still Diomedes Systems; the desktop shell, the app
// icon's source and every machine identifier still say Diomedes in this pass.
//
// The scan reads every string a client source file can put on screen (JSX
// text, attribute values, string and template literals) with the TypeScript
// parser, so comments, imports, identifiers and class names never count. Each
// place still allowed to say Diomedes is named below with its reason.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const NAME = /\bDiomedes\b/;

interface Allowed {
  file: string;
  text: string;
  why: string;
}
const ALLOWED: Allowed[] = [
  {
    file: 'client/App.tsx',
    text: 'A new folder in the Diomedes projects folder',
    why: 'names the folder on disk, Documents/Diomedes (desktop/main.mjs projectRoot)',
  },
  {
    file: 'client/attribution-display.ts',
    text: 'Diomedes',
    why: 'the actor name the server records in History; the client maps it to the product name at render',
  },
  {
    file: 'client/console/Mark.tsx',
    text: 'Diomedes',
    why: 'the app icon source keeps its wordmark (contract A3); the UI draws NectoviaMark',
  },
];
/** Header names are machine identifiers (contract §1 never-change list). */
const HEADER = /^X-Diomedes-[A-Za-z]+$/;
/** The company keeps its name everywhere. */
const COMPANY = /\bDiomedes Systems\b/g;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** Is this node an argument of a console.* call (developer logs, not the screen)? */
function inConsoleCall(node: ts.Node): boolean {
  const call = node.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'console'
  );
}

/**
 * Every string a source file can show: JSX text, attribute values, string and
 * template literals. Module names and console.* arguments are left out.
 */
function shownStrings(file: string, text: string, kind: ts.ScriptKind): Hit[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    let value: string | null = null;
    if (ts.isJsxText(node)) value = node.text;
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      value = node.text;
    const moduleName =
      node.parent &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent) ||
        ts.isExternalModuleReference(node.parent));
    if (value !== null && value.trim() && !moduleName && !inConsoleCall(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      hits.push({ file, line, text: value.trim().replace(/\s+/g, ' ') });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** The strings in a client file that still name the product the old way. */
function screenStrings(file: string, text = read(file)): Hit[] {
  return shownStrings(file, text, ts.ScriptKind.TSX).filter(
    (hit) => NAME.test(hit.text.replace(COMPANY, '')) && !HEADER.test(hit.text),
  );
}

const allowed = (hit: Hit) =>
  ALLOWED.some((entry) => entry.file === hit.file && entry.text === hit.text);

/**
 * Shared modules that only the client renders. The other shared modules that
 * still say Diomedes are read by the server or written into recorded documents
 * (the capability record), so they are a separate, recorded decision.
 */
const CLIENT_ONLY_SHARED = ['shared/evidence-rows.ts', 'shared/onboarding.ts'];

describe('the product name on screen', () => {
  const files = [...sourceFiles('client'), ...CLIENT_ONLY_SHARED];

  it('reads the whole client', () => {
    // A scan that found nothing to read proves nothing.
    expect(files.length).toBeGreaterThan(80);
    expect(files).toContain('client/console/Diomedes.tsx');
  });

  it('says Nectovia wherever the product is named, apart from the named exceptions', () => {
    const hits = files.flatMap((file) => screenStrings(file));
    const stray = hits.filter((hit) => !allowed(hit));
    expect(stray.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([]);
    // Every exception is still needed: an allowance that matches nothing is stale.
    for (const entry of ALLOWED)
      expect(
        hits.some((hit) => hit.file === entry.file && hit.text === entry.text),
        `${entry.file}: ${entry.text} (${entry.why})`,
      ).toBe(true);
  });

  it('catches the name in the places a person reads it', () => {
    const probe = [
      '// Diomedes in a comment is fine.',
      "import { Diomedes } from './Diomedes';",
      'export const a = <p>Ask Diomedes</p>;',
      'export const b = <input aria-label="Message Diomedes" placeholder="Diomedes" />;',
      "export const c = { hint: 'What Diomedes may do', header: 'X-Diomedes-Client' };",
      'export const d = `${1} Diomedes`;',
      'export const e = <Diomedes className="diomedes" />;',
      "console.error('Diomedes stopped drawing');",
      "export const f = 'Nectovia by Diomedes Systems.';",
    ].join('\n');
    const found = screenStrings('probe.tsx', probe).map((hit) => hit.line);
    expect(found).toEqual([3, 4, 4, 5, 6]);
  });
});

describe('the brand', () => {
  it('draws the three plates and two seams of the approved mark, with one point for the wake', () => {
    const html = renderToStaticMarkup(createElement(NectoviaMark));
    expect(html).toContain('points="3,3 7.6,3 7.6,21 3,21"');
    expect(html).toContain('points="8.9,3 12.9,3 15.3,21 11.3,21"');
    expect(html).toContain('points="16.5,3 21,3 21,21 16.5,21"');
    expect(html).toContain('x1="8.5" y1="3.4" x2="9.8" y2="12.6"');
    expect(html).toContain('x1="21.9" y1="15.5" x2="21.9" y2="21"');
    expect(html.match(/data-mark-point/g)).toHaveLength(1);
    // The point is where the lead seam ends.
    expect(html).toMatch(/cx="9\.8" cy="12\.6"[^>]*data-mark-point/);
    expect(html).toContain('<span class="dm-nmark-word">Nectovia</span>');
  });

  it('drops the trail seam at 18 px and below', () => {
    const small = renderToStaticMarkup(createElement(NectoviaGlyph, { size: 18 }));
    expect(small).not.toContain('x1="21.9"');
    expect(small).not.toContain('dm-nmark-word');
    expect(small.match(/data-mark-point/g)).toHaveLength(1);
    const header = renderToStaticMarkup(createElement(NectoviaMark, { size: 20 }));
    expect(header).toContain('x1="21.9"');
  });

  it('spells the wordmark and the wake in the new name', () => {
    expect(renderToStaticMarkup(createElement(Brand))).toContain('NECTOVIA');
    const wake = read('client/console/Wake.tsx');
    expect(wake).toContain("const LETTERS = ['N', 'E', 'C', 'T', 'O', 'V', 'I', 'A'];");
    expect(wake).toContain('aria-label="Nectovia is waking"');
  });

  it('draws NectoviaMark at the three places the old mark stood', () => {
    expect(read('client/console/Shell.tsx')).toMatch(/<header className="top">\s*<NectoviaMark \/>/);
    expect(read('client/console/TopStrip.tsx')).toMatch(/aria-label="Nectovia projects"[\s\S]{0,80}<NectoviaMark \/>/);
    expect(read('client/App.tsx')).toContain('<NectoviaGlyph size={18} />');
  });
});

describe('attribution under the new name', () => {
  it("shows the product's own actions as Nectovia and leaves the recorded word alone", () => {
    const shown = formatOrigin(applicationOrigin());
    expect(shown.primary).toBe(PRODUCT_NAME);
    expect(shown.actor).toBe('Nectovia');
    expect(shown.label).toBe('Nectovia application action');
    expect(shown.detail).toBe('Nectovia application action; no model authorship implied.');
    // The server still records the shared literal in History sentences.
    expect(formatRecordedOrigin(applicationOrigin()).primary).toBe('Diomedes');
  });

  it('names the native supervisor as the product and keeps the reported model', () => {
    const origin = { ...directOrigin({ engine: 'codex', reportedModel: 'gpt-5.5' }), mode: 'supervisor' as const };
    const shown = formatOrigin(origin);
    expect(shown.primary).toBe('Nectovia');
    // The route keeps the one name shared/engines.ts gives it (Codex runs as ChatGPT).
    expect(shown.secondary).toBe(`gpt-5.5 via ${routeDisplayName('codex')}`);
    expect(shown.detail).toBe('Nectovia native supervisor operation.');
  });

  it('never renames an engine or a model, even one that reports the old name', () => {
    expect(formatOrigin(directOrigin({ engine: 'claude-code', reportedModel: 'claude-opus-5' })).primary).toBe(
      'claude-opus-5',
    );
    // A direct runtime that reports a model called Diomedes is quoted as reported.
    expect(formatOrigin(directOrigin({ engine: 'codex', reportedModel: 'Diomedes' })).primary).toBe('Diomedes');
    expect(formatOrigin(undefined, { engine: 'codex' }).primary).toBe(routeDisplayName('codex'));
    expect(formatOrigin(undefined, { application: true }).primary).toBe('Nectovia');
  });

  it('labels every turn that is not the person as the product', () => {
    expect(speakerName('you')).toBe('You');
    expect(speakerName('diomedes')).toBe('Nectovia');
    expect(speakerName('assistant')).toBe('Nectovia');
  });
});

describe('what keeps the old name in this pass (contract A3)', () => {
  it('leaves the desktop shell, the window title and the icon source as Diomedes', () => {
    const shell = read('desktop/main.mjs');
    expect(shell).toContain("app.setName('Diomedes');");
    expect(shell).toContain("title: 'Diomedes',");
    // Native dialogs keep the name the window has (a recorded remaining decision).
    expect(shell).toContain("dialog.showErrorBox('Diomedes could not start'");
    // No string the shell can show says the new name: the scheme's id and a
    // comment may mention it, a window title or a dialog may not.
    const desktop = fs
      .readdirSync(path.join(root, 'desktop'))
      .filter((name) => /\.(mjs|js|ts)$/.test(name))
      .map((name) => `desktop/${name}`);
    expect(desktop).toContain('desktop/main.mjs');
    const said = desktop.flatMap((file) =>
      shownStrings(file, read(file), file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS),
    );
    expect(said.length).toBeGreaterThan(50);
    expect(said.filter((hit) => /nectovia/i.test(hit.text))).toEqual([]);
    expect(read('index.html')).toContain('<title>Diomedes</title>');
    expect(read('client/console/Mark.tsx')).toContain('<span className="dm-mark-word">Diomedes</span>');
  });

  it('keeps the machine identifiers the scan allows', () => {
    expect(read('client/api.ts')).toContain("'X-Diomedes-Client': '1'");
    expect(read('client/console/Wake.tsx')).toContain('dm-wake');
    expect(read('client/console/Diomedes.tsx')).toContain('export function Diomedes(');
  });
});
