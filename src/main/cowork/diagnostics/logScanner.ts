import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 256 * 1024;
const RECORD_BYTES = 64 * 1024;
const NATIVE_DAILY_LOG = /^(openclaw(?:-[a-z0-9-]+)?)-\d{4}-\d{2}-\d{2}\.log$/u;
const NATIVE_LOG_ROTATION = /\.([1-5])(?=\.log$)/u;
interface DiagnosticLogFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

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

function assertLocalAbsolutePath(file: string): void {
  if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw new Error('unsafe_file');
}

export async function assertDiagnosticLogPath(file: string, signal?: AbortSignal): Promise<void> {
  assertLocalAbsolutePath(file);
  const paths: string[] = [];
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    paths.push(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of paths.reverse()) {
    if (signal?.aborted) throw new Error('canceled');
    const stat = await operation(fs.lstat(current), signal);
    if (stat.isSymbolicLink()) throw new Error('unsafe_file');
  }
}

export async function verifyDiagnosticLogFile(
  file: string,
  captured: DiagnosticLogFileIdentity,
  signal?: AbortSignal,
): Promise<void> {
  const current = await operation(fs.lstat(file), signal).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('source_changed');
    throw error;
  });
  if (
    !current.isFile() ||
    current.dev !== captured.dev ||
    current.ino !== captured.ino ||
    current.size < captured.size ||
    (current.size === captured.size && current.mtimeMs !== captured.mtimeMs)
  )
    throw new Error('source_changed');
}

/** Only a structured response from the already connected local runtime supplies this path. */
export async function discoverNativeDiagnosticLogs(
  file: unknown,
  signal?: AbortSignal,
): Promise<string[]> {
  if (typeof file !== 'string' || !file.endsWith('.log')) return [];
  assertLocalAbsolutePath(file);
  const directory = path.dirname(file);
  await assertDiagnosticLogPath(directory, signal);
  const resolvedDirectory = path.resolve(directory);
  const name = path.basename(file);
  const anchorPath = path.join(resolvedDirectory, name);
  const anchor = await operation(fs.lstat(anchorPath), signal).catch((error): undefined => {
    // A rotation can leave the authenticated active path briefly absent.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (anchor && !anchor.isFile()) throw new Error('unsafe_file');

  const family = NATIVE_DAILY_LOG.exec(name)?.[1];
  const entries = await operation(fs.readdir(resolvedDirectory, { withFileTypes: true }), signal);
  const matching = entries
    .filter(entry => {
      if (!entry.isFile()) return false;
      const activeName = entry.name.replace(NATIVE_LOG_ROTATION, '');
      return (
        entry.name === name ||
        activeName === name ||
        (family !== undefined && NATIVE_DAILY_LOG.exec(activeName)?.[1] === family)
      );
    })
    .map(entry => path.join(resolvedDirectory, entry.name));
  // The explicit path can still be valid when directory-entry casing differs.
  if (anchor && !matching.includes(anchorPath)) matching.push(anchorPath);
  // Scan older backups before the active file. A rotation moves them away
  // from paths that remain in the scan, rather than into those paths.
  return matching.sort((left, right) => {
    const leftName = path.basename(left);
    const rightName = path.basename(right);
    return (
      leftName
        .replace(NATIVE_LOG_ROTATION, '')
        .localeCompare(rightName.replace(NATIVE_LOG_ROTATION, '')) ||
      Number(NATIVE_LOG_ROTATION.exec(rightName)?.[1] ?? 0) -
        Number(NATIVE_LOG_ROTATION.exec(leftName)?.[1] ?? 0)
    );
  });
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
): Promise<DiagnosticLogFileIdentity> {
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
      const separator = record ? '\n' : '';
      if (
        lineOversized ||
        Buffer.byteLength(record) + Buffer.byteLength(line) + separator.length > RECORD_BYTES
      ) {
        record = '';
        recordOversized = true;
      } else if (!recordOversized) record += `${separator}${line}`;
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
    await verifyDiagnosticLogFile(file, stat, signal);
    completed = true;
    return stat;
  } finally {
    const closing = handle.close();
    if (completed) await operation(closing);
    else void closing.catch(() => {});
  }
}
