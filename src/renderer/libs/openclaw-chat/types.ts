/**
 * Gateway message format types matching OpenClaw's internal types.
 * These are the types used by the rendering pipeline (buildChatItems, renderMessageGroup).
 */

// ─── ChatItem (rendering pipeline output) ───────────────────────────────────

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: 'message'; key: string; message: unknown; duplicateCount?: number }
  | {
      kind: 'divider';
      key: string;
      label: string;
      description?: string;
      action?: { kind: 'session-checkpoints'; label: string };
      timestamp: number;
    }
  | {
      kind: 'stream';
      key: string;
      text: string;
      startedAt: number;
      isStreaming: boolean;
      toolMessages?: unknown[];
    }
  | { kind: 'reading-indicator'; key: string };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: 'group';
  key: string;
  role: string;
  senderLabel?: string | null;
  messages: Array<{ message: unknown; key: string; duplicateCount?: number }>;
  timestamp: number;
  isStreaming: boolean;
};

// ─── NormalizedMessage (rendering pipeline intermediate) ────────────────────

/** Content item types in a normalized message */
export type MessageContentItem =
  | {
      type: 'text' | 'tool_call' | 'tool_result';
      text?: string;
      name?: string;
      args?: unknown;
    }
  | {
      type: 'attachment';
      attachment: {
        url: string;
        kind: 'image' | 'audio' | 'video' | 'document';
        label: string;
        mimeType?: string;
        isVoiceNote?: boolean;
      };
    }
  | {
      type: 'canvas';
      preview: {
        kind: 'canvas';
        surface: 'assistant_message';
        render: 'url';
        title?: string;
        preferredHeight?: number;
        url?: string;
        viewId?: string;
        className?: string;
        style?: string;
      };
      rawText?: string | null;
    };

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  audioAsVoice?: boolean;
  replyTarget?: { kind: 'current' } | { kind: 'id'; id: string } | null;
};

// ─── ToolCard (inline tool call/result rendering) ───────────────────────────

export type ToolCard = {
  id: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  isError?: boolean;
  messageId?: string;
  preview?: {
    kind: 'canvas';
    surface: 'assistant_message';
    render: 'url';
    title?: string;
    preferredHeight?: number;
    url?: string;
    viewId?: string;
    className?: string;
    style?: string;
  };
};

// ─── Gateway Message (raw format from gateway) ─────────────────────────────

/**
 * Raw gateway message format. This is the format that the rendering pipeline expects.
 * Messages from the gateway have `role` and `content` fields.
 *
 * Content can be:
 * - A string (simple text message)
 * - An array of content blocks (text, tool_use, tool_result, image, etc.)
 */
export interface GatewayMessage {
  role: string;
  content?: string | GatewayContentBlock[];
  text?: string;
  timestamp?: number;
  ts?: number;
  id?: string;
  // Tool message fields
  toolCallId?: string;
  tool_call_id?: string;
  toolName?: string;
  tool_name?: string;
  // Media paths
  MediaPaths?: string[];
  MediaPath?: string;
  // Metadata
  __openclaw?: Record<string, unknown>;
  // Extensible
  [key: string]: unknown;
}

export interface GatewayContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  tool_call_id?: string;
  input?: unknown;
  content?: string | GatewayContentBlock[];
  // Extensible
  [key: string]: unknown;
}

// ─── ChatQueueItem ──────────────────────────────────────────────────────────

export type ChatQueueItem = {
  key: string;
  id?: string;
  text: string;
  createdAt: number;
  sendSubmittedAtMs?: number;
  sendState?:
    | 'queued'
    | 'sending'
    | 'sent'
    | 'error'
    | 'failed'
    | 'waiting-model'
    | 'waiting-reconnect';
  attachments?: ChatAttachment[];
};

// ─── ChatAttachment ─────────────────────────────────────────────────────────

export type ChatAttachment = {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
};
