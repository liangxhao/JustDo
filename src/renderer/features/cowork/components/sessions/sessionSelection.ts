export function toggleVisibleSessionSelection(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  return visibleIds.every(id => selected.has(id)) ? new Set() : new Set(visibleIds);
}
