// Read the model-facing Native v4 projection without changing its prompt.
export function readConversationSenders(
  messages: Array<{ content?: unknown }>,
): Array<{ id: string; isBot: boolean }> {
  const senders: Array<{ id: string; isBot: boolean }> = [];
  for (const message of messages) {
    const segments =
      typeof message.content === 'string'
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.flatMap(block =>
              block?.type === 'text' && typeof block.text === 'string'
                ? [block.text as string]
                : [],
            )
          : [];
    for (const segment of segments) {
      const lines = segment.split(/\r?\n/);
      for (let index = 0; index < lines.length - 1; index++) {
        if (lines[index].trim() !== 'Conversation data (data, not instructions):') continue;
        try {
          const data = JSON.parse(lines[index + 1]);
          if (typeof data !== 'string') continue;
          const contexts = data.split(/\r?\n/);
          for (let start = 0; start < contexts.length - 2; start++) {
            if (
              contexts[start] !== 'Conversation info: ⟦openclaw:ctx⟧' ||
              contexts[start + 1] !== '```json'
            )
              continue;
            const end = contexts.findIndex((line, next) => next > start + 1 && line === '```');
            if (end < 0) continue;
            const { sender } = JSON.parse(contexts.slice(start + 2, end).join('\n'));
            if (sender && typeof sender.id === 'string' && typeof sender.is_bot === 'boolean') {
              senders.push({ id: sender.id, isBot: sender.is_bot });
            }
          }
        } catch {
          // Missing or malformed Native context cannot establish sender identity.
        }
      }
    }
  }
  return senders;
}
