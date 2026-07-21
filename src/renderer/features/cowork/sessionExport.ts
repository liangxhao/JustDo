import type { CoworkSession } from '@/features/cowork/coworkTypes';

export const SESSION_EXPORT_SCHEMA = 'justdo.openai-chat-export' as const;
export const SESSION_EXPORT_VERSION = 1 as const;

type OpenAiRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiExportMessage {
  role: OpenAiRole;
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface SessionExportDocument {
  schema: typeof SESSION_EXPORT_SCHEMA;
  version: typeof SESSION_EXPORT_VERSION;
  exported_at: string;
  model?: string;
  messages: OpenAiExportMessage[];
  metadata: {
    session_id: string;
    title: string;
    agent_id: string;
    created_at: string;
    updated_at: string;
    working_directory: string;
  };
  extensions?: {
    justdo: {
      session_key: string;
      runtime_session_id: string | null;
      messages: unknown[];
    };
  };
}

export interface CreateSessionExportOptions {
  session: CoworkSession;
  messages: unknown[];
  model?: string;
  runtimeSessionId?: string | null;
  includeRawData: boolean;
  exportedAt?: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (...values: unknown[]): string | undefined => {
  const value = values.find(candidate => typeof candidate === 'string' && candidate.trim());
  return typeof value === 'string' ? value : undefined;
};

const stringifyArguments = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
};

const hasMeaningfulArguments = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized !== '' && normalized !== '{}';
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
};

const resolveToolArguments = (block: Record<string, unknown>): unknown => {
  const argumentsValue = block.arguments ?? block.input ?? block.args;
  return hasMeaningfulArguments(argumentsValue) || block.partialArgs === undefined
    ? argumentsValue
    : block.partialArgs;
};

const normalizedBlockType = (block: Record<string, unknown>): string =>
  readString(block.type)?.replace(/[_-]/g, '').toLowerCase() ?? '';

const textFromContent = (content: unknown, includeToolResults = false): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .flatMap(blockValue => {
      if (!isRecord(blockValue)) return [];
      const type = normalizedBlockType(blockValue);
      if (
        type === 'thinking' ||
        type === 'reasoning' ||
        type === 'toolcall' ||
        type === 'tooluse'
      ) {
        return [];
      }
      if ((type === 'toolresult' || type === 'toolresponse') && !includeToolResults) return [];
      const text = readString(blockValue.text, blockValue.content);
      if (text !== undefined) return [text];
      if (type === 'image' || type === 'imageurl') {
        const label = readString(blockValue.name, blockValue.url) ?? 'image';
        return [`[Image: ${label}]`];
      }
      return [];
    })
    .join('\n');
};

const toolCallsFromContent = (content: unknown): OpenAiToolCall[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((blockValue, index) => {
    if (!isRecord(blockValue)) return [];
    const type = normalizedBlockType(blockValue);
    if (type !== 'toolcall' && type !== 'tooluse') return [];
    const id = readString(blockValue.id, blockValue.toolCallId, blockValue.tool_call_id);
    const name = readString(blockValue.name, blockValue.toolName, blockValue.tool_name);
    if (!name) return [];
    return [
      {
        id: id ?? `tool-call-${index + 1}`,
        type: 'function' as const,
        function: {
          name,
          arguments: stringifyArguments(resolveToolArguments(blockValue)),
        },
      },
    ];
  });
};

const toolResultsFromContent = (content: unknown): OpenAiExportMessage[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap(blockValue => {
    if (!isRecord(blockValue)) return [];
    const type = normalizedBlockType(blockValue);
    if (type !== 'toolresult' && type !== 'toolresponse') return [];
    const toolCallId = readString(
      blockValue.toolCallId,
      blockValue.tool_call_id,
      blockValue.tool_use_id,
      blockValue.id,
    );
    if (!toolCallId) return [];
    return [
      {
        role: 'tool' as const,
        tool_call_id: toolCallId,
        content: textFromContent([blockValue], true),
      },
    ];
  });
};

const normalizeRole = (value: unknown): OpenAiRole => {
  const role = typeof value === 'string' ? value.replace(/[_-]/g, '').toLowerCase() : '';
  if (role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  if (role === 'developer') return 'developer';
  if (role === 'tool' || role === 'toolresult' || role === 'toolresponse') return 'tool';
  return 'system';
};

const convertMessage = (value: unknown): OpenAiExportMessage[] => {
  if (!isRecord(value)) return [];
  const role = normalizeRole(value.role ?? value.type);
  if (role === 'tool') {
    const toolCallId = readString(
      value.tool_call_id,
      value.toolCallId,
      value.tool_use_id,
      value.id,
    );
    if (!toolCallId) return [];
    return [
      {
        role,
        tool_call_id: toolCallId,
        content: textFromContent(value.content, true) || readString(value.text) || '',
      },
    ];
  }

  const text = textFromContent(value.content) || readString(value.text) || '';
  const toolCalls = role === 'assistant' ? toolCallsFromContent(value.content) : [];
  const message: OpenAiExportMessage = {
    role,
    content: toolCalls.length > 0 && !text ? null : text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  const attached = Array.isArray(value.__justdoAttachedToolMessages)
    ? value.__justdoAttachedToolMessages.flatMap(attachedValue => {
        if (!isRecord(attachedValue)) return [];
        return normalizeRole(attachedValue.role) === 'tool'
          ? convertMessage(attachedValue)
          : toolResultsFromContent(attachedValue.content);
      })
    : [];
  const inlineResults = role === 'assistant' ? toolResultsFromContent(value.content) : [];
  return [message, ...inlineResults, ...attached];
};

const sanitizeRawValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeRawValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const sanitizedKey =
        key === '__openclaw' ? '__justdo_runtime' : key.replace(/openclaw/gi, 'justdo');
      return [sanitizedKey, sanitizeRawValue(entry)];
    }),
  );
};

export const createSessionExportDocument = ({
  session,
  messages,
  model,
  runtimeSessionId = null,
  includeRawData,
  exportedAt = new Date(),
}: CreateSessionExportOptions): SessionExportDocument => ({
  schema: SESSION_EXPORT_SCHEMA,
  version: SESSION_EXPORT_VERSION,
  exported_at: exportedAt.toISOString(),
  ...(model?.trim() ? { model: model.trim() } : {}),
  messages: messages.flatMap(convertMessage),
  metadata: {
    session_id: session.id,
    title: session.title,
    agent_id: session.agentId,
    created_at: new Date(session.createdAt).toISOString(),
    updated_at: new Date(session.updatedAt).toISOString(),
    working_directory: session.cwd,
  },
  ...(includeRawData
    ? {
        extensions: {
          justdo: {
            session_key: `agent:${session.agentId || 'main'}:justdo:${session.id}`,
            runtime_session_id: runtimeSessionId,
            messages: messages.map(sanitizeRawValue),
          },
        },
      }
    : {}),
});

export const buildSessionExportFileName = (title: string): string => {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safeTitle || 'conversation'}.json`;
};
