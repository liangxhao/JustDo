import type { ThinkingItem, ToolItem } from '../chat-transcript-state';
import { projectProcessNesting } from '../tools/tool-presentation';

type Process = ThinkingItem | ToolItem;
type ProcessRow = {
  item: Process;
  visible: boolean;
  toolDepth?: number;
};

/** Keep a visible call with its family while preserving the native order of archived rows. */
export function projectProcessVisibility(
  items: readonly Process[],
  isVisible: (item: Process) => boolean,
): ProcessRow[] {
  const { items: displayOrder, depths, roots } = projectProcessNesting(items);
  if (!roots.size) return items.map(item => ({ item, visible: isVisible(item) }));

  const familyMembers = new Map<ToolItem, ProcessRow[]>();
  const visibleFamilies = new Set<ToolItem>();
  for (const item of displayOrder) {
    if (item.type !== 'tool') continue;
    const root = roots.get(item);
    if (isVisible(item)) visibleFamilies.add(root ?? item);
    if (!root) continue;
    const members = familyMembers.get(root) ?? [];
    members.push({ item, visible: true, toolDepth: depths.get(item) });
    familyMembers.set(root, members);
  }

  const rows: ProcessRow[] = [];
  for (const item of items) {
    if (item.type === 'thinking') {
      rows.push({ item, visible: isVisible(item) });
      continue;
    }
    const root = roots.get(item) ?? item;
    if (!visibleFamilies.has(root)) {
      rows.push({ item, visible: false });
    } else if (root === item) {
      const members = familyMembers.get(root);
      rows.push({ item, visible: true, ...(members ? { toolDepth: 0 } : {}) });
      for (const member of members ?? []) rows.push(member);
    }
  }
  return rows;
}
