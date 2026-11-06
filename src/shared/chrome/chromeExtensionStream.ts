import type { NormalizedAgentEvent, NormalizedChatEvent } from '../openclaw/agentEvent';

/** Product app-server notification; not a native Codex protocol method. */
export const CHROME_EXTENSION_STREAM_METHOD = 'chrome/thread/stream';
export type ChromeExtensionStreamEvent =
  { kind: 'agent'; event: NormalizedAgentEvent } | { kind: 'chat'; event: NormalizedChatEvent };
