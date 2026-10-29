import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  getCurrentLogFileName,
  getRetainedLogPaths,
  LOG_MAINTENANCE_POLICY,
  LogKind,
  LogMaintenance,
} from './logMaintenance';

let root: string;
const managers: LogMaintenance[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T04:00:00Z'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-maintenance-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function createManager(options: ConstructorParameters<typeof LogMaintenance>[0] = {}) {
  const manager = new LogMaintenance({
    maxFileBytes: { main: 128, cowork: 128, gateway: 128 },
    maxTotalBytes: 1024,
    retentionMs: 10_000,
    intervalMs: 1000,
    onWarning: vi.fn(),
    ...options,
  });
  managers.push(manager);
  return manager;
}

function writeLog(directory: string, name: string, text: string, modified = Date.now()) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(modified), new Date(modified));
  return file;
}

test('bounds an oversized UTF-8 record, preserves its prefix and marks omitted content', () => {
  const manager = createManager();
  const file = path.join(root, getCurrentLogFileName(LogKind.Main));

  manager.append(LogKind.Main, file, '错误细节'.repeat(100));

  const data = fs.readFileSync(file);
  const text = data.toString('utf8');
  expect(data.length).toBeLessThanOrEqual(128);
  expect(text).toMatch(/^错误细节/);
  expect(text).toContain('Oversized log record truncated.');
  expect(text).not.toContain('\ufffd');
});

test('rotates before the file limit and repeatedly replaces only the previous Gateway backup', () => {
  const manager = createManager();
  const file = path.join(root, 'gateway.log');
  manager.append(LogKind.Gateway, file, 'first '.padEnd(90, 'a'));
  manager.start();

  manager.append(LogKind.Gateway, file, 'second '.padEnd(90, 'b'));
  manager.append(LogKind.Gateway, file, 'latest '.padEnd(90, 'c'));

  expect(getRetainedLogPaths(root, LogKind.Gateway)).toEqual([file, `${file}.old`]);
  expect(fs.readFileSync(file, 'utf8')).toBe('latest '.padEnd(90, 'c'));
  expect(fs.readFileSync(`${file}.old`, 'utf8')).toBe('second '.padEnd(90, 'b'));
  expect(fs.statSync(file).size).toBeLessThanOrEqual(128);
  expect(fs.statSync(`${file}.old`).size).toBeLessThanOrEqual(128);
});

test('normalizes pre-existing oversized current and backup files before accepting fresh logs', () => {
  const directory = path.join(root, 'gateway');
  const file = writeLog(directory, 'gateway.log', 'a'.repeat(300));
  writeLog(directory, 'gateway.log.old', 'b'.repeat(200));
  const unrelated = writeLog(directory, 'engine-notes.log', 'keep'.repeat(100));
  const manager = createManager();
  manager.registerDirectory(directory, LogKind.Gateway);

  manager.start();
  manager.append(LogKind.Gateway, file, 'fresh Gateway evidence');

  expect(getRetainedLogPaths(directory, LogKind.Gateway)).toEqual([file]);
  expect(fs.readFileSync(file, 'utf8')).toBe('fresh Gateway evidence');
  expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep'.repeat(100));
});

test('shares the budget across primary, installation fallback and Gateway, reclaiming the oldest first', () => {
  const primary = path.join(root, 'primary');
  const fallback = path.join(root, 'fallback');
  const gateway = path.join(root, 'gateway');
  const mainOld = writeLog(primary, 'main-2026-10-28.log', 'm'.repeat(100), Date.now() - 100);
  const fallbackOld = writeLog(fallback, 'main-2026-10-27.log', 'f'.repeat(100), Date.now() - 300);
  const gatewayOld = writeLog(gateway, 'gateway.log.old', 'b'.repeat(100), Date.now() - 200);
  const gatewayActive = writeLog(gateway, 'gateway.log', 'g'.repeat(80));
  const manager = createManager({ maxTotalBytes: 400 });
  manager.registerDirectory(primary, LogKind.Main);
  manager.registerDirectory(fallback, LogKind.Main);
  manager.registerDirectory(gateway, LogKind.Gateway);
  manager.start();
  expect(fs.existsSync(fallbackOld)).toBe(true);

  const mainActive = path.join(primary, getCurrentLogFileName(LogKind.Main));
  manager.append(LogKind.Main, mainActive, 'n'.repeat(50));

  expect(fs.existsSync(fallbackOld)).toBe(false);
  const retained = [mainOld, mainActive, gatewayOld, gatewayActive];
  expect(retained.every(file => fs.existsSync(file))).toBe(true);
  expect(retained.reduce((bytes, file) => bytes + fs.statSync(file).size, 0)).toBe(330);
});

test('expires logs while running, leaves the timer unreferenced and stops periodic maintenance', () => {
  const file = writeLog(root, 'gateway.log.old', 'old backup', Date.now() - 500);
  const manager = createManager({ retentionMs: 1000, intervalMs: 100 });
  manager.registerDirectory(root, LogKind.Gateway);
  const interval = vi.spyOn(global, 'setInterval');
  manager.start();
  const timer = interval.mock.results[0].value as ReturnType<typeof setInterval>;
  expect(timer.hasRef()).toBe(false);
  expect(fs.existsSync(file)).toBe(true);

  vi.advanceTimersByTime(600);
  expect(fs.existsSync(file)).toBe(false);
  manager.stop();
  writeLog(root, 'gateway.log.old', 'after stopping', Date.now() - 1001);
  vi.advanceTimersByTime(1000);
  expect(fs.readFileSync(file, 'utf8')).toBe('after stopping');
});

test('removes an expired idle static log during maintenance without a restart', () => {
  const file = writeLog(root, 'cowork.log', 'idle diagnostic evidence');
  const manager = createManager({ retentionMs: 1000, intervalMs: 100 });
  manager.registerDirectory(root, LogKind.Cowork);
  manager.start();

  vi.advanceTimersByTime(1100);

  expect(fs.existsSync(file)).toBe(false);
  manager.append(LogKind.Cowork, file, 'new evidence');
  expect(fs.readFileSync(file, 'utf8')).toBe('new evidence');
});

test('ignores unknown filenames, directories and symlinked family roots', () => {
  const owned = path.join(root, 'owned');
  const outside = path.join(root, 'outside');
  const unknown = writeLog(owned, 'gateway-debug.log', 'preserve unknown', Date.now() - 20_000);
  const wrongFamily = writeLog(
    owned,
    'cowork.log.old',
    'preserve other family',
    Date.now() - 20_000,
  );
  const victim = writeLog(outside, 'gateway.log.old', 'preserve linked file', Date.now() - 20_000);
  const nested = writeLog(path.join(owned, 'gateway.log.old'), 'nested.txt', 'preserve nested');
  const linked = path.join(root, 'linked');
  fs.symlinkSync(outside, linked, 'junction');
  const warnings = vi.fn();
  const manager = createManager({ maxTotalBytes: 1, onWarning: warnings });
  manager.registerDirectory(owned, LogKind.Gateway);
  manager.registerDirectory(linked, LogKind.Gateway);

  expect(() => manager.cleanup()).not.toThrow();

  expect(fs.readFileSync(unknown, 'utf8')).toBe('preserve unknown');
  expect(fs.readFileSync(wrongFamily, 'utf8')).toBe('preserve other family');
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve linked file');
  expect(fs.readFileSync(nested, 'utf8')).toBe('preserve nested');
  expect(() => getRetainedLogPaths(linked, LogKind.Gateway)).toThrow('Unsafe log directory');
  expect(warnings).toHaveBeenCalled();
});

test('a failed rotation cannot grow the file or retry on every record, and later reports missed writes', () => {
  const file = writeLog(root, 'gateway.log', 'existing '.padEnd(90, 'e'));
  const manager = createManager({ intervalMs: LOG_MAINTENANCE_POLICY.intervalMs });
  manager.registerDirectory(root, LogKind.Gateway);
  manager.start();
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('Rotation file is locked'), { code: 'EBUSY' });
  });

  expect(() => manager.append(LogKind.Gateway, file, 'first failed '.padEnd(60, 'f'))).toThrow(
    'locked',
  );
  expect(() => manager.append(LogKind.Gateway, file, 'second failed '.padEnd(60, 'f'))).toThrow(
    'locked',
  );
  manager.cleanup();
  expect(rename).toHaveBeenCalledTimes(1);
  expect(fs.statSync(file).size).toBe(90);

  rename.mockRestore();
  vi.advanceTimersByTime(LOG_MAINTENANCE_POLICY.intervalMs);
  manager.append(LogKind.Gateway, file, 'recovered evidence');
  const recovered = fs.readFileSync(file, 'utf8');
  expect(recovered).toContain('2 records could not be written');
  expect(recovered).toContain('recovered evidence');
  expect(fs.statSync(file).size).toBeLessThanOrEqual(128);
});

test('failed capacity deletion leaves existing evidence intact and refuses to exceed the shared budget', () => {
  const old = writeLog(root, 'gateway.log.old', 'old'.padEnd(128, 'o'));
  const file = writeLog(root, 'gateway.log', 'active'.padEnd(80, 'a'));
  const unlink = fs.unlinkSync.bind(fs);
  const deletion = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
    if (String(target) === old)
      throw Object.assign(new Error('Backup cannot be deleted'), { code: 'EACCES' });
    return unlink(target);
  });
  const warnings = vi.fn();
  const manager = createManager({ maxTotalBytes: 200, onWarning: warnings });
  manager.registerDirectory(root, LogKind.Gateway);

  expect(() => manager.start()).not.toThrow();
  expect(() => manager.append(LogKind.Gateway, file, 'new evidence')).toThrow('capacity');
  expect(fs.statSync(old).size).toBe(128);
  expect(fs.statSync(file).size).toBe(80);
  expect(warnings).toHaveBeenCalled();

  deletion.mockRestore();
  vi.advanceTimersByTime(1000);
  expect(() => manager.append(LogKind.Gateway, file, 'recovered evidence')).not.toThrow();
  const retained = getRetainedLogPaths(root, LogKind.Gateway);
  expect(retained.reduce((bytes, item) => bytes + fs.statSync(item).size, 0)).toBeLessThanOrEqual(
    200,
  );
  expect(fs.readFileSync(file, 'utf8')).toContain('recovered evidence');
});

test('an unreadable directory remains unknown, cleanup does not throw and writes recover after a later inventory', () => {
  const file = writeLog(root, 'gateway.log', 'retained evidence');
  const read = fs.readdirSync.bind(fs);
  const enumeration = vi
    .spyOn(fs, 'readdirSync')
    .mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === root)
        throw Object.assign(new Error('Cannot enumerate logs'), { code: 'EACCES' });
      return read(...args);
    });
  const warnings = vi.fn();
  const manager = createManager({ onWarning: warnings });
  manager.registerDirectory(root, LogKind.Gateway);

  expect(() => manager.start()).not.toThrow();
  expect(() => manager.append(LogKind.Gateway, file, 'new evidence')).toThrow('capacity');
  expect(fs.readFileSync(file, 'utf8')).toBe('retained evidence');
  expect(warnings).toHaveBeenCalled();

  enumeration.mockRestore();
  vi.advanceTimersByTime(1000);
  expect(() => manager.append(LogKind.Gateway, file, 'recovered evidence')).not.toThrow();
  expect(fs.readFileSync(file, 'utf8')).toContain('1 records could not be written');
  expect(fs.readFileSync(file, 'utf8')).toContain('recovered evidence');
});

test('does not rotate files through a junction after a formerly known directory becomes unsafe', () => {
  const owned = path.join(root, 'owned');
  const file = writeLog(owned, 'gateway.log', 'oversized'.padEnd(300, 'x'));
  const outside = path.join(root, 'outside');
  const victim = writeLog(outside, 'gateway.log', 'external log must remain intact');
  const manager = createManager();
  manager.registerDirectory(owned, LogKind.Gateway);
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('File is locked'), { code: 'EBUSY' });
  });
  manager.start();
  expect(fs.existsSync(file)).toBe(true);
  rename.mockRestore();
  fs.renameSync(owned, path.join(root, 'detached'));
  fs.symlinkSync(outside, owned, 'junction');

  expect(() => manager.cleanup()).not.toThrow();

  expect(fs.readFileSync(victim, 'utf8')).toBe('external log must remain intact');
  expect(fs.readdirSync(outside)).toEqual(['gateway.log']);
});

test('recounts a partially failed append before admitting another writer into the shared budget', () => {
  const main = writeLog(root, getCurrentLogFileName(LogKind.Main), 'm'.repeat(100));
  const gateway = writeLog(root, 'gateway.log', 'g'.repeat(100));
  const cowork = writeLog(root, 'cowork.log', 'c'.repeat(40));
  const manager = createManager({
    maxFileBytes: { main: 512, cowork: 512, gateway: 512 },
    maxTotalBytes: 300,
  });
  for (const kind of Object.values(LogKind)) manager.registerDirectory(root, kind);
  manager.start();
  const append = fs.appendFileSync.bind(fs);
  vi.spyOn(fs, 'appendFileSync').mockImplementation(
    (...args: Parameters<typeof fs.appendFileSync>) => {
      if (String(args[0]) === gateway) {
        append(gateway, Buffer.from(args[1] as Uint8Array).subarray(0, 20));
        throw Object.assign(new Error('Disk filled after a partial append'), { code: 'ENOSPC' });
      }
      return append(...args);
    },
  );

  expect(() => manager.append(LogKind.Gateway, gateway, 'new'.padEnd(40, 'g'))).toThrow(
    'partial append',
  );
  expect(() => manager.append(LogKind.Cowork, cowork, 'next'.padEnd(60, 'c'))).toThrow('capacity');

  expect([main, gateway, cowork].reduce((bytes, file) => bytes + fs.statSync(file).size, 0)).toBe(
    260,
  );
  expect(fs.statSync(cowork).size).toBe(40);
});

test('a disappearing listed file does not erase the bytes of surviving logs from the inventory', () => {
  const main = writeLog(root, getCurrentLogFileName(LogKind.Main), 'm'.repeat(100));
  const gateway = writeLog(root, 'gateway.log', 'g'.repeat(100));
  const cowork = writeLog(root, 'cowork.log', 'c'.repeat(40));
  const disappearing = writeLog(root, 'gateway.log.old', 'gone');
  const lstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === disappearing && fs.existsSync(disappearing)) {
      fs.unlinkSync(disappearing);
      throw Object.assign(new Error('Log removed during enumeration'), { code: 'ENOENT' });
    }
    return lstat(...args);
  });
  const manager = createManager({
    maxFileBytes: { main: 512, cowork: 512, gateway: 512 },
    maxTotalBytes: 300,
  });
  for (const kind of Object.values(LogKind)) manager.registerDirectory(root, kind);
  manager.start();

  expect(() => manager.append(LogKind.Cowork, cowork, 'next'.padEnd(80, 'c'))).toThrow('capacity');

  expect([main, gateway, cowork].reduce((bytes, file) => bytes + fs.statSync(file).size, 0)).toBe(
    240,
  );
});
