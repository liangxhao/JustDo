import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

export const PluginOperationStatusSlot = createContext<HTMLDivElement | null | undefined>(
  undefined,
);

export const pluginOperationStatusContainerClassName =
  'pointer-events-none fixed bottom-4 right-4 z-[70] max-h-[calc(100vh-2rem)] w-96 max-w-[calc(100vw-2rem)] space-y-2 overflow-y-auto';

export function PluginOperationStatusContent({ children }: { children: ReactNode }) {
  const slot = useContext(PluginOperationStatusSlot);
  if (slot === null) return null;
  return createPortal(
    slot ? (
      children
    ) : (
      <div className={pluginOperationStatusContainerClassName}>
        <div className="pointer-events-auto space-y-2">{children}</div>
      </div>
    ),
    slot ?? document.body,
  );
}
