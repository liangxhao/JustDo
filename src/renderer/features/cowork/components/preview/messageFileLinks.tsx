import type { MessageFileLinkTarget } from '@shared/preview/messageFileLink';
import { createContext, useContext } from 'react';

/** The receiving workspace owns preparation, routing and navigation lifetime. */
export type OpenMessageFileLink = (
  target: MessageFileLinkTarget,
  options?: { legacyHtml?: boolean },
) => void;

export const MessageFileLinkContext = createContext<OpenMessageFileLink | undefined>(undefined);

export function useMessageFileLinkOpener(): OpenMessageFileLink | undefined {
  return useContext(MessageFileLinkContext);
}
