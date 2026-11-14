import { CoworkSessionSource } from '../../../shared/cowork/sessionSource';
import { ExternalSessionSource } from '../../../shared/integrations/externalSession';
import type { CoworkSession } from '../../data/coworkStore';
import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  buildGatewaySessionDetailStats,
  requestGatewaySessionUsage,
} from '../../openclaw/sessions/openclawSessionDetails';
import {
  extractOpenClawTokenUsage,
  type OpenClawTokenUsage,
} from '../../openclaw/sessions/openclawTokenUsage';
import { redactDiagnosticLog } from './exportLogs';

export interface DiagnosticSessionBinding {
  key: string;
  nativeSessionId?: string;
}

export interface DiagnosticLocalSessionDetails {
  session: Pick<
    CoworkSession,
    | 'title'
    | 'cwd'
    | 'createdAt'
    | 'updatedAt'
    | 'executionMode'
    | 'status'
    | 'source'
    | 'agentId'
    | 'groupId'
    | 'modelRef'
  > & { externalOrigin?: ExternalSessionSource };
  groupName?: string;
  runModelRef?: string;
}

export interface DiagnosticExportSessionDetails extends DiagnosticLocalSessionDetails {
  collectedAt: number;
  native: DiagnosticNativeSessionDetails;
}

interface DiagnosticNativeSessionDetails {
  nativeSessionId?: string;
  nativeSessionSource?: 'saved_history_binding' | 'gateway_describe';
  usage?: {
    models: string[];
    lastActivity?: number;
    counts?: Record<string, unknown>;
    tokens?: OpenClawTokenUsage;
  };
}

const USAGE_TIMEOUT_MS = 3000;

export async function describeDiagnosticSession(
  binding: DiagnosticSessionBinding | null,
  client: GatewayClientLike | null | undefined,
  signal?: AbortSignal,
) {
  if (!binding || !client || signal?.aborted) return {};
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), USAGE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let abort: (() => void) | undefined;
  try {
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', abort, { once: true });
    });
    const response = await Promise.race([
      client.request<{ session?: { key?: unknown; sessionId?: unknown } }>(
        'sessions.describe',
        { key: binding.key },
        { signal: requestSignal },
      ),
      canceled,
    ]);
    requestSignal.throwIfAborted();
    const row = response?.session;
    if (
      row?.key === binding.key &&
      typeof row.sessionId === 'string' &&
      row.sessionId.trim() &&
      row.sessionId.length <= 256
    ) {
      if (binding.nativeSessionId && row.sessionId !== binding.nativeSessionId)
        return { replaced: true };
      return { nativeSessionId: row.sessionId };
    }
  } catch {
    // Local evidence is still usable when the current instance is unavailable.
  } finally {
    clearTimeout(timer);
    if (abort) requestSignal.removeEventListener('abort', abort);
  }
  return {};
}

export async function collectDiagnosticSessionUsage(
  binding: DiagnosticSessionBinding | null,
  client: GatewayClientLike | null | undefined,
  verifiedSessionId?: string,
  signal?: AbortSignal,
): Promise<DiagnosticNativeSessionDetails> {
  const savedId = binding?.nativeSessionId;
  const identity: DiagnosticNativeSessionDetails = verifiedSessionId
    ? { nativeSessionId: verifiedSessionId, nativeSessionSource: 'gateway_describe' }
    : savedId
      ? { nativeSessionId: savedId, nativeSessionSource: 'saved_history_binding' }
      : {};
  if (!client || !binding || !verifiedSessionId || signal?.aborted) return identity;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), USAGE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let abort: (() => void) | undefined;
  try {
    const collect = async (): Promise<DiagnosticNativeSessionDetails> => {
      const usage = await requestGatewaySessionUsage(client, binding.key, {
        nativeSessionId: verifiedSessionId,
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      const stats = buildGatewaySessionDetailStats(usage, null);
      if (!stats) return identity;
      const counts = (usage as { messageCounts?: Record<string, unknown> }).messageCounts;
      return {
        ...identity,
        usage: {
          models: stats.models,
          lastActivity: stats.lastActivity,
          counts,
          tokens: extractOpenClawTokenUsage(usage),
        },
      };
    };
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([collect(), canceled]);
  } catch {
    return identity;
  } finally {
    clearTimeout(timer);
    if (abort) requestSignal.removeEventListener('abort', abort);
  }
}

/** Keep task labels in the local ZIP, with the same masking as its logs. */
export function diagnosticDetailText(value: unknown, limit: number): string | undefined {
  // Reject oversized values before masking so clipping cannot expose a partial credential.
  if (typeof value !== 'string' || value.length > 8192 || !value.trim()) return;
  const redacted = redactDiagnosticLog(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return redacted.slice(0, limit) || undefined;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function projectDiagnosticExportSessionDetails(
  details: DiagnosticExportSessionDetails,
  alias: (value: unknown) => string | undefined,
) {
  const { session, native } = details;
  const usage = native.usage;
  const models = [
    ...new Set(
      usage?.models
        .slice(0, 32)
        .map(model => diagnosticDetailText(model, 200))
        .filter((model): model is string => model !== undefined),
    ),
  ];
  const counts = usage?.counts;
  const messages = counts && {
    total: count(counts.total),
    user: count(counts.user),
    assistant: count(counts.assistant),
    toolCalls: count(counts.toolCalls),
  };
  const tokens = usage?.tokens && {
    input: count(usage.tokens.input),
    output: count(usage.tokens.output),
    cacheRead: count(usage.tokens.cacheRead),
    cacheWrite: count(usage.tokens.cacheWrite),
    total: count(usage.tokens.total),
  };
  return {
    scope: 'session_at_export',
    collectedAt: count(details.collectedAt),
    title: diagnosticDetailText(session.title, 240),
    workingDirectory: diagnosticDetailText(session.cwd, 1024),
    createdAt: count(session.createdAt),
    updatedAt: count(session.updatedAt),
    savedStatus: ['idle', 'running', 'completed', 'error'].includes(session.status)
      ? session.status
      : undefined,
    executionMode: ['local', 'sandbox'].includes(session.executionMode)
      ? session.executionMode
      : undefined,
    source: session.externalOrigin
      ? Object.values(ExternalSessionSource).find(origin => origin === session.externalOrigin)
      : session.source === CoworkSessionSource.ChromeExtension
        ? session.source
        : 'desktop',
    agent: alias(session.agentId),
    group: alias(session.groupId),
    groupName: diagnosticDetailText(details.groupName, 160),
    nativeSession: alias(native.nativeSessionId),
    nativeSessionSource: native.nativeSessionSource,
    configuredModel: diagnosticDetailText(session.modelRef, 200),
    usage: usage
      ? {
          source: 'gateway_instance_rollup',
          lastActivity: count(usage.lastActivity),
          models: models.length ? models : undefined,
          messages:
            messages && Object.values(messages).some(value => value !== undefined)
              ? messages
              : undefined,
          tokens:
            tokens && Object.values(tokens).some(value => value !== undefined) ? tokens : undefined,
        }
      : undefined,
  };
}
