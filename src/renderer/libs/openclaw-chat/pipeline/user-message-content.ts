export function buildUserChatMessageContentBlocks(_text: string, _attachments?: unknown[]): unknown[] {
  return [{ type: 'text', text: _text }];
}
