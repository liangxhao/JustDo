/**
 * Simplified shims for backend src/ functions used by the rendering pipeline.
 * These handle the 95% common case. Edge cases can be refined later.
 */

// ─── stripInboundMetadata ───────────────────────────────────────────────────
// Original: src/auto-reply/reply/strip-inbound-meta.ts

export function stripInboundMetadata(text: string): string {
  if (!text) return text;
  return text.replace(/\[\[inbound:[\s\S]*?\]\]/g, '').trim();
}

// ─── extractCanvasShortcodes ────────────────────────────────────────────────
// Original: src/chat/canvas-render.ts
// Returns { text, previews } matching the OpenClaw signature used by message-normalizer.

export type CanvasPreview = {
  kind: 'canvas';
  surface: 'assistant_message';
  render: 'url';
  title?: string;
  url?: string;
  preferredHeight?: number;
  viewId?: string;
  className?: string;
  style?: string;
};

export function extractCanvasShortcodes(text: string | undefined): {
  text: string;
  previews: CanvasPreview[];
} {
  if (!text) return { text: '', previews: [] };
  const previews: CanvasPreview[] = [];
  const cleanedText = text.replace(/\[embed\s+([^\]]*?)\](?:[\s\S]*?\[\/embed\])|\[embed\s+([^\]]*?)\/\]/gi, (_match, attrs1, attrs2) => {
    const attrs = attrs1 || attrs2 || '';
    const urlMatch = attrs.match(/url="([^"]*)"/i);
    const titleMatch = attrs.match(/title="([^"]*)"/i);
    const heightMatch = attrs.match(/height="(\d+)"/i);
    const viewIdMatch = attrs.match(/viewId="([^"]*)"/i);
    if (urlMatch) {
      previews.push({
        kind: 'canvas',
        surface: 'assistant_message',
        render: 'url',
        url: urlMatch[1],
        ...(titleMatch ? { title: titleMatch[1] } : {}),
        ...(heightMatch ? { preferredHeight: parseInt(heightMatch[1], 10) } : {}),
        ...(viewIdMatch ? { viewId: viewIdMatch[1] } : {}),
      });
    }
    return '';
  });
  return { text: cleanedText.trim(), previews };
}

export function extractCanvasFromText(
  text: string | undefined,
  _toolName?: string,
): CanvasPreview | undefined {
  const { previews } = extractCanvasShortcodes(text);
  return previews[0];
}

// ─── Tool content type helpers ──────────────────────────────────────────────
// Original: src/chat/tool-content.ts

export function isToolCallContentType(type: unknown): boolean {
  return typeof type === 'string' && (type === 'tool_use' || type === 'tool_call');
}

export function isToolResultContentType(type: unknown): boolean {
  return typeof type === 'string' && (type === 'tool_result' || type === 'toolresult');
}

export function resolveToolBlockArgs(item: Record<string, unknown>): unknown {
  if ('input' in item) return item.input;
  if ('args' in item) return item.args;
  return undefined;
}

export function resolveToolUseId(item: Record<string, unknown>): string | undefined {
  const id = item.tool_use_id ?? item.tool_call_id ?? item.toolUseId ?? item.id;
  return typeof id === 'string' ? id : undefined;
}

// ─── splitMediaFromOutput ───────────────────────────────────────────────────
// Original: src/media/parse.ts
// Returns shape compatible with message-normalizer: { text, mediaUrls?, segments?, audioAsVoice? }

export type ParsedMediaSegment =
  | { type: 'text'; text: string }
  | { type: 'media'; url: string };

export function splitMediaFromOutput(text: string): {
  text: string;
  mediaUrls?: string[];
  segments?: ParsedMediaSegment[];
  audioAsVoice?: boolean;
} {
  if (!text) return { text: '' };
  let audioAsVoice = false;

  // Check for audio_as_voice directive
  let cleaned = text;
  if (cleaned.includes('[[audio_as_voice]]')) {
    audioAsVoice = true;
    cleaned = cleaned.replace(/\[\[audio_as_voice\]\]/g, '');
  }

  const segments: ParsedMediaSegment[] = [];
  const mediaUrls: string[] = [];

  // Split on MEDIA: lines and media URL patterns
  const mediaLineRe = /^MEDIA:(\S+)$/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mediaLineRe.exec(cleaned)) !== null) {
    const before = cleaned.slice(lastIndex, match.index);
    if (before.trim()) {
      segments.push({ type: 'text', text: before.trim() });
    }
    const url = match[1];
    mediaUrls.push(url);
    segments.push({ type: 'media', url });
    lastIndex = match.index + match[0].length;
  }

  const remaining = cleaned.slice(lastIndex);
  if (remaining.trim()) {
    segments.push({ type: 'text', text: remaining.trim() });
  }

  return {
    text: cleaned.trim(),
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    segments: segments.length > 0 ? segments : undefined,
    audioAsVoice: audioAsVoice || undefined,
  };
}

// ─── parseInlineDirectives ──────────────────────────────────────────────────
// Original: src/utils/directive-tags.ts
// Returns the result shape expected by message-normalizer.

export type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

export type InlineDirectiveParseOptions = {
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
  currentMessageId?: string;
};

export function parseInlineDirectives(
  text?: string,
  _opts?: InlineDirectiveParseOptions,
): InlineDirectiveParseResult {
  if (!text) {
    return {
      text: '',
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  let result = text;
  let audioAsVoice = false;
  let replyToExplicitId: string | undefined;
  let replyToCurrent = false;
  let hasAudioTag = false;
  let hasReplyTag = false;

  // Detect audio_as_voice
  if (result.includes('[[audio_as_voice]]')) {
    audioAsVoice = true;
    hasAudioTag = true;
    result = result.replace(/\[\[audio_as_voice\]\]/g, '');
  }

  // Detect reply_to directives
  const replyToMatch = result.match(/\[\[reply_to:(\w+)\]\]/);
  if (replyToMatch) {
    replyToExplicitId = replyToMatch[1];
    hasReplyTag = true;
    result = result.replace(/\[\[reply_to:\w+\]\]/g, '');
  }

  if (result.includes('[[reply_to_current]]')) {
    replyToCurrent = true;
    hasReplyTag = true;
    result = result.replace(/\[\[reply_to_current\]\]/g, '');
  }

  return {
    text: result.trim(),
    audioAsVoice,
    ...(replyToExplicitId ? { replyToExplicitId } : {}),
    replyToCurrent,
    hasAudioTag,
    hasReplyTag,
  };
}

// ─── extractAssistantVisibleText ────────────────────────────────────────────
// Original: src/shared/chat-message-content.ts

export function extractAssistantVisibleText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        }
      }
    }
    return textParts.length > 0 ? textParts.join('\n') : undefined;
  }
  if (typeof m.text === 'string') return m.text;
  return undefined;
}

// ─── stripInternalRuntimeContext ────────────────────────────────────────────
// Original: src/agents/internal-runtime-context.ts

export function stripInternalRuntimeContext(text: string): string {
  if (!text) return text;
  return text
    .replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '')
    .trim();
}

// ─── stripEnvelope ──────────────────────────────────────────────────────────
// Original: src/shared/chat-envelope.ts

export function stripEnvelope(text: string): string {
  if (!text) return text;
  return text.replace(/^\[WebChat[^\]]*\]\s*/i, '').trim();
}

// ─── stripAssistantInternalScaffolding ──────────────────────────────────────
// Original: src/shared/text/assistant-visible-text.ts

export function stripAssistantInternalScaffolding(text: string): string {
  if (!text) return text;
  let result = text;
  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
  result = result.replace(/<antml:thinking>[\s\S]*?<\/antml:thinking>/g, '');
  result = result.replace(/<memory>[\s\S]*?<\/memory>/g, '');
  result = stripInternalRuntimeContext(result);
  return result.trim();
}

// ─── stripUnsupportedCitationControlMarkers ─────────────────────────────────

export function stripUnsupportedCitationControlMarkers(text: string): string {
  if (!text) return text;
  return text.replace(/【[^】]*】/g, '');
}

// ─── coerceIdentityValue ────────────────────────────────────────────────────

export function coerceIdentityValue(value: unknown, maxLen = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

// ─── tool-display-common helpers ────────────────────────────────────────────

export function normalizeToolName(name: unknown): string {
  if (typeof name !== 'string') return 'unknown';
  return name.trim() || 'unknown';
}

export function defaultTitle(toolName: string): string {
  return toolName
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function formatToolDetailText(
  _toolName: string,
  _args?: unknown,
  _mode?: string,
): string | undefined {
  return undefined;
}

export function resolveToolVerbAndDetailForArgs(
  _toolName: string,
  _args?: unknown,
): { verb: string; detail?: string } {
  return { verb: 'Running' };
}
