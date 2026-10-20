import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

const UiStyleScopeContext = createContext<string | undefined>(undefined);

/** Supply a stylesheet ancestor without adding a layout box to the surface. */
export function UiStyleScopeBoundary({
  scope,
  children,
}: {
  scope?: string;
  children?: ReactNode;
}) {
  const inherited = useContext(UiStyleScopeContext);
  const current = scope ?? inherited;
  if (!current) return children;
  return (
    <UiStyleScopeContext.Provider value={current}>
      <span data-ui-style-scope={current} style={{ display: 'contents' }}>
        {children}
      </span>
    </UiStyleScopeContext.Provider>
  );
}

/** Resolve scope while rendering the portal, including calls made outside a component. */
export const createStyleScopedPortal: typeof createPortal = (children, container, key) =>
  createPortal(<UiStyleScopeBoundary>{children}</UiStyleScopeBoundary>, container, key);
