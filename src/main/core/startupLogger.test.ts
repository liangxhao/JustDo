import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { PRODUCT_NAME } from '../../shared/productMetadata';

const appState = vi.hoisted(() => ({
  userData: '',
  installation: '',
  packaged: false,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.packaged;
    },
    getPath: (name: string) =>
      name === 'logs' ? path.join(appState.userData, 'logs') : appState.userData,
    getAppPath: () => appState.installation,
  },
}));

vi.mock('electron-log/main', async () => {
  // Exercise the real electron-log routing while keeping Electron and all
  // filesystem paths isolated from the user's application data.
  const { createRequire } = await import('module');
  const nodeLog = createRequire(import.meta.url)('electron-log/node');
  return { default: nodeLog.create({ logId: 'startup-logger-behavior-test' }) };
});

const consoleMethods = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};
const actualExecPath = process.execPath;
let root: string;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-startup-logs-'));
  appState.userData = path.join(root, '用户 数据');
  appState.installation = path.join(root, '安装 目录');
  appState.packaged = false;
  for (const method of Object.keys(consoleMethods) as Array<keyof typeof consoleMethods>) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(console, consoleMethods);
  process.execPath = actualExecPath;
  fs.rmSync(root, { recursive: true, force: true });
});

test('writes real daily logs to user data with the complete startup error and dynamic product name', async () => {
  const logger = await import('./logger');
  logger.initLogger();
  const error = Object.assign(new Error('Cannot create the application database'), {
    code: 'EACCES',
    syscall: 'open',
    path: path.join(appState.userData, 'justdo.sqlite'),
    cause: new Error('Underlying filesystem write failed'),
  });
  console.error('[AppInitialization] Startup failed:', error);

  const file = logger.getLogFilePath();
  const content = fs.readFileSync(file, 'utf8');
  expect(path.dirname(file)).toBe(path.join(appState.userData, 'logs'));
  expect(content).toContain(`${PRODUCT_NAME} started`);
  expect(content).toContain(error.stack);
  for (const frame of error.cause.stack?.split('\n') ?? []) {
    expect(content).toContain(frame.trim());
  }
  expect(content).toContain('EACCES');
  expect(content).toContain('justdo.sqlite');
  expect(fs.existsSync(path.join(appState.installation, 'logs'))).toBe(false);
});

test('records the real user directory failure and full error in installation logs without blocking startup', async () => {
  fs.writeFileSync(appState.userData, 'preserve this file');
  const logger = await import('./logger');
  expect(() => logger.initLogger()).not.toThrow();
  const error = new Error('Failed to initialize user data');
  console.error('[AppInitialization] Startup failed:', error);

  const file = logger.getLogFilePath();
  const content = fs.readFileSync(file, 'utf8');
  expect(path.dirname(file)).toBe(path.join(appState.installation, 'logs'));
  expect(content).toMatch(/ENOTDIR|EEXIST/);
  expect(content).toContain(appState.userData);
  expect(content).toContain(error.stack);
  expect(fs.readFileSync(appState.userData, 'utf8')).toBe('preserve this file');
  expect(logger.getRecentMainLogEntries()).toContainEqual({
    archiveName: path.basename(file).replace(/\.log$/, '.fallback.log'),
    filePath: file,
  });
});

test('uses the executable installation directory for packaged fallback logs', async () => {
  fs.writeFileSync(appState.userData, 'occupied');
  appState.packaged = true;
  process.execPath = path.join(appState.installation, `${PRODUCT_NAME}.exe`);
  const logger = await import('./logger');
  logger.initLogger();

  expect(path.dirname(logger.getLogFilePath())).toBe(path.join(appState.installation, 'logs'));
  expect(fs.readFileSync(logger.getLogFilePath(), 'utf8')).toContain(`${PRODUCT_NAME} started`);
});

test('persists the failing record after the original log directory becomes unavailable', async () => {
  const logger = await import('./logger');
  logger.initLogger();
  const firstFile = logger.getLogFilePath();
  fs.renameSync(path.dirname(firstFile), path.join(appState.userData, 'previous-logs'));
  fs.writeFileSync(path.dirname(firstFile), 'now occupied');
  const error = new Error('Gateway launch failed after startup');
  console.error('[OpenClaw] Failed to start:', error);

  const content = fs.readFileSync(logger.getLogFilePath(), 'utf8');
  expect(path.dirname(logger.getLogFilePath())).toBe(path.join(appState.installation, 'logs'));
  expect(content).toContain(error.stack);
  expect(content).toMatch(/ENOTDIR|EEXIST/);
});

test('keeps console output when both log directories fail and recovers once a real append succeeds', async () => {
  fs.writeFileSync(appState.userData, 'occupied');
  fs.writeFileSync(appState.installation, 'occupied');
  const output = vi.mocked(console.error);
  const logger = await import('./logger');
  expect(() => logger.initLogger()).not.toThrow();
  const error = new Error('No writable user or installation log directory');
  expect(() => console.error('[AppInitialization] Startup failed:', error)).not.toThrow();
  expect(output.mock.calls.some(call => call.includes(error))).toBe(true);
  expect(output.mock.calls.some(call => String(call[0]).includes('Unable to persist logs'))).toBe(
    true,
  );

  fs.unlinkSync(appState.userData);
  logger.log.error('[AppInitialization] Retrying the real operation:', error);
  expect(fs.readFileSync(logger.getLogFilePath(), 'utf8')).toContain(error.stack);
  expect(path.dirname(logger.getLogFilePath())).toBe(path.join(appState.userData, 'logs'));
});

test('a retention directory read failure is logged and never interrupts initialization', async () => {
  const actualReadDirectory = fs.readdirSync.bind(fs);
  vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === path.join(appState.userData, 'logs')) {
      throw Object.assign(new Error('Permission denied enumerating logs'), { code: 'EACCES' });
    }
    return actualReadDirectory(...args);
  });
  const logger = await import('./logger');
  expect(() => logger.initLogger()).not.toThrow();

  expect(fs.readFileSync(logger.getLogFilePath(), 'utf8')).toContain(
    'Permission denied enumerating logs',
  );
  expect(() => logger.getRecentMainLogEntries()).not.toThrow();
});

test('exports both successful primary and fallback records after a real primary write failure', async () => {
  const logger = await import('./logger');
  logger.initLogger();
  const primaryFile = logger.getLogFilePath();
  const actualAppend = fs.appendFileSync.bind(fs);
  vi.spyOn(fs, 'appendFileSync').mockImplementation(
    (...args: Parameters<typeof fs.appendFileSync>) => {
      if (String(args[0]) === primaryFile) {
        throw Object.assign(new Error('Disk became full'), { code: 'ENOSPC' });
      }
      return actualAppend(...args);
    },
  );
  console.error('[AppInitialization] Disk write failed:', new Error('Real operation failed'));
  const fallbackFile = logger.getLogFilePath();
  const entries = logger.getRecentMainLogEntries();

  expect(entries.map(entry => entry.filePath)).toEqual(
    expect.arrayContaining([primaryFile, fallbackFile]),
  );
  expect(new Set(entries.map(entry => entry.archiveName)).size).toBe(entries.length);
  expect(fs.readFileSync(fallbackFile, 'utf8')).toContain('ENOSPC');
});

test('masks credentials in persisted failures while retaining their diagnostic stack frames', async () => {
  const logger = await import('./logger');
  logger.initLogger();
  const error = new Error('Gateway refused authorization: Bearer credential-value');
  console.error('[AppInitialization] Startup failed:', error);
  const content = fs.readFileSync(logger.getLogFilePath(), 'utf8');

  expect(content).toContain('[REDACTED]');
  expect(content).not.toContain('credential-value');
  expect(content).toContain('startupLogger.test.ts');
});

test('records a log rotation failure and continues appending without repeated rename attempts', async () => {
  const actualStat = fs.statSync.bind(fs);
  vi.spyOn(fs, 'statSync').mockImplementation((...args: Parameters<typeof fs.statSync>) => {
    const stat = actualStat(...args);
    if (String(args[0]).endsWith('.log')) {
      return Object.assign(stat, { size: 81 * 1024 * 1024 });
    }
    return stat;
  });
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('Log is open in another application'), { code: 'EBUSY' });
  });
  const logger = await import('./logger');
  expect(() => logger.initLogger()).not.toThrow();
  const error = new Error('Original startup failure must survive rotation');
  console.error('[AppInitialization] Startup failed:', error);

  const content = fs.readFileSync(logger.getLogFilePath(), 'utf8');
  expect(content).toContain('Log is open in another application');
  expect(content).toContain('EBUSY');
  expect(content).toContain(error.stack);
  expect(rename).toHaveBeenCalledTimes(1);
});
