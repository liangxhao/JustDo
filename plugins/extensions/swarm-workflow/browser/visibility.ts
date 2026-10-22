import { useEffect, useState } from 'react';

/** The host supplies the owning document, including detached workspace documents. */
export function useWorkflowVisibility(ownerDocument: Document): boolean {
  const [visible, setVisible] = useState(ownerDocument.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(ownerDocument.visibilityState !== 'hidden');
    update();
    ownerDocument.addEventListener('visibilitychange', update);
    return () => ownerDocument.removeEventListener('visibilitychange', update);
  }, [ownerDocument]);
  return visible;
}
