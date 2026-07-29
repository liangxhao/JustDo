const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const AGENT_RUN_FAILED_BEFORE_REPLY = 'The agent run failed before producing a reply.';
const FAILED_RUN_STORAGE_KEY = 'justdo-openclaw-failed-runs';
const FAILED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type FailedRunRecord = {
  sessionKey: string;
  runId: string | null;
  error: string;
  timestamp: number;
};

type HistoryDisplayBridge = {
  getToolInputs?: (params: { sessionKey: string; toolCallIds: string[] }) => Promise<{
    success?: boolean;
    inputs?: Record<string, { name?: string; input?: unknown }>;
  }>;
  getCompactionDetails?: (params: { sessionKey: string; entryIds: string[] }) => Promise<{
    success?: boolean;
    details?: Record<string, { summary?: string; tokensBefore?: number; tokensAfter?: number }>;
  }>;
};

export interface HistoryDisplayNormalizationOptions {
  sessionKey: string;
  lastError?: string | null;
  enrichCompactionMarkers?: (
    messages: unknown[],
    sessionKey: string,
  ) => Promise<unknown[]>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function historyDisplayBridge(): HistoryDisplayBridge | undefined {
  return (
    globalThis as {
      electron?: {
        openclaw?: {
          history?: HistoryDisplayBridge;
        };
      };
    }
  ).electron?.openclaw?.history;
}

function extractSnapshotText(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) return null;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (!Array.isArray(record.content)) return null;
  const texts = record.content.flatMap(block => {
    const item = asRecord(block);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  });
  return texts.length > 0 ? texts.join('') : null;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap(item => {
      const record = asRecord(item);
      return typeof record?.text === 'string' ? [record.text] : [];
    })
    .join('\n');
}

export function stripSilentReplySuffixFromText(text: string): string {
  if (SILENT_REPLY_PATTERN.test(text.trim())) return text;
  return text.replace(/\s*NO_REPLY\s*$/i, '').trimEnd();
}

export function stripAssistantSilentReplySuffix(message: unknown): unknown {
  const record = asRecord(message);
  if (!record || String(record.role ?? '').toLowerCase() !== 'assistant') return message;

  if (typeof record.content === 'string') {
    const stripped = stripSilentReplySuffixFromText(record.content);
    return stripped === record.content ? message : { ...record, content: stripped };
  }

  if (typeof record.text === 'string') {
    const stripped = stripSilentReplySuffixFromText(record.text);
    return stripped === record.text ? message : { ...record, text: stripped };
  }

  const originalContent = record.content;
  if (!Array.isArray(originalContent)) return message;

  let changed = false;
  const content = originalContent.map((item, index) => {
    const block = asRecord(item);
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return item;
    if (index !== originalContent.length - 1) return item;
    const stripped = stripSilentReplySuffixFromText(block.text);
    if (stripped === block.text) return item;
    changed = true;
    return { ...block, text: stripped };
  });

  return changed ? { ...record, content } : message;
}

function isPersistedSilentReplyArtifactText(text: string): boolean {
  const trimmed = text.trim();
  if (SILENT_REPLY_PATTERN.test(trimmed)) return true;
  const upper = trimmed.toUpperCase();
  return upper.startsWith('NO_') && 'NO_REPLY'.startsWith(upper);
}

export function shouldHideMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
  if (role !== 'assistant') return false;
  const text = extractSnapshotText(message);
  return Boolean(
    text && (isPersistedSilentReplyArtifactText(text) || text.includes('HEARTBEAT_OK')),
  );
}

export function projectGatewayHistoryForDisplay(messages: unknown[]): unknown[] {
  return messages
    .map(stripAssistantSilentReplySuffix)
    .filter(message => !shouldHideMessage(message))
    .filter(message => !asRecord(message)?.__openclawStreamFallback);
}

function readFailedRuns(): FailedRunRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(FAILED_RUN_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    const cutoff = Date.now() - FAILED_RUN_RETENTION_MS;
    return value.filter(
      (item): item is FailedRunRecord =>
        typeof item?.sessionKey === 'string' &&
        (typeof item.runId === 'string' || item.runId === null) &&
        typeof item.error === 'string' &&
        typeof item.timestamp === 'number' &&
        item.timestamp >= cutoff,
    );
  } catch {
    return [];
  }
}

export function persistFailedRun(record: FailedRunRecord): void {
  if (typeof localStorage === 'undefined') return;
  const records = readFailedRuns().filter(
    item => !(record.runId && item.sessionKey === record.sessionKey && item.runId === record.runId),
  );
  try {
    localStorage.setItem(FAILED_RUN_STORAGE_KEY, JSON.stringify([...records, record].slice(-100)));
  } catch {
    // A storage failure must not interfere with chat error handling.
  }
}

function findFailedRunError(message: Record<string, unknown>, sessionKey: string): string | null {
  const runId = typeof message.runId === 'string' ? message.runId : null;
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
  const candidates = readFailedRuns().filter(item => item.sessionKey === sessionKey);
  const exact = runId ? candidates.find(item => item.runId === runId) : null;
  if (exact) return exact.error;
  if (timestamp === null) return candidates[candidates.length - 1]?.error ?? null;
  return (
    candidates
      .filter(item => Math.abs(item.timestamp - timestamp) < 60_000)
      .sort(
        (left, right) =>
          Math.abs(left.timestamp - timestamp) - Math.abs(right.timestamp - timestamp),
      )[0]?.error ?? null
  );
}

function normalizeFailedRunMessage(
  message: unknown,
  sessionKey: string,
  errorMessage: string | null,
): unknown {
  const raw = asRecord(message);
  if (
    raw?.role !== 'assistant' ||
    messageText(raw.content).trim() !== AGENT_RUN_FAILED_BEFORE_REPLY
  ) {
    return message;
  }
  return {
    ...raw,
    role: 'system',
    content:
      errorMessage?.trim() || findFailedRunError(raw, sessionKey) || AGENT_RUN_FAILED_BEFORE_REPLY,
    isError: true,
  };
}

function hasMeaningfulToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function getToolResultId(message: unknown): string | null {
  const raw = asRecord(message);
  if (!raw) return null;
  const id = [raw.toolCallId, raw.tool_call_id, raw.toolUseId, raw.tool_use_id].find(
    value => typeof value === 'string' && value.trim(),
  );
  return typeof id === 'string' ? id : null;
}

function hasMessageToolInput(message: unknown): boolean {
  const raw = asRecord(message);
  if (!raw) return false;
  return [raw.toolInput, raw.tool_input, raw.arguments, raw.args, raw.input].some(
    hasMeaningfulToolInput,
  );
}

async function hydrateMissingToolInputs(
  sessionKey: string,
  messages: unknown[],
): Promise<unknown[]> {
  const missingIds = Array.from(
    new Set(
      messages
        .filter(message => {
          const raw = asRecord(message);
          const role = typeof raw?.role === 'string' ? raw.role.toLowerCase() : '';
          return ['toolresult', 'tool_result', 'tool', 'function'].includes(role);
        })
        .filter(message => !hasMessageToolInput(message))
        .map(getToolResultId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (missingIds.length === 0) return messages;

  const result = await historyDisplayBridge()?.getToolInputs?.({
    sessionKey,
    toolCallIds: missingIds,
  });
  const inputs = result?.success && result.inputs ? result.inputs : {};
  if (Object.keys(inputs).length === 0) return messages;

  return messages.map(message => {
    const raw = asRecord(message);
    if (!raw || hasMessageToolInput(raw)) return message;
    const id = getToolResultId(raw);
    const hydrated = id ? inputs[id] : undefined;
    if (!hydrated || !hasMeaningfulToolInput(hydrated.input)) return message;
    return {
      ...raw,
      toolName: raw.toolName ?? raw.tool_name ?? hydrated.name,
      toolInput: hydrated.input,
    };
  });
}

function readNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function hydrateMissingCompactionDetails(
  sessionKey: string,
  messages: unknown[],
): Promise<unknown[]> {
  const missingEntryIds = Array.from(
    new Set(
      messages.flatMap(message => {
        const raw = asRecord(message);
        const marker = asRecord(raw?.__openclaw);
        if (marker?.kind !== 'compaction' || typeof marker.id !== 'string') return [];
        return readNonBlankString(marker.summary) ? [] : [marker.id];
      }),
    ),
  );
  if (missingEntryIds.length === 0) return messages;

  let result:
    | {
        success?: boolean;
        details?: Record<
          string,
          { summary?: string; tokensBefore?: number; tokensAfter?: number }
        >;
      }
    | undefined;
  try {
    result = await historyDisplayBridge()?.getCompactionDetails?.({
      sessionKey,
      entryIds: missingEntryIds,
    });
  } catch {
    return messages;
  }
  const details = result?.success && result.details ? result.details : {};
  if (Object.keys(details).length === 0) return messages;

  return messages.map(message => {
    const raw = asRecord(message);
    const marker = asRecord(raw?.__openclaw);
    const id = typeof marker?.id === 'string' ? marker.id : '';
    const detail = id ? details[id] : undefined;
    if (marker?.kind !== 'compaction' || !detail) return message;
    return {
      ...raw,
      __openclaw: {
        ...marker,
        summary: readNonBlankString(marker.summary) ?? readNonBlankString(detail.summary),
        tokensBefore: marker.tokensBefore ?? detail.tokensBefore,
        tokensAfter: marker.tokensAfter ?? detail.tokensAfter,
      },
    };
  });
}

export async function hydrateGatewayHistoryForDisplay(
  messages: unknown[],
  options: HistoryDisplayNormalizationOptions,
): Promise<unknown[]> {
  const withGatewayCompactionDetails = options.enrichCompactionMarkers
    ? await options.enrichCompactionMarkers(messages, options.sessionKey)
    : messages;
  const withLocalCompactionDetails = await hydrateMissingCompactionDetails(
    options.sessionKey,
    withGatewayCompactionDetails,
  );
  const withToolInputs = await hydrateMissingToolInputs(
    options.sessionKey,
    withLocalCompactionDetails,
  );
  return withToolInputs.map(message =>
    normalizeFailedRunMessage(message, options.sessionKey, options.lastError ?? null),
  );
}

export async function normalizeGatewayHistoryForDisplay(
  messages: unknown[],
  options: HistoryDisplayNormalizationOptions,
): Promise<unknown[]> {
  return hydrateGatewayHistoryForDisplay(projectGatewayHistoryForDisplay(messages), options);
}
