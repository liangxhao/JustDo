import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { redactSensitiveText } from 'openclaw/plugin-sdk/logging-core';
import {
  getSessionEntry,
  loadTranscriptEventsSync,
} from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from 'openclaw/plugin-sdk/ssrf-runtime';

const PLUGIN_ID = 'runtime-services';
const MAX_DETAIL_IDS = 250;
const MAX_DETAIL_ID_CHARS = 256;
const MAX_FAILURE_DETAIL_CHARS = 2000;
const MAX_HISTORY_MESSAGE_CHUNK_CHARS = 1024 * 1024;
const MAX_HISTORY_MESSAGE_TRANSFERS = 8;
const HISTORY_MESSAGE_TRANSFER_TTL_MS = 2 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;
type ToolInputLookup = Record<string, { name?: string; input: unknown }>;
type FailureDetailLookup = Record<string, { errorMessage: string }>;
type CompactionDetailLookup = Record<
  string,
  { summary?: string; tokensBefore?: number; tokensAfter?: number }
>;
type HistoryMessageTransfer = {
  createdAt: number;
  messageId: string;
  serialized: string;
  sessionId: string;
  sessionKey: string;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const boundedIds = (value: unknown): Set<string> => {
  if (!Array.isArray(value) || value.length > MAX_DETAIL_IDS) return new Set();
  return new Set(
    value.flatMap(item =>
      typeof item === 'string' && item.trim() && item.trim().length <= MAX_DETAIL_ID_CHARS
        ? [item.trim()]
        : [],
    ),
  );
};

const coerceToolInput = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const hasToolInput = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
};

const serializeVisibleTranscriptMessage = (
  entries: Array<{ entryId: string; message: unknown }>,
  messageId: string,
): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.entryId !== messageId || !isRecord(entry.message)) continue;
    return JSON.stringify(entry.message);
  }
  return null;
};

const collectHistoryDetails = (
  value: unknown,
  toolCallIds: Set<string>,
  compactionEntryIds: Set<string>,
  toolInputs: ToolInputLookup,
  compactionDetails: CompactionDetailLookup,
  depth = 0,
): void => {
  if (depth > 10 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHistoryDetails(
        item,
        toolCallIds,
        compactionEntryIds,
        toolInputs,
        compactionDetails,
        depth + 1,
      );
    }
    return;
  }
  const record = value as UnknownRecord;
  const id = [
    record.id,
    record.toolCallId,
    record.tool_call_id,
    record.toolUseId,
    record.tool_use_id,
  ].find(candidate => typeof candidate === 'string') as string | undefined;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (
    id &&
    toolCallIds.has(id) &&
    !toolInputs[id] &&
    ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'functioncall', 'function_call'].includes(type)
  ) {
    const input = [
      record.arguments,
      record.args,
      record.input,
      record.toolInput,
      record.partialArgs,
    ]
      .map(coerceToolInput)
      .find(hasToolInput);
    if (hasToolInput(input)) {
      toolInputs[id] = {
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        input,
      };
    }
  }
  if (type === 'compaction' && typeof record.id === 'string') {
    const entryId = record.id;
    if (compactionEntryIds.has(entryId) && !compactionDetails[entryId]) {
      const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
      const tokensBefore =
        typeof record.tokensBefore === 'number' && Number.isFinite(record.tokensBefore)
          ? record.tokensBefore
          : undefined;
      const tokensAfter =
        typeof record.tokensAfter === 'number' && Number.isFinite(record.tokensAfter)
          ? record.tokensAfter
          : undefined;
      if (summary || tokensBefore !== undefined || tokensAfter !== undefined) {
        compactionDetails[entryId] = {
          ...(summary ? { summary } : {}),
          ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        };
      }
    }
  }
  for (const child of Object.values(record)) {
    collectHistoryDetails(
      child,
      toolCallIds,
      compactionEntryIds,
      toolInputs,
      compactionDetails,
      depth + 1,
    );
  }
};

const toEmbeddingText = (input: unknown): string => {
  if (typeof input === 'string') return input;
  if (!isRecord(input) || typeof input.text !== 'string') {
    throw new Error('Runtime embeddings only support text input.');
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) return input.text;
  return input.parts
    .map(part => {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
        throw new Error('Runtime embeddings only support text input.');
      }
      return part.text;
    })
    .join('');
};

const readEmbeddingVectors = (value: unknown, expected: number): number[][] => {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expected) {
    throw new Error('Runtime embedding service returned malformed data.');
  }
  // Match OpenClaw's indexed/positional response contract without changing the guarded transport.
  const vectors: number[][] = [];
  let indexed: boolean | undefined;
  for (const [position, entry] of value.data.entries()) {
    if (!isRecord(entry) || !Array.isArray(entry.embedding)) {
      throw new Error(`Runtime embedding result ${position} is malformed.`);
    }
    const usesIndex = entry.index !== undefined;
    const vector = entry.embedding;
    if (
      vector.length === 0 ||
      (indexed !== undefined && indexed !== usesIndex) ||
      !vector.every(item => typeof item === 'number' && Number.isFinite(item))
    ) {
      throw new Error(`Runtime embedding result ${position} is malformed.`);
    }
    indexed = usesIndex;
    const index = usesIndex ? entry.index : position;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected ||
      vectors[index] !== undefined
    ) {
      throw new Error(`Runtime embedding result ${position} is malformed.`);
    }
    vectors[index] = vector;
  }
  return vectors;
};

const plugin = {
  id: PLUGIN_ID,
  name: 'Runtime Services',
  description: 'Provides runtime progress, history detail, and embedding capabilities.',
  register(api: OpenClawPluginApi) {
    const historyMessageTransfers = new Map<string, HistoryMessageTransfer>();
    let historyMessageTransferSequence = 0;
    const pruneHistoryMessageTransfers = (): void => {
      const expiredBefore = Date.now() - HISTORY_MESSAGE_TRANSFER_TTL_MS;
      for (const [id, transfer] of historyMessageTransfers) {
        if (transfer.createdAt < expiredBefore) historyMessageTransfers.delete(id);
      }
      while (historyMessageTransfers.size >= MAX_HISTORY_MESSAGE_TRANSFERS) {
        const oldest = historyMessageTransfers.keys().next().value as string | undefined;
        if (!oldest) break;
        historyMessageTransfers.delete(oldest);
      }
    };
    const emitProgress = (
      stage: 'preparing' | 'waiting_model',
      ctx: { runId?: string; sessionKey?: string; modelProviderId?: string; modelId?: string },
    ): void => {
      if (!ctx.runId || !ctx.sessionKey || !/^agent:[^:]+:justdo:/i.test(ctx.sessionKey)) return;
      api.agent.events.emitAgentEvent({
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        stream: 'lifecycle',
        data: {
          phase: 'progress',
          stage,
          at: Date.now(),
          ...(ctx.modelProviderId ? { provider: ctx.modelProviderId.slice(0, 128) } : {}),
          ...(ctx.modelId ? { model: ctx.modelId.slice(0, 128) } : {}),
        },
      });
    };
    api.on('before_agent_reply', (_event, ctx) => emitProgress('preparing', ctx));
    // A model call can follow a successful tool round. These hooks do not identify retries.
    api.on('model_call_started', (_event, ctx) => {
      emitProgress('waiting_model', ctx);
    });

    api.registerGatewayMethod(
      'runtimeServices.historyDetails',
      async ({ params, respond }) => {
        if (!isRecord(params) || typeof params.sessionKey !== 'string') {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Missing session key' });
          return;
        }
        const sessionKey = params.sessionKey.trim();
        const entry = getSessionEntry({ sessionKey, readConsistency: 'latest' });
        if (!entry?.sessionId) {
          respond(true, { toolInputs: {}, compactionDetails: {}, failureDetails: {} });
          return;
        }
        const toolCallIds = boundedIds(params.toolCallIds);
        const compactionEntryIds = boundedIds(params.compactionEntryIds);
        const failureMessageIds = boundedIds(params.failureMessageIds);
        const toolInputs: ToolInputLookup = {};
        const compactionDetails: CompactionDetailLookup = {};
        const failureDetails: FailureDetailLookup = Object.create(null);
        if (toolCallIds.size > 0 || failureMessageIds.size > 0) {
          const visibleMessages = await readVisibleSessionTranscriptMessageEntries({
            sessionKey,
            sessionId: entry.sessionId,
          });
          if (toolCallIds.size > 0) {
            collectHistoryDetails(
              visibleMessages.map(item => item.message),
              toolCallIds,
              new Set(),
              toolInputs,
              compactionDetails,
            );
          }
          for (const item of visibleMessages) {
            if (!failureMessageIds.has(item.entryId) || !isRecord(item.message)) continue;
            const message = item.message;
            if (
              message.role !== 'assistant' ||
              message.stopReason !== 'error' ||
              typeof message.errorMessage !== 'string' ||
              !message.errorMessage.trim()
            )
              continue;
            // Restore only bounded display text, never the raw provider body or
            // diagnostics. Force built-in redaction even if logging disables it.
            const errorMessage = redactSensitiveText(message.errorMessage.trim(), {
              mode: 'tools',
            }).slice(0, MAX_FAILURE_DETAIL_CHARS);
            failureDetails[item.entryId] = { errorMessage };
          }
        }
        if (compactionEntryIds.size > 0) {
          collectHistoryDetails(
            loadTranscriptEventsSync({ sessionKey, sessionId: entry.sessionId }),
            new Set(),
            compactionEntryIds,
            toolInputs,
            compactionDetails,
          );
        }
        respond(true, { toolInputs, compactionDetails, failureDetails });
      },
      { scope: 'operator.read' },
    );

    // OpenClaw deliberately bounds chat.history and chat.message.get payloads.
    // Preserve that fast path, while allowing JustDo to recover an explicitly
    // selected oversized transcript row through bounded chunks when necessary.
    api.registerGatewayMethod(
      'runtimeServices.historyMessage',
      async ({ params, respond }) => {
        if (
          !isRecord(params) ||
          typeof params.sessionKey !== 'string' ||
          typeof params.messageId !== 'string'
        ) {
          respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'Missing history identity',
          });
          return;
        }
        const sessionKey = params.sessionKey.trim();
        const messageId = params.messageId.trim();
        const cursor =
          typeof params.cursor === 'number' && Number.isSafeInteger(params.cursor)
            ? params.cursor
            : 0;
        const requestedMaxChars =
          typeof params.maxChars === 'number' && Number.isSafeInteger(params.maxChars)
            ? params.maxChars
            : MAX_HISTORY_MESSAGE_CHUNK_CHARS;
        const requestedTransferId =
          typeof params.transferId === 'string' ? params.transferId.trim() : '';
        if (
          !sessionKey ||
          !messageId ||
          messageId.length > MAX_DETAIL_ID_CHARS ||
          cursor < 0 ||
          requestedMaxChars <= 0
        ) {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Invalid history range' });
          return;
        }
        const entry = getSessionEntry({ sessionKey, readConsistency: 'latest' });
        if (!entry?.sessionId) {
          respond(true, { ok: false, unavailableReason: 'not_found' });
          return;
        }
        pruneHistoryMessageTransfers();
        let transferId = requestedTransferId;
        let transfer = transferId ? historyMessageTransfers.get(transferId) : undefined;
        if (
          transfer &&
          (transfer.sessionKey !== sessionKey ||
            transfer.sessionId !== entry.sessionId ||
            transfer.messageId !== messageId)
        ) {
          transfer = undefined;
        }
        if (!transfer && cursor === 0 && !requestedTransferId) {
          const serialized = serializeVisibleTranscriptMessage(
            await readVisibleSessionTranscriptMessageEntries({
              sessionKey,
              sessionId: entry.sessionId,
            }),
            messageId,
          );
          if (serialized !== null) {
            transferId = `${Date.now().toString(36)}-${++historyMessageTransferSequence}`;
            transfer = {
              createdAt: Date.now(),
              messageId,
              serialized,
              sessionId: entry.sessionId,
              sessionKey,
            };
            historyMessageTransfers.set(transferId, transfer);
          }
        }
        const serialized = transfer?.serialized ?? null;
        if (serialized === null || cursor > serialized.length) {
          respond(true, { ok: false, unavailableReason: 'not_found' });
          return;
        }
        const end = Math.min(
          serialized.length,
          cursor + Math.min(requestedMaxChars, MAX_HISTORY_MESSAGE_CHUNK_CHARS),
        );
        const complete = end === serialized.length;
        respond(true, {
          ok: true,
          transferId,
          chunk: serialized.slice(cursor, end),
          complete,
          ...(end < serialized.length ? { nextCursor: end } : {}),
        });
        if (complete) historyMessageTransfers.delete(transferId);
      },
      { scope: 'operator.read' },
    );

    api.registerEmbeddingProvider({
      id: PLUGIN_ID,
      transport: 'remote',
      create: async options => {
        const baseUrl = options.remote?.baseUrl?.trim().replace(/\/+$/, '');
        const model = options.model.trim();
        if (!baseUrl || !model) return { provider: null };
        const headers: Record<string, string> = {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(options.remote?.headers ?? {}),
        };
        const apiKey =
          typeof options.remote?.apiKey === 'string' ? options.remote.apiKey.trim() : '';
        if (apiKey && !headers.authorization) headers.authorization = `Bearer ${apiKey}`;
        const endpointUrl = `${baseUrl}/embeddings`;
        const request = async (inputs: unknown[], signal?: AbortSignal): Promise<number[][]> => {
          const { response, release } = await fetchWithSsrFGuard({
            url: endpointUrl,
            init: {
              method: 'POST',
              headers,
              body: JSON.stringify({ model, input: inputs.map(toEmbeddingText) }),
              ...(signal ? { signal } : {}),
            },
            ...(signal ? { signal } : {}),
            policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
            auditContext: 'runtime-services:embeddings',
            useEnvProxyForEligibleUrls: true,
          });
          try {
            if (!response.ok)
              throw new Error(`Runtime embedding service returned HTTP ${response.status}.`);
            return readEmbeddingVectors(await response.json(), inputs.length);
          } finally {
            await release();
          }
        };
        return {
          provider: {
            id: PLUGIN_ID,
            model,
            embed: async (input, callOptions) =>
              (await request([input], callOptions?.signal))[0] ?? [],
            embedBatch: async (inputs, callOptions) => request(inputs, callOptions?.signal),
          },
          runtime: {
            id: PLUGIN_ID,
            cacheKeyData: { endpointUrl, model },
          },
        };
      },
    });

    api.logger.info('[runtime-services] runtime integration enabled.');
  },
};

export default plugin;
