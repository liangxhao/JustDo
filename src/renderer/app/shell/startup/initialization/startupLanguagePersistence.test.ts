// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), updateConfig: vi.fn() }));
vi.mock('@/services/config', () => ({ configService: mocks }));
vi.mock('@/services/i18n/translations', () => ({
  translations: { zh: { startupHeading: '正在启动' }, en: { startupHeading: 'Starting' } },
}));
import { i18nService } from '@/services/i18n';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.updateConfig.mockResolvedValue(undefined);
  i18nService.setLanguage('zh', { persist: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function configure(language: unknown, initialized: boolean, locale = 'zh-CN') {
  mocks.getConfig.mockReturnValue({ language, language_initialized: initialized });
  const readLocale = vi.fn().mockResolvedValue(locale);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { appInfo: { getSystemLocale: readLocale } },
  });
  return readLocale;
}

test.each(['zh', 'en'] as const)(
  'preserves an initialized %s preference without another read or write',
  async language => {
    const readLocale = configure(language, true);
    await i18nService.initialize();
    expect(i18nService.getLanguage()).toBe(language);
    expect(readLocale).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  },
);

test.each(['fr', 'zh-CN', '', null, undefined, 1])(
  'repairs an initialized unsupported language (%s) before rendering translated copy',
  async language => {
    const readLocale = configure(language, true);
    await i18nService.initialize();
    expect(i18nService.getLanguage()).toBe('en');
    expect(i18nService.t('startupHeading')).toBe('Starting');
    expect(readLocale).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith({ language: 'en', language_initialized: true });
  },
);

test('preserves a valid uninitialized English selection instead of replacing it with the system language', async () => {
  const readLocale = configure('en', false);
  await i18nService.initialize();
  expect(i18nService.getLanguage()).toBe('en');
  expect(readLocale).not.toHaveBeenCalled();
  expect(mocks.updateConfig).toHaveBeenCalledWith({ language: 'en', language_initialized: true });
});

test.each(['zh', 'fr', 'zh-CN', '', null, undefined])(
  'uses the bundled locale resolution for an uninitialized default or unsupported selection (%s)',
  async language => {
    const readLocale = configure(language, false, 'zh-TW');
    await i18nService.initialize();
    expect(i18nService.getLanguage()).toBe('zh');
    expect(i18nService.t('startupHeading')).toBe('正在启动');
    expect(readLocale).toHaveBeenCalledOnce();
    expect(mocks.updateConfig).toHaveBeenCalledWith({ language: 'zh', language_initialized: true });
  },
);

test('a queued language preference write does not prevent the initialized interface from becoming ready', async () => {
  configure('zh', false);
  mocks.updateConfig.mockImplementation(() => new Promise(() => {}));
  await i18nService.initialize();
  expect(i18nService.getLanguage()).toBe('zh');
  expect(mocks.updateConfig).toHaveBeenCalledWith({ language: 'zh', language_initialized: true });
});

test('repairing an invalid preference does not wait for a pending write', async () => {
  configure('fr', true);
  mocks.updateConfig.mockImplementation(() => new Promise(() => {}));
  await i18nService.initialize();
  expect(i18nService.t('startupHeading')).toBe('Starting');
  expect(mocks.updateConfig).toHaveBeenCalledWith({ language: 'en', language_initialized: true });
});

test('a rejected preference write keeps usable translated copy and reports the persistence error', async () => {
  configure('fr', true);
  const failure = new Error('preference write unavailable');
  mocks.updateConfig.mockRejectedValue(failure);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(i18nService.initialize()).resolves.toBeUndefined();
  expect(i18nService.t('startupHeading')).toBe('Starting');
  expect(warning).toHaveBeenCalledWith(
    '[StartupLanguage] Failed to save language preference:',
    failure,
  );
});
