import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { LogKind, LogMaintenance, managedLogs } from '../../core/logMaintenance';
import { OpenClawEngineManager } from './openclawEngineManager';

test('serializes interleaved Gateway streams across rotation and masks persisted credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-log-rotation-'));
  const file = path.join(directory, 'gateway.log');
  const maintenance = new LogMaintenance({ maxFileBytes: { [LogKind.Gateway]: 320 } });
  vi.spyOn(managedLogs, 'append').mockImplementation((...args) => maintenance.append(...args));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const manager = Object.assign(Object.create(OpenClawEngineManager.prototype), {
    gatewayLogPath: file,
    observeGatewayProcessLine: vi.fn(),
  }) as { attachGatewayProcessLogs: (value: typeof child) => void };
  try {
    manager.attachGatewayProcessLogs(child);
    child.stdout.emit('data', `gateway-record-1 ${'a'.repeat(80)}\n`);
    child.stderr.emit('data', `gateway-record-2 ${'b'.repeat(80)}\n`);
    child.stdout.emit('data', `gateway-record-3 ${'c'.repeat(80)}\n`);
    child.stderr.emit('data', 'gateway-record-4 Authorization: Bearer secret-credential\n');

    const backup = fs.readFileSync(`${file}.old`, 'utf8');
    const current = fs.readFileSync(file, 'utf8');
    expect(backup).toContain('gateway-record-1');
    expect(backup).toContain('gateway-record-2');
    expect(current).toContain('gateway-record-3');
    expect(current).toContain('gateway-record-4');
    expect(current).toContain('[REDACTED]');
    expect(backup + current).not.toContain('secret-credential');
    for (const name of fs.readdirSync(directory)) {
      expect(fs.statSync(path.join(directory, name)).size).toBeLessThanOrEqual(320);
    }
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
