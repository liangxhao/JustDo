// @vitest-environment jsdom

import type { AgentCliIntegrationStatus } from '@shared/integrations/agentCliIntegration';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import AgentCliIntegrationCard from './AgentCliIntegrationCard';

const language = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));
vi.mock('@/services/i18n', async () => {
  const { translations: dictionary } = await import('@/services/i18n/translations');
  return { i18nService: { t: (key: string) => dictionary[language.current][key] ?? key } };
});

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const command = `C:\\用户 数据\\${'很长的工具目录\\'.repeat(8)}O'Brien\\assistant-cli.exe`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  language.current = 'zh';
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function snapshot(overrides: Partial<AgentCliIntegrationStatus> = {}): AgentCliIntegrationStatus {
  return {
    supported: true,
    command,
    launcherReady: true,
    bridgeRunning: true,
    activeTaskCount: 2,
    gatewayPhase: 'stopped',
    ...overrides,
  };
}

function setup(initial = snapshot()) {
  const getStatus = vi.fn(async (): Promise<AgentCliIntegrationStatus> => initial);
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', { agentCli: { getStatus } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, writeText };
}

async function mount(onCommandChange?: (command: string) => void) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<AgentCliIntegrationCard onCommandChange={onCommandChange} />); });
  return view;
}

const text = () => translations[language.current];
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const click = async (target: HTMLElement) => {
  await act(async () => { fireEvent.click(target); });
};

test.each(['zh', 'en'] as const)('shows the available entry without an enable switch in %s', async currentLanguage => {
  language.current = currentLanguage;
  const api = setup();
  await mount();

  expect(screen.getByRole('status').textContent).toBe(text().agentCliReady);
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(button(text().agentCliCopyCommand).disabled).toBe(false);
  expect(button(text().agentCliCopyConfig).disabled).toBe(false);
  expect(screen.getByText('acp')).toBeTruthy();
  expect(screen.getByText(command).textContent).toBe(command);
  expect(screen.getByText(text().agentCliActiveTasks.replace('{count}', '2'))).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();
});

test.each([
  { launcherReady: true, bridgeRunning: true, expected: 'agentCliReady' },
  { launcherReady: false, bridgeRunning: true, expected: 'agentCliNotReady' },
  { launcherReady: true, bridgeRunning: false, expected: 'agentCliNotReady' },
  { launcherReady: false, bridgeRunning: false, expected: 'agentCliNotReady' },
])('reports command readiness for %j without requiring a running model runtime', async state => {
  setup(snapshot({ launcherReady: state.launcherReady, bridgeRunning: state.bridgeRunning }));
  await mount();

  expect(screen.getByRole('status').textContent).toBe(text()[state.expected]);
  expect(screen.queryByRole('switch')).toBeNull();
});

test('shows unsupported explicitly without offering an enable switch', async () => {
  setup(snapshot({ supported: false }));
  await mount();

  expect(screen.getByRole('status').textContent).toBe(text().agentCliUnsupported);
  expect(screen.queryByRole('switch')).toBeNull();
});

test('copies the original long path containing spaces, Chinese and an apostrophe without shell quoting', async () => {
  const api = setup();
  await mount();

  await click(button(text().agentCliCopyCommand));

  expect(api.writeText).toHaveBeenCalledExactlyOnceWith(command);
  expect(button(text().agentCliCommandCopied)).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();
});

test('copies ACP configuration from the shared CLI path with the exact launch argument', async () => {
  const api = setup();
  await mount();

  await click(button(text().agentCliCopyConfig));

  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args: ['acp'] });
  expect(button(text().agentCliCopied)).toBeTruthy();
  expect(button(text().agentCliCopyCommand)).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();
});

test.each(['resolve', 'reject'] as const)('ignores an ACP copy that later %ss after copying the path', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyConfig));
  await click(button(text().agentCliCopyCommand));

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Old ACP copy failed.'));
  });

  expect(button(text().agentCliCommandCopied)).toBeTruthy();
  expect(button(text().agentCliCopyConfig)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
});

test.each(['resolve', 'reject'] as const)('retires an ACP copy that later %ss after the shared command changes', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyConfig));
  const nextCommand = 'D:\\新目录 空格\\assistant-cli.exe';
  api.getStatus.mockResolvedValueOnce(snapshot({ command: nextCommand }));
  await click(button(text().agentCliRefresh));

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Old ACP copy failed.'));
  });

  expect(button(text().agentCliCopyConfig)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByRole('alert')).toBeNull();
  await click(button(text().agentCliCopyConfig));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command: nextCommand, args: ['acp'] });
});

test('a newer path copy keeps its own full feedback lifetime', async () => {
  setup();
  await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyCommand));
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  await click(button(text().agentCliCommandCopied));
  await act(async () => { await vi.advanceTimersByTimeAsync(900); });
  expect(button(text().agentCliCommandCopied)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(button(text().agentCliCopyCommand)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'] as const)(
  'ignores an older path copy that later %ss after a newer copy',
  async settlement => {
    const api = setup();
    const first = deferred<void>();
    api.writeText.mockReturnValueOnce(first.promise);
    await mount();
    vi.useFakeTimers();
    await click(button(text().agentCliCopyCommand));
    await click(button(text().agentCliCopyCommand));
    await act(async () => {
      if (settlement === 'resolve') first.resolve(undefined);
      else first.reject(new Error('Previous clipboard operation failed.'));
    });
    expect(button(text().agentCliCommandCopied)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  },
);

test.each(['resolve', 'reject'] as const)(
  'ignores a clipboard operation that later %ss after the executable path changes',
  async settlement => {
    const api = setup();
    const pending = deferred<void>();
    api.writeText.mockReturnValueOnce(pending.promise);
    await mount();
    vi.useFakeTimers();
    await click(button(text().agentCliCopyCommand));
    const nextCommand = 'D:\\新环境 目录\\assistant-cli.exe';
    api.getStatus.mockResolvedValueOnce(snapshot({ command: nextCommand }));

    await click(button(text().agentCliRefresh));
    expect(screen.getByText(nextCommand).textContent).toBe(nextCommand);
    await act(async () => {
      if (settlement === 'resolve') pending.resolve(undefined);
      else pending.reject(new Error('Old path copy failed.'));
    });

    expect(button(text().agentCliCopyCommand)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await click(button(text().agentCliCopyCommand));
    expect(api.writeText).toHaveBeenLastCalledWith(nextCommand);
  },
);

test('an older clipboard success cannot clear a newer status failure when the command is unchanged', async () => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyCommand));
  api.getStatus.mockRejectedValueOnce(new Error('Status read failed.'));

  await click(button(text().agentCliRefresh));
  expect(screen.getByRole('alert').textContent).toBe(text().agentCliStatusFailed);
  await act(async () => { pending.resolve(undefined); });

  expect(screen.getByRole('alert').textContent).toBe(text().agentCliStatusFailed);
  expect(screen.getByText(command).textContent).toBe(command);
  expect(button(text().agentCliCopyCommand)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

test('a status read clears existing copy feedback even when the path stays the same', async () => {
  const api = setup();
  await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyCommand));
  expect(vi.getTimerCount()).toBe(1);

  await click(button(text().agentCliRefresh));

  expect(button(text().agentCliCopyCommand)).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('unmount cancels existing copy feedback timers', async () => {
  setup();
  const view = await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyCommand));
  expect(vi.getTimerCount()).toBe(1);

  view.unmount();

  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'] as const)('ignores clipboard %s after unmount', async settlement => {
  const api = setup();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  const view = await mount();
  vi.useFakeTimers();
  await click(button(text().agentCliCopyCommand));
  view.unmount();

  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Disposed clipboard operation.'));
  });

  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByRole('region', { name: text().agentCliTitle })).toBeNull();
});

test('refresh only reads status and blocks duplicate reads while pending', async () => {
  const api = setup();
  await mount();
  const pending = deferred<AgentCliIntegrationStatus>();
  api.getStatus.mockReturnValueOnce(pending.promise);

  await click(button(text().agentCliRefresh));
  expect(button(text().agentCliRefresh).disabled).toBe(true);
  await click(button(text().agentCliRefresh));
  expect(api.getStatus).toHaveBeenCalledTimes(2);

  await act(async () => { pending.resolve(snapshot()); });
  expect(button(text().agentCliRefresh).disabled).toBe(false);
  expect(screen.queryByRole('switch')).toBeNull();
});

test('initial loading disables copy and duplicate reads until the status is known', async () => {
  const api = setup();
  const pending = deferred<AgentCliIntegrationStatus>();
  api.getStatus.mockReturnValueOnce(pending.promise);
  render(<AgentCliIntegrationCard />);

  expect(screen.getByRole('status').textContent).toBe(text().agentCliLoading);
  expect(button(text().agentCliRefresh).disabled).toBe(true);
  expect(button(text().agentCliCopyCommand).disabled).toBe(true);
  expect(button(text().agentCliCopyConfig).disabled).toBe(true);
  await click(button(text().agentCliRefresh));
  expect(api.getStatus).toHaveBeenCalledOnce();

  await act(async () => { pending.resolve(snapshot()); });
  expect(screen.getByRole('status').textContent).toBe(text().agentCliReady);
});

test('an initial status failure ends loading and a retry can recover', async () => {
  const api = setup();
  api.getStatus.mockRejectedValueOnce(new Error('Initial status read failed.'));
  await mount();

  expect(screen.getByRole('status').textContent).toBe(text().agentCliNotReady);
  expect(screen.getByRole('alert').textContent).toBe(text().agentCliStatusFailed);
  expect(button(text().agentCliRefresh).disabled).toBe(false);
  expect(button(text().agentCliCopyCommand).disabled).toBe(true);
  const retry = deferred<AgentCliIntegrationStatus>();
  api.getStatus.mockReturnValueOnce(retry.promise);

  await click(button(text().agentCliRefresh));
  expect(screen.getByRole('status').textContent).toBe(text().agentCliLoading);
  await act(async () => { retry.resolve(snapshot()); });

  expect(screen.getByRole('status').textContent).toBe(text().agentCliReady);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(button(text().agentCliRefresh).disabled).toBe(false);
  expect(button(text().agentCliCopyCommand).disabled).toBe(false);
  expect(api.getStatus).toHaveBeenCalledTimes(2);
});

test('failed clipboard access reports an error without changing readiness', async () => {
  const api = setup();
  api.writeText.mockRejectedValueOnce(new Error('Clipboard unavailable.'));
  await mount();

  await click(button(text().agentCliCopyCommand));

  expect(screen.getByRole('alert').textContent).toBe(text().agentCliCopyFailed);
  expect(screen.getByRole('status').textContent).toBe(text().agentCliReady);
  await click(button(text().agentCliCopyCommand));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(button(text().agentCliCommandCopied)).toBeTruthy();
});

test('shares the committed command with examples without rereading when the callback changes', async () => {
  const api = setup();
  const first = vi.fn();
  const view = await mount(first);
  expect(first).toHaveBeenLastCalledWith(command);
  const second = vi.fn();

  view.rerender(<AgentCliIntegrationCard onCommandChange={second} />);

  expect(second).toHaveBeenCalledExactlyOnceWith(command);
  expect(api.getStatus).toHaveBeenCalledOnce();
  const nextCommand = 'D:\\另一个环境\\assistant-cli.exe';
  api.getStatus.mockResolvedValueOnce(snapshot({ command: nextCommand }));
  await click(button(text().agentCliRefresh));
  expect(second).toHaveBeenLastCalledWith(nextCommand);
});

test('does not publish a status response that arrives after the card was unmounted', async () => {
  const api = setup();
  const pending = deferred<AgentCliIntegrationStatus>();
  api.getStatus.mockReturnValueOnce(pending.promise);
  const onCommandChange = vi.fn();
  const view = await mount(onCommandChange);
  onCommandChange.mockClear();

  view.unmount();
  await act(async () => { pending.resolve(snapshot()); });

  expect(onCommandChange).not.toHaveBeenCalled();
});
