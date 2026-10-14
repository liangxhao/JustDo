const nameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

/** Keep local inventory order independent of discovery order and UI language. */
export const comparePluginNames = (
  left: { id: string; name: string },
  right: { id: string; name: string },
): number => {
  const nameOrder = nameCollator.compare(left.name, right.name);
  if (nameOrder !== 0) return nameOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};
