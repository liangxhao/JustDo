import type {
  DiagnosticLogRecord,
  DiagnosticLogSource,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { redactLogText as redactDiagnosticLog } from '../../core/logRedaction';
import type { DiagnosticLogExportMetadata } from './logCollector';

export { redactDiagnosticLog };

const SOURCE_LIMIT = 2 * 1024 * 1024;
const SOURCE_RECORD_LIMIT = 2048;
const SOURCES: DiagnosticLogSource[] = ['main', 'cowork', 'gateway', 'native'];
const SELECTION = 'evidence_priority_with_recent_context';

export interface DiagnosticExportLogIndex extends DiagnosticLogExportMetadata {
  source: DiagnosticLogSource;
  association: DiagnosticLogRecord['association'];
  line: number;
  endLine: number;
}
export interface DiagnosticExportLogBundle {
  entries: Record<string, string>;
  coverage: Array<{
    source: DiagnosticLogSource;
    bytes: number;
    records: number;
    omitted: number;
    byteLimit: number;
    seenRecords?: number;
    omittedBytes?: number;
    recordLimit?: number;
    selection?: string;
    retainedAssociations?: Partial<Record<DiagnosticLogRecord['association'], number>>;
    seenAssociations?: Partial<Record<DiagnosticLogRecord['association'], number>>;
  }>;
  index?: DiagnosticExportLogIndex[];
}
interface RetainedRecord extends DiagnosticLogExportMetadata {
  association: DiagnosticLogRecord['association'];
  content: string;
  bytes: number;
  order: number;
  priority: number;
}
const priority = (
  association: DiagnosticLogRecord['association'],
  level: DiagnosticLogRecord['level'],
) => {
  const issue = level === 'warn' || level === 'error';
  return association === 'run'
    ? issue
      ? 5
      : 4
    : association === 'session'
      ? issue
        ? 3
        : 1
      : issue
        ? 2
        : 0;
};
/** Lowest-value, oldest evidence is evicted first; unknown times stay unknown. */
const compareRetention = (left: RetainedRecord, right: RetainedRecord) =>
  left.priority - right.priority ||
  Number(left.timestamp !== undefined) - Number(right.timestamp !== undefined) ||
  (left.timestamp !== undefined && right.timestamp !== undefined
    ? left.timestamp - right.timestamp
    : 0) ||
  left.order - right.order;

/** A bounded min-heap avoids sorting retained text for every scanned record. */
function push(records: RetainedRecord[], record: RetainedRecord): void {
  records.push(record);
  let index = records.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compareRetention(records[parent], records[index]) <= 0) break;
    [records[parent], records[index]] = [records[index], records[parent]];
    index = parent;
  }
}
function shift(records: RetainedRecord[]): RetainedRecord {
  const first = records[0];
  const last = records.pop()!;
  if (records.length) {
    records[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < records.length && compareRetention(records[left], records[smallest]) < 0)
        smallest = left;
      if (right < records.length && compareRetention(records[right], records[smallest]) < 0)
        smallest = right;
      if (smallest === index) break;
      [records[index], records[smallest]] = [records[smallest], records[index]];
      index = smallest;
    }
  }
  return first;
}

export class DiagnosticExportLogs {
  private readonly sources = new Map(
    SOURCES.map(source => [
      source,
      {
        records: [] as RetainedRecord[],
        bytes: 0,
        seen: 0,
        omittedBytes: 0,
        seenAssociations: {} as Partial<Record<DiagnosticLogRecord['association'], number>>,
      },
    ]),
  );

  append(
    source: DiagnosticLogSource,
    text: string,
    association: DiagnosticLogRecord['association'],
    metadata?: DiagnosticLogExportMetadata,
  ): void {
    const target = this.sources.get(source)!;
    const order = ++target.seen;
    target.seenAssociations[association] = (target.seenAssociations[association] ?? 0) + 1;
    const id =
      metadata?.id.startsWith(`log-${source}-`) && /^log-\w+-\d+$/.test(metadata.id)
        ? metadata.id
        : `log-${source}-${order}`;
    const level = metadata?.level ?? 'unknown';
    const timestamp =
      typeof metadata?.timestamp === 'number' && Number.isFinite(metadata.timestamp)
        ? metadata.timestamp
        : undefined;
    // Mask complete records before retention so clipping cannot introduce a partial credential.
    const content = `[record=${id} association=${association}]\n${redactDiagnosticLog(text)}\n\n`;
    const bytes = Buffer.byteLength(content);
    if (bytes > SOURCE_LIMIT) {
      target.omittedBytes += bytes;
      return;
    }
    push(target.records, {
      id,
      timestamp,
      level,
      association,
      content,
      bytes,
      order,
      priority: priority(association, level),
    });
    target.bytes += bytes;
    while (target.bytes > SOURCE_LIMIT || target.records.length > SOURCE_RECORD_LIMIT) {
      const omitted = shift(target.records);
      target.bytes -= omitted.bytes;
      target.omittedBytes += omitted.bytes;
    }
  }

  finish(): DiagnosticExportLogBundle {
    const entries: Record<string, string> = {};
    const index: DiagnosticExportLogIndex[] = [];
    const coverage: DiagnosticExportLogBundle['coverage'] = [];
    for (const [source, value] of this.sources) {
      const records = [...value.records].sort(
        (left, right) =>
          Number(left.timestamp === undefined) - Number(right.timestamp === undefined) ||
          (left.timestamp !== undefined && right.timestamp !== undefined
            ? left.timestamp - right.timestamp
            : 0) ||
          left.order - right.order,
      );
      let line = 1;
      const associations: NonNullable<
        DiagnosticExportLogBundle['coverage'][number]['retainedAssociations']
      > = {};
      for (const record of records) {
        const lines = record.content.split('\n').length - 1;
        index.push({
          id: record.id,
          source,
          association: record.association,
          level: record.level,
          timestamp: record.timestamp,
          line,
          endLine: line + lines - 2,
        });
        line += lines;
        associations[record.association] = (associations[record.association] ?? 0) + 1;
      }
      entries[`logs/${source}.log`] = records.map(record => record.content).join('');
      coverage.push({
        source,
        bytes: value.bytes,
        records: records.length,
        omitted: value.seen - records.length,
        byteLimit: SOURCE_LIMIT,
        seenRecords: value.seen,
        omittedBytes: value.omittedBytes,
        recordLimit: SOURCE_RECORD_LIMIT,
        selection: SELECTION,
        retainedAssociations: associations,
        seenAssociations: { ...value.seenAssociations },
      });
    }
    return { entries, index, coverage };
  }
}
