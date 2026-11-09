import { createContext, useContext } from 'react';

import type { OpenMessageFileLink } from '@/libs/openclaw-chat/message-actions';

export type { OpenMessageFileLink } from '@/libs/openclaw-chat/message-actions';

export const MessageFileLinkContext = createContext<OpenMessageFileLink | undefined>(undefined);

export function useMessageFileLinkOpener(): OpenMessageFileLink | undefined {
  return useContext(MessageFileLinkContext);
}
