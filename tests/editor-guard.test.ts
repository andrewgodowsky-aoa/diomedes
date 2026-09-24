import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import {
  editorDocument,
  guardEditorExits,
  leaveEditor,
  type EditorExit,
} from '../client/console/editor-guard';
import type { DocumentInfo } from '../shared/types';

/**
 * The editor's one exit gate (DIO-85) and the no-guessing rule for the kind of
 * file it opens (DIO-87). The browser behaviour is driven end to end in
 * tests/editor-guard-ui.spec.ts; this pins the contract and keeps new exits
 * from growing around the gate.
 */

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

describe('leaveEditor', () => {
  test('goes straight through when no Console holds an editor', () => {
    const went: string[] = [];
    leaveEditor(() => went.push('settings'));
    expect(went).toEqual(['settings']);
  });

  test('hands the exit to the gate, which may let it through later or never', () => {
    const waiting: Array<() => void> = [];
    release = guardEditorExits((then) => waiting.push(then));
    const went: string[] = [];
    leaveEditor(() => went.push('projects'));
    expect(went).toEqual([]);
    waiting[0]();
    expect(went).toEqual(['projects']);
    leaveEditor(() => went.push('board'));
    expect(went).toEqual(['projects']);
  });

  test('a removed gate stops guarding, and removing a replaced one changes nothing', () => {
    const first: EditorExit = () => undefined;
    const second: EditorExit = (then) => then();
    const dropFirst = guardEditorExits(first);
    release = guardEditorExits(second);
    dropFirst();
    const went: string[] = [];
    leaveEditor(() => went.push('thread'));
    expect(went).toEqual(['thread']);
    release();
    release = null;
    leaveEditor(() => went.push('after'));
    expect(went).toEqual(['thread', 'after']);
  });
});

describe('editorDocument', () => {
  const listed: DocumentInfo = {
    path: 'example.go',
    kind: 'unsupported',
    size: 12,
    changedAt: '2026-09-24T00:00:00.000Z',
    hasChangesWaiting: false,
    recorded: false,
  };

  test('is the listing record when the listing has the file', () => {
    expect(editorDocument([listed], 'example.go', null)).toBe(listed);
  });

  test('never guesses a kind for a file the listing does not have yet', () => {
    const pending = editorDocument([], 'example.go', null);
    expect(pending).toEqual({ path: 'example.go' });
    expect(pending.kind).toBeUndefined();
  });

  test('carries the listing failure, still without a kind', () => {
    expect(editorDocument([], 'notes.md', 'The folder could not be read.')).toEqual({
      path: 'notes.md',
      problem: 'The folder could not be read.',
    });
  });
});

describe('every way out of the editor goes through the gate', () => {
  const read = (file: string) =>
    fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  test('Shell changes the open file only through the gate, Close and a rescue copy', () => {
    const shell = read('client/console/Shell.tsx');
    const calls = shell.match(/setEditing\([^)]*\)/g) ?? [];
    // The gate's own leave, Close (which has asked already), a rescue copy
    // (whose writing is on disk in the copy) and opening a file from Files
    // (inside `leaveEditor`). Anything else is a new exit that skipped the gate.
    expect(calls.sort()).toEqual(
      ['setEditing(null)', 'setEditing(null)', 'setEditing(path)', 'setEditing(path)'].sort(),
    );
    expect(shell).toContain('onEdit={(path) => path !== editing && leaveEditor(() => setEditing(path))}');
    expect(shell).toContain('if (editingNow.current !== null) return leaveEditor(() => goTo(id));');
    // No file is ever given a made-up kind.
    expect(shell).not.toMatch(/kind:\s*'markdown'/);
  });

  test('App takes the Console off the screen only through the gate', () => {
    const app = read('client/App.tsx');
    // The top strip and the usage chip, which sit above the Console, use the guarded helpers too.
    expect(app.match(/onShowProjects=\{showProjects\}/g) ?? []).toHaveLength(2);
    expect(app).toContain('onToggleSettings={() => (showSettings ? setShowSettings(false) : openSettings())}');
    expect(app).toContain('onOpen={() => openSettings(true)}');
    expect(app).toContain('const openSettings = (helpers = false) =>\n    leaveEditor(() => {');
    expect(app).toContain('const showProjects = () =>\n    leaveEditor(() => {');
    expect(app).toContain('else leaveEditor(() => enterProject(project));');
    const shellProps = app.slice(app.indexOf('<Shell'), app.indexOf('/>', app.indexOf('<Shell')));
    expect(shellProps).toContain('openEngineSettings={() => openSettings(true)}');
    expect(shellProps).toContain('onOpenProject={openProject}');
    expect(shellProps).toContain('onShowProjects={showProjects}');
    expect(shellProps).toContain('onOpenSettings={() => openSettings()}');
  });

  test('the desktop window asks before closing over writing the page could not keep', () => {
    const main = read('desktop/main.mjs');
    expect(main).toContain("win.webContents.on('will-prevent-unload'");
    expect(main).toContain("buttons: ['Keep writing', 'Close and lose it']");
  });
});
