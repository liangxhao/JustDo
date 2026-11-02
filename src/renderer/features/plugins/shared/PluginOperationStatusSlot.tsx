import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { useOwnerDocument } from '@/shared/dom/ownerDocument';

export const PluginOperationStatusSlot = createContext<HTMLDivElement | null | undefined>(
  undefined,
);

export const pluginOperationStatusContainerClassName =
  'pointer-events-none fixed bottom-4 right-4 z-[70] max-h-[calc(100vh-2rem)] w-96 max-w-[calc(100vw-2rem)] space-y-2 overflow-y-auto';

type FallbackSlot = { root: HTMLDivElement; content: HTMLDivElement; users: number };
const fallbackSlots = new WeakMap<Document, FallbackSlot>();

function useFallbackSlot(enabled: boolean): HTMLDivElement | null {
  const ownerDocument = useOwnerDocument();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setSlot(null);
      return;
    }
    let fallback = fallbackSlots.get(ownerDocument);
    if (!fallback) {
      const root = ownerDocument.createElement('div');
      root.className = pluginOperationStatusContainerClassName;
      const content = ownerDocument.createElement('div');
      content.className = 'pointer-events-auto space-y-2';
      root.append(content);
      ownerDocument.body.append(root);
      fallback = { root, content, users: 0 };
      fallbackSlots.set(ownerDocument, fallback);
    }
    const current = fallback;
    current.users += 1;
    setSlot(current.content);
    return () => {
      current.users -= 1;
      if (current.users === 0) {
        current.root.remove();
        fallbackSlots.delete(ownerDocument);
      }
    };
  }, [enabled, ownerDocument]);
  return slot;
}

export function PluginOperationStatusContent({ children }: { children: ReactNode }) {
  const slot = useContext(PluginOperationStatusSlot);
  const fallback = useFallbackSlot(slot === undefined);
  const target = slot === undefined ? fallback : slot;
  return target ? createPortal(children, target) : null;
}
