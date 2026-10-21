import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dialog: vi.fn(),
  copy: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN', relaunch: mocks.relaunch, quit: mocks.quit },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: mocks.copy },
  dialog: { showMessageBox: mocks.dialog },
}));
vi.mock('../logger', () => ({ getLogFilePath: () => 'C:\\用户 数据\\logs\\main.log' }));

import { registerAppWindowDiagnostics } from './appWindowFailure';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
test('shows and copies a redacted native failure without needing a working preload', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.dialog.mockResolvedValue({ response: 0 });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  registerAppWindowDiagnostics(contents as unknown as WebContents, 'AppInitialization');
  contents.emit('preload-error', {}, '/app/preload.js', new Error('Missing bridge token=hidden'));
  await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
  expect(mocks.copy.mock.calls[0][0]).toContain('Missing bridge');
  expect(mocks.copy.mock.calls[0][0]).toContain('main.log');
  expect(mocks.copy.mock.calls[0][0]).not.toContain('hidden');
});

test('ignores subframes/canceled loads and merges concurrent page failures into one dialog', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let resolve!: (value: { response: number }) => void;
  mocks.dialog.mockReturnValue(
    new Promise(yes => {
      resolve = yes;
    }),
  );
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, reload: vi.fn() });
  registerAppWindowDiagnostics(contents as unknown as WebContents, 'MainWindow');
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '/index.html', true);
  contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', '/preview.html', false);
  expect(mocks.dialog).not.toHaveBeenCalled();
  contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', '/index.html', true);
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  expect(mocks.dialog).toHaveBeenCalledOnce();
  resolve({ response: 1 });
  await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
  expect(mocks.quit).toHaveBeenCalledOnce();
  expect(contents.reload).not.toHaveBeenCalled();
});

test('reports renderer host preparation errors before any navigation event exists', async () => {
  mocks.dialog.mockResolvedValue({ response: 2 });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const report = registerAppWindowDiagnostics(contents as unknown as WebContents, 'MainWindow');
  report(Object.assign(new Error('Immutable renderer asset missing'), { code: 'ENOENT' }));
  await vi.waitFor(() => expect(mocks.dialog).toHaveBeenCalledOnce());
  expect(mocks.dialog.mock.calls[0][0].detail).toContain('ENOENT');
  expect(mocks.dialog.mock.calls[0][0].detail).toContain('rendererHost');
});
