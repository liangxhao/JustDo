import type { WorktreeInitialCommitFile } from '@shared/cowork/worktreeInitialCommit';

interface CommitTreeFile {
  kind: 'file';
  name: string;
  path: string;
}

interface CommitTreeFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: CommitTreeEntry[];
  fileCount: number;
}

type CommitTreeEntry = CommitTreeFolder | CommitTreeFile;

interface CommitTreeRow {
  entry: CommitTreeEntry;
  depth: number;
  expanded: boolean;
}

export function buildCommitTree(files: readonly WorktreeInitialCommitFile[]): CommitTreeEntry[] {
  const root: CommitTreeEntry[] = [];
  const folders = new Map<string, CommitTreeFolder>();

  for (const file of files) {
    const segments = file.path.split('/');
    const name = segments.pop()!;
    let children = root;
    let folderPath = '';
    for (const segment of segments) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { kind: 'folder', name: segment, path: folderPath, children: [], fileCount: 0 };
        folders.set(folderPath, folder);
        children.push(folder);
      }
      folder.fileCount++;
      children = folder.children;
    }
    children.push({ kind: 'file', name, path: file.path });
  }

  const sortEntries = (entries: CommitTreeEntry[]) => {
    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  };
  sortEntries(root);
  for (const folder of folders.values()) sortEntries(folder.children);
  return root;
}

export function countCommitFilesByFolder(paths: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const filePath of paths) {
    let end = filePath.lastIndexOf('/');
    while (end !== -1) {
      const path = filePath.slice(0, end);
      counts.set(path, (counts.get(path) ?? 0) + 1);
      end = path.lastIndexOf('/');
    }
  }
  return counts;
}

export function flattenCommitTree(
  tree: CommitTreeEntry[],
  expandedPaths: ReadonlySet<string>,
  search: {
    files: ReadonlySet<string>;
    folders: ReadonlyMap<string, number>;
    collapsed: ReadonlySet<string>;
  } | null,
): CommitTreeRow[] {
  const rows: CommitTreeRow[] = [];
  const visit = (entries: CommitTreeEntry[], depth: number) => {
    for (const entry of entries) {
      if (entry.kind === 'file') {
        if (!search || search.files.has(entry.path)) rows.push({ entry, depth, expanded: false });
        continue;
      }
      if (search && !search.folders.has(entry.path)) continue;
      const expanded = search ? !search.collapsed.has(entry.path) : expandedPaths.has(entry.path);
      rows.push({ entry, depth, expanded });
      if (expanded) visit(entry.children, depth + 1);
    }
  };
  visit(tree, 0);
  return rows;
}

export function selectCommitTreeEntry(
  selectedPaths: ReadonlySet<string>,
  entry: CommitTreeEntry,
  checked: boolean,
  matchingFiles?: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selectedPaths);
  const visit = (item: CommitTreeEntry) => {
    if (item.kind === 'folder') {
      item.children.forEach(visit);
    } else if (!matchingFiles || matchingFiles.has(item.path)) {
      if (checked) next.add(item.path);
      else next.delete(item.path);
    }
  };
  visit(entry);
  return next;
}
