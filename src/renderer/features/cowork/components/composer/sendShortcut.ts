import type { KeyboardEvent } from 'react';

import { configService } from '@/services/config';
import { matchesShortcut } from '@/services/shortcuts';

export function isComposerSendShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcut = configService.getConfig().shortcuts?.sendMessage ?? 'Enter',
): boolean {
  if (
    event.defaultPrevented ||
    event.key !== 'Enter' ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return false;

  const sendShortcut = ['Enter', 'Shift+Enter', 'Ctrl+Enter', 'Alt+Enter'].includes(shortcut)
    ? shortcut
    : 'Enter';
  return matchesShortcut(
    event,
    sendShortcut === 'Ctrl+Enter' && navigator.platform.includes('Mac')
      ? 'Cmd+Enter'
      : sendShortcut,
  );
}
