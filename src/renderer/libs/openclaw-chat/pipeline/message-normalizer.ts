/**
 * Message normalization utilities for chat rendering.
 */

import { stripInboundMetadata } from '@/libs/openclaw-chat/shims/backend-helpers';
import { extractCanvasShortcodes } from '@/libs/openclaw-chat/shims/backend-helpers';
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolBlockArgs,
} from '@/libs/openclaw-chat/shims/backend-helpers';
import { splitMediaFromOutput } from '@/libs/openclaw-chat/shims/backend-helpers';
import { parseInlineDirectives } from '@/libs/openclaw-chat/shims/backend-helpers';
import { mediaKindFromMime } from '@/libs/openclaw-chat/shims/media-core';
import type { MessageContentItem, NormalizedMessage } from '@/libs/openclaw-chat/types';
export {
  isToolResultMessage,
  normalizeRoleForGrouping,
} from '@/libs/openclaw-chat/pipeline/role-normalizer';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveMessageModelName(message: Record<string, unknown>): string | null {
  const metadata = asRecord(message.metadata);
  const nestedMessage = asRecord(message.message);
  const nestedMetadata = nestedMessage ? asRecord(nestedMessage.metadata) : null;

  const explicitModelName = pickTrimmedString(
    message.modelName,
    metadata?.modelName,
    nestedMessage?.modelName,
    nestedMetadata?.modelName,
  );
  if (explicitModelName) return explicitModelName;

  const provider = pickTrimmedString(message.provider, metadata?.provider, nestedMessage?.provider);
  const model = pickTrimmedString(
    message.model,
    message.modelId,
    metadata?.model,
    metadata?.modelId,
    nestedMessage?.model,
    nestedMessage?.modelId,
  );

  if (provider && model) return `${provider}/${model}`;
  return model;
}

function coerceCanvasPreview(
  value: unknown,
):
  Extract<NonNullable<NormalizedMessage['content'][number]>, { type: 'canvas' }>['preview'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const preview = value as Record<string, unknown>;
  if (preview.kind !== 'canvas' || preview.surface === 'tool_card') {
    return null;
  }
  const render = preview.render === 'url' ? 'url' : null;
  if (!render) {
    return null;
  }
  return {
    kind: 'canvas',
    surface: 'assistant_message',
    render,
    ...(typeof preview.title === 'string' ? { title: preview.title } : {}),
    ...(typeof preview.preferredHeight === 'number'
      ? { preferredHeight: preview.preferredHeight }
      : {}),
    ...(typeof preview.url === 'string' ? { url: preview.url } : {}),
    ...(typeof preview.viewId === 'string' ? { viewId: preview.viewId } : {}),
    ...(typeof preview.className === 'string' ? { className: preview.className } : {}),
    ...(typeof preview.style === 'string' ? { style: preview.style } : {}),
  };
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
};

function getFileExtension(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  const source = (() => {
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        return new URL(trimmed).pathname;
      }
    } catch {
      return trimmed;
    }
    return trimmed;
  })();
  const fileName = source.split(/[\\/]/).pop() ?? source;
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  return match?.[1]?.toLowerCase();
}

function mimeTypeFromUrl(url: string): string | undefined {
  const ext = getFileExtension(url);
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function inferAttachmentKind(url: string): {
  kind: 'image' | 'audio' | 'video' | 'document';
  mimeType?: string;
  label: string;
} {
  const mimeType = mimeTypeFromUrl(url);
  const kind = mediaKindFromMime(mimeType) ?? 'document';
  const label = (() => {
    try {
      if (/^https?:\/\//i.test(url)) {
        const parsed = new URL(url);
        const pathName = parsed.pathname.split('/').pop()?.trim();
        return pathName ? decodeURIComponent(pathName) : parsed.hostname;
      }
    } catch {
      const name = url.split(/[\\/]/).pop()?.trim();
      return name || url;
    }
    const name = url.split(/[\\/]/).pop()?.trim();
    return name || url;
  })();
  return { kind, mimeType, label };
}

function coerceAudioContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: 'attachment' }> | null {
  if (item.type !== 'audio') {
    return null;
  }
  const source = item.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  const mediaType =
    typeof sourceRecord.media_type === 'string' &&
    sourceRecord.media_type.trim().toLowerCase().startsWith('audio/')
      ? sourceRecord.media_type.trim()
      : 'audio/mpeg';
  if (sourceRecord.type === 'base64' && typeof sourceRecord.data === 'string') {
    const data = sourceRecord.data.trim();
    if (!data) {
      return null;
    }
    const url = data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;
    return {
      type: 'attachment',
      attachment: {
        url,
        kind: 'audio',
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : 'Audio',
        mimeType: mediaType,
        ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      },
    };
  }
  if (sourceRecord.type === 'url' && typeof sourceRecord.url === 'string') {
    const url = sourceRecord.url.trim();
    if (!url) {
      return null;
    }
    return {
      type: 'attachment',
      attachment: {
        url,
        kind: 'audio',
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : 'Audio',
        mimeType: mediaType,
        ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      },
    };
  }
  return null;
}

function coerceImageContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: 'attachment' }> | null {
  if (item.type !== 'image' && item.type !== 'image_url' && item.type !== 'input_image')
    return null;

  const source =
    item.source && typeof item.source === 'object' && !Array.isArray(item.source)
      ? (item.source as Record<string, unknown>)
      : null;
  const imageUrl =
    item.image_url && typeof item.image_url === 'object' && !Array.isArray(item.image_url)
      ? (item.image_url as Record<string, unknown>)
      : null;
  const directUrl =
    typeof item.url === 'string'
      ? item.url.trim()
      : typeof imageUrl?.url === 'string'
        ? imageUrl.url.trim()
        : typeof item.image_url === 'string'
          ? item.image_url.trim()
          : typeof source?.url === 'string'
            ? source.url.trim()
            : '';
  if (directUrl) {
    return {
      type: 'attachment',
      attachment: {
        url: directUrl,
        kind: 'image',
        label:
          typeof item.alt === 'string' && item.alt.trim()
            ? item.alt.trim()
            : typeof item.label === 'string' && item.label.trim()
              ? item.label.trim()
              : 'Image',
        ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
      },
    };
  }
  const data =
    source && typeof source.data === 'string'
      ? source.data.trim()
      : typeof item.content === 'string'
        ? item.content.trim()
        : '';
  const mimeTypeValue =
    source && typeof source.media_type === 'string'
      ? source.media_type
      : typeof item.mimeType === 'string'
        ? item.mimeType
        : '';
  const mimeType = mimeTypeValue.trim().toLowerCase();
  if (!data || !mimeType.startsWith('image/')) {
    return null;
  }

  const url = data.startsWith('data:image/') ? data : `data:${mimeType};base64,${data}`;
  const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : 'Image';
  return {
    type: 'attachment',
    attachment: {
      url,
      kind: 'image',
      label,
      mimeType,
    },
  };
}

function mergeAdjacentTextItems(items: MessageContentItem[]): MessageContentItem[] {
  const merged: MessageContentItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (item.type === 'text' && previous?.type === 'text') {
      previous.text = [previous.text, item.text].filter(value => value !== undefined).join('\n');
      continue;
    }
    merged.push(item);
  }
  return merged.filter(item => item.type !== 'text' || Boolean(item.text?.trim()));
}

export function stripMessageDisplayMetadataText(text: string): string {
  return stripInboundMetadata(text);
}

function stripMessageDisplayMetadata(items: MessageContentItem[]): MessageContentItem[] {
  return items
    .map(item => {
      if (item.type !== 'text' || typeof item.text !== 'string') {
        return item;
      }
      return { ...item, text: stripMessageDisplayMetadataText(item.text) };
    })
    .filter(item => item.type !== 'text' || Boolean(item.text?.trim()));
}

function expandTextContent(text: string): {
  content: MessageContentItem[];
  audioAsVoice: boolean;
  replyTarget: NormalizedMessage['replyTarget'];
} {
  const extracted = extractCanvasShortcodes(text);
  const parsed = splitMediaFromOutput(extracted.text);
  const parts: MessageContentItem[] = [];
  let audioAsVoice = parsed.audioAsVoice === true;
  let replyTarget: NormalizedMessage['replyTarget'] = null;
  const segments = parsed.segments ?? [{ type: 'text' as const, text: parsed.text }];

  for (const segment of segments) {
    if (segment.type === 'media') {
      const inferred = inferAttachmentKind(segment.url);
      parts.push({
        type: 'attachment',
        attachment: {
          url: segment.url,
          kind: inferred.kind,
          label: inferred.label,
          mimeType: inferred.mimeType,
        },
      });
      continue;
    }

    const directives = parseInlineDirectives(segment.text, {
      stripAudioTag: true,
      stripReplyTags: true,
    });
    audioAsVoice = audioAsVoice || directives.audioAsVoice;
    if (directives.replyToExplicitId) {
      replyTarget = { kind: 'id', id: directives.replyToExplicitId };
    } else if (directives.replyToCurrent && replyTarget === null) {
      replyTarget = { kind: 'current' };
    }
    if (directives.text) {
      parts.push({ type: 'text', text: directives.text });
    }
  }
  for (const preview of extracted.previews) {
    parts.push({ type: 'canvas', preview, rawText: null });
  }

  const content = mergeAdjacentTextItems(
    parts.map(item => {
      if (item.type === 'attachment' && item.attachment.kind === 'audio' && audioAsVoice) {
        return Object.assign({}, item, { attachment: { ...item.attachment, isVoiceNote: true } });
      }
      return item;
    }),
  );

  return {
    content:
      content.length > 0
        ? content
        : replyTarget === null && !audioAsVoice && parsed.text.trim().length > 0
          ? [{ type: 'text', text: parsed.text }]
          : [],
    audioAsVoice,
    replyTarget,
  };
}

const GOAL_REPLY_PATTERN = /(?:^|\n)Goal(?: complete:|\s*$)/m;

const stripZeroTokenUsageLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter(line => !/^Tokens used:\s*0\s*$/i.test(line))
    .join('\n')
    .trim();

export const stripUnreliableGoalZeroUsageText = (
  text: string,
  goalReplyContext = text,
): string => {
  if (!GOAL_REPLY_PATTERN.test(goalReplyContext)) return text;
  return stripZeroTokenUsageLine(text);
};

const stripUnreliableGoalZeroUsage = (content: MessageContentItem[]): MessageContentItem[] => {
  const textContent = content
    .map(item => (item.type === 'text' ? (item.text ?? '') : ''))
    .join('\n');
  if (!GOAL_REPLY_PATTERN.test(textContent)) return content;

  return content.flatMap(item => {
    if (item.type !== 'text' || typeof item.text !== 'string') return [item];
    const text = stripUnreliableGoalZeroUsageText(item.text, textContent);
    return text ? [{ ...item, text }] : [];
  });
};

function expandUserTextMediaContent(
  text: string,
  includeLegacyTextFields = false,
): MessageContentItem[] {
  const parsed = splitMediaFromOutput(text);
  if (!parsed.mediaUrls || parsed.mediaUrls.length === 0) {
    return [
      includeLegacyTextFields
        ? { type: 'text', text, name: undefined, args: undefined }
        : { type: 'text', text },
    ];
  }

  const segments = parsed.segments ?? [{ type: 'text' as const, text: parsed.text }];
  const content: MessageContentItem[] = [];
  for (const segment of segments) {
    if (segment.type === 'text') {
      if (segment.text.trim()) {
        content.push(
          includeLegacyTextFields
            ? { type: 'text', text: segment.text, name: undefined, args: undefined }
            : { type: 'text', text: segment.text },
        );
      }
      continue;
    }

    const inferred = inferAttachmentKind(segment.url);
    content.push({
      type: 'attachment',
      attachment: {
        url: segment.url,
        kind: inferred.kind,
        label: inferred.label,
        mimeType: inferred.mimeType,
      },
    });
  }
  return content;
}

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = message as Record<string, unknown>;
  let role = typeof m.role === 'string' ? m.role : 'unknown';

  // Detect tool messages by common gateway shapes.
  const hasToolId = typeof m.toolCallId === 'string' || typeof m.tool_call_id === 'string';

  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const hasToolContent =
    Array.isArray(contentItems) &&
    contentItems.some(item => {
      const x = item as Record<string, unknown>;
      return isToolResultContentType(x.type) || isToolCallContentType(x.type);
    });

  const hasToolName = typeof m.toolName === 'string' || typeof m.tool_name === 'string';

  if (hasToolId || hasToolName || (hasToolContent && role !== 'assistant')) {
    role = 'toolResult';
  }
  const isAssistantMessage = role === 'assistant';

  // Extract content
  let content: MessageContentItem[] = [];
  let audioAsVoice = false;
  let replyTarget: NormalizedMessage['replyTarget'] = null;

  if (typeof m.content === 'string') {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.content);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = expandUserTextMediaContent(m.content);
    }
  } else if (Array.isArray(m.content)) {
    content = m.content.flatMap((item: Record<string, unknown>) => {
      const imageAttachment = coerceImageContentBlock(item);
      if (imageAttachment) {
        return [imageAttachment];
      }
      if (isAssistantMessage) {
        const audioAttachment = coerceAudioContentBlock(item);
        if (audioAttachment) {
          return [audioAttachment];
        }
      } else if (item.type === 'audio') {
        return [];
      }
      if (
        item.type === 'attachment' &&
        item.attachment &&
        typeof item.attachment === 'object' &&
        !Array.isArray(item.attachment)
      ) {
        const attachment = item.attachment as {
          url?: unknown;
          kind?: unknown;
          label?: unknown;
          mimeType?: unknown;
          isVoiceNote?: unknown;
        };
        if (
          typeof attachment.url !== 'string' ||
          (attachment.kind !== 'image' &&
            attachment.kind !== 'audio' &&
            attachment.kind !== 'video' &&
            attachment.kind !== 'document') ||
          typeof attachment.label !== 'string'
        ) {
          return [];
        }
        return [
          {
            type: 'attachment' as const,
            attachment: {
              url: attachment.url,
              kind: attachment.kind,
              label: attachment.label,
              ...(typeof attachment.mimeType === 'string' ? { mimeType: attachment.mimeType } : {}),
              ...(attachment.isVoiceNote === true ? { isVoiceNote: true } : {}),
            },
          },
        ];
      }
      if (
        item.type === 'canvas' &&
        item.preview &&
        typeof item.preview === 'object' &&
        !Array.isArray(item.preview)
      ) {
        const preview = coerceCanvasPreview(item.preview);
        if (!preview) {
          return [];
        }
        return [
          {
            type: 'canvas' as const,
            preview,
            rawText: typeof item.rawText === 'string' ? item.rawText : null,
          },
        ];
      }
      if (item.type === 'text' && typeof item.text === 'string' && isAssistantMessage) {
        const expanded = expandTextContent(item.text);
        audioAsVoice = audioAsVoice || expanded.audioAsVoice;
        if (expanded.replyTarget?.kind === 'id') {
          replyTarget = expanded.replyTarget;
        } else if (expanded.replyTarget?.kind === 'current' && replyTarget === null) {
          replyTarget = expanded.replyTarget;
        }
        return expanded.content;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        return expandUserTextMediaContent(item.text, true);
      }
      return [
        {
          type:
            (item.type as Extract<
              MessageContentItem,
              { type: 'text' | 'tool_call' | 'tool_result' }
            >['type']) || 'text',
          text: item.text as string | undefined,
          name: item.name as string | undefined,
          args: resolveToolBlockArgs(item),
        },
      ];
    });
  } else if (typeof m.text === 'string') {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.text);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = expandUserTextMediaContent(m.text);
    }
  }

  const timestamp = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
  const id = typeof m.id === 'string' ? m.id : undefined;
  const senderLabel =
    typeof m.senderLabel === 'string' && m.senderLabel.trim() ? m.senderLabel.trim() : null;
  const modelName = isAssistantMessage ? resolveMessageModelName(m) : null;

  content = stripMessageDisplayMetadata(content);
  if (isAssistantMessage) {
    content = stripUnreliableGoalZeroUsage(content);
  }

  return {
    role,
    content,
    timestamp,
    id,
    senderLabel,
    modelName,
    ...(audioAsVoice ? { audioAsVoice: true } : {}),
    ...(replyTarget ? { replyTarget } : {}),
  };
}
