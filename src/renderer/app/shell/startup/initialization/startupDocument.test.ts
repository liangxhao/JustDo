// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { appTranslations } from '@/services/i18n/appTranslations';
import { initializationTranslations } from '@/services/i18n/initializationTranslations';
import { startupTranslations } from '@/services/i18n/startupTranslations';

import { startupPresentationPlugin } from '../../../../../../scripts/build/startupPresentationPlugin.mjs';
import { STARTUP_ENTRY_STARTED_ATTRIBUTE } from './startupMotion';

vi.hoisted(() => {
  // esbuild uses Node's TextEncoder; jsdom supplies a different typed-array realm.
  globalThis.Uint8Array = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;
});

const template = startupPresentationPlugin(path.resolve('src/renderer')).transformIndexHtml.handler(
  fs.readFileSync(path.resolve('src/renderer/index.html'), 'utf8'),
);
const dictionaries = {
  zh: { ...appTranslations.zh, ...startupTranslations.zh },
  en: { ...appTranslations.en, ...startupTranslations.en },
};
function openDocument(language: string, firstLaunch = false, route?: string,
  clocks: { entryStartedAt?: number; startedAt?: number } = {}) {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
  localStorage.clear();
  HTMLElement.prototype.animate = vi.fn(() => ({ currentTime: 0, cancel: vi.fn() })) as never;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { initialization: { firstLaunch, route, entryStartedAt: clocks.entryStartedAt,
      getState: () => Promise.resolve({ startedAt: clocks.startedAt ?? Date.now() }) } },
  });
  document.body.innerHTML = template.match(/<body>([\s\S]*)<\/body>/u)![1];
  const scripts = [...template.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
  const script = scripts[scripts.length - 1][1];
  new Function(script.replace('%STARTUP_TRANSLATIONS%', JSON.stringify(dictionaries)))();
}
afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE);
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.startupDiagnostics;
});

test('paints localized content with elapsed time before the module entry executes', async () => {
  openDocument('zh-CN');
  await Promise.resolve();
  expect(document.querySelector('h1')?.textContent).toBe(dictionaries.zh.startupHeading);
  expect(document.querySelector('.startup-main')?.getAttribute('data-entry')).toBe('opening');
  expect(document.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
  expect([...document.querySelectorAll('.startup-step-name')].map(step => step.textContent?.trim()))
    .toEqual([
      dictionaries.zh.startupStep_userData, dictionaries.zh.startupStep_configuration,
      dictionaries.zh.startupStep_engine, dictionaries.zh.startupStep_integrations,
      dictionaries.zh.startupStep_interface,
    ]);
  vi.advanceTimersByTime(31_000);
  expect(document.querySelector('.startup-main')?.getAttribute('data-entry')).toBe('open');
  expect(document.getElementById('startup-clock')?.textContent).toBe('00:31');
  expect(document.getElementById('startup-document-hint')?.textContent).toBe(
    dictionaries.zh.startupLongWait,
  );
  document.getElementById('startup-document')!.remove();
  vi.advanceTimersByTime(1000);
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps the static total elapsed clock independent of the fresh visual entry clock', async () => {
  const now = Date.now();
  openDocument('zh-CN', false, 'normal', { entryStartedAt: now, startedAt: now - 30_000 });
  await Promise.resolve();
  vi.advanceTimersByTime(1000);
  expect(document.getElementById('startup-clock')?.textContent).toBe('00:31');
  expect(document.querySelector('.startup-main')?.getAttribute('data-entry')).toBe('opening');
  expect(document.documentElement.getAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE)).toBe(String(now));
  vi.advanceTimersByTime(300);
  expect(document.querySelector('.startup-main')?.getAttribute('data-entry')).toBe('open');
});

test('keeps a visible recovery action when interface modules fail to load', () => {
  openDocument('en-US');
  window.dispatchEvent(new Event('error'));
  expect(document.getElementById('startup-document-error')?.hidden).toBe(false);
  expect(document.getElementById('startup-reload')?.textContent).toBe(
    dictionaries.en.startupReload,
  );
  expect((document.querySelector('.startup-progress') as HTMLElement).hidden).toBe(true);
  expect(document.querySelectorAll('.startup-step')).toHaveLength(5);
  expect(document.querySelectorAll('.startup-step[data-status="complete"]')).toHaveLength(0);
  expect(
    document.querySelector('[data-startup-step="interface"]')?.getAttribute('data-status'),
  ).toBe('failed');
  expect(
    document.querySelector('[data-startup-step="interface"] .startup-step-marker')?.textContent,
  ).toBe('×');
});

test.each([true, false])(
  'captures the early exception and copies the same redacted details (firstLaunch=%s)',
  async firstLaunch => {
    openDocument('zh-CN', firstLaunch);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: Object.assign(new Error('Import failed token=private-token'), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      }),
    );
    const detail = document.getElementById('startup-failure-detail')!.textContent!;
    expect(detail).toContain('ERR_MODULE_NOT_FOUND');
    expect(detail).not.toContain('private-token');
    document.getElementById('startup-copy-diagnostics')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(detail);
    expect(document.querySelector('[data-startup-view]')?.getAttribute('data-startup-view')).toBe(
      firstLaunch ? 'first-launch' : 'launch',
    );
  },
);

test('selects the first-launch guide before any module executes and retains it on failure', () => {
  openDocument('zh-CN', true);
  const root = document.getElementById('root')!;
  expect(root.querySelector('[data-startup-view="first-launch"]')).toBeTruthy();
  expect(root.querySelector('[data-startup-view="launch"]')).toBeNull();
  expect(document.documentElement.hasAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE)).toBe(true);
  expect(root.querySelector('h1')?.textContent).toBe(
    initializationTranslations.zh.firstLaunchTitle,
  );
  document.getElementById('startup-document')!.setAttribute('data-activity', 'preferences');
  vi.advanceTimersByTime(1000);
  expect(document.getElementById('startup-operation')?.textContent).toBe(
    initializationTranslations.zh.initializationRenderer_preferences,
  );
  window.dispatchEvent(new Event('error'));
  vi.advanceTimersByTime(1000);
  expect(document.getElementById('startup-document-error')?.hidden).toBe(false);
  expect(root.querySelector('[data-startup-view="launch"]')).toBeNull();
});

test.each(['zh-CN', 'en-US'])(
  'paints four distinct startup routes before React without changing their meaning on failure (%s)',
  language => {
    const locale = language === 'zh-CN' ? 'zh' : 'en';
    const copy = initializationTranslations[locale];
    for (const [route, view, heading, count] of [
      ['fresh', 'first-launch', copy.firstLaunchTitle, 4],
      ['migration', 'migration', copy.initializationUpgradeTitle, 6],
      ['upgrade', 'upgrade', copy.initializationNormalUpgradeTitle, 5],
      ['normal', 'launch', startupTranslations[locale].startupHeading, 0],
    ] as const) {
      openDocument(language, route !== 'normal', route);
      const startup = document.getElementById('startup-document')!;
      expect(startup.dataset.startupView).toBe(view);
      expect(startup.querySelector('h1')?.textContent).toBe(heading);
      const steps = [...startup.querySelectorAll('nav ol > li')].filter(
        item => !(item as HTMLElement).hidden,
      );
      expect(steps).toHaveLength(count);
      expect(steps.map(item => item.firstElementChild?.textContent)).toEqual(
        Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, '0')),
      );
      if (route === 'upgrade') {
        expect(startup.textContent).toContain(copy.initializationNormalUpgradeDescription);
        expect(startup.querySelector('[data-upgrade-only]')?.hasAttribute('hidden')).toBe(false);
        expect(startup.querySelector('[data-migration-only]')?.hasAttribute('hidden')).toBe(true);
        startup.dataset.activity = 'conversations';
        vi.advanceTimersByTime(1000);
        expect(document.getElementById('startup-operation')?.textContent).toBe(
          startupTranslations[locale].startupRenderer_conversations,
        );
      }
      window.dispatchEvent(new Event('error'));
      vi.advanceTimersByTime(1000);
      expect(startup.dataset.startupView).toBe(view);
      startup.remove();
      vi.advanceTimersByTime(1000);
      vi.restoreAllMocks();
      delete window.startupDiagnostics;
    }
  },
);
