/**
 * Stream text behavior utilities.
 * Copied from OpenClaw ui/src/ui/chat/stream-text.ts
 */
export function trimAccumulatedStreamPrefix(text: string, previousText: string | null): string {
  if (!previousText || !text.startsWith(previousText)) {
    return text;
  }
  return text.slice(previousText.length).trimStart();
}
