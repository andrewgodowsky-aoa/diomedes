import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Wide windows and multitask mode, Phase 1
// (docs/superpowers/specs/2026-10-03-wide-windows-and-multitask-mode-design.md): type and
// spacing keep one size at every window width, so a bigger window adds margin and nothing
// else. A viewport or container unit in a font, padding, margin or gap, or in a type, line
// or measure token, would tie them to the window again. The rules that predate the guard are
// listed below with the reason each may stay; anything new fails.

const unit =
  /(?<![\w-])\d*\.?\d+(?:vw|vh|vi|vb|vmin|vmax|[dsl]v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))\b/i;
const sizing = /^(?:font|font-size|padding(?:-[a-z]+)*|margin(?:-[a-z]+)*|gap|row-gap|column-gap)$/;
const token = /^--dm-(?:type|line|measure)\b/;

const allowed: Record<string, string> = {
  'client/styles.css|.top-bar|padding-right':
    'Keeps the bar clear of the window buttons (env(titlebar-area-*)); it sizes nothing.',
  'client/console/console.css|.console .top|padding-right':
    'Keeps the bar clear of the window buttons (env(titlebar-area-*)); it sizes nothing.',
  'client/console/artifacts.css|.console.diomedes .stage.art-open|padding-right':
    "Room for the artifact panel, capped like the panel at 60% of the window. Phase 2's side panel replaces it.",
  'client/console/palette.css|.console .veil|padding-top':
    'Where the Ctrl+K palette sits on the screen; it sizes nothing.',
  'client/styles.css|.initial-state|padding':
    'The full-window loading, error and sign-in screens, outside the Console.',
};

function files(dir: string, ext: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(ext))
    .map((file) => path.join(dir, file));
}

/** Every declaration in a stylesheet, with the selector of the rule it sits in. */
function declarations(css: string) {
  const found: { selector: string; property: string; value: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // An innermost block: a group rule's own `{` ends the prelude, so the match starts at the rule.
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim().replace(/\s+/g, ' ');
    for (const line of block[2].split(';')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      found.push({
        selector,
        property: line.slice(0, colon).trim().toLowerCase(),
        value: line.slice(colon + 1).trim(),
      });
    }
  }
  return found;
}

function offenders() {
  const root = process.cwd();
  const list: string[] = [];
  for (const file of files(path.join(root, 'client'), '.css')) {
    const name = path.relative(root, file).split(path.sep).join('/');
    for (const { selector, property, value } of declarations(fs.readFileSync(file, 'utf8')))
      if ((sizing.test(property) || token.test(property)) && unit.test(value))
        list.push(`${name}|${selector}|${property}`);
  }
  return list;
}

describe('type and spacing keep one size at every window width', () => {
  it('no stylesheet sizes type or spacing by the window, beyond the listed rules', () => {
    const found = offenders();
    expect(found.filter((key) => !(key in allowed))).toEqual([]);
  });

  it('every listed rule still exists, so the list only ever shrinks', () => {
    const found = new Set(offenders());
    expect(Object.keys(allowed).filter((key) => !found.has(key))).toEqual([]);
  });

  it('no inline style sizes type or spacing by the window', () => {
    const inline =
      /\b(?:fontSize|font|padding\w*|margin\w*|gap|rowGap|columnGap)\s*:\s*(['"`])((?:(?!\1).)*)\1/g;
    const list: string[] = [];
    for (const file of files(path.join(process.cwd(), 'client'), '.tsx')) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(inline))
        if (unit.test(match[2])) list.push(`${path.relative(process.cwd(), file)}: ${match[0]}`);
    }
    expect(list).toEqual([]);
  });

  it('the home greeting has a fixed size from the type scale', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'client/console/nectovia.css'), 'utf8');
    const greeting = declarations(css).find(
      (rule) => rule.selector.endsWith('.nv-greeting') && rule.property === 'font',
    );
    expect(greeting?.value).toContain('var(--dm-type-display)');
    const tokens = fs.readFileSync(path.join(process.cwd(), 'client/styles.css'), 'utf8');
    expect(tokens).toMatch(/--dm-type-display:\s*3rem;/);
  });
});
