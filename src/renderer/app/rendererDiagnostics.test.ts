// @vitest-environment jsdom

import { afterEach, expect, test, vi } from 'vitest';

import { registerRendererDiagnostics } from './rendererDiagnostics';

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

function installDiagnostics() {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const dispose = registerRendererDiagnostics();
  disposers.push(dispose);
  return { error, warn, dispose };
}

test('preserves complete caught Error stacks and accompanying context in error and warning messages', () => {
  const diagnostics = installDiagnostics();
  const error = new Error('Initialization state could not be read');
  const context = { operation: 'getState', stage: 'startup' };

  console.error('[AppInitialization] State read failed:', error, context);
  console.warn('[AppInitialization] Continuing after a recoverable failure:', error);

  expect(diagnostics.error).toHaveBeenCalledWith(
    '[AppInitialization] State read failed:',
    error.stack,
    context,
  );
  expect(diagnostics.warn).toHaveBeenCalledWith(
    '[AppInitialization] Continuing after a recoverable failure:',
    error.stack,
  );
  expect(error.stack).toContain('Initialization state could not be read');
});

test('records uncaught renderer exceptions with their full stack and source location', () => {
  const diagnostics = installDiagnostics();
  const error = new Error('Application render failed');

  window.dispatchEvent(
    new ErrorEvent('error', {
      error,
      message: error.message,
      filename: 'file:///app/assets/index.js',
      lineno: 128,
      colno: 9,
    }),
  );

  expect(diagnostics.error).toHaveBeenCalledWith(
    '[Renderer] Uncaught error:',
    error.stack,
    'file:///app/assets/index.js:128:9',
  );
});

test('records unhandled Promise failures with the original Error stack', () => {
  const diagnostics = installDiagnostics();
  const error = new Error('Startup retry failed');
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: error });

  window.dispatchEvent(event);

  expect(diagnostics.error).toHaveBeenCalledWith('[Renderer] Unhandled rejection:', error.stack);
});

test('retains error codes and nested causes without expanding unrelated rejection data', () => {
  const diagnostics = installDiagnostics();
  const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  const error = Object.assign(new Error('startup retry failed'), {
    cause,
    code: 'STARTUP_FAILED',
  });
  console.error('retry:', error);
  expect(diagnostics.error.mock.lastCall?.[1]).toContain('code=STARTUP_FAILED');
  expect(diagnostics.error.mock.lastCall?.[1]).toContain('Caused by: Error: socket closed');
  expect(diagnostics.error.mock.lastCall?.[1]).toContain('code=ECONNRESET');
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', {
    value: {
      message: 'configuration write failed',
      code: 'EACCES',
      credential: 'never serialize this',
    },
  });
  window.dispatchEvent(event);
  expect(diagnostics.error.mock.lastCall?.[1]).toBe('configuration write failed\ncode=EACCES');
});

test('restores the original console functions and removes event listeners when disposed', () => {
  const diagnostics = installDiagnostics();
  diagnostics.dispose();
  disposers.splice(disposers.indexOf(diagnostics.dispose), 1);
  const error = new Error('After disposal');
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: error });
  const exception = new ErrorEvent('error', { error, message: error.message });
  // Vitest considers ErrorEvents without application listeners uncaught test
  // failures. A separate observer handles only this intentional test event.
  const observeTestError = () => undefined;
  window.addEventListener('error', observeTestError);

  try {
    window.dispatchEvent(exception);
    window.dispatchEvent(rejection);
  } finally {
    window.removeEventListener('error', observeTestError);
  }

  expect(console.error).toBe(diagnostics.error);
  expect(console.warn).toBe(diagnostics.warn);
  expect(diagnostics.error).not.toHaveBeenCalled();
  console.error('Original logger restored:', error);
  expect(diagnostics.error).toHaveBeenCalledWith('Original logger restored:', error);
});
