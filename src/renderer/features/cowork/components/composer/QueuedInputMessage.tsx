import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { UserMessageContent } from '../chat/UserMessageContent';

/** Queued inputs share the same rich message surface as other user input. */
export function QueuedInputMessage({
  message,
  workingDirectory,
}: {
  message: GatewayMessage;
  workingDirectory?: string;
}) {
  return (
    <div data-queued-message>
      <UserMessageContent message={message} workingDirectory={workingDirectory} />
    </div>
  );
}
