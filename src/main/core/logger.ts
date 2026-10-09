/**
 * Logger module using electron-log
 * Intercepts console.* methods and writes to file + console simultaneously.
 *
 * Log file locations:
 *   macOS:   ~/Library/Logs/<productName>/main-YYYY-MM-DD.log
 *   Windows: %APPDATA%/<productName>/logs/main-YYYY-MM-DD.log
 *   Linux:   ~/.config/<productName>/logs/main-YYYY-MM-DD.log
 *   Fallback: <installation directory>/logs/main-YYYY-MM-DD.log
 *
 * Rotation policy:
 *   - Daily log files (one file per calendar day)
 *   - Max 80 MB per file; on overflow rotate to .old.log, best-effort
 *   - Files older than 7 days are pruned on startup
 */

import { app } from 'electron';
import log from 'electron-log/main';
import fs from 'fs';
import path from 'path';
import { formatWithOptions } from 'util';

import { PRODUCT_NAME } from '../../shared/productMetadata';
import { redactLogText } from './logRedaction';

const LOG_RETENTION_DAYS = 7;
const LOG_MAX_SIZE = 80 * 1024 * 1024; // 80 MB
const MAIN_LOG_FILE_PATTERN = /^main-\d{4}-\d{2}-\d{2}(?:\.old)?\.log(?:\.old)?$/;

const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};

/** The directory of the last successful real log append. */
let _logDir: string | undefined;
let preferredLogDirectory: string | undefined;
let fallbackLogDirectory: string | undefined;
let trackedLogPath: string | undefined;
let trackedLogBytes = 0;
let initialized = false;
let lastWriteFailure = '';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function logDir(): string {
  return _logDir ?? preferredLogDirectory ?? path.join(app.getPath('userData'), 'logs');
}

function formatTimestamp(date: Date): string {
  const padded = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())} ${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}.${padded(date.getMilliseconds(), 3)}`;
}

function describe(error: unknown): string {
  return redactLogText(
    formatWithOptions({ colors: false, depth: 5, maxStringLength: null }, error),
  );
}

function appendLogRecord(directory: string, line: string): void {
  const filePath = path.join(directory, `main-${todayStr()}.log`);
  // Rotation is best-effort: a failed rename must not prevent a real append.
  if (trackedLogPath === filePath && trackedLogBytes > LOG_MAX_SIZE) {
    try {
      fs.renameSync(filePath, filePath.replace(/\.log$/, '.old.log'));
      trackedLogBytes = 0;
    } catch (error) {
      originalConsole.warn('[Logger] Unable to rotate the log:', error);
      line = `[${formatTimestamp(new Date())}] [warn] [Logger] Unable to rotate ${filePath}: ${describe(error)}\n${line}`;
      // Avoid retrying the same failed rename for every later log record.
      trackedLogBytes = 0;
    }
  }
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Create only the directory needed by the real log, never a probe file.
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(filePath, line, 'utf8');
  }
  if (trackedLogPath === filePath) {
    trackedLogBytes += Buffer.byteLength(line);
  } else {
    trackedLogPath = filePath;
    try {
      trackedLogBytes = fs.statSync(filePath).size;
    } catch (error) {
      const warning = `[${formatTimestamp(new Date())}] [warn] [Logger] Unable to read log size: ${describe(error)}\n`;
      originalConsole.warn('[Logger] Unable to read log size:', error);
      fs.appendFileSync(filePath, warning, 'utf8');
      trackedLogBytes = Buffer.byteLength(line + warning);
    }
  }
}

function persistLogRecord(line: string): void {
  const candidates = [...new Set([_logDir, preferredLogDirectory, fallbackLogDirectory])].filter(
    (directory): directory is string => Boolean(directory),
  );
  const failures: string[] = [];
  for (const directory of candidates) {
    try {
      const recovery =
        failures.length > 0
          ? `[${formatTimestamp(new Date())}] [warn] [Logger] Log write failed; continuing in ${directory}:\n${failures.join('\n')}\n`
          : '';
      appendLogRecord(directory, recovery + line);
      if (failures.length > 0) {
        originalConsole.warn(
          `[Logger] Log write failed; continuing in ${directory}:\n${failures.join('\n')}`,
        );
      }
      _logDir = directory;
      lastWriteFailure = '';
      return;
    } catch (error) {
      failures.push(`${directory}: ${describe(error)}`);
    }
  }
  const failure = failures.join('\n');
  if (failure !== lastWriteFailure) {
    originalConsole.error(
      '[Logger] Unable to persist logs in the user or installation directory:',
      failure,
    );
    lastWriteFailure = failure;
  }
  // Direct electron-log calls also remain visible when neither path is writable.
  originalConsole.error(line.trimEnd());
}

/**
 * Initialize logging system.
 * Must be called early in main process, before any console output.
 */
export function initLogger(): void {
  if (initialized) return;
  initialized = true;
  try {
    preferredLogDirectory =
      process.platform === 'darwin'
        ? app.getPath('logs')
        : path.join(app.getPath('userData'), 'logs');
  } catch (error) {
    originalConsole.warn('[Logger] Unable to resolve the user log directory:', error);
  }
  try {
    fallbackLogDirectory = path.join(
      app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
      'logs',
    );
  } catch (error) {
    originalConsole.warn('[Logger] Unable to resolve the installation log directory:', error);
  }

  // electron-log caches a NullFile after an initial filesystem error and can
  // swallow later write errors. Use actual appends so startup failures survive
  // an invalid userData path and a directory becoming unwritable after startup.
  log.transports.file.level = false;
  log.transports.console.level = false;
  log.transports.persistentFile = Object.assign(
    (message: Parameters<typeof log.transports.file>[0]) => {
      const text = redactLogText(
        formatWithOptions(
          { colors: false, depth: 5, maxArrayLength: null, maxStringLength: null },
          ...message.data,
        ),
      );
      const scope = message.scope ? `[${message.scope}] ` : '';
      persistLogRecord(`[${formatTimestamp(message.date)}] [${message.level}] ${scope}${text}\n`);
    },
    { level: 'debug' as const, transforms: [] },
  );

  // Intercept console.* methods so all existing console.log/error/warn
  // across 25+ files are automatically captured without any code changes.
  // electron-log correctly serializes Error objects (with stack traces),
  // unlike JSON.stringify which outputs '{}' for Error instances.
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    log.info(...args);
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    log.error(...args);
  };
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    log.warn(...args);
  };
  console.info = (...args: unknown[]) => {
    originalConsole.info(...args);
    log.info(...args);
  };
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    log.debug(...args);
  };

  // Log startup marker
  log.info('='.repeat(60));
  log.info(`${PRODUCT_NAME} started (${process.platform} ${process.arch})`);
  log.info('='.repeat(60));
  // Start writing before cleanup; even directory enumeration can fail.
  try {
    pruneOldLogs();
  } catch (error) {
    console.warn('[Logger] Unable to prune old logs; continuing startup:', error);
  }
}

/** Delete daily main-*.log files whose mtime exceeds the retention window. */
function pruneOldLogs(): void {
  const dir = logDir();
  if (!fs.existsSync(dir)) return;

  const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const file of fs.readdirSync(dir)) {
    if (!MAIN_LOG_FILE_PATTERN.test(file)) continue;
    const filePath = path.join(dir, file);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn('[Logger] Unable to prune an old log:', filePath, error);
    }
  }
}

/**
 * Get today's log file path (for display / open-in-folder).
 */
export function getLogFilePath(): string {
  return path.join(logDir(), `main-${todayStr()}.log`);
}

/**
 * Return archive entries for all daily main log files within the last 7 days.
 * Suitable for passing directly to exportLogsZip.
 */
export function getRecentMainLogEntries(
  includeAllRetained = false,
): Array<{ archiveName: string; filePath: string }> {
  const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const directories = [...new Set([preferredLogDirectory, fallbackLogDirectory, _logDir])].filter(
    (directory): directory is string => Boolean(directory),
  );
  const entries: Array<{ archiveName: string; filePath: string }> = [];
  for (const directory of directories) {
    try {
      for (const file of fs.readdirSync(directory)) {
        if (!MAIN_LOG_FILE_PATTERN.test(file)) continue;
        const filePath = path.join(directory, file);
        try {
          if (!includeAllRetained && fs.statSync(filePath).mtimeMs < cutoffMs) continue;
          const fallback =
            directory === fallbackLogDirectory && directory !== preferredLogDirectory;
          // Keep the existing main-YYYY-MM-DD prefix used to prioritize
          // diagnostic reads, while avoiding duplicate ZIP entry names.
          entries.push({
            archiveName: fallback ? file.replace(/\.log$/, '.fallback.log') : file,
            filePath,
          });
        } catch (error) {
          console.warn('[Logger] Unable to include a log in the export:', filePath, error);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Logger] Unable to enumerate logs for export:', directory, error);
      }
    }
  }
  return entries.sort((a, b) => a.archiveName.localeCompare(b.archiveName));
}

/**
 * Log instance for direct usage if needed
 */
export { log };
