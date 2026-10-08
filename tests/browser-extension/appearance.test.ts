// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_KEY,
  initializeAppearance,
} from '../../resources/browser-extension/conversation-overlay/modules/appearance.js';

function environment(value = 'dark') {
  let changed: (changes: unknown, area: string) => void = () => {};
  let systemChanged = () => {};
  const storage = {
    local: { get: vi.fn(async () => ({ [APPEARANCE_KEY]: value })), set: vi.fn(async () => {}) },
    onChanged: {
      addListener: vi.fn(fn => {
        changed = fn;
      }),
      removeListener: vi.fn(),
    },
  };
  const media = {
    matches: false,
    addEventListener: vi.fn((_name, fn) => {
      systemChanged = fn;
    }),
    removeEventListener: vi.fn(),
  };
  return {
    storage,
    media,
    change: (next: string, area = 'local') =>
      changed({ [APPEARANCE_KEY]: { newValue: next } }, area),
    systemChange: () => systemChanged(),
  };
}

describe('extension appearance preferences', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });
  it('restores saved appearance and updates open pages when settings change', async () => {
    const env = environment('warm');
    const controller = await initializeAppearance(env);
    expect(document.documentElement.dataset.theme).toBe('warm');
    env.change('blue');
    expect(document.documentElement.dataset.theme).toBe('blue');
    env.change('light', 'sync');
    expect(document.documentElement.dataset.theme).toBe('blue');
    await controller.select('light');
    expect(env.storage.local.set).toHaveBeenCalledWith({ [APPEARANCE_KEY]: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    controller.dispose();
    expect(env.storage.onChanged.removeListener).toHaveBeenCalled();
  });
  it('follows system changes only for the system option', async () => {
    const env = environment('system');
    const controller = await initializeAppearance(env);
    expect(document.documentElement.dataset.theme).toBe('light');
    env.media.matches = true;
    env.systemChange();
    expect(document.documentElement.dataset.theme).toBe('dark');
    await controller.select('warm');
    env.media.matches = false;
    env.systemChange();
    expect(document.documentElement.dataset.theme).toBe('warm');
  });
  it('keeps the previous theme when saving fails and defaults invalid stored values', async () => {
    const env = environment('invalid');
    const controller = await initializeAppearance(env);
    expect(document.documentElement.dataset.theme).toBe('light');
    env.storage.local.set.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(controller.select('dark')).rejects.toThrow('Unavailable');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('uses light for an unsaved preference and unavailable storage', async () => {
    const env = environment();
    env.storage.local.get.mockResolvedValueOnce({} as never);
    const controller = await initializeAppearance(env);
    expect(document.documentElement.dataset.theme).toBe('light');
    controller.dispose();
    env.storage.local.get.mockRejectedValueOnce(new Error('Unavailable'));
    await initializeAppearance(env);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('does not overwrite a live storage change with a stale initial read', async () => {
    const env = environment();
    let finish!: (value: Record<string, string>) => void;
    env.storage.local.get.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = initializeAppearance(env);
    env.change('blue');
    finish({ [APPEARANCE_KEY]: 'dark' });
    await pending;
    expect(document.documentElement.dataset.theme).toBe('blue');
  });
  it('does not overwrite a newer stored theme when a previous save finishes', async () => {
    const env = environment();
    const controller = await initializeAppearance(env);
    let finish!: () => void;
    env.storage.local.set.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const pending = controller.select('light');
    env.change('light');
    env.change('blue');
    finish();
    await pending;
    expect(document.documentElement.dataset.theme).toBe('blue');
  });
  it('offers a saved settings selection and restores it on failure', async () => {
    vi.resetModules();
    document.body.innerHTML = '<section id="appearance" class="appearance-settings"></section>';
    const env = environment('warm');
    vi.stubGlobal('chrome', { storage: env.storage });
    vi.stubGlobal('matchMedia', () => env.media);
    await import('../../resources/browser-extension/conversation-overlay/modules/appearance-settings.js');
    const select = document.getElementById('chatTheme') as HTMLSelectElement;
    expect(document.getElementById('appearanceTitle')?.textContent).toBe('Background color');
    expect(select.options[0].textContent).toBe('Dark');
    expect(select.options).toHaveLength(5);
    expect(select.value).toBe('warm');
    select.value = 'blue';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(document.documentElement.dataset.theme).toBe('blue');
    env.storage.local.set.mockRejectedValueOnce(new Error('Unavailable'));
    select.value = 'light';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('blue');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Could not save. Please try again.',
    );
    vi.unstubAllGlobals();
  });
});
