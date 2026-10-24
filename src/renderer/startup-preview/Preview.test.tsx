// @vitest-environment jsdom
import { StartupRoute } from '@shared/app/startup/routing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import Preview from './Preview';
import { installPreviewBridge, type PreviewOptions } from './state';

let dispose: (() => void) | undefined;
afterEach(() => {
  cleanup();
  dispose?.();
  document.documentElement.removeAttribute('data-startup-entry-started-at');
  vi.restoreAllMocks();
});

function mount(options: PreviewOptions) {
  i18nService.setLanguage(options.language, { persist: false });
  dispose = installPreviewBridge(
    window,
    true,
    options,
    action => window.dispatchEvent(new CustomEvent('startup-preview-action', { detail: action })),
    Date.now(),
    () => (document.documentElement.lang === 'en' ? 'en' : 'zh'),
  );
  return render(<Preview options={options} />);
}

test('confirmation after a long human wait resets only the activity clock', async () => {
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
  mount({ route: StartupRoute.Upgrade, language: 'en', theme: 'light' });
  fireEvent.change(screen.getByLabelText('Simulated state'), { target: { value: 'failed' } });
  fireEvent.change(screen.getByLabelText('Simulated failure kind'), {
    target: { value: 'downgrade' },
  });
  time.mockReturnValue(102000);
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('startupDowngradeContinue') }));
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: i18nService.t('startupDowngradeTitle') }),
    ).toBeNull(),
  );
  expect(screen.getByText('01:41')).toBeTruthy();
  expect(screen.getByText('00:00')).toBeTruthy();
  expect(screen.queryByText(i18nService.t('initializationExtendedWait'))).toBeNull();
});

test.each(
  [StartupRoute.Upgrade, StartupRoute.Normal].flatMap(route =>
    (['zh', 'en'] as const).flatMap(language => [
      { route, language, kind: 'versionUnknown', key: 'startupCompatibilityUnknown' },
      { route, language, kind: 'dataUnsupported', key: 'startupCompatibilitySchema' },
    ]),
  ),
)(
  'simulates actual $kind advice on $route in $language without native access',
  ({ route, language, kind, key }) => {
    mount({ route, language, theme: 'light' });
    fireEvent.change(screen.getByLabelText(language === 'zh' ? '模拟状态' : 'Simulated state'), {
      target: { value: 'failed' },
    });
    fireEvent.change(
      screen.getByLabelText(language === 'zh' ? '模拟错误种类' : 'Simulated failure kind'),
      { target: { value: kind } },
    );
    expect(screen.getByRole('heading', { name: i18nService.t(key) })).toBeTruthy();
    expect(screen.getByText(i18nService.t(`${key}Description`))).toBeTruthy();
    expect(window.electron).not.toHaveProperty('openclaw');
    expect(window.electron).not.toHaveProperty('store');
  },
);

test.each(
  [StartupRoute.Upgrade, StartupRoute.Normal].flatMap(route =>
    (['zh', 'en'] as const).map(language => ({ route, language })),
  ),
)(
  'downgrade confirmation on $route in $language only resumes this in-memory presentation',
  async ({ route, language }) => {
    mount({ route, language, theme: 'light' });
    fireEvent.change(screen.getByLabelText(language === 'zh' ? '模拟状态' : 'Simulated state'), {
      target: { value: 'failed' },
    });
    fireEvent.change(
      screen.getByLabelText(language === 'zh' ? '模拟错误种类' : 'Simulated failure kind'),
      { target: { value: 'downgrade' } },
    );
    expect(
      screen.getByRole('heading', { name: i18nService.t('startupDowngradeTitle') }),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: i18nService.t('startupDowngradeContinue') }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: i18nService.t('startupDowngradeTitle') }),
      ).toBeNull(),
    );
    expect(
      (
        screen.getByLabelText(
          language === 'zh' ? '模拟状态' : 'Simulated state',
        ) as HTMLSelectElement
      ).value,
    ).toBe('preparing');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(window.electron).not.toHaveProperty('openclaw');
    expect(window.electron).not.toHaveProperty('store');
  },
);

test.each(
  Object.values(StartupRoute).flatMap(route =>
    (['zh', 'en'] as const).map(language => ({ route, language, theme: 'light' as const })),
  ),
)('renders actual $route startup components in $language with visibly synthetic state', options => {
  const view = mount(options);
  expect(screen.getByRole('complementary').textContent).toContain(
    options.language === 'zh' ? '不读取用户资料' : 'No user profile',
  );
  expect(
    view.container.querySelector('[data-startup-view]')?.getAttribute('data-startup-view'),
  ).toBe(
    options.route === 'normal'
      ? 'launch'
      : options.route === 'fresh'
        ? 'first-launch'
        : options.route,
  );
  expect(screen.getAllByRole('link')).toHaveLength(4);
  if (options.route === StartupRoute.Migration) {
    expect(view.container.querySelector('[data-history-result]')).toBeNull();
    expect(view.container.textContent).not.toContain(
      i18nService.t('initializationHistoryRecovered'),
    );
  }
  if (options.route === StartupRoute.Upgrade) {
    const label = i18nService.t('initializationRetainedData');
    expect(screen.getByRole('option', { name: `2 · ${label}` })).toBeTruthy();
    expect(view.container.querySelector('[data-startup-panel] nav')?.textContent).toContain(label);
  }
  const theme = screen.getByLabelText(options.language === 'zh' ? '主题' : 'Theme');
  fireEvent.change(theme, { target: { value: 'dark' } });
  expect(document.documentElement.dataset.theme).toBe('classic-dark');
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  fireEvent.change(theme, { target: { value: 'light' } });
  expect(document.documentElement.dataset.theme).toBe('classic-light');
});

test('step, native operation, language, failure and retry change only presentation state', async () => {
  const view = mount({ route: StartupRoute.Upgrade, language: 'zh', theme: 'dark' });
  fireEvent.change(screen.getByLabelText('模拟维护操作'), { target: { value: 'nativeVerify' } });
  expect(view.container.textContent).toContain(
    i18nService.t('initializationActivity_nativeVerify'),
  );
  fireEvent.change(screen.getByLabelText('模拟步骤'), { target: { value: '2' } });
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  fireEvent.change(screen.getByLabelText('模拟状态'), { target: { value: 'failed' } });
  expect(screen.getByRole('alert').textContent).toContain('模拟错误');
  fireEvent.click(screen.getByRole('button', { name: '重新演练' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('complementary').textContent).toContain('No user profile');
  fireEvent.change(screen.getByLabelText('Simulated state'), { target: { value: 'failed' } });
  expect(await screen.findByText('No log file in rehearsal')).toBeTruthy();
  expect(screen.queryByText('演练无日志文件')).toBeNull();
  expect(screen.getByRole('link', { name: 'Normal upgrade' }).getAttribute('href')).toContain(
    'language=en',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(
    screen.getByText('Rehearsal action recorded; no system operation was performed.'),
  ).toBeTruthy();
  expect(window.electron).not.toHaveProperty('store');
});

test('completed migration result and support actions do not open directories or a workspace', async () => {
  mount({ route: StartupRoute.Migration, language: 'en', theme: 'light' });
  fireEvent.change(screen.getByLabelText('Simulated state'), { target: { value: 'ready' } });
  expect(screen.getByRole('region')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('initializationOpenBackup') }));
  expect(
    await screen.findByText('Rehearsal action recorded; no system operation was performed.'),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('initializationResultContinue') }),
  );
  expect(
    screen.getByText('Entering the application was simulated; no actual workspace was started.'),
  ).toBeTruthy();
});
