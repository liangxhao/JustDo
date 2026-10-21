// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';

import type { WindowAppearance } from '@shared/app/windowAppearance';
import { afterEach, expect, test, vi } from 'vitest';

import { createRendererPreferences } from '@/services/rendererPreferences';

import { startupPresentationPlugin } from '../../../scripts/build/startupPresentationPlugin.mjs';

vi.hoisted(() => {
  // esbuild uses Node's TextEncoder; jsdom supplies a different typed-array realm.
  globalThis.Uint8Array = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;
});

const rendererRoot = path.resolve('src/renderer');
const html = startupPresentationPlugin(rendererRoot).transformIndexHtml.handler(
  fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8'),
);
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)][0][1];
const styles = html.match(/<style>([\s\S]*?)<\/style>/u)![1];

afterEach(() => {
  document.head.innerHTML = '';
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  vi.doUnmock('@/services/config');
  vi.doUnmock('@/services/rendererPreferences');
  vi.unstubAllGlobals();
  vi.resetModules();
});

const scenarios: { appearance?: WindowAppearance; systemDark: boolean; expected: string }[] = [
  { appearance: { mode: 'light' }, systemDark: true, expected: 'classic-light' },
  { appearance: { mode: 'dark' }, systemDark: false, expected: 'classic-dark' },
  { appearance: { mode: 'dark', themeId: 'midnight' }, systemDark: false, expected: 'midnight' },
  { appearance: { mode: 'light', themeId: 'paper' }, systemDark: true, expected: 'paper' },
  { appearance: { mode: 'system', themeId: 'midnight' }, systemDark: true, expected: 'midnight' },
  {
    appearance: { mode: 'system', themeId: 'midnight' },
    systemDark: false,
    expected: 'classic-light',
  },
  {
    appearance: { mode: 'dark', themeId: 'missing-theme' },
    systemDark: false,
    expected: 'classic-dark',
  },
  { appearance: undefined, systemDark: true, expected: 'classic-light' },
];

test.each(scenarios)(
  'retains the first-paint palette through preference hydration and ThemeService startup: %j',
  async ({ appearance, systemDark, expected }) => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { initialization: { appearance } },
    });
    vi.stubGlobal('matchMedia', () => ({
      matches: systemDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    // A random HTTP origin may contain no config or stale browser values.
    localStorage.setItem('app_config', JSON.stringify({ theme: systemDark ? 'dark' : 'light' }));
    document.head.innerHTML = `<style>${styles}</style>`;
    new Function(bootstrap)();
    const root = document.documentElement;
    expect(root.dataset.theme).toBe(expected);
    const firstPaint = {
      classes: root.className,
      background: getComputedStyle(root).getPropertyValue('--justdo-background').trim(),
    };
    expect(firstPaint.background).toBeTruthy();
    const preferences = createRendererPreferences(
      () => ({
        get: async () => (appearance?.themeId ? { 'justdo-theme-id': appearance.themeId } : {}),
        set: async () => {},
      }),
      () => localStorage,
    );
    await preferences.initialize();
    vi.doMock('@/services/rendererPreferences', () => ({ rendererPreferences: preferences }));
    vi.doMock('@/services/config', () => ({
      configService: { getConfig: () => ({ theme: appearance?.mode ?? 'light' }) },
    }));
    const service = (await import('@/services/theme')).themeService;
    // Loading the regular stylesheet and applying the full service must not recolor startup.
    const stylesheet = document.createElement('style');
    stylesheet.textContent = fs.readFileSync(
      path.join(rendererRoot, 'theme/css/themes.css'),
      'utf8',
    );
    document.head.appendChild(stylesheet);
    service.initialize();
    expect(service.getThemeId()).toBe(expected);
    expect(root.dataset.theme).toBe(expected);
    expect({
      classes: root.className,
      background: getComputedStyle(root).getPropertyValue('--justdo-background').trim(),
    }).toEqual(firstPaint);
  },
);
