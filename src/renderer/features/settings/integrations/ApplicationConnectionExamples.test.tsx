// @vitest-environment jsdom

import { PRODUCT_NAME } from '@shared/productMetadata';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import ApplicationConnectionExamples from './ApplicationConnectionExamples';

const language = vi.hoisted(() => ({ current: 'en' as 'zh' | 'en' }));
vi.mock('@/services/i18n', async () => {
  const { translations: dictionary } = await import('@/services/i18n/translations');
  return { i18nService: { t: (key: string) => dictionary[language.current][key] ?? key } };
});
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const command = `C:\\用户 数据\\${'长路径\\'.repeat(8)}O'Brien\\assistant-cli.exe`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  language.current = 'en';
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

const text = () => translations[language.current];
const label = (field: string, copied = false) => text()[
  copied ? 'applicationConnectionValueCopied' : 'applicationConnectionCopyValue'
].replace('{field}', field);
const copyButton = (field: string, copied = false) => screen.getByRole<HTMLButtonElement>(
  'button', { name: label(field, copied) },
);
const click = async (element: HTMLElement) => {
  await act(async () => { fireEvent.click(element); });
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
function setup() {
  const getStatus = vi.fn();
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', { agentCli: { getStatus } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, writeText };
}

function renderExample(value: string, open = true) {
  const view = render(<ApplicationConnectionExamples command={value} />);
  if (open) fireEvent.click(screen.getByText(text().applicationConnectionExampleSummary));
  return view;
}

test.each(['zh', 'en'] as const)('starts the client example collapsed and opens it without backend settings in %s', currentLanguage => {
  language.current = currentLanguage;
  const api = setup();
  renderExample(command, false);

  const summary = screen.getByText(text().applicationConnectionExampleSummary);
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(summary.querySelector('button')).toBeNull();
  expect(screen.queryByRole('heading')).toBeNull();
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(screen.getByText('codex')).toBeTruthy();
  expect(screen.getByText(text().applicationConnectionExamplesDescription).textContent).toContain('Codex app-server');
  expect(screen.getByText(text().applicationConnectionLaunchDescription).textContent).toContain('app-server --listen stdio://');
  expect(screen.getByText(PRODUCT_NAME)).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(api.getStatus).not.toHaveBeenCalled();
});

test('copies the exact Codex setup values and the raw command without ACP arguments or quoting', async () => {
  const api = setup();
  renderExample(command);

  for (const [field, value] of [
    [text().applicationConnectionProtocol, 'codex'],
    [text().applicationConnectionName, PRODUCT_NAME],
    [text().agentCliCommand, command],
    [text().applicationConnectionDescription, text().applicationConnectionRuntimeDescription],
  ]) {
    await click(copyButton(field));
    expect(api.writeText).toHaveBeenLastCalledWith(value);
    expect(copyButton(field, true)).toBeTruthy();
  }
  expect(api.writeText).toHaveBeenCalledTimes(4);
  expect(api.getStatus).not.toHaveBeenCalled();
});

test('leaves command copying unavailable until its parent supplies the path', async () => {
  const api = setup();
  const view = renderExample('');

  expect(copyButton(text().agentCliCommand).disabled).toBe(true);
  await click(copyButton(text().agentCliCommand));
  expect(api.writeText).not.toHaveBeenCalled();
  view.rerender(<ApplicationConnectionExamples command={command} />);
  expect(copyButton(text().agentCliCommand).disabled).toBe(false);
  await click(copyButton(text().agentCliCommand));
  expect(api.writeText).toHaveBeenCalledExactlyOnceWith(command);
});

test('a newer field copy owns its feedback lifetime after the old expiry deadline', async () => {
  setup();
  renderExample(command);
  vi.useFakeTimers();
  await click(copyButton(text().applicationConnectionProtocol));
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

  await click(copyButton(text().agentCliCommand));
  await act(async () => { await vi.advanceTimersByTimeAsync(900); });

  expect(copyButton(text().agentCliCommand, true)).toBeTruthy();
  expect(copyButton(text().applicationConnectionProtocol)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(copyButton(text().agentCliCommand)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'] as const)('ignores an old copy that later %ss after copying another field', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  renderExample(command);
  vi.useFakeTimers();
  await click(copyButton(text().agentCliCommand));
  await click(copyButton(text().applicationConnectionName));

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Previous copy failed.'));
  });

  expect(copyButton(text().applicationConnectionName, true)).toBeTruthy();
  expect(copyButton(text().agentCliCommand)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
});

test.each(['resolve', 'reject'] as const)('ignores an old command copy that later %ss after a profile path update', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  const view = renderExample(command);
  vi.useFakeTimers();
  await click(copyButton(text().agentCliCommand));
  const nextCommand = 'D:\\新配置\\assistant-cli.exe';

  view.rerender(<ApplicationConnectionExamples command={nextCommand} />);
  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Old command copy failed.'));
  });

  expect(copyButton(text().agentCliCommand)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await click(copyButton(text().agentCliCommand));
  expect(api.writeText).toHaveBeenLastCalledWith(nextCommand);
});

test('path changes and unmount both clear feedback timers', async () => {
  setup();
  const view = renderExample(command);
  vi.useFakeTimers();
  await click(copyButton(text().agentCliCommand));
  expect(vi.getTimerCount()).toBe(1);

  view.rerender(<ApplicationConnectionExamples command="/new/profile/assistant-cli" />);
  expect(copyButton(text().agentCliCommand)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  await click(copyButton(text().agentCliCommand));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('clipboard failure stays within the example and a later copy can recover', async () => {
  const api = setup();
  api.writeText.mockRejectedValueOnce(new Error('Clipboard unavailable.'));
  renderExample(command);

  await click(copyButton(text().agentCliCommand));
  expect(screen.getByRole('alert').textContent).toBe(text().agentCliCopyFailed);
  await click(copyButton(text().applicationConnectionProtocol));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(copyButton(text().applicationConnectionProtocol, true)).toBeTruthy();
  expect(api.getStatus).not.toHaveBeenCalled();
});

test.each(['resolve', 'reject'] as const)('ignores a clipboard %s after unmount', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  const view = renderExample(command);
  vi.useFakeTimers();
  await click(copyButton(text().agentCliCommand));
  view.unmount();

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Disposed clipboard operation.'));
  });

  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByText(text().applicationConnectionExampleSummary)).toBeNull();
});

test('keeps its disclosure state through a command update and never copies from the summary', async () => {
  const api = setup();
  const view = renderExample(command);
  const summary = screen.getByText(text().applicationConnectionExampleSummary);
  const details = summary.closest('details')!;
  const nextCommand = '/new/profile/assistant-cli';

  view.rerender(<ApplicationConnectionExamples command={nextCommand} />);
  expect(details.open).toBe(true);
  await click(summary);
  expect(details.open).toBe(false);
  await click(summary);
  expect(details.open).toBe(true);
  expect(api.writeText).not.toHaveBeenCalled();
  expect(api.getStatus).not.toHaveBeenCalled();
  await click(copyButton(text().agentCliCommand));
  expect(api.writeText).toHaveBeenCalledExactlyOnceWith(nextCommand);
});
