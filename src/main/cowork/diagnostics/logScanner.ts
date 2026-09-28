import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 256 * 1024;
const RECORD_BYTES = 64 * 1024;

/** A stalled operation is bounded; total scan size and duration are not tail limits. */
async function operation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('canceled'));
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('read_timeout')), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export async function assertDiagnosticLogPath(file: string, signal?: AbortSignal): Promise<void> {
  if (!path.isAbsolute(file) || /^(?:\\\\|\/\/)/.test(file)) throw new Error('unsafe_file');
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (signal?.aborted) throw new Error('canceled');
    const stat = await operation(fs.lstat(current), signal);
    if (stat.isSymbolicLink()) throw new Error('unsafe_file');
    if (path.dirname(current) === current) break;
  }
}

/** Only a structured response from the already connected local runtime supplies this path. */
export async function discoverNativeDiagnosticLogs(
  file: unknown,
  signal?: AbortSignal,
): Promise<string[]> {
  if (typeof file !== 'string' || !file.endsWith('.log')) return [];
  await assertDiagnosticLogPath(file, signal);
  const name = path.basename(file);
  if (!/^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(name)) return [file];
  const entries = await operation(fs.readdir(path.dirname(file), { withFileTypes: true }), signal);
  return entries
    .filter(entry => entry.isFile() && /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name))
    .map(entry => path.join(path.dirname(file), entry.name))
    .sort();
}

/** Scan the complete size captured at open, with bounded buffers and record retention. */
export async function scanDiagnosticLog(
  file: string,
  native: boolean,
  callbacks: {
    record: (text: string) => void;
    oversized: () => void;
    progress: (bytes: number, total: number) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  await assertDiagnosticLogPath(file, signal);
  const before = await operation(fs.lstat(file), signal);
  if (!before.isFile()) throw new Error('unsafe_file');
  // A delayed open must still close its handle after timeout or cancellation.
  const opening = fs.open(file, 'r');
  let handle: Awaited<typeof opening>;
  try {
    handle = await operation(opening, signal);
  } catch (error) {
    void opening.then(opened => opened.close()).catch(() => {});
    throw error;
  }
  let completed = false;
  try {
    const stat = await operation(handle.stat(), signal);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
      throw new Error('unsafe_file');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let line = '';
    let lineOversized = false;
    let record = '';
    let recordOversized = false;
    const flush = () => {
      if (recordOversized) callbacks.oversized();
      else if (record) callbacks.record(record);
      record = '';
      recordOversized = false;
    };
    const acceptLine = () => {
      const start = native || /^\[\d{4}-\d\d-\d\d[ T]/.test(line) || line.startsWith('{');
      if (start) flush();
      if (lineOversized || Buffer.byteLength(record) + Buffer.byteLength(line) + 1 > RECORD_BYTES) {
        record = '';
        recordOversized = true;
      } else if (!recordOversized) record += `${record ? '\n' : ''}${line}`;
      line = '';
      lineOversized = false;
    };
    const consume = (text: string) => {
      let start = 0;
      for (let end = text.indexOf('\n'); ; end = text.indexOf('\n', start)) {
        const part = text.slice(start, end < 0 ? undefined : end);
        if (!lineOversized) {
          if (Buffer.byteLength(line) + Buffer.byteLength(part) > RECORD_BYTES) {
            // Retain only the prefix to identify the next record boundary.
            line = (line + part).slice(0, 128);
            lineOversized = true;
          } else line += part;
        }
        if (end < 0) break;
        acceptLine();
        start = end + 1;
      }
    };
    let position = 0;
    callbacks.progress(0, stat.size);
    while (position < stat.size) {
      if (signal?.aborted) throw new Error('canceled');
      const result = await operation(
        handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position),
        signal,
      );
      if (!result.bytesRead) throw new Error('source_changed');
      position += result.bytesRead;
      consume(decoder.write(buffer.subarray(0, result.bytesRead)));
      callbacks.progress(position, stat.size);
      // Let IPC, cancellation and other source work proceed even with cached local reads.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    consume(decoder.end());
    if (line || lineOversized) acceptLine();
    flush();
    const after = await operation(fs.lstat(file), signal);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size < stat.size ||
      (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)
    )
      throw new Error('source_changed');
    completed = true;
  } finally {
    const closing = handle.close();
    if (completed) await operation(closing);
    else void closing.catch(() => {});
  }
}
