// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import AgentProtocolConnectionCard, { AgentConnectionProtocol } from './AgentProtocolConnectionCard';

const language = vi.hoisted(() => ({ current: 'en' as 'zh' | 'en' }));
vi.mock('@/services/i18n', async () => {
  const { translations: dictionary } = await import('@/services/i18n/translations');
  return { i18nService: { t: (key: string) => dictionary[language.current][key] ?? key } };
});

const cases = [
  {
    protocol: AgentConnectionProtocol.Acp,
    title: 'agentProtocolAcpTitle',
    description: 'agentProtocolAcpDescription',
    args: ['acp'],
    copy: 'agentCliCopyConfig',
    copied: 'agentCliCopied',
  },
  {
    protocol: AgentConnectionProtocol.CodexAppServer,
    title: 'agentProtocolCodexTitle',
    description: 'agentProtocolCodexDescription',
    args: ['app-server', '--listen', 'stdio://'],
    copy: 'agentProtocolCodexCopyConfig',
    copied: 'agentProtocolCodexCopied',
  },
] as const;

const command = `C:\\用户 数据\\${'长路径\\'.repeat(8)}O'Brien\\assistant-cli.exe`;
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

test.each(cases)('$protocol presents its own title, negotiated scope and exact launch arguments', async item => {
  const api = setup();
  for (const currentLanguage of ['zh', 'en'] as const) {
    language.current = currentLanguage;
    const view = render(
      <AgentProtocolConnectionCard protocol={item.protocol} command={command}>
        <p>Optional client example</p>
      </AgentProtocolConnectionCard>,
    );

    const region = screen.getByRole('region', { name: text()[item.title] });
    expect(within(region).getByRole('heading', { level: 4, name: text()[item.title] })).toBeTruthy();
    expect(within(region).getByText(text()[item.description])).toBeTruthy();
    expect(within(region).getByText(item.args.join(' '))).toBeTruthy();
    expect(within(region).getByText(text().agentProtocolArguments)).toBeTruthy();
    expect(within(region).getByText('Optional client example')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    await click(button(text()[item.copy]));
    expect(api.writeText).toHaveBeenLastCalledWith(JSON.stringify({ command, args: item.args }, null, 2));
    expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args: item.args });
    expect(button(text()[item.copied])).toBeTruthy();
    view.unmount();
  }
  expect(api.getStatus).not.toHaveBeenCalled();
});

test.each(cases)('$protocol copying waits for the shared command path', async item => {
  const api = setup();
  const view = render(<AgentProtocolConnectionCard protocol={item.protocol} command="" />);

  expect(button(text()[item.copy]).disabled).toBe(true);
  await click(button(text()[item.copy]));
  expect(api.writeText).not.toHaveBeenCalled();
  view.rerender(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
  expect(button(text()[item.copy]).disabled).toBe(false);
  await click(button(text()[item.copy]));
  expect(JSON.parse(api.writeText.mock.calls[0][0])).toEqual({ command, args: item.args });
});

test.each(cases)('$protocol repeat copying gets a fresh feedback lifetime', async item => {
  setup();
  render(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
  vi.useFakeTimers();
  await click(button(text()[item.copy]));
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

  await click(button(text()[item.copied]));
  await act(async () => { await vi.advanceTimersByTimeAsync(900); });

  expect(button(text()[item.copied])).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(button(text()[item.copy])).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(cases)('$protocol keeps copy feedback through ordinary rerenders', async item => {
  const api = setup();
  const view = render(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
  vi.useFakeTimers();
  await click(button(text()[item.copy]));

  view.rerender(
    <AgentProtocolConnectionCard protocol={item.protocol} command={command}>
      <p>Updated example content</p>
    </AgentProtocolConnectionCard>,
  );

  expect(button(text()[item.copied])).toBeTruthy();
  expect(vi.getTimerCount()).toBe(1);
  expect(api.writeText).toHaveBeenCalledOnce();
});

test.each(cases)('$protocol ignores stale command-copy success and failure after a path update', async item => {
  const api = setup();
  for (const settlement of ['resolve', 'reject'] as const) {
    const pending = deferred<void>();
    api.writeText.mockReturnValueOnce(pending.promise);
    const view = render(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
    vi.useFakeTimers();
    await click(button(text()[item.copy]));
    const nextCommand = '/new profile/工具/assistant-cli';

    view.rerender(<AgentProtocolConnectionCard protocol={item.protocol} command={nextCommand} />);
    await act(async () => {
      if (settlement === 'resolve') pending.resolve(undefined);
      else pending.reject(new Error('Previous profile copy failed.'));
    });

    expect(button(text()[item.copy])).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await click(button(text()[item.copy]));
    expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command: nextCommand, args: item.args });
    view.unmount();
  }
});

test.each(cases)('$protocol ignores an old clipboard response after a newer copy', async item => {
  const api = setup();
  for (const settlement of ['resolve', 'reject'] as const) {
    const pending = deferred<void>();
    api.writeText.mockReturnValueOnce(pending.promise);
    const view = render(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
    vi.useFakeTimers();
    await click(button(text()[item.copy]));
    await click(button(text()[item.copy]));

    await act(async () => {
      if (settlement === 'resolve') pending.resolve(undefined);
      else pending.reject(new Error('Older clipboard operation failed.'));
    });

    expect(button(text()[item.copied])).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
  }
});

test.each(cases)('$protocol clears feedback timers on path updates and unmount', async item => {
  setup();
  const view = render(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
  vi.useFakeTimers();
  await click(button(text()[item.copy]));
  expect(vi.getTimerCount()).toBe(1);

  view.rerender(<AgentProtocolConnectionCard protocol={item.protocol} command="/new/profile/cli" />);
  expect(button(text()[item.copy])).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  await click(button(text()[item.copy]));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(cases)('$protocol ignores clipboard settlements after unmount', async item => {
  const api = setup();
  for (const settlement of ['resolve', 'reject'] as const) {
    const pending = deferred<void>();
    api.writeText.mockReturnValueOnce(pending.promise);
    const view = render(<AgentProtocolConnectionCard protocol={item.protocol} command={command} />);
    vi.useFakeTimers();
    await click(button(text()[item.copy]));
    view.unmount();

    await act(async () => {
      if (settlement === 'resolve') pending.resolve(undefined);
      else pending.reject(new Error('Disposed clipboard operation failed.'));
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole('region', { name: text()[item.title] })).toBeNull();
  }
});

test('changing the protocol invalidates pending feedback even when the command is unchanged', async () => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  const view = render(<AgentProtocolConnectionCard protocol={AgentConnectionProtocol.Acp} command={command} />);
  vi.useFakeTimers();
  await click(button(text().agentCliCopyConfig));

  view.rerender(<AgentProtocolConnectionCard protocol={AgentConnectionProtocol.CodexAppServer} command={command} />);
  await act(async () => { pending.resolve(undefined); });

  expect(button(text().agentProtocolCodexCopyConfig)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  await click(button(text().agentProtocolCodexCopyConfig));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args: ['app-server', '--listen', 'stdio://'] });
});

test('keeps feedback and errors isolated between the ACP and Codex cards', async () => {
  const api = setup();
  api.writeText.mockRejectedValueOnce(new Error('ACP clipboard access failed.'));
  render(<>
    <AgentProtocolConnectionCard protocol={AgentConnectionProtocol.Acp} command={command} />
    <AgentProtocolConnectionCard protocol={AgentConnectionProtocol.CodexAppServer} command={command} />
  </>);
  const acp = within(screen.getByRole('region', { name: text().agentProtocolAcpTitle }));
  const codex = within(screen.getByRole('region', { name: text().agentProtocolCodexTitle }));

  await click(acp.getByRole('button', { name: text().agentCliCopyConfig }));
  expect(acp.getByRole('alert').textContent).toBe(text().agentCliCopyFailed);
  expect(codex.queryByRole('alert')).toBeNull();
  await click(codex.getByRole('button', { name: text().agentProtocolCodexCopyConfig }));
  expect(codex.getByRole('button', { name: text().agentProtocolCodexCopied })).toBeTruthy();
  expect(acp.getByRole('alert').textContent).toBe(text().agentCliCopyFailed);
  await click(acp.getByRole('button', { name: text().agentCliCopyConfig }));
  expect(acp.queryByRole('alert')).toBeNull();
  expect(acp.getByRole('button', { name: text().agentCliCopied })).toBeTruthy();
  expect(codex.getByRole('button', { name: text().agentProtocolCodexCopied })).toBeTruthy();
  expect(api.getStatus).not.toHaveBeenCalled();
});
