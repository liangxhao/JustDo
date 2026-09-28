import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import yazl from 'yazl';

import { DiagnosticReason, type DiagnosticReport } from '../../../shared/cowork/sessionDiagnostics';

const member = (value: unknown, values: readonly string[], fallback = 'unknown'): string =>
  typeof value === 'string' && values.includes(value) ? value : fallback;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const boolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** Defense in depth: aliases for identity and finite values for every exported string. */
export function buildDiagnosticArchive(
  report: DiagnosticReport,
  appVersion: string,
  language: 'zh' | 'en',
) {
  const aliases = new Map<string, string>();
  const alias = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) return;
    if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
    return aliases.get(value);
  };
  const reason = member(report.conclusion.reason, Object.values(DiagnosticReason));
  const sources = ['main', 'cowork', 'gateway', 'native'] as const;
  const logs = report.logs
    ? {
        scanMode: member(report.logs.scanMode, ['full_files', 'tail']),
        collectedAt: count(report.logs.collectedAt),
        window: { from: count(report.logs.window.from), to: count(report.logs.window.to) },
        partial: true,
        localTimezoneOffsetMinutes:
          Number.isInteger(report.logs.localTimezoneOffsetMinutes) &&
          Math.abs(report.logs.localTimezoneOffsetMinutes) <= 1440
            ? report.logs.localTimezoneOffsetMinutes
            : undefined,
        sources: report.logs.sources.slice(0, 4).map(source => ({
          source: member(source.source, sources),
          scanComplete: boolean(source.scanComplete),
          filesDiscovered: count(source.filesDiscovered),
          filesCompleted: count(source.filesCompleted),
          matched: count(source.matched),
          outputOmitted: count(source.outputOmitted),
          signalCounts: Object.fromEntries(
            [
              'auth',
              'rate_limit',
              'billing',
              'context',
              'timeout',
              'network',
              'tls',
              'provider',
              'tool',
              'retry',
              'disconnect',
              'reconnect',
              'process_exit',
              'queue',
              'storage',
              'permission',
              'unknown',
            ].flatMap(signal => {
              const value = count(
                source.signalCounts?.[signal as keyof NonNullable<typeof source.signalCounts>],
              );
              return value === undefined ? [] : [[signal, value]];
            }),
          ),
          status: member(source.status, ['available', 'partial', 'unavailable']),
          filesRead: count(source.filesRead),
          bytesRead: count(source.bytesRead),
          recordsRead: count(source.recordsRead),
          emitted: count(source.emitted),
          suppressed: count(source.suppressed),
          parseFailures: count(source.parseFailures),
          truncated: source.truncated === true,
          reasons: source.reasons
            .slice(0, 12)
            .map(value =>
              member(value, [
                'missing',
                'unreadable',
                'unsafe_file',
                'limit',
                'malformed',
                'native_unavailable',
                'outside_window',
                'no_safe_fields',
                'output_limit',
                'source_changed',
                'read_timeout',
                'canceled',
              ]),
            ),
        })),
        records: report.logs.records.slice(0, 400).map(record => ({
          id: alias(record.id),
          source: member(record.source, sources),
          timestamp: count(record.timestamp),
          level: member(record.level, ['error', 'warn', 'info', 'debug', 'unknown']),
          association: member(record.association, ['run', 'session', 'time_window']),
          signal: member(record.signal, [
            'auth',
            'rate_limit',
            'billing',
            'context',
            'timeout',
            'network',
            'tls',
            'provider',
            'tool',
            'retry',
            'disconnect',
            'reconnect',
            'process_exit',
            'queue',
            'storage',
            'permission',
            'unknown',
          ]),
          inferred: record.inferred !== false,
          metrics: Object.fromEntries(
            [
              'statusCode',
              'attempt',
              'durationMs',
              'queueDepth',
              'exitCode',
              'waitMs',
              'timeToFirstByteMs',
              'requestPayloadBytes',
              'responseStreamBytes',
            ].flatMap(key => {
              const value = record.metrics[key as keyof typeof record.metrics];
              return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12
                ? [[key, value]]
                : [];
            }),
          ),
        })),
      }
    : undefined;
  const safe = {
    version: 1,
    collectedAt: count(report.collectedAt),
    session: alias(report.sessionId),
    run: report.run
      ? {
          id: alias(report.run.id),
          startedAt: count(report.run.startedAt),
          endedAt: count(report.run.endedAt),
          state: member(report.run.state, ['running', 'completed', 'failed', 'aborted']),
        }
      : undefined,
    conclusion: {
      reason,
      confidence: member(report.conclusion.confidence, ['confirmed', 'unknown']),
      evidence: report.conclusion.evidenceIds.slice(0, 232).map(alias),
      toolFailures: count(report.conclusion.toolFailures),
    },
    coverage: {
      partial: true,
      dropped: count(report.coverage.dropped),
      collectorDropped: count(report.coverage.collectorDropped),
      storageFailed: report.coverage.storageFailed === true,
      firstObservedAt: count(report.coverage.firstObservedAt),
    },
    connection: member(report.connection, ['connected', 'offline']),
    environment: {
      scope: 'global',
      status: member(report.environment.status, ['not_requested', 'available', 'unavailable']),
      collectedAt: count(report.environment.collectedAt),
      stabilityCount: count(report.environment.stabilityCount),
      stabilityDropped: count(report.environment.stabilityDropped),
    },
    events: report.events.slice(0, 232).map(event => ({
      id: alias(event.id),
      run: alias(event.runId),
      nativeRun: alias(event.nativeRunId),
      generation: alias(event.generation),
      epoch: alias(event.epoch),
      sequence: count(event.sequence),
      observedAt: count(event.observedAt),
      occurredAt: count(event.occurredAt),
      kind: member(event.kind, ['lifecycle', 'chat', 'tool', 'connection', 'cancel']),
      phase: member(event.phase, [
        'start',
        'finishing',
        'end',
        'error',
        'final',
        'aborted',
        'connected',
        'disconnected',
        'requested',
        'acknowledged',
        'failed',
      ]),
      stopReason: member(event.stopReason, [
        'stop',
        'end_turn',
        'completed',
        'length',
        'max_tokens',
        'aborted',
        'timeout',
        'restart',
        'superseded',
        'error',
      ]),
      errorCategory: member(event.errorCategory, [
        'auth',
        'rate_limit',
        'billing',
        'timeout',
        'network',
        'context',
        'provider',
      ]),
      executionSettled: boolean(event.executionSettled),
      aborted: boolean(event.aborted),
      yielded: boolean(event.yielded),
      providerStarted: boolean(event.providerStarted),
      userInitiated: boolean(event.userInitiated),
      toolFailed: boolean(event.toolFailed),
    })),
  };
  const manifest = {
    version: 1,
    redactionVersion: 2,
    appVersion: /^v?\d+(\.\d+){1,3}$/.test(appVersion) ? appVersion : 'unknown',
    files: [
      'summary.md',
      'report.json',
      'manifest.json',
      'ai-analysis.md',
      ...(logs ? ['logs.json'] : []),
    ],
    sources: [
      'local_run_metadata',
      ...(report.environment.status === 'available' ? ['global_environment_snapshot'] : []),
      ...(logs ? ['sanitized_log_evidence'] : []),
    ],
    rawLogsIncluded: false,
    transcriptsIncluded: false,
    identifiersAliased: true,
    nativeRuntimeVersion: 'not_collected',
    logCollectionRequested: Boolean(logs),
    logCoverage: logs?.sources,
    limits: {
      localFiles: report.logs?.scanMode === 'full_files' ? 'all_discovered' : 16,
      localBytes:
        report.logs?.scanMode === 'full_files'
          ? 'all_discovered'
          : report.run?.endedAt !== undefined
            ? 13631488
            : 4194304,
      fileBytes:
        report.logs?.scanMode === 'full_files'
          ? 'captured_file_size'
          : report.run?.endedAt !== undefined
            ? 4194304
            : 524288,
      recordBytes: 65536,
      outputRecords: 400,
      nativeLines: 1000,
      nativeBytes: report.logs?.sources.some(
        source => source.source === 'native' && source.filesDiscovered !== undefined,
      )
        ? 'captured_file_size'
        : 524288,
      sourceFiles: report.logs?.scanMode === 'full_files' ? 'all_discovered' : 4,
      sourceBytes:
        report.logs?.scanMode === 'full_files'
          ? 'all_discovered'
          : report.run?.endedAt !== undefined
            ? 4194304
            : 1048576,
      sourceRecords: 100,
    },
    localTimestampAssumption: 'collector_local_timezone_historical_offset_unverified',
  };
  const summary =
    language === 'zh'
      ? `# 会话诊断\n\n原因码：${reason}\n\n包含运行元数据${logs ? '和已收集的日志安全投影（logs.json）' : '；尚未收集日志'}，不包含原始日志或对话。标识已替换为包内别名。全局环境和时间相关日志不代表本轮故障原因。\n\n请先阅读 ai-analysis.md，结合 report.json 和 manifest.json 分析。\n`
      : `# Session diagnostics\n\nReason code: ${reason}\n\nRun metadata${logs ? ' and collected safe log projections (logs.json)' : '; logs have not been collected'}. Raw logs and conversations are excluded. Identifiers use archive-local aliases. Global or time-correlated evidence does not establish this run's cause.\n\nRead ai-analysis.md, report.json and manifest.json together.\n`;
  const guide =
    language === 'zh'
      ? '# AI 分析说明\n\n1. 先检查 manifest.json 的来源覆盖、截断、读取失败和脱敏版本。缺失记录不等于事件未发生。\n2. 引用 report.json / logs.json 中的记录 ID，分别列出已确认事实、可能原因和未知信息。\n3. 只有 executionSettled=true 的运行终态能确认整轮结束；chat final、单次尝试或工具失败不能替代运行终态。\n4. logs.json 是有限字段的安全投影，不是原始日志。inferred=true 表示日志文本推导的提示，不能直接断言根因。run/session/time_window 分别表示运行字段关联、会话关联和仅时间相关。会话关联仍可能属于另一轮；多来源可能重复记录同一事件，不能简单累计重试次数。\n5. 本机日志时间可能没有时区，按采集时本机时区解释；历史时区变化无法确认。检查各来源 scanComplete：仅说明发现文件的扫描是否完成，不代表历史保留完整。outputOmitted 为预览省略数量，signalCounts 仍统计扫描到的全部匹配线索；不要将重复来源计数相加。原生日志离线时可能缺失。\n6. 对模型主动停止、用户取消、网络断开、运行服务退出、供应商失败、工具失败分别核对证据；不要把日志缺口归因于模型。\n7. 输出：现象、证据引用、最可能解释及置信度、替代解释、缺失证据、可复现验证步骤。没有足够证据就明确写无法确定。\n\n此包在本地生成，不会自动上传。任意日志文本、对话、工具输入输出和路径均不包含。\n'
      : '# AI analysis guide\n\n1. Inspect manifest.json source coverage, clipping, failures and projection version first. Missing evidence is not evidence an event never occurred.\n2. Cite record IDs from report.json / logs.json. Separate facts, hypotheses and unknowns.\n3. Only executionSettled=true terminal lifecycle evidence confirms a whole-run outcome. Chat final, an attempt error or tool failure is insufficient.\n4. logs.json contains finite safe projections, not raw logs. inferred=true is a text-derived hint, not a confirmed cause. run/session/time_window associations have decreasing specificity; session matches can belong to another turn. Sources may duplicate events; do not sum them as distinct retries.\n5. Offset-less timestamps assume collector-local timezone; historical changes cannot be verified. Check source scanComplete: it describes scanning discovered files, not historical retention. outputOmitted counts preview omissions; signalCounts includes all matching scanned hints. Do not add duplicated source counts. Native evidence may be unavailable offline.\n6. Check model completion, user cancellation, network loss, runtime exit, provider and tool failure separately. Never attribute missing logs to model behavior.\n7. Return symptoms, cited evidence, likely explanation and confidence, alternatives, missing evidence, and reproducible next checks. State uncertainty when evidence is insufficient.\n\nGenerated locally without automatic upload. Arbitrary log text, conversation/tool content and paths are excluded.\n';
  const entries: Record<string, string> = {
    'summary.md': summary,
    'report.json': JSON.stringify(safe, null, 2),
    'manifest.json': JSON.stringify(manifest, null, 2),
    'ai-analysis.md': guide,
  };
  if (logs) entries['logs.json'] = JSON.stringify(logs, null, 2);
  return entries;
}

/** Write only a fresh temporary file until complete; never unlink the user's target on failure. */
export async function writeDiagnosticArchive(
  destination: string,
  entries: Record<string, string>,
  assertCurrent: () => void,
): Promise<void> {
  const bytes = Object.values(entries).reduce(
    (total, value) => total + Buffer.byteLength(value),
    0,
  );
  if (bytes > 10 * 1024 * 1024) throw new Error('size');
  const temporary = path.join(path.dirname(destination), `.diagnostics-${randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  zip.on('error', error => (zip.outputStream as import('node:stream').Readable).destroy(error));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const writing = pipeline(zip.outputStream, output, { signal: controller.signal });
    for (const [name, content] of Object.entries(entries))
      zip.addBuffer(Buffer.from(content), name);
    zip.end();
    await writing;
    assertCurrent();
    await fs.promises.rename(temporary, destination);
  } finally {
    clearTimeout(timer);
    output.destroy();
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}
