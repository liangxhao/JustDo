import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { EOL } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  parseChatHistoryCursorResultV2026_10_6,
  parseChatHistoryResultV2026_10_6,
  parseHistoryDetailsResultV2026_10_6,
} from '../../engine/openclaw/wire/v2026_10_6';
import { diagnosticExportTime } from './exportFormat';
import { redactDiagnosticLog } from './exportLogs';
import type { DiagnosticSessionBinding } from './exportSessionDetails';

export const DIAGNOSTIC_CONTEXT_FILE = 'context.json';
const CONTEXT_READ_CHUNK_BYTES = 64 * 1024;
const PAGE_MESSAGES = 200;
const MAX_DETAIL_IDS = 250;
const DETAIL_BATCH_SIZE = 50;
const MAX_MESSAGE_LOOKUPS = 16;
const RPC_TIMEOUT_MS = 30_000;
const CONTEXT_COUNTS = [
  'estimatedPromptTokens',
  'contextTokenBudget',
  'promptBudgetBeforeReserve',
  'reserveTokens',
  'effectiveReserveTokens',
  'remainingPromptBudgetTokens',
  'overflowTokens',
  'toolResultReducibleChars',
  'messageCount',
  'unwindowedMessageCount',
];

type ContextGap =
  | 'offline'
  | 'no_binding'
  | 'canceled'
  | 'timeout'
  | 'read_failed'
  | 'write_failed'
  | 'identity_unconfirmed'
  | 'history_changed'
  | 'native_instance_changed'
  | 'history_appended'
  | 'verification_unavailable'
  | 'verification_failed'
  | 'upstream_truncation'
  | 'message_lookup_limit'
  | 'detail_limit'
  | 'details_unavailable';

export interface DiagnosticExportContext {
  nativeSessionId?: string;
  entry?: DiagnosticContextEntry;
  coverage: {
    source: 'gateway_chat_history';
    status: 'complete' | 'partial' | 'unavailable' | 'changed';
    reasons: ContextGap[];
    pagesRead: number;
    messages: number;
    activityItems: number;
    upstreamTruncatedMessages: number;
    recoveredMessages: number;
    toolInputs: number;
    compactions: number;
    bytes: number;
    totalMessages?: number;
  };
}

export interface DiagnosticContextEntry {
  bytes: number;
  open(): Readable;
}

type ContextPage = { start: number; bytes: number };

class ContextIdentityError extends Error {
  constructor(
    readonly reason: 'identity_unconfirmed' | 'history_changed' | 'native_instance_changed',
  ) {
    super(reason);
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const historyId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 256 && value.trim() === value && value
    ? value
    : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function projectContextSettings(envelope: Record<string, unknown>) {
  const session = asRecord(envelope.sessionInfo);
  const defaults = asRecord(envelope.defaults);
  const budget = asRecord(session?.contextBudgetStatus);
  const overrides = asRecord(envelope.toolOverrides);
  const projectModel = (value: Record<string, unknown> | undefined) => {
    const provider = historyId(value?.modelProvider);
    const model = historyId(value?.model);
    const contextTokens = count(value?.contextTokens);
    return provider || model || contextTokens !== undefined
      ? { provider, model, contextTokens }
      : undefined;
  };
  const flags = (value: unknown) =>
    Object.entries(asRecord(value) ?? {})
      .slice(0, 250)
      .filter(([id, state]) => historyId(id) !== undefined && typeof state === 'boolean');
  const webSearch = typeof overrides?.webSearch === 'boolean' ? overrides.webSearch : undefined;
  const mcpServers = flags(overrides?.mcpServers);
  const skills = flags(overrides?.skills);
  const mcpToolsDeny = Object.entries(asRecord(overrides?.mcpToolsDeny) ?? {})
    .slice(0, 250)
    .flatMap(([id, tools]) =>
      historyId(id) && Array.isArray(tools)
        ? [[id, tools.slice(0, 250).map(historyId).filter(Boolean)]]
        : [],
    );
  return {
    scope: 'gateway_current_session',
    configuredModel: projectModel(session),
    activeModel: projectModel({
      modelProvider: session?.activeModelProvider,
      model: session?.activeModel,
    }),
    thinkingLevel: historyId(envelope.thinkingLevel),
    defaults: projectModel(defaults),
    contextBudget:
      budget?.source === 'pre-prompt-estimate'
        ? {
            source: 'pre-prompt-estimate',
            provider: historyId(budget.provider),
            model: historyId(budget.model),
            route: historyId(budget.route),
            updatedAt: diagnosticExportTime(budget.updatedAt),
            shouldCompact:
              typeof budget.shouldCompact === 'boolean' ? budget.shouldCompact : undefined,
            ...Object.fromEntries(CONTEXT_COUNTS.map(key => [key, count(budget[key])])),
          }
        : undefined,
    toolOverrides:
      webSearch !== undefined || mcpServers.length || skills.length || mcpToolsDeny.length
        ? {
            webSearch,
            mcpServers: mcpServers.length ? mcpServers : undefined,
            skills: skills.length ? skills : undefined,
            mcpToolsDeny: mcpToolsDeny.length ? mcpToolsDeny : undefined,
          }
        : undefined,
  };
}

const TOOL_BLOCK_TYPES = new Set([
  'toolcall',
  'tooluse',
  'functioncall',
  'toolresult',
  'toolresponse',
]);
const ACTIVITY_TIMES = ['timestamp', 'startedAt', 'endedAt', 'completedAt'] as const;

function projectActivityTimes(value: Record<string, unknown>) {
  const projected = { ...value };
  for (const key of ACTIVITY_TIMES) {
    const timestamp = diagnosticExportTime(value[key]);
    if (timestamp !== undefined) projected[key] = timestamp;
  }
  return projected;
}

function projectContextMessage(message: Record<string, unknown>) {
  const projected = projectActivityTimes(message);
  const metadata = asRecord(message.__openclaw);
  if (Array.isArray(message.content)) {
    projected.content = message.content.map(value => {
      const block = asRecord(value);
      const type =
        typeof block?.type === 'string' ? block.type.replace(/[_-]/g, '').toLowerCase() : '';
      return block && TOOL_BLOCK_TYPES.has(type) ? projectActivityTimes(block) : value;
    });
  }
  if (metadata) {
    const { recordTimestampMs, senderProfileAvatarUrl: _avatar, ...native } = metadata;
    const recordTimestamp = diagnosticExportTime(recordTimestampMs);
    projected.__openclaw = {
      ...native,
      recordTimestampMs: recordTimestamp === undefined ? recordTimestampMs : undefined,
      recordTimestamp: recordTimestamp !== projected.timestamp ? recordTimestamp : undefined,
    };
  }
  return projected;
}

// Native messages may contain arbitrary structured tool arguments. Keep the
// payload shape, but don't publish headers or credentials from any nested object.
const protectedKey =
  /^(?:auth(?:entication)?|(?:request|response)?headers|cookies?|bearer|clientsecret|refreshsecret|credential(?:s|value)?|(?:x)?accessjwt|jwt|proxyauthorization|sig(?:nature)?|(?:api|access|secret|private|public)key(?:value)?|secret(?:value|ref)?|accesscode)$/i;
function redactContextValue(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[OMITTED NESTING]';
  if (typeof value === 'string' && /^[\s]*[{\[]/.test(value)) {
    try {
      return JSON.stringify(redactContextValue(JSON.parse(value), depth + 1));
    } catch {
      // Non-JSON text still passes through the ordinary text masker below.
    }
  }
  if (Array.isArray(value)) return value.map(item => redactContextValue(item, depth + 1));
  const fields = asRecord(value);
  return fields
    ? Object.fromEntries(
        Object.entries(fields).map(([key, item]) => [
          key,
          protectedKey.test(key.replace(/[-_\s]/g, ''))
            ? '[REDACTED]'
            : redactContextValue(item, depth + 1),
        ]),
      )
    : value;
}

function formatContextRecord(payload: unknown, indent: string): string {
  const masked = redactDiagnosticLog(JSON.stringify(redactContextValue(payload)));
  return JSON.stringify(JSON.parse(masked), null, 2).replaceAll('\n', `${EOL}${indent}`);
}

type ContextDetails = { toolInputs: string[]; compactions: string[] };

function createContextEntry(
  spoolPath: string,
  session: string | undefined,
  pages: readonly ContextPage[],
  details: ContextDetails,
): DiagnosticContextEntry {
  const recordSeparator = `,${EOL}`;
  const formatArray = (items: string[]) =>
    items.length ? `[${EOL}${items.join(recordSeparator)}${EOL}  ]` : '[]';
  const header = [
    '{',
    ...(session === undefined ? [] : [`  "session": ${session},`]),
    '  "messages": [',
  ].join(EOL);
  const footer = [
    pages.length ? `${EOL}  ],` : '],',
    `  "toolInputs": ${formatArray(details.toolInputs)},`,
    `  "compactions": ${formatArray(details.compactions)}`,
    '}',
    '',
  ].join(EOL);
  const bytes =
    Buffer.byteLength(header) +
    Buffer.byteLength(footer) +
    pages.reduce((sum, page) => sum + page.bytes, 0) +
    (pages.length ? pages.length * EOL.length + pages.length - 1 : 0);
  async function* chunks() {
    yield Buffer.from(header);
    if (pages.length) {
      const spool = await fs.open(spoolPath, 'r');
      try {
        for (let index = pages.length - 1; index >= 0; index--) {
          yield Buffer.from(index === pages.length - 1 ? EOL : recordSeparator);
          const page = pages[index];
          for (let offset = 0; offset < page.bytes;) {
            const buffer = Buffer.allocUnsafe(
              Math.min(CONTEXT_READ_CHUNK_BYTES, page.bytes - offset),
            );
            const { bytesRead } = await spool.read(buffer, 0, buffer.length, page.start + offset);
            if (bytesRead === 0) throw new Error('Incomplete diagnostic context');
            offset += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
        }
      } finally {
        await spool.close();
      }
    }
    yield Buffer.from(footer);
  }
  return { bytes, open: () => Readable.from(chunks(), { objectMode: false }) };
}

function getToolCallIds(message: Record<string, unknown>): string[] {
  const top =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const blocks = Array.isArray(message.content)
    ? message.content.filter(block => {
        const type = asRecord(block)?.type;
        return (
          typeof type === 'string' && /^(?:tool[_-]?(?:call|use)|function[_-]?call)$/i.test(type)
        );
      })
    : [];
  return [...blocks, ...(Array.isArray(top) ? top : [top])].flatMap(block => {
    const item = asRecord(block);
    const id = historyId(item?.id ?? item?.toolCallId ?? item?.tool_call_id);
    return id ? [id] : [];
  });
}

/** Export the retained Gateway projection without storing conversation rows in Main. */
export async function collectDiagnosticExportContext(
  client: GatewayClientLike | null | undefined,
  binding: DiagnosticSessionBinding | null,
  stagingDirectory: string,
  signal?: AbortSignal,
): Promise<DiagnosticExportContext> {
  const coverage: DiagnosticExportContext['coverage'] = {
    source: 'gateway_chat_history',
    status: 'unavailable',
    reasons: [],
    pagesRead: 0,
    messages: 0,
    activityItems: 0,
    upstreamTruncatedMessages: 0,
    recoveredMessages: 0,
    toolInputs: 0,
    compactions: 0,
    bytes: 0,
  };
  if (!client || !binding || signal?.aborted) {
    coverage.reasons.push(signal?.aborted ? 'canceled' : !binding ? 'no_binding' : 'offline');
    return { coverage };
  }

  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    signal?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('timeout')), RPC_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
    let cancel: (() => void) | undefined;
    try {
      const canceled = new Promise<never>((_, reject) => {
        cancel = () => reject(requestSignal.reason);
        requestSignal.addEventListener('abort', cancel, { once: true });
      });
      const reply = await Promise.race([
        client.request(method, { sessionKey: binding.key, ...params }, { signal: requestSignal }),
        canceled,
      ]);
      requestSignal.throwIfAborted();
      return reply;
    } finally {
      clearTimeout(timer);
      if (cancel) requestSignal.removeEventListener('abort', cancel);
    }
  };
  const gap = (reason: ContextGap) => {
    if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
  };
  const reset = (
    reason:
      | 'canceled'
      | 'identity_unconfirmed'
      | 'history_changed'
      | 'native_instance_changed'
      | 'write_failed',
  ) => {
    coverage.status =
      reason === 'history_changed' || reason === 'native_instance_changed'
        ? 'changed'
        : 'unavailable';
    coverage.reasons = [reason];
    coverage.messages = 0;
    coverage.activityItems = 0;
    coverage.upstreamTruncatedMessages = 0;
    coverage.recoveredMessages = 0;
    coverage.toolInputs = 0;
    coverage.compactions = 0;
    coverage.bytes = 0;
    return { coverage };
  };
  let nativeSessionId: string | undefined;
  let cursor: string | undefined;
  let offset = 0;
  let phase: 'messages' | 'details' | 'staging' = 'messages';
  let hasMore = true;
  let spoolBytes = 0;
  let messageLookups = 0;
  let settings: string | undefined;
  const pages: ContextPage[] = [];
  const spoolPath = path.join(stagingDirectory, 'context-pages.tmp');
  let spool: Awaited<ReturnType<typeof fs.open>> | undefined;
  const details: ContextDetails = { toolInputs: [], compactions: [] };
  const seen = new Set<string>();
  const seenActivities = new Set<string>();
  const toolIds = new Set<string>();
  const compactionIds = new Set<string>();
  const acceptId = (ids: Set<string>, id: string) => {
    if (ids.has(id)) return;
    if (ids.size === MAX_DETAIL_IDS) gap('detail_limit');
    else ids.add(id);
  };
  let spoolCloseFailed = false;
  try {
    while (hasMore) {
      const raw = await request('chat.history', {
        offset,
        limit: PAGE_MESSAGES,
        maxBytes: 512 * 1024,
        maxChars: 500_000,
        toolResultMaxChars: 500_000,
      });
      const page = parseChatHistoryResultV2026_10_6(raw);
      const envelope = asRecord(raw);
      const pageSessionId = historyId(envelope?.sessionId);
      if (envelope?.sessionKey !== binding.key || !pageSessionId) {
        throw new ContextIdentityError(
          nativeSessionId ? 'history_changed' : 'identity_unconfirmed',
        );
      }
      if (pageSessionId !== (nativeSessionId ?? binding.nativeSessionId ?? pageSessionId)) {
        throw new ContextIdentityError('native_instance_changed');
      }
      if (page.windowReset || (offset > 0 && page.totalMessages !== coverage.totalMessages)) {
        throw new ContextIdentityError('history_changed');
      }
      if (offset === 0) {
        nativeSessionId = pageSessionId;
        cursor = page.deltaCursor;
        coverage.totalMessages = page.totalMessages;
        if (
          envelope.sessionInfo ||
          envelope.defaults ||
          envelope.toolOverrides ||
          envelope.thinkingLevel
        ) {
          settings = formatContextRecord(projectContextSettings(envelope), '  ');
        }
      }
      coverage.pagesRead++;
      hasMore = page.hasMore;

      const activities = new Map<string, unknown[]>();
      for (const rawActivity of page.activity ?? []) {
        const item = asRecord(rawActivity);
        const messageId = historyId(item?.messageId);
        if (messageId && Array.isArray(item?.items)) {
          activities.set(messageId, item.items);
        }
      }
      const lines: string[] = [];
      let recoveredMessages = 0;
      let activityItems = 0;
      let truncatedMessages = 0;
      for (let index = page.messages.length - 1; index >= 0; index--) {
        let message = asRecord(page.messages[index]);
        if (!message) throw new Error('Malformed conversation history record');
        let metadata = asRecord(message.__openclaw);
        const id = historyId(metadata?.id);
        // A source row can have multiple display siblings with the same id;
        // deduplicate only exact projections replayed by the pagination boundary.
        const activity = id && !seenActivities.has(id) ? activities.get(id) : undefined;
        const fingerprint = id
          ? createHash('sha256').update(JSON.stringify(message)).digest('hex')
          : undefined;
        if (fingerprint && seen.has(fingerprint)) continue;
        let recovered = false;
        if (metadata?.truncated === true && id) {
          if (messageLookups >= MAX_MESSAGE_LOOKUPS) {
            gap('message_lookup_limit');
          } else {
            messageLookups++;
            try {
              const lookup = asRecord(
                await request('chat.message.get', {
                  sessionId: nativeSessionId,
                  messageId: id,
                  maxChars: 500_000,
                }),
              );
              const expanded = asRecord(lookup?.message);
              const expandedMeta = asRecord(expanded?.__openclaw);
              if (
                lookup?.ok === true &&
                expanded &&
                expandedMeta?.id === id &&
                expandedMeta.truncated !== true &&
                expanded.role === message.role &&
                (metadata.runId === undefined || metadata.runId === expandedMeta.runId) &&
                Buffer.byteLength(JSON.stringify(expanded)) <= 512 * 1024
              ) {
                message = expanded;
                metadata = expandedMeta;
                recovered = true;
              }
            } catch {
              signal?.throwIfAborted();
            }
          }
        }
        const row = `    ${formatContextRecord(
          {
            message: projectContextMessage(message),
            ...(activity
              ? { activity: activity.map(item => projectActivityTimes(asRecord(item) ?? {})) }
              : {}),
          },
          '    ',
        )}`;
        if (fingerprint) seen.add(fingerprint);
        lines.push(row);
        if (recovered) recoveredMessages++;
        activityItems += activity?.length ?? 0;
        if (activity && id) seenActivities.add(id);
        if (metadata?.truncated === true) {
          truncatedMessages++;
        }
        if (id && metadata?.kind === 'compaction') acceptId(compactionIds, id);
        for (const id of getToolCallIds(message)) acceptId(toolIds, id);
      }
      if (lines.length) {
        signal?.throwIfAborted();
        phase = 'staging';
        spool ??= await fs.open(spoolPath, 'wx', 0o600);
        const fragment = lines.reverse().join(`,${EOL}`);
        const bytes = Buffer.byteLength(fragment);
        await spool.appendFile(fragment);
        pages.push({ start: spoolBytes, bytes });
        spoolBytes += bytes;
        coverage.messages += lines.length;
        coverage.recoveredMessages += recoveredMessages;
        coverage.activityItems += activityItems;
        coverage.upstreamTruncatedMessages += truncatedMessages;
        if (truncatedMessages) gap('upstream_truncation');
        phase = 'messages';
      }
      if (!hasMore) break;
      if (page.nextOffset === undefined || page.nextOffset <= offset)
        throw new ContextIdentityError('history_changed');
      offset = page.nextOffset;
    }
    phase = 'details';
    const tools = [...toolIds];
    const compactions = [...compactionIds];
    for (
      let start = 0;
      cursor && start < Math.max(tools.length, compactions.length);
      start += DETAIL_BATCH_SIZE
    ) {
      const toolCallIds = tools.slice(start, start + DETAIL_BATCH_SIZE);
      const compactionEntryIds = compactions.slice(start, start + DETAIL_BATCH_SIZE);
      const raw = await request('runtimeServices.historyDetails', {
        sessionId: nativeSessionId,
        toolCallIds,
        compactionEntryIds,
      });
      const identity = asRecord(raw);
      if (identity?.status === 'changed') throw new ContextIdentityError('native_instance_changed');
      if (identity?.sessionId !== nativeSessionId) {
        if (historyId(identity?.sessionId))
          throw new ContextIdentityError('native_instance_changed');
        gap('details_unavailable');
        break;
      }
      if (identity?.truncated === true) gap('detail_limit');
      const batch = parseHistoryDetailsResultV2026_10_6(raw);
      for (const [ids, lookup, section] of [
        [toolCallIds, batch.toolInputs, 'toolInputs'],
        [compactionEntryIds, batch.compactionDetails, 'compactions'],
      ] as const) {
        for (const id of ids) {
          if (!Object.hasOwn(lookup, id)) {
            gap('details_unavailable');
            continue;
          }
          const row = `    ${formatContextRecord({ id, detail: lookup[id] }, '    ')}`;
          details[section].push(row);
          coverage[section]++;
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) return reset('canceled');
    if (error instanceof ContextIdentityError) return reset(error.reason);
    if (phase === 'staging') return reset('write_failed');
    if (error instanceof Error && error.message === 'timeout') gap('timeout');
    gap(phase === 'details' ? 'details_unavailable' : 'read_failed');
  } finally {
    try {
      await spool?.close();
    } catch {
      spoolCloseFailed = true;
    }
  }
  if (signal?.aborted) return reset('canceled');
  if (spoolCloseFailed) return reset('write_failed');

  // Hydration may yield while compaction or a branch change updates the same
  // physical instance. Validate the original cursor after the last such read.
  let verified = false;
  try {
    if (nativeSessionId && cursor) {
      const raw = await request('chat.history', { cursor });
      const delta = parseChatHistoryCursorResultV2026_10_6(raw);
      if (delta.kind === 'reset') return reset('history_changed');
      const deltaSession = asRecord(asRecord(raw)?.sessionInfo);
      if (deltaSession?.sessionId !== undefined && deltaSession.sessionId !== nativeSessionId)
        return reset('native_instance_changed');
      for (const message of delta.messages) {
        const envelope = asRecord(message);
        if (envelope?.sessionKey !== binding.key) return reset('history_changed');
        if (envelope.sessionId !== undefined && envelope.sessionId !== nativeSessionId)
          return reset('native_instance_changed');
      }
      if (delta.messages.length) gap('history_appended');
      verified = true;
    } else if (nativeSessionId) {
      gap('verification_unavailable');
    }
  } catch (error) {
    if (signal?.aborted) return reset('canceled');
    if (error instanceof Error && error.message === 'timeout') gap('timeout');
    gap('verification_failed');
  }
  if (!nativeSessionId) return { coverage };
  coverage.status = coverage.reasons.length ? 'partial' : 'complete';
  if (!verified) {
    coverage.toolInputs = 0;
    coverage.compactions = 0;
  }
  if (settings === undefined && pages.length === 0) return { nativeSessionId, coverage };
  const entry = createContextEntry(
    spoolPath,
    settings,
    pages,
    verified ? details : { toolInputs: [], compactions: [] },
  );
  coverage.bytes = entry.bytes;
  return { nativeSessionId, coverage, entry };
}
