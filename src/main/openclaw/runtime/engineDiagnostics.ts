import type {
  EngineDiagnosticEvidence,
  EngineDiagnosticReport,
  EngineFailureCategory,
  EngineFailureContext,
  EngineLogCoverage,
  EngineLogIssue,
  EngineLogSource,
} from '../../../shared/openclaw/engineDiagnostics';
import { getLogFilePath, getRecentMainLogEntries } from '../../core/logger';
import { redactLogText } from '../../core/logRedaction';
import {
  discoverNativeDiagnosticLogs,
  scanDiagnosticLog,
} from '../../cowork/diagnostics/logScanner';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawEngineManager } from './openclawEngineManager';

const SOURCE_RECORDS = 30;
const EXCERPT_CHARS = 4000;
const ERROR_TEXT = /\b(?:error|fatal|failed|failure|cannot|unable|invalid)\b/i;
const ERROR_CODE =
  /\b(?:E(?:ADDRINUSE|CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|NETUNREACH|TIMEDOUT|ACCES|PERM|NOENT|NOSPC|NOMEM|BUSY)|ERR_[A-Z_]+|SQLITE_[A-Z_]+)\b/;
const ENGINE_SCOPE =
  /\[(?:OpenClaw[^\]]*|gateway|reload|plugins?|runtime[^\]]*|Main|ConfigSync[^\]]*|OutboundHeader[^\]]*|Trusted[^\]]*)\]/i;
const BOOT_CONTEXT =
  /\b(?:startGateway|startup|starting|restarting|gateway process|gateway is running|runtime.*missing|listening on|ready)\b/i;
const PRIVATE_CONTENT =
  /(?:chat\.(?:send|event)|stream=(?:thinking|assistant|item)|"(?:messages|prompt|completion|toolInput|toolResult|authorization|config)"\s*:)/i;
const STACK_CONTEXT = /^\s*(?:at\s|Caused by:|cause:|code:|errno:|syscall:|address:|port:)/i;

export function classifyEngineFailure(text: string): EngineFailureCategory {
  if (/\bEADDRINUSE\b|(?:port|address).{0,40}(?:already in use|occupied)/i.test(text))
    return 'port';
  if (
    /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|Cannot find (?:module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|runtime.*(?:missing|invalid)|entry file.*missing/i.test(
      text,
    )
  )
    return 'runtime';
  if (
    /SQLITE_(?:BUSY|LOCKED|CORRUPT|CANTOPEN|NOTADB)|\bENOSPC\b|disk.{0,10}full|database.{0,30}(?:locked|corrupt)|(?:lease|lock).{0,40}(?:held|busy|failed)/i.test(
      text,
    )
  )
    return 'storage';
  if (/\b(?:EACCES|EPERM)\b|permission denied/i.test(text)) return 'permission';
  if (
    /CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate.{0,30}(?:expired|invalid|verify|failed)|self.signed certificate/i.test(
      text,
    )
  )
    return 'certificate';
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH)\b|fetch failed/i.test(text))
    return 'network';
  if (/heap out of memory|allocation failed|\bENOMEM\b/i.test(text)) return 'memory';
  if (
    /(?:secret|credential|api.key|auth profile).{0,70}(?:missing|unresolved|not found|failed|invalid)|unauthorized|authentication failed/i.test(
      text,
    )
  )
    return 'credentials';
  if (
    /(?:invalid|failed|error).{0,40}(?:configuration|config|schema)|(?:config|configuration).{0,70}(?:invalid|failed|parse error)|SyntaxError/i.test(
      text,
    )
  )
    return 'config';
  if (/timed? out|timeout|healthy in time|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/exited unexpectedly|exit(?:ed)? (?:with )?code|SIGKILL|SIGTERM/i.test(text)) return 'exit';
  return 'unknown';
}

const rank = (e: EngineDiagnosticEvidence) =>
  (['timeout', 'exit'].includes(e.category) ? 10 : e.category === 'unknown' ? 20 : 40) +
  (e.level === 'error' ? 8 : e.level === 'warning' ? 4 : 0);

/** Extract message/error fields, never dump native configuration or chat payload objects. */
function parseEngineRecord(raw: string, source: EngineLogSource) {
  const prefix = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*/.exec(raw);
  let timestamp = prefix ? Date.parse(prefix[1].replace(' ', 'T')) : NaN;
  let level = prefix?.[2].toLowerCase() ?? '';
  let text = prefix ? raw.slice(prefix[0].length) : raw;
  if (text.trimStart().startsWith('{')) {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const meta = value._meta as Record<string, unknown> | undefined;
      const recordTimestamp = Date.parse(String(value.time ?? meta?.date ?? ''));
      if (Number.isFinite(recordTimestamp)) timestamp = recordTimestamp;
      level = String(value.level ?? meta?.logLevelName ?? level).toLowerCase();
      if (value.ok === true || value.success === true || value.outcome === 'success') {
        return { timestamp, text: '', level: 'info' as const };
      }
      if (
        typeof value.runId === 'string' ||
        typeof value.sessionKey === 'string' ||
        /^(?:chat|agent|tool|model)\./.test(String(value.event ?? ''))
      ) {
        return { timestamp, text: '', level: 'info' as const };
      }
      const messages: string[] = [];
      for (const [key, item] of Object.entries(value)) {
        if (!/^\d+$|^(?:message|msg|error|stack|code)$/.test(key)) continue;
        if (typeof item === 'string') {
          let payload = false;
          if (/^\s*[\[{]/.test(item)) {
            try {
              JSON.parse(item);
              payload = true;
            } catch {
              /* Plain log prefix. */
            }
          }
          if (!payload) messages.push(item);
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const error = item as Record<string, unknown>;
          for (const field of ['message', 'stack', 'code']) {
            if (typeof error[field] === 'string') messages.push(error[field] as string);
          }
        }
      }
      text = messages.join('\n');
    } catch {
      return null;
    }
  } else if (source === 'native') return null;
  if (!Number.isFinite(timestamp)) return null;
  if (PRIVATE_CONTENT.test(text)) return { timestamp, text: '', level: 'info' as const };
  const category = classifyEngineFailure(text);
  // stderr includes routine warnings, so error wording/codes still have to agree.
  const error =
    ['error', 'fatal'].includes(level) || ERROR_TEXT.test(text) || ERROR_CODE.test(text);
  const warning = ['warn', 'warning'].includes(level) || /\bwarn(?:ing)?\b/i.test(text);
  const scoped = source !== 'main' || ENGINE_SCOPE.test(text);
  const continuation = STACK_CONTEXT.test(text.replace(/^\[OpenClaw (?:stderr|stdout)\]\s*/, ''));
  const relevant =
    continuation ||
    (scoped &&
      ((error && (category !== 'unknown' || ENGINE_SCOPE.test(text) || source !== 'main')) ||
        (warning && (category !== 'unknown' || BOOT_CONTEXT.test(text))) ||
        BOOT_CONTEXT.test(text)));
  return {
    timestamp,
    text: relevant ? text : '',
    level: error ? ('error' as const) : warning ? ('warning' as const) : ('info' as const),
    continuation,
  };
}

const issueFor = (error: unknown): EngineLogIssue => {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === 'ENOENT') return 'missing';
  if (message === 'unsafe_file') return 'unsafe';
  if (message === 'source_changed') return 'changed';
  if (message === 'read_timeout') return 'timeout';
  return 'unavailable';
};

export interface EngineDiagnosticsDependencies {
  getContext: () => EngineFailureContext;
  getMainLogFiles: () => string[];
  getGatewayLogFile: () => string;
  getGatewayClient: () => GatewayClientLike | null;
}

export async function collectEngineDiagnostics(
  deps: EngineDiagnosticsDependencies,
  signal: AbortSignal,
): Promise<EngineDiagnosticReport> {
  const current = deps.getContext();
  const context = {
    ...current,
    status: { ...current.status, message: redactLogText(current.status.message ?? '') },
  };
  const collectedAt = Date.now();
  const window = {
    from: context.startedAt - 2000,
    to: Math.min(collectedAt, context.failedAt + 2000),
  };
  const evidence: EngineDiagnosticEvidence[] = [];
  const coverage: EngineLogCoverage[] = [];
  let sequence = 0;
  if (context.status.phase === 'error' && context.status.message)
    evidence.push({
      id: `engine-${sequence++}`,
      source: 'engine',
      timestamp: context.failedAt,
      level: 'error',
      text: context.status.message.slice(0, EXCERPT_CHARS),
      category: classifyEngineFailure(context.status.message),
      truncated: false,
    });
  const scan = async (source: EngineLogSource, files: string[], initialIssue?: EngineLogIssue) => {
    const retained: EngineDiagnosticEvidence[] = [];
    const item: EngineLogCoverage = {
      source,
      files: files.length,
      scannedFiles: 0,
      matched: 0,
      omitted: 0,
      issues: initialIssue ? [initialIssue] : [],
    };
    coverage.push(item);
    if (!files.length && !initialIssue) item.issues.push('missing');
    const issue = (value: EngineLogIssue) => {
      if (!item.issues.includes(value)) item.issues.push(value);
    };
    for (const file of [...new Set(files)]) {
      if (signal.aborted) throw new Error('canceled');
      let previous: EngineDiagnosticEvidence | undefined;
      const trim = () => {
        retained.sort((a, b) => rank(b) - rank(a) || b.timestamp - a.timestamp);
        if (retained.length > SOURCE_RECORDS) {
          retained.pop();
          item.omitted++;
        }
      };
      try {
        await scanDiagnosticLog(
          file,
          source === 'native',
          {
            oversized: () => issue('oversized'),
            progress: () => {},
            record: raw => {
              const parsed = parseEngineRecord(raw, source);
              if (!parsed) {
                issue('invalid_record');
                return;
              }
              if (!parsed.text || parsed.timestamp < window.from || parsed.timestamp > window.to) {
                previous = undefined;
                return;
              }
              const safe = redactLogText(parsed.text);
              if ('continuation' in parsed && parsed.continuation) {
                if (
                  !previous ||
                  previous.level !== 'error' ||
                  parsed.timestamp < previous.timestamp ||
                  parsed.timestamp - previous.timestamp > 2000
                )
                  return;
                item.matched++;
                const combined = `${previous.text}\n${safe}`;
                previous.text = combined.slice(0, EXCERPT_CHARS);
                previous.truncated ||= combined.length > EXCERPT_CHARS;
                previous.category = classifyEngineFailure(previous.text);
                if (!retained.includes(previous)) {
                  retained.push(previous);
                  item.omitted--;
                }
                trim();
                return;
              }
              item.matched++;
              previous = {
                id: `${source}-${sequence++}`,
                source,
                timestamp: parsed.timestamp,
                level: parsed.level,
                text: safe.slice(0, EXCERPT_CHARS),
                truncated: safe.length > EXCERPT_CHARS,
                category: classifyEngineFailure(safe),
              };
              retained.push(previous);
              trim();
            },
          },
          signal,
        );
        item.scannedFiles++;
      } catch (error) {
        if (signal.aborted) throw new Error('canceled');
        issue(issueFor(error));
      }
    }
    evidence.push(...retained);
  };
  const native = async () => {
    const client = deps.getGatewayClient();
    if (!client) return scan('native', [], 'offline');
    try {
      const result = await client.request<{ file?: unknown }>(
        'logs.tail',
        { limit: 1, maxBytes: 1024 },
        { timeoutMs: 3000, signal },
      );
      if (client !== deps.getGatewayClient()) return scan('native', [], 'changed');
      const files = await discoverNativeDiagnosticLogs(result.file, signal);
      return scan('native', files);
    } catch (error) {
      if (signal.aborted) throw new Error('canceled');
      return scan('native', [], issueFor(error));
    }
  };
  // Local files remain available even when the runtime cannot start or answer RPCs.
  const scans = await Promise.allSettled([
    async () => scan('main', deps.getMainLogFiles()),
    async () => scan('gateway', [deps.getGatewayLogFile()]),
    native,
  ].map(source => source()));
  if (signal.aborted) throw new Error('canceled');
  // A failed or canceled source must not release the IPC slot while another
  // source is still unwinding its scanner and file handle.
  for (const scan of scans) {
    if (scan.status === 'rejected') throw scan.reason;
  }
  const after = deps.getContext();
  const findings = [...evidence]
    .filter(e => e.level !== 'info')
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        Number(a.source === 'engine') - Number(b.source === 'engine') ||
        b.timestamp - a.timestamp,
    );
  const seen = new Set<string>();
  return {
    context,
    collectedAt,
    window,
    engineChanged:
      context.status.phase !== 'error' ||
      after.id !== context.id ||
      after.processGeneration !== context.processGeneration ||
      after.status.phase !== context.status.phase,
    evidence: evidence.sort((a, b) => a.timestamp - b.timestamp),
    findings: findings
      .filter(e => {
        const key = e.category === 'unknown' ? e.text : e.category;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5)
      .map(e => e.id),
    coverage,
  };
}

export function createEngineDiagnosticsCollector(deps: {
  getManager: () => Pick<
    OpenClawEngineManager,
    'getDiagnosticContext' | 'getGatewayDiagnosticLogPath'
  >;
  getGatewayClient: () => GatewayClientLike | null;
}) {
  return (signal: AbortSignal) =>
    collectEngineDiagnostics(
      {
        getContext: () => deps.getManager().getDiagnosticContext(),
        getMainLogFiles: () => [
          ...new Set([
            getLogFilePath(),
            ...getRecentMainLogEntries(true).map(entry => entry.filePath),
          ]),
        ],
        getGatewayLogFile: () => deps.getManager().getGatewayDiagnosticLogPath(),
        getGatewayClient: deps.getGatewayClient,
      },
      signal,
    );
}
