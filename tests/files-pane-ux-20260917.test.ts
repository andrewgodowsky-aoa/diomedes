import { describe, expect, it } from 'vitest';
import {
  fileTreeKey,
  visibleFileNodes,
  visibleFocus,
  type FileNode,
} from '../client/console/file-tree-navigation';

const file = (path: string): FileNode => ({
  kind: 'file',
  path,
  name: path,
  document: {
    path,
    kind: 'text',
    size: 1,
    changedAt: '',
    recorded: false,
    hasChangesWaiting: false,
  },
});
const tree: FileNode[] = [
  {
    kind: 'folder',
    name: 'a',
    path: 'a',
    children: [
      { kind: 'folder', name: 'nested', path: 'a/nested', children: [file('a/nested/one')] },
      file('a/two'),
    ],
  },
  file('z'),
];
describe('visible file hierarchy navigation', () => {
  it('omits collapsed descendants and supplies explicit hierarchy metadata', () => {
    expect(visibleFileNodes(tree, new Set()).map(({ node }) => node.path)).toEqual(['a', 'z']);
    const rows = visibleFileNodes(tree, new Set(['a']));
    expect(rows.map(({ node }) => node.path)).toEqual(['a', 'a/nested', 'a/two', 'z']);
    expect(rows[2]).toMatchObject({ depth: 1, parent: 'a', position: 2, size: 2 });
  });
  it('moves only through visible rows and clamps the ends', () => {
    const expanded = new Set(['a']);
    const rows = visibleFileNodes(tree, expanded);
    for (const [path, key, target] of [
      ['a', 'ArrowUp', 'a'],
      ['z', 'ArrowDown', 'z'],
      ['a/nested', 'ArrowDown', 'a/two'],
      ['z', 'Home', 'a'],
      ['a', 'End', 'z'],
    ])
      expect(fileTreeKey(rows, expanded, path, key)).toEqual({ kind: 'focus', path: target });
  });
  it('expands before entering a folder and collapses before going to its parent', () => {
    const expanded = new Set(['a']);
    const rows = visibleFileNodes(tree, expanded);
    expect(fileTreeKey(rows, expanded, 'a/nested', 'ArrowRight')).toEqual({
      kind: 'expand',
      path: 'a/nested',
    });
    expect(fileTreeKey(rows, expanded, 'a', 'ArrowRight')).toEqual({
      kind: 'focus',
      path: 'a/nested',
    });
    expect(fileTreeKey(rows, expanded, 'a', 'ArrowLeft')).toEqual({ kind: 'collapse', path: 'a' });
    expect(fileTreeKey(rows, expanded, 'a/two', 'ArrowLeft')).toEqual({ kind: 'focus', path: 'a' });
  });
  it('leaves native activation and unrelated keys to the row button', () => {
    const rows = visibleFileNodes(tree, new Set());
    for (const key of ['Enter', ' ', 'k', 'ArrowRight'])
      expect(fileTreeKey(rows, new Set(), 'z', key)).toBeNull();
    expect(fileTreeKey(rows, new Set(), 'missing', 'Home')).toBeNull();
  });
  it('recovers focus after collapse, removal and an empty listing', () => {
    expect(visibleFocus(visibleFileNodes(tree, new Set(['a'])), 'a/nested/one')).toBe('a/nested');
    expect(visibleFocus(visibleFileNodes(tree, new Set()), 'a/two')).toBe('a');
    expect(visibleFocus(visibleFileNodes(tree, new Set()), 'removed')).toBe('a');
    expect(visibleFocus([], 'a')).toBeNull();
  });
});
