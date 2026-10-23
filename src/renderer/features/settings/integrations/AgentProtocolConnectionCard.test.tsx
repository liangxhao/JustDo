// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import AgentProtocolConnectionCard from './AgentProtocolConnectionCard';

const language = vi.hoisted(() => ({ current: 'en' as 'zh' | 'en' }));
vi.mock('@/services/i18n', async () => {
  const { translations: dictionary } = await import('@/services/i18n/translations');
  return { i18nService: { t: (key: string) => dictionary[language.current][key] ?? key } };
});

const command = 'C:\\用户 数据\\' + '长路径\\'.repeat(8) + "O'Brien\\assistant-cli.exe";
const args = ['app-server', '--listen', 'stdio://'];
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  language.current = 'en';
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

const text = () => translations[language.current];
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const click = async (element: HTMLElement) => {
  await act(async () => { fireEvent.click(element); });
};
function setup() {
  const getStatus = vi.fn();
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', { agentCli: { getStatus } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, writeText };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const card = (value = command, example = 'stdio client example') => (
  <AgentProtocolConnectionCard
    command={value}
    webSocket={<section aria-label="WebSocket connection"><p>Separate connection</p></section>}
  >
    <p>{example}</p>
  </AgentProtocolConnectionCard>
);

test.each(['zh', 'en'] as const)('labels peer transports and copies the exact stdio configuration in %s', async locale => {
  language.current = locale;
  const api = setup();
  render(card());

  const region = screen.getByRole('region', { name: text().agentProtocolCodexTitle });
  expect(within(region).getByRole('heading', { level: 4, name: text().agentProtocolCodexTitle })).toBeTruthy();
  expect(within(region).getByText(text().agentProtocolCodexDescription)).toBeTruthy();
  const stdio = within(region).getByRole('region', { name: text().agentProtocolStdioTitle });
  const webSocket = within(region).getByRole('region', { name: 'WebSocket connection' });
  expect(stdio.parentElement).toBe(webSocket.parentElement);
  expect(within(stdio).getByRole('heading', { level: 5, name: text().agentProtocolStdioTitle })).toBeTruthy();
  expect(within(stdio).getByText(text().agentProtocolStdioDescription)).toBeTruthy();
  expect(within(stdio).getByText(text().agentProtocolArguments)).toBeTruthy();
  expect(within(stdio).getByText(args.join(' '))).toBeTruthy();
  expect(within(stdio).getByText('stdio client example')).toBeTruthy();
  expect(within(webSocket).queryByText('stdio client example')).toBeNull();
  expect(within(region).queryByRole('button', { name: text().agentCliCopyConfig })).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();

  await click(within(stdio).getByRole('button', { name: text().agentProtocolCodexCopyConfig }));

  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args });
  expect(button(text().agentProtocolCodexCopied)).toBeTruthy();
  expect(api.getStatus).not.toHaveBeenCalled();
});

test('waits for the shared command path before copying', async () => {
  const api = setup();
  const view = render(card(''));
  expect(button(text().agentProtocolCodexCopyConfig).disabled).toBe(true);
  await click(button(text().agentProtocolCodexCopyConfig));
  expect(api.writeText).not.toHaveBeenCalled();

  view.rerender(card());
  await click(button(text().agentProtocolCodexCopyConfig));

  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args });
});

test('repeat copying owns a fresh feedback lifetime', async () => {
  setup();
  render(card());
  vi.useFakeTimers();
  await click(button(text().agentProtocolCodexCopyConfig));
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  await click(button(text().agentProtocolCodexCopied));
  await act(async () => { await vi.advanceTimersByTimeAsync(900); });
  expect(button(text().agentProtocolCodexCopied)).toBeTruthy();

  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

  expect(button(text().agentProtocolCodexCopyConfig)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps feedback through an ordinary rerender', async () => {
  setup();
  const view = render(card());
  vi.useFakeTimers();
  await click(button(text().agentProtocolCodexCopyConfig));

  view.rerender(card(command, 'Updated example'));

  expect(button(text().agentProtocolCodexCopied)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(1);
});

test.each(['resolve', 'reject'] as const)('ignores an old clipboard %s after a command change', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  const view = render(card());
  vi.useFakeTimers();
  await click(button(text().agentProtocolCodexCopyConfig));
  const nextCommand = '/new profile/工具/assistant-cli';
  view.rerender(card(nextCommand));

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Old copy failed.'));
  });

  expect(screen.queryByRole('alert')).toBeNull();
  expect(button(text().agentProtocolCodexCopyConfig)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  await click(button(text().agentProtocolCodexCopyConfig));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command: nextCommand, args });
});

test.each(['resolve', 'reject'] as const)('ignores an old clipboard %s after a newer copy', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  render(card());
  vi.useFakeTimers();
  await click(button(text().agentProtocolCodexCopyConfig));
  await click(button(text().agentProtocolCodexCopyConfig));

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Old copy failed.'));
  });

  expect(button(text().agentProtocolCodexCopied)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
});

test('clears feedback timers on path changes and unmount', async () => {
  setup();
  const view = render(card());
  vi.useFakeTimers();
  await click(button(text().agentProtocolCodexCopyConfig));
  expect(vi.getTimerCount()).toBe(1);

  view.rerender(card('/new/profile/assistant-cli'));
  expect(vi.getTimerCount()).toBe(0);
  await click(button(text().agentProtocolCodexCopyConfig));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'] as const)('ignores clipboard %s after unmount', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  const view = render(card());
  vi.useFakeTimers();
  await click(button(text().agentProtocolCodexCopyConfig));
  view.unmount();

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Disposed copy failed.'));
  });

  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByRole('region', { name: text().agentProtocolCodexTitle })).toBeNull();
});

test('reports clipboard failure and allows a successful retry', async () => {
  const api = setup();
  api.writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
  render(card());
  await click(button(text().agentProtocolCodexCopyConfig));
  expect(screen.getByRole('alert').textContent).toBe(text().agentCliCopyFailed);

  await click(button(text().agentProtocolCodexCopyConfig));

  expect(screen.queryByRole('alert')).toBeNull();
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args });
});
