import type { NormalizedAgentEvent, NormalizedChatEvent } from '../openclaw/agentEvent';

/** Product app-server notification; not a native Codex protocol method. */
export const BROWSER_EXTENSION_STREAM_METHOD = 'browser/thread/stream';
export type BrowserExtensionStreamEvent =
  { kind: 'agent'; event: NormalizedAgentEvent } | { kind: 'chat'; event: NormalizedChatEvent };
