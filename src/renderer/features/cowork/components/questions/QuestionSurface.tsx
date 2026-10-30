import { type ReactNode, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

/** Move one persistent portal container so changing display windows does not erase answers. */
export function QuestionSurface({ target, children }: { target?: Document; children: ReactNode }) {
  const [container] = useState(() => document.createElement('div'));
  const [closedDocument, setClosedDocument] = useState<Document | null>(null);
  const ownerDocument =
    target === closedDocument || target?.defaultView?.closed ? document : (target ?? document);
  useLayoutEffect(() => {
    ownerDocument.body.appendChild(container);
  }, [container, ownerDocument]);
  useLayoutEffect(() => {
    if (ownerDocument === document) return;
    const onPageHide = (): void => {
      document.body.appendChild(container);
      setClosedDocument(ownerDocument);
    };
    ownerDocument.defaultView?.addEventListener('pagehide', onPageHide, {
      once: true,
    });
    return () => ownerDocument.defaultView?.removeEventListener('pagehide', onPageHide);
  }, [container, ownerDocument]);
  useLayoutEffect(
    () => () => {
      container.remove();
    },
    [container],
  );
  return createPortal(
    <OwnerDocumentContext.Provider value={ownerDocument}>{children}</OwnerDocumentContext.Provider>,
    container,
  );
}
