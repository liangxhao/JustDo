/**
 * Converts JustDo's CoworkMessage[] to OpenClaw's gateway message format.
 *
 * CoworkMessage uses a flat structure with `type` and `metadata`:
 *   { id, type: 'user'|'assistant'|'tool_use'|'tool_result'|'system', content, metadata: { toolName, toolInput, toolResult, toolUseId } }
 *
 * Gateway messages use `role` and `content` (string or content blocks):
 *   { role: 'user'|'assistant'|'toolresult', content: string | ContentBlock[], timestamp }
 */

import type { CoworkMessage } from '../../../types/cowork';
import type { GatewayContentBlock, GatewayMessage } from '../types';

/**
 * Convert a single CoworkMessage to a GatewayMessage.
 */
export function coworkMessageToGateway(msg: CoworkMessage): GatewayMessage {
  const base: GatewayMessage = {
    role: mapRole(msg.type),
    timestamp: msg.timestamp,
    id: msg.id,
  };

  switch (msg.type) {
    case 'user':
      return {
        ...base,
        role: 'user',
        content: buildUserContent(msg),
      };

    case 'assistant':
      return {
        ...base,
        role: 'assistant',
        content: buildAssistantContent(msg),
      };

    case 'tool_use':
      return {
        ...base,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: msg.metadata?.toolUseId ?? msg.id,
            name: msg.metadata?.toolName ?? 'unknown',
            input: msg.metadata?.toolInput ?? {},
          },
        ],
      };

    case 'tool_result':
      return {
        ...base,
        role: 'toolresult',
        tool_call_id: msg.metadata?.toolUseId ?? undefined,
        tool_use_id: msg.metadata?.toolUseId ?? undefined,
        toolName: msg.metadata?.toolName,
        content: buildToolResultContent(msg),
      };

    case 'system':
      return {
        ...base,
        role: 'system',
        content: msg.content,
      };

    case 'subagent_completion':
      return {
        ...base,
        role: 'assistant',
        content: msg.content,
      };

    default:
      return {
        ...base,
        role: 'user',
        content: msg.content,
      };
  }
}

/**
 * Convert an array of CoworkMessages to GatewayMessages.
 */
export function coworkMessagesToGateway(messages: CoworkMessage[]): GatewayMessage[] {
  return messages.map(coworkMessageToGateway);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapRole(type: CoworkMessage['type']): string {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool_use':
      return 'assistant';
    case 'tool_result':
      return 'toolresult';
    case 'system':
      return 'system';
    case 'subagent_completion':
      return 'assistant';
    default:
      return 'user';
  }
}

function buildUserContent(msg: CoworkMessage): string | GatewayContentBlock[] {
  const rawAttachments = msg.metadata?.imageAttachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return msg.content;
  }

  const blocks: GatewayContentBlock[] = msg.content
    ? [{ type: 'text', text: msg.content }]
    : [];

  for (const value of rawAttachments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const attachment = value as Record<string, unknown>;
    const base64Data =
      typeof attachment.base64Data === 'string' ? attachment.base64Data.trim() : '';
    const mimeType =
      typeof attachment.mimeType === 'string' && attachment.mimeType.startsWith('image/')
        ? attachment.mimeType
        : '';
    if (!base64Data || !mimeType) continue;

    blocks.push({
      type: 'attachment',
      attachment: {
        url: base64Data.startsWith('data:')
          ? base64Data
          : `data:${mimeType};base64,${base64Data}`,
        kind: 'image',
        label:
          typeof attachment.name === 'string' && attachment.name.trim()
            ? attachment.name.trim()
            : 'Image',
        mimeType,
      },
    });
  }

  return blocks.length > 0 ? blocks : msg.content;
}

function buildAssistantContent(msg: CoworkMessage): string | GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = [];

  // Add thinking block if present
  if (msg.thinkingContent) {
    blocks.push({
      type: 'thinking',
      thinking: msg.thinkingContent,
    });
  }

  // Add text block
  if (msg.content) {
    blocks.push({
      type: 'text',
      text: msg.content,
    });
  }

  // If only text and no thinking, return as string
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return msg.content;
  }

  // If no content at all
  if (blocks.length === 0) {
    return msg.content || '';
  }

  return blocks;
}

function buildToolResultContent(msg: CoworkMessage): string {
  const metadata = msg.metadata;
  if (!metadata) return msg.content;

  const toolResult = metadata.toolResult;
  if (typeof toolResult === 'string') return toolResult;
  if (typeof toolResult === 'object' && toolResult !== null) {
    try {
      return JSON.stringify(toolResult, null, 2);
    } catch {
      return String(toolResult);
    }
  }

  return msg.content;
}
