/** Pure helpers for building a recursive directory tree from flat git-change
 *  paths, used by the Git Panel's tree view. No React. */

import type { GitFileChange } from '@/lib/api/client';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
  file?: GitFileChange;
}

/** Build a recursive directory tree from flat file paths.
 *  `src/components/chat/Composer.tsx` → src → components → chat → Composer.tsx */
export function buildFileTree(files: GitFileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const childPath = node.path ? `${node.path}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: childPath,
          isDir: !isLeaf,
          children: new Map(),
          file: isLeaf ? file : undefined,
        });
      }
      node = node.children.get(part)!;
    }
  }
  return root;
}

/** Count total files under a node (recursively). */
export function countFiles(node: TreeNode): number {
  if (!node.isDir) return 1;
  let count = 0;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}
