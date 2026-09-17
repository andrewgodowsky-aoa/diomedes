import type { DocumentInfo } from '../../shared/types';

export type FileNode =
  | { kind: 'folder'; path: string; name: string; children: FileNode[] }
  | { kind: 'file'; path: string; name: string; document: DocumentInfo };

export interface VisibleFileNode {
  node: FileNode;
  depth: number;
  parent: string | null;
  position: number;
  size: number;
}

/** The same visible order drives rendering, roving focus and ARIA hierarchy. */
export function visibleFileNodes(
  nodes: readonly FileNode[],
  expanded: ReadonlySet<string>,
): VisibleFileNode[] {
  const rows: VisibleFileNode[] = [];
  const visit = (siblings: readonly FileNode[], depth: number, parent: string | null) => {
    siblings.forEach((node, index) => {
      rows.push({ node, depth, parent, position: index + 1, size: siblings.length });
      if (node.kind === 'folder' && expanded.has(node.path))
        visit(node.children, depth + 1, node.path);
    });
  };
  visit(nodes, 0, null);
  return rows;
}

export type FileTreeAction = { kind: 'focus' | 'expand' | 'collapse'; path: string };

export function fileTreeKey(
  rows: readonly VisibleFileNode[],
  expanded: ReadonlySet<string>,
  path: string,
  key: string,
): FileTreeAction | null {
  const index = rows.findIndex((row) => row.node.path === path);
  if (index < 0) return null;
  const row = rows[index];
  const focus = (target: VisibleFileNode): FileTreeAction => ({
    kind: 'focus',
    path: target.node.path,
  });
  switch (key) {
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows[rows.length - 1]);
    case 'ArrowUp':
      return focus(rows[Math.max(0, index - 1)]);
    case 'ArrowDown':
      return focus(rows[Math.min(rows.length - 1, index + 1)]);
    case 'ArrowRight':
      if (row.node.kind !== 'folder') return null;
      if (!expanded.has(path)) return { kind: 'expand', path };
      return rows[index + 1]?.parent === path ? focus(rows[index + 1]) : null;
    case 'ArrowLeft':
      if (row.node.kind === 'folder' && expanded.has(path)) return { kind: 'collapse', path };
      return row.parent ? { kind: 'focus', path: row.parent } : null;
    default:
      return null;
  }
}

/** A removed/hidden row falls back to its nearest visible ancestor, then first. */
export function visibleFocus(
  rows: readonly VisibleFileNode[],
  preferred: string | null,
): string | null {
  let path = preferred;
  while (path) {
    if (rows.some((row) => row.node.path === path)) return path;
    const slash = path.lastIndexOf('/');
    path = slash < 0 ? null : path.slice(0, slash);
  }
  return rows[0]?.node.path ?? null;
}
