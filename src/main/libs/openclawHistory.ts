import { isGatewayToolFailureNotice } from '../../common/toolFailureNotice';
import {
  parseScheduledReminderPrompt,
  parseSimpleScheduledReminderText,
} from '../../scheduledTask/reminderText';

type GatewayHistoryRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';

export interface GatewayHistoryEntry {
  role: GatewayHistoryRole;
  text: string;
  metadata?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const collectTextChunks = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectTextChunks(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const chunks: string[] = [];
  if (typeof value.text === 'string') {
    const text = value.text.trim();
    if (text) {
      chunks.push(text);
    }
  }

  if (value.content !== undefined) {
    chunks.push(...collectTextChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectTextChunks(value.parts));
  }

  return chunks;
};

export const extractGatewayMessageText = (message: unknown): string => {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) {
    return '';
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks = collectTextChunks(content);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (isRecord(content)) {
    const chunks = collectTextChunks(content);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  return '';
};

export const buildScheduledReminderSystemMessage = (text: string): string | null => {
  const parsed = parseScheduledReminderPrompt(text);
  if (!parsed) {
    return parseSimpleScheduledReminderText(text)?.reminderText ?? null;
  }

  return parsed.reminderText;
};

export const extractGatewayHistoryEntry = (message: unknown): GatewayHistoryEntry | null => {
  if (!isRecord(message)) {
    return null;
  }

  const roleRaw = typeof message.role === 'string' ? message.role.trim() : '';
  const role = roleRaw.toLowerCase();
  // Support tool_use, tool_result, and Gateway's 'toolResult'/'toolresult' role
  // Gateway returns 'toolResult' (camelCase) which becomes 'toolresult' after toLowerCase()
  const validRoles = ['user', 'assistant', 'system', 'tool_use', 'tool_result', 'toolresult'];
  // Normalize 'toolresult' to 'tool_result'
  const normalizedRole = role === 'toolresult' ? 'tool_result' : role;
  if (!validRoles.includes(role)) {
    // Debug: log unknown roles to understand Gateway message format
    if (role && role !== '') {
      console.log(
        '[extractGatewayHistoryEntry] unknown role:',
        roleRaw,
        '(lowercase:',
        role,
        ')',
        'message keys:',
        Object.keys(message).slice(0, 5),
      );
    }
    return null;
  }

  const text = extractGatewayMessageText(message).trim();

  // OpenClaw writes a synthetic system notice after a failed tool call. The
  // corresponding tool_result is already shown in its tool group, so replaying
  // this notice during final history reconciliation creates a duplicate bubble.
  if (normalizedRole === 'system' && isGatewayToolFailureNotice(text)) {
    return null;
  }

  // Handle scheduled reminder system message for user role
  if (normalizedRole === 'user') {
    const reminderSystemMessage = buildScheduledReminderSystemMessage(text);
    if (reminderSystemMessage) {
      return {
        role: 'system' as GatewayHistoryRole,
        text: reminderSystemMessage,
      };
    }
  }

  // Extract metadata for tool_use and tool_result (including 'toolresult')
  const metadata: Record<string, unknown> | undefined = isRecord(message.metadata)
    ? message.metadata
    : undefined;

  // For tool_use, extract toolName and toolInput from content if not in metadata
  if (normalizedRole === 'tool_use') {
    const toolName = metadata?.toolName ?? message.tool_name ?? message.name;
    // 尝试从多个字段获取 toolInput
    let toolInput = metadata?.toolInput ?? message.tool_input ?? message.input;
    // 如果 toolInput 为空，尝试从 content 中的 toolCall block 解析
    if (!toolInput || (isRecord(toolInput) && Object.keys(toolInput).length === 0)) {
      // 检查 content 是否是数组，可能包含 toolCall block
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          // Support multiple type names: toolcall, tool_call, tooluse
          if (blockType !== 'toolcall' && blockType !== 'tool_call' && blockType !== 'tooluse')
            continue;
          toolInput = block.input ?? block.args ?? block.arguments ?? {};
          if (toolInput && Object.keys(toolInput as Record<string, unknown>).length > 0) {
            console.log(
              '[extractGatewayHistoryEntry] found toolInput in tool_call block:',
              Object.keys(toolInput as Record<string, unknown>),
            );
            break;
          }
        }
      }
    }
    // Debug: 如果 toolInput 为空或空对象，记录消息结构
    if (!toolInput || (isRecord(toolInput) && Object.keys(toolInput).length === 0)) {
      console.log(
        '[extractGatewayHistoryEntry] tool_use missing toolInput:',
        'toolName=' + toolName,
        'messageKeys=' + Object.keys(message).slice(0, 8).join(','),
        'metadataKeys=' + (metadata ? Object.keys(metadata).slice(0, 5).join(',') : 'none'),
      );
    }
    return {
      role: 'tool_use' as GatewayHistoryRole,
      text: text || (typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)),
      metadata: {
        toolName,
        toolInput: toolInput ?? {},
        // Gateway may use toolCallId, id, or tool_use_id
        toolUseId: metadata?.toolUseId ?? message.tool_use_id ?? message.toolCallId ?? message.id,
      },
    };
  }

  // For tool_result (including 'toolresult'), extract toolResult and isError
  // Gateway 'toolresult' messages have: role, toolCallId, toolName, content, isError
  if (normalizedRole === 'tool_result') {
    const isError = metadata?.isError ?? message.is_error ?? message.isError ?? false;
    const rawToolResult =
      metadata?.toolResult ?? message.tool_result ?? message.result ?? message.content ?? text;

    // If toolResult is array format [{ type: "text", text: "xxx" }], extract text content
    let toolResultText: string;
    if (Array.isArray(rawToolResult)) {
      const chunks = collectTextChunks(rawToolResult);
      toolResultText = chunks.length > 0 ? chunks.join('\n') : JSON.stringify(rawToolResult);
    } else if (typeof rawToolResult === 'string') {
      toolResultText = rawToolResult;
    } else {
      toolResultText = JSON.stringify(rawToolResult);
    }

    // toolCallId is in message.toolCallId for Gateway 'toolresult' format
    const toolUseId =
      metadata?.toolUseId ?? message.tool_use_id ?? message.toolCallId ?? message.id;

    // Extract toolInput from Gateway toolResult message (may have input/args field)
    const toolInput = metadata?.toolInput ?? message.input ?? message.args ?? message.tool_input;

    return {
      role: 'tool_result' as GatewayHistoryRole,
      text: toolResultText,
      metadata: {
        toolUseId,
        isError,
        toolResult: toolResultText,
        toolName: metadata?.toolName ?? message.toolName ?? message.tool_name,
        toolInput: toolInput ?? {},
      },
    };
  }

  // For user/assistant/system, skip empty text
  if (!text) {
    return null;
  }

  return {
    role: normalizedRole as GatewayHistoryRole,
    text,
    metadata,
  };
};

export const extractGatewayHistoryEntries = (messages: unknown[]): GatewayHistoryEntry[] => {
  return messages
    .map(message => extractGatewayHistoryEntry(message))
    .filter((entry): entry is GatewayHistoryEntry => entry !== null);
};
