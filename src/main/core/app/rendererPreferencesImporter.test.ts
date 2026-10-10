import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ BrowserWindow: vi.fn() }));
vi.mock('electron', () => mocks);

import { RENDERER_PREFERENCES_KEY } from '../../../shared/app/rendererPreferences';
import {
  importFileOriginRendererPreferences,
  sanitizeRendererPreferenceImport,
} from './rendererPreferencesImporter';

function setup() {
  const window = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(async () => undefined),
    webContents: {
      executeJavaScript: vi.fn(async () => ({ 'justdo-theme-id': 'midnight' })),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  });
  window.destroy.mockImplementation(() => {
    window.isDestroyed.mockReturnValue(true);
    window.emit('closed');
  });
  mocks.BrowserWindow.mockImplementation(function () {
    return window;
  });
  return {
    window,
    resourcePath: path.resolve('resources/renderer-preferences.html'),
    session: {} as Electron.Session,
    store: { get: vi.fn(() => undefined as unknown), set: vi.fn() },
    isCurrent: vi.fn(() => true),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('first-adoption file-origin UI preferences', () => {
  it('reads only a fixed blank page with the same session and no preload or Node', async () => {
    const state = setup();
    await importFileOriginRendererPreferences(state);
    const options = mocks.BrowserWindow.mock.calls[0][0];
    expect(options).toMatchObject({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session: state.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
      },
    });
    expect(options.webPreferences).not.toHaveProperty('preload');
    expect(state.window.loadFile).toHaveBeenCalledWith(state.resourcePath);
    expect(state.store.set).toHaveBeenCalledWith(RENDERER_PREFERENCES_KEY, {
      'justdo-theme-id': 'midnight',
    });
    expect(state.window.destroy).toHaveBeenCalledOnce();
    expect(state.window.listenerCount('closed')).toBe(0);
  });

  it('does not read or overwrite an existing Main-owned record, including empty records', async () => {
    const state = setup();
    state.store.get.mockReturnValue({});
    await importFileOriginRendererPreferences(state);
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
    expect(state.store.set).not.toHaveBeenCalled();
  });

  it('preserves an existing record that appears while the reader loads', async () => {
    const state = setup();
    state.store.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ 'justdo-theme-id': 'new' });
    await importFileOriginRendererPreferences(state);
    expect(state.store.set).not.toHaveBeenCalled();
    expect(state.window.destroy).toHaveBeenCalledOnce();
  });

  it('drops the read when its owning main window has closed or begun quitting', async () => {
    const state = setup();
    state.window.loadFile.mockImplementation(async () => {
      state.isCurrent.mockReturnValue(false);
    });
    await importFileOriginRendererPreferences(state);
    expect(state.window.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(state.store.set).not.toHaveBeenCalled();
    expect(state.window.destroy).toHaveBeenCalledOnce();
  });

  it('bounds a stalled read and writes nothing when loading fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stalled = setup();
    stalled.window.loadFile.mockReturnValue(new Promise(() => undefined));
    const reading = importFileOriginRendererPreferences(stalled);
    await vi.advanceTimersByTimeAsync(3000);
    await reading;
    expect(stalled.store.set).not.toHaveBeenCalled();
    expect(stalled.window.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    const failed = setup();
    failed.window.loadFile.mockRejectedValueOnce(new Error('Missing resource'));
    await importFileOriginRendererPreferences(failed);
    expect(failed.store.set).not.toHaveBeenCalled();
    expect(failed.window.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('denies popup, off-entry navigation, child frames and redirects', async () => {
    const state = setup();
    await importFileOriginRendererPreferences(state);
    const popup = state.window.webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(popup({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    const listeners = new Map(state.window.webContents.on.mock.calls);
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn();
      listeners.get(name)?.({ url: 'https://example.com', isMainFrame: true, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const preventDefault = vi.fn();
    listeners.get('will-frame-navigate')?.({
      url: state.resourcePath,
      isMainFrame: false,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('executes a bounded allowlisted reader rather than exporting generic storage', async () => {
    const state = setup();
    const records = new Map([
      ['justdo-theme-id', 'midnight'],
      ['justdo-pet-floating-position', '{"x":10,"y":20}'],
      ['justdo-scheduled-task-result-preferences-v1', '{"includeRoutine":true}'],
      ['justdo:goal-completion-feedback:session-1', '{"completedGoalId":"goal-1"}'],
      ['justdo-openclaw-interrupted-messages', 'private transcript'],
      ['providers_export_key', 'private credential'],
    ]);
    state.window.webContents.executeJavaScript.mockImplementation(async source => {
      const localStorage = {
        getItem: (key: string) => records.get(key) ?? null,
        key: (index: number) => [...records.keys()][index] ?? null,
        length: records.size,
      };
      return new Function('window', `return ${source}`)({ localStorage });
    });
    await importFileOriginRendererPreferences(state);
    expect(state.store.set).toHaveBeenCalledWith(RENDERER_PREFERENCES_KEY, {
      'justdo-theme-id': 'midnight',
      'justdo-pet-floating-position': '{"x":10,"y":20}',
      'justdo-scheduled-task-result-preferences-v1': '{"includeRoutine":true}',
      'justdo:goal-completion-feedback:session-1': '{"completedGoalId":"goal-1"}',
    });
  });

  it('keeps the packaged reader inert and includes it in the package asset list', () => {
    const source = readFileSync(path.resolve('resources/renderer-preferences.html'), 'utf8');
    expect(source).toContain("default-src 'none'");
    expect(source).not.toMatch(/<(?:script|iframe|img|audio|video|link)\b/u);
    const packaging = JSON.parse(readFileSync(path.resolve('electron-builder.json'), 'utf8'));
    expect(packaging.files).toContain('resources/renderer-preferences.html');
  });
});

describe('preference import result bounds', () => {
  it('retains only strings with allowed keys and bounds entry count, bytes and total size', () => {
    const source: Record<string, unknown> = {
      'justdo-theme-id': 'midnight',
      'justdo-pet-floating-position': 1,
      providers_export_key: 'secret',
      'justdo-openclaw-failed-runs': 'private excerpt',
      'justdo:goal-completion-feedback:bad/key': 'invalid namespace',
      'justdo:goal-completion-feedback:oversized': '界'.repeat(22_000),
    };
    for (let index = 0; index < 130; index++)
      source[`justdo:goal-completion-feedback:${index}`] = '{}';
    const imported = sanitizeRendererPreferenceImport(source);
    expect(imported['justdo-theme-id']).toBe('midnight');
    expect(Object.keys(imported)).toHaveLength(128);
    expect(imported).not.toHaveProperty('providers_export_key');
    expect(imported).not.toHaveProperty('justdo-openclaw-failed-runs');
    expect(imported).not.toHaveProperty('justdo:goal-completion-feedback:bad/key');
    expect(imported).not.toHaveProperty('justdo:goal-completion-feedback:oversized');

    const large = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `justdo:goal-completion-feedback:${index}`,
        '界'.repeat(20_000),
      ]),
    );
    expect(Object.keys(sanitizeRendererPreferenceImport(large))).toHaveLength(8);
  });
});
