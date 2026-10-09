import { redactLogText as redactDiagnosticLog } from '../../core/logRedaction';

export { redactDiagnosticLog };

import type {
  DiagnosticLogRecord,
  DiagnosticLogSource,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';

const SOURCE_LIMIT = 2 * 1024 * 1024;
const SOURCES: DiagnosticLogSource[] = ['main', 'cowork', 'gateway', 'native'];

export class DiagnosticExportLogs {
  private readonly sources = new Map(
    SOURCES.map(source => [
      source,
      {
        chunks: [] as string[],
        bytes: 0,
        records: 0,
        omitted: 0,
      },
    ]),
  );

  append(
    source: DiagnosticLogSource,
    text: string,
    association: DiagnosticLogRecord['association'],
  ): void {
    const target = this.sources.get(source)!;
    const content = `[association=${association}]\n${redactDiagnosticLog(text)}\n\n`;
    const bytes = Buffer.byteLength(content);
    if (target.bytes + bytes > SOURCE_LIMIT) {
      target.omitted++;
      return;
    }
    target.chunks.push(content);
    target.bytes += bytes;
    target.records++;
  }

  finish() {
    return {
      entries: Object.fromEntries(
        [...this.sources].map(([source, value]) => [`logs/${source}.log`, value.chunks.join('')]),
      ),
      coverage: [...this.sources].map(([source, value]) => ({
        source,
        bytes: value.bytes,
        records: value.records,
        omitted: value.omitted,
        byteLimit: SOURCE_LIMIT,
      })),
    };
  }
}
export type DiagnosticExportLogBundle = ReturnType<DiagnosticExportLogs['finish']>;
