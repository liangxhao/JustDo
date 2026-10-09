import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

import { registerWindowDiagnostics } from './windowDiagnostics';

afterEach(() => vi.restoreAllMocks());
function contents() {
  const emitter = Object.assign(new EventEmitter(), { mainFrame: {} });
  registerWindowDiagnostics(emitter as unknown as WebContents, 'StartupTest');
  return emitter;
}

test('records preload errors with the original stack and page failure details', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const emitter = contents();
  const error = new Error('preload dependency unavailable');
  emitter.emit('preload-error', {}, 'C:\\安装 目录\\preload.js', error);
  expect(log).toHaveBeenCalledWith(
    '[StartupTest] Preload failed:',
    'C:\\安装 目录\\preload.js',
    error,
  );
  emitter.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///app/index.html', true);
  expect(log).toHaveBeenCalledWith('[StartupTest] Page failed to load:', {
    code: -6,
    description: 'ERR_FILE_NOT_FOUND',
    url: 'file:///app/index.html',
    isMainFrame: true,
  });
});

test('captures only application warnings/errors and masks credentials without losing stack text', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const emitter = contents();
  const details = {
    frame: emitter.mainFrame,
    level: 'error',
    lineNumber: 15,
    sourceId: 'file:///app/main.js',
    message: 'Error: missing runtime token=secret-value\n at prepare (main.js:15)',
  };
  emitter.emit('console-message', details);
  expect(error).toHaveBeenCalledWith('[StartupTest] Renderer error:', {
    source: details.sourceId,
    line: 15,
    message: 'Error: missing runtime token=[REDACTED]\n at prepare (main.js:15)',
  });
  emitter.emit('console-message', { ...details, level: 'warning', message: 'retry failed' });
  expect(warn).toHaveBeenCalledOnce();
  emitter.emit('console-message', { ...details, frame: {}, message: 'external preview content' });
  emitter.emit('console-message', { ...details, level: 'info', message: 'application content' });
  emitter.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///app/index.html', true);
  expect(error).toHaveBeenCalledOnce();
});
