export const getAdjacentDisplayTabId = (
  tabIds: readonly string[],
  closingId: string,
): string | null => {
  const closingIndex = tabIds.indexOf(closingId);
  if (closingIndex < 0) return null;
  return tabIds[closingIndex + 1] ?? tabIds[closingIndex - 1] ?? null;
};
