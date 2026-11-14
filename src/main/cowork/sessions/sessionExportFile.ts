import { randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';

import {
  createSessionExportDocument,
  type CreateSessionExportOptions,
  projectSessionExportMessage,
  toOpenAiExportMessages,
  toRawExportMessages,
} from '../../../shared/cowork/sessionExport';

type Range = { offset: number; bytes: number };
type Page = { messages?: Range; raw?: Range };
type ExportHistoryInfo = { runtimeSessionId: string | null; model?: string };

const indented = (value: unknown, spaces: number) => {
  const prefix = ' '.repeat(spaces);
  return prefix + JSON.stringify(value, null, 2).replaceAll('\n', `\n${prefix}`);
};

const fields = (value: Record<string, unknown>, indent: number) =>
  Object.entries(value)
    .map(([key, item]) => `${' '.repeat(indent)}${JSON.stringify(key)}: ${indented(item, indent).trimStart()}`)
    .join(',\n');

async function* exportArrayEntries(
  spool: FileHandle,
  pages: Page[],
  key: keyof Page,
  indent: number,
) {
  let separator = '\n';
  for (let index = pages.length - 1; index >= 0; index--) {
    const range = pages[index][key];
    if (!range) continue;
    yield separator;
    separator = ',\n';
    for (let read = 0; read < range.bytes;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, range.bytes - read));
      const { bytesRead } = await spool.read(chunk, 0, chunk.length, range.offset + read);
      if (!bytesRead) throw new Error('Session export page could not be read');
      read += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  }
  if (separator === ',\n') yield `\n${' '.repeat(indent)}`;
}

async function* exportJson(
  spool: FileHandle,
  pages: Page[],
  options: Omit<CreateSessionExportOptions, 'messages'>,
) {
  const { metadata, extensions, messages: _messages, ...header } = createSessionExportDocument({
    ...options,
    messages: [],
  });
  yield `{\n${fields(header, 2)},\n  "messages": [`;
  yield* exportArrayEntries(spool, pages, 'messages', 2);
  yield `],\n  "metadata": ${indented(metadata, 2).trimStart()},\n`;
  if (extensions) {
    const { messages: _rawMessages, ...identities } = extensions.justdo;
    yield `  "extensions": {\n    "justdo": {\n${fields(identities, 6)},\n      "messages": [`;
    yield* exportArrayEntries(spool, pages, 'raw', 6);
    yield ']\n    }\n  },\n';
  }
  yield `  "scope": "main",\n  "exportedAt": ${JSON.stringify(header.exported_at)}\n}\n`;
}

/** Page bodies are kept in private staging for this operation only. */
export async function writeSessionExportFile(options: {
  destination: string;
  document: Omit<CreateSessionExportOptions, 'messages' | 'runtimeSessionId'>;
  readHistory: (onPage: (messages: readonly unknown[]) => Promise<void>) => Promise<ExportHistoryInfo>;
  assertCurrent: () => void;
  signal: AbortSignal;
}): Promise<void> {
  const { destination, document, readHistory, assertCurrent, signal } = options;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-export-'));
  const temporary = path.join(path.dirname(destination), `.session-export-${randomUUID()}.tmp`);
  let spool: FileHandle | undefined;
  let ownsTemporary = false;
  try {
    spool = await fs.open(path.join(directory, 'pages'), 'wx+', 0o600);
    const file = spool;
    const pages: Page[] = [];
    let offset = 0;
    const stage = async (rows: readonly unknown[], indent: number) => {
      if (!rows.length) return;
      const text = rows.map(row => indented(row, indent)).join(',\n');
      const range = { offset, bytes: Buffer.byteLength(text) };
      await file.writeFile(text);
      offset += range.bytes;
      return range;
    };
    const { runtimeSessionId, model } = await readHistory(async messages => {
      signal.throwIfAborted();
      const projected = messages.map(projectSessionExportMessage);
      pages.push({
        messages: await stage(toOpenAiExportMessages(projected), 4),
        raw: document.includeRawData ? await stage(toRawExportMessages(projected), 8) : undefined,
      });
    });
    assertCurrent();
    const outputFile = await fs.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    const output = outputFile.createWriteStream();
    try {
      await pipeline(exportJson(file, pages, {
        ...document,
        model: model ?? document.model,
        runtimeSessionId,
      }), output, { signal });
    } finally {
      output.destroy();
      await finished(output).catch(() => {});
    }
    assertCurrent();
    await fs.rename(temporary, destination);
    ownsTemporary = false;
  } finally {
    await spool?.close().catch(() => {});
    if (ownsTemporary) await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
