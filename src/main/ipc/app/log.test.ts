import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { registerLogHandlers } from './log';
import { exportLogsZip } from './logExport';

const state = vi.hoisted(() => ({
  directory: '',
  handlers: new Map<string, (event: { sender: object }) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.directory },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  dialog: {
    showSaveDialog: () => Promise.resolve({ filePath: path.join(state.directory, 'logs.zip') }),
  },
  ipcMain: {
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    handle: (channel: string, handler: (event: { sender: object }) => Promise<unknown>) =>
      state.handlers.set(channel, handler),
  },
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock('../../core/logger', () => ({
  getLogFilePath: () => path.join(state.directory, 'logs', 'main-2026-10-29.log'),
  getRecentMainLogEntries: () => [{
    archiveName: 'main-2026-10-29.log',
    filePath: path.join(state.directory, 'logs', 'main-2026-10-29.log'),
  }],
}));

vi.mock('./logExport', () => ({
  exportLogsZip: vi.fn().mockResolvedValue({ missingEntries: [] }),
}));

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'log-export-'));
  state.handlers.clear();
  vi.mocked(exportLogsZip).mockClear();
  registerLogHandlers();
});

afterEach(() => {
  fs.rmSync(state.directory, { recursive: true, force: true });
});

test('exports retained Cowork and Gateway logs with their backups alongside Main logs', async () => {
  const logs = path.join(state.directory, 'logs');
  const gatewayLogs = path.join(state.directory, 'openclaw', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(gatewayLogs, { recursive: true });
  for (const name of ['cowork.log', 'cowork.log.old', 'unrelated.log']) {
    fs.writeFileSync(path.join(logs, name), name);
  }
  for (const name of ['gateway.log', 'gateway.log.old', 'unrelated.log']) {
    fs.writeFileSync(path.join(gatewayLogs, name), name);
  }

  const result = await state.handlers.get('log:exportZip')!({ sender: {} });

  expect(result).toMatchObject({ success: true, canceled: false, missingEntries: [] });
  const entries = vi.mocked(exportLogsZip).mock.calls[0][0].entries;
  expect(entries.map(entry => entry.archiveName).sort()).toEqual([
    'cowork.log',
    'cowork.log.old',
    'gateway.log',
    'gateway.log.old',
    'main-2026-10-29.log',
  ]);
  expect(entries.find(entry => entry.archiveName === 'gateway.log.old')?.filePath).toBe(
    path.join(gatewayLogs, 'gateway.log.old'),
  );
});

test('exports available logs when Cowork and Gateway log directories have not been created', async () => {
  const result = await state.handlers.get('log:exportZip')!({ sender: {} });

  expect(result).toMatchObject({ success: true, missingEntries: [] });
  expect(vi.mocked(exportLogsZip).mock.calls[0][0].entries).toHaveLength(1);
});
