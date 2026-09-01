import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import {
  getSessionEntry,
  loadTranscriptEventsSync,
} from 'openclaw/plugin-sdk/session-store-runtime';
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from 'openclaw/plugin-sdk/ssrf-runtime';

const PLUGIN_ID = 'justdo-runtime-bridge';
const MAX_DETAIL_IDS = 250;
const MAX_DETAIL_ID_CHARS = 256;

type UnknownRecord = Record<string, unknown>;
type ToolInputLookup = Record<string, { name?: string; input: unknown }>;
type CompactionDetailLookup = Record<
  string,
  { summary?: string; tokensBefore?: number; tokensAfter?: number }
>;

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
    throw new Error('JustDo embeddings only support text input.');
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) return input.text;
  return input.parts
    .map(part => {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
        throw new Error('JustDo embeddings only support text input.');
      }
      return part.text;
    })
    .join('');
};

const readEmbeddingVectors = (value: unknown, expected: number): number[][] => {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expected) {
    throw new Error('JustDo embedding service returned malformed data.');
  }
  const vectors = value.data.map((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.embedding)) {
      throw new Error(`JustDo embedding result ${index} is malformed.`);
    }
    const vector = entry.embedding;
    if (
      vector.length === 0 ||
      !vector.every(item => typeof item === 'number' && Number.isFinite(item))
    ) {
      throw new Error(`JustDo embedding result ${index} is malformed.`);
    }
    return vector as number[];
  });
  return vectors;
};

const plugin = {
  id: PLUGIN_ID,
  name: 'JustDo Runtime Bridge',
  description: 'Bounded JustDo integration over supported OpenClaw plugin APIs.',
  register(api: OpenClawPluginApi) {
    const emitProgress = (
      stage: 'preparing' | 'waiting_model' | 'retrying',
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
    const modelCalls = new Map<string, number>();
    api.on('before_agent_reply', (_event, ctx) => emitProgress('preparing', ctx));
    api.on('model_call_started', (_event, ctx) => {
      if (!ctx.runId) return;
      const calls = (modelCalls.get(ctx.runId) ?? 0) + 1;
      modelCalls.set(ctx.runId, calls);
      if (calls > 1) emitProgress('retrying', ctx);
      emitProgress('waiting_model', ctx);
    });
    api.on('agent_end', (_event, ctx) => {
      if (ctx.runId) modelCalls.delete(ctx.runId);
    });

    api.registerGatewayMethod(
      'justdoRuntimeBridge.historyDetails',
      async ({ params, respond }) => {
        if (!isRecord(params) || typeof params.sessionKey !== 'string') {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Missing session key' });
          return;
        }
        const sessionKey = params.sessionKey.trim();
        const entry = getSessionEntry({ sessionKey, readConsistency: 'latest' });
        if (!entry?.sessionId) {
          respond(true, { toolInputs: {}, compactionDetails: {} });
          return;
        }
        const toolCallIds = boundedIds(params.toolCallIds);
        const compactionEntryIds = boundedIds(params.compactionEntryIds);
        const toolInputs: ToolInputLookup = {};
        const compactionDetails: CompactionDetailLookup = {};
        const events = loadTranscriptEventsSync({
          sessionKey,
          sessionId: entry.sessionId,
        });
        collectHistoryDetails(
          events,
          toolCallIds,
          compactionEntryIds,
          toolInputs,
          compactionDetails,
        );
        respond(true, { toolInputs, compactionDetails });
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
            auditContext: 'justdo-runtime-bridge:embeddings',
            useEnvProxyForEligibleUrls: true,
          });
          try {
            if (!response.ok)
              throw new Error(`JustDo embedding service returned HTTP ${response.status}.`);
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

    api.logger.info('[justdo-runtime-bridge] runtime integration enabled.');
  },
};

export default plugin;
