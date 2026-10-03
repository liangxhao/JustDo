import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

export function useDisplayTabOrder(runtimeId: string, tabIds: readonly string[]) {
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const orderedIds = useMemo(() => {
    const previous = orders[runtimeId] ?? [];
    const present = new Set(tabIds);
    const known = new Set(previous);
    return [...previous.filter(id => present.has(id)), ...tabIds.filter(id => !known.has(id))];
  }, [orders, runtimeId, tabIds]);

  useLayoutEffect(() => {
    const previous = orders[runtimeId];
    if (previous?.length === orderedIds.length && previous.every((id, i) => id === orderedIds[i])) {
      return;
    }
    setOrders(current => ({ ...current, [runtimeId]: orderedIds }));
  }, [orderedIds, orders, runtimeId]);

  const replaceTab = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      setOrders(current => {
        const previous = current[runtimeId] ?? tabIds;
        // Selecting an existing singleton tool retains that tool's position.
        if (previous.includes(targetId)) return current;
        const sourceIndex = previous.indexOf(sourceId);
        if (sourceIndex < 0) return current;
        const next = [...previous];
        // Browser close notifications arrive after the tool has opened. Keep the
        // source beside its replacement until the browser publishes its removal.
        next.splice(sourceIndex, 0, targetId);
        return { ...current, [runtimeId]: next };
      });
    },
    [runtimeId, tabIds],
  );

  return { orderedIds, replaceTab };
}
