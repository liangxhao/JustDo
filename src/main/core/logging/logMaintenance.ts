import fs from 'node:fs';
import path from 'node:path';

export const LogKind = {
  Main: 'main',
  Cowork: 'cowork',
  Gateway: 'gateway',
} as const;
export type LogKind = (typeof LogKind)[keyof typeof LogKind];

export const LOG_MAINTENANCE_POLICY = {
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  intervalMs: 5 * 60 * 1000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: {
    [LogKind.Main]: 80 * 1024 * 1024,
    [LogKind.Cowork]: 5 * 1024 * 1024,
    [LogKind.Gateway]: 20 * 1024 * 1024,
  },
};

const rawWarning = console.warn.bind(console);
const MAIN_LOG_PATTERN = /^main-\d{4}-\d{2}-\d{2}(?:\.old)?\.log(?:\.old)?$/;
const TRUNCATION_MARKER = '\n[LogMaintenance] Oversized log record truncated.\n';

export function isManagedLogFile(kind: LogKind, name: string): boolean {
  if (kind === LogKind.Main) return MAIN_LOG_PATTERN.test(name);
  return name === `${kind}.log` || name === `${kind}.log.old`;
}

export function getCurrentLogFileName(kind: LogKind, now = Date.now()): string {
  return kind === LogKind.Main
    ? `main-${new Date(now).toISOString().slice(0, 10)}.log`
    : `${kind}.log`;
}

function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

/** Never follow a managed directory, junction or ancestor redirected elsewhere. */
function assertLogDirectory(directory: string): void {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe log directory: ${current}`);
    if (!stat.isDirectory())
      throw Object.assign(new Error(`Not a log directory: ${current}`), {
        code: 'ENOTDIR',
        path: current,
      });
    if (path.dirname(current) === current) break;
  }
}

function ensureLogDirectory(directory: string): void {
  // Check existing ancestors before mkdir, which would otherwise follow junctions.
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe log directory: ${current}`);
      if (!stat.isDirectory())
        throw Object.assign(new Error(`Not a log directory: ${current}`), {
          code: 'ENOTDIR',
          path: current,
        });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (path.dirname(current) === current) break;
  }
  fs.mkdirSync(directory, { recursive: true });
  assertLogDirectory(directory);
}

/** Existing regular files only; an absent backup must not create a diagnostic gap. */
export function getRetainedLogPaths(directory: string, kind: LogKind): string[] {
  try {
    assertLogDirectory(directory);
    return fs
      .readdirSync(directory)
      .filter(name => isManagedLogFile(kind, name))
      .map(name => path.join(directory, name))
      .filter(file => {
        try {
          return fs.lstatSync(file).isFile();
        } catch (error) {
          if (isMissing(error)) return false;
          throw error;
        }
      })
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function boundedRecord(text: string, maximum: number): Buffer {
  const data = Buffer.from(text);
  if (data.length <= maximum) return data;
  const marker = Buffer.from(TRUNCATION_MARKER);
  // Policy limits are always larger than the marker, including injected test limits.
  if (maximum <= marker.length) return marker.subarray(0, maximum);
  let end = maximum - marker.length;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
  return Buffer.concat([data.subarray(0, end), marker]);
}

type LogFile = {
  file: string;
  kind: LogKind;
  size: number;
  mtimeMs: number;
  active: boolean;
  dev: number;
  ino: number;
};
type MaintenanceOptions = Partial<Omit<typeof LOG_MAINTENANCE_POLICY, 'maxFileBytes'>> & {
  maxFileBytes?: Partial<Record<LogKind, number>>;
  onWarning?: (message: string, error: unknown) => void;
};

/** One synchronous owner for appends, rotation and pruning, including Gateway output. */
export class LogMaintenance {
  private readonly policy;
  private readonly directories = new Map<string, Set<LogKind>>();
  private readonly knownFiles = new Map<string, LogFile[]>();
  private readonly unavailableDirectories = new Set<string>();
  private readonly failures = new Map<string, { until: number; error: unknown; records: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private enabled = false;
  private cleaning = false;
  private dirty = true;
  private complete = true;
  private totalBytes = 0;
  private readonly onWarning: (message: string, error: unknown) => void;

  constructor(options: MaintenanceOptions = {}) {
    this.policy = {
      ...LOG_MAINTENANCE_POLICY,
      ...options,
      maxFileBytes: { ...LOG_MAINTENANCE_POLICY.maxFileBytes, ...options.maxFileBytes },
    };
    this.onWarning =
      options.onWarning ?? ((message, error) => rawWarning(`[LogMaintenance] ${message}`, error));
  }

  registerDirectory(directory: string, kind: LogKind): void {
    const resolved = path.resolve(directory);
    const kinds = this.directories.get(resolved) ?? new Set<LogKind>();
    if (kinds.has(kind)) return;
    kinds.add(kind);
    this.directories.set(resolved, kinds);
    this.dirty = true;
  }

  /** Start only after the real startup records have been written, with no probe file. */
  start(): void {
    if (this.timer) return;
    this.enabled = true;
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), this.policy.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  append(kind: LogKind, file: string, text: string): void {
    if (path.basename(file) !== getCurrentLogFileName(kind))
      throw new Error(`Unexpected current log name: ${file}`);
    const directory = path.dirname(file);
    this.registerDirectory(directory, kind);
    const previousFailure = this.failures.get(file);
    const recovery = previousFailure
      ? `[LogMaintenance] ${previousFailure.records} records could not be written to this file.\n`
      : '';
    const data = boundedRecord(recovery + text, this.policy.maxFileBytes[kind]);
    let appendAttempted = false;
    try {
      if (previousFailure && Date.now() < previousFailure.until && fs.existsSync(file)) {
        throw previousFailure.error;
      }
      if (
        this.enabled &&
        (this.dirty || !this.complete || this.totalBytes + data.length > this.policy.maxTotalBytes)
      ) {
        this.cleanup(data.length);
      }
      if (
        this.enabled &&
        (!this.complete || this.totalBytes + data.length > this.policy.maxTotalBytes)
      ) {
        throw new Error('Managed log capacity unavailable; refusing to grow retained logs.');
      }
      ensureLogDirectory(directory);
      let size = 0;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) throw new Error(`Unsafe log file: ${file}`);
        size = stat.size;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (size > 0 && size + data.length > this.policy.maxFileBytes[kind]) {
        this.rotate(kind, file);
        // Reconcile replaced backups before reserving capacity for the new file.
        if (this.enabled) this.cleanup(data.length);
        if (
          this.enabled &&
          (!this.complete || this.totalBytes + data.length > this.policy.maxTotalBytes)
        ) {
          throw new Error('Managed log capacity unavailable after rotation.');
        }
      }
      appendAttempted = true;
      fs.appendFileSync(file, data);
      // Conservative between inventories: overwritten/deleted bytes are reclaimed by cleanup.
      this.totalBytes += data.length;
      this.failures.delete(file);
    } catch (error) {
      // ENOSPC can follow a partial write; the next destination must recount those bytes.
      if (appendAttempted) this.dirty = true;
      this.failures.set(file, {
        until:
          previousFailure?.until && previousFailure.until > Date.now()
            ? previousFailure.until
            : Date.now() + this.policy.intervalMs,
        error,
        records: (previousFailure?.records ?? 0) + 1,
      });
      throw error;
    }
  }

  private rotate(kind: LogKind, file: string, expected?: Pick<LogFile, 'dev' | 'ino'>): void {
    assertLogDirectory(path.dirname(file));
    const current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      (expected && (current.dev !== expected.dev || current.ino !== expected.ino))
    ) {
      throw new Error(`Log source changed before rotation: ${file}`);
    }
    const backup = kind === LogKind.Main ? file.replace(/\.log$/, '.old.log') : `${file}.old`;
    try {
      if (!fs.lstatSync(backup).isFile()) throw new Error(`Unsafe log backup: ${backup}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    fs.renameSync(file, backup);
    this.dirty = true;
  }

  private inventory(): LogFile[] {
    this.complete = true;
    this.unavailableDirectories.clear();
    for (const [directory, kinds] of this.directories) {
      try {
        assertLogDirectory(directory);
        const files: LogFile[] = [];
        for (const name of fs.readdirSync(directory)) {
          const kind = [...kinds].find(candidate => isManagedLogFile(candidate, name));
          if (!kind) continue;
          const file = path.join(directory, name);
          let stat: fs.Stats;
          try {
            stat = fs.lstatSync(file);
          } catch (error) {
            if (isMissing(error)) continue;
            throw error;
          }
          if (!stat.isFile()) continue;
          files.push({
            file,
            kind,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            active: name === getCurrentLogFileName(kind),
            dev: stat.dev,
            ino: stat.ino,
          });
        }
        assertLogDirectory(directory);
        this.knownFiles.set(directory, files);
      } catch (error) {
        if (isMissing(error)) this.knownFiles.delete(directory);
        else {
          // Keep the last known bytes; an unreadable directory is never an empty one.
          this.complete = false;
          this.unavailableDirectories.add(directory);
          this.warn(`Unable to enumerate ${directory}:`, error);
        }
      }
    }
    return [...this.knownFiles.values()].flat();
  }

  /** Only exact, regular app-owned log files participate in retention and the shared budget. */
  cleanup(reservedBytes = 0): void {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      let files = this.inventory();
      let rotated = false;
      for (const entry of files) {
        if (!entry.active || entry.size <= this.policy.maxFileBytes[entry.kind]) continue;
        if (this.unavailableDirectories.has(path.dirname(entry.file))) continue;
        const failure = this.failures.get(entry.file);
        if (failure && failure.until > Date.now()) continue;
        try {
          this.rotate(entry.kind, entry.file, entry);
          rotated = true;
        } catch (error) {
          this.warn(`Unable to rotate ${entry.file}:`, error);
        }
      }
      if (rotated) files = this.inventory();
      let total = files.reduce((bytes, entry) => bytes + entry.size, 0);
      const cutoff = Date.now() - this.policy.retentionMs;
      for (const entry of files.sort(
        (a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file),
      )) {
        if (this.unavailableDirectories.has(path.dirname(entry.file))) continue;
        if (entry.active && entry.mtimeMs >= cutoff) continue;
        if (
          entry.mtimeMs >= cutoff &&
          entry.size <= this.policy.maxFileBytes[entry.kind] &&
          total + reservedBytes <= this.policy.maxTotalBytes
        )
          continue;
        try {
          // Recheck before deleting; do not follow a replaced symlink or touch another file.
          assertLogDirectory(path.dirname(entry.file));
          const current = fs.lstatSync(entry.file);
          if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino) {
            this.complete = false;
            continue;
          }
          fs.unlinkSync(entry.file);
          total -= entry.size;
        } catch (error) {
          if (isMissing(error)) total -= entry.size;
          else this.warn(`Unable to remove ${entry.file}:`, error);
        }
      }
      this.totalBytes = total;
      this.dirty = false;
      for (const [file, failure] of this.failures) {
        if (failure.until + this.policy.retentionMs < Date.now()) this.failures.delete(file);
      }
    } finally {
      this.cleaning = false;
    }
  }

  private warn(message: string, error: unknown): void {
    // This callback must bypass the captured console, so maintenance cannot log recursively.
    try {
      this.onWarning(message, error);
    } catch {
      /* Maintenance must never break startup. */
    }
  }
}

export const managedLogs = new LogMaintenance();
