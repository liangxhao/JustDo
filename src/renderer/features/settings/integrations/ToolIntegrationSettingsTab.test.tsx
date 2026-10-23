// @vitest-environment jsdom

import type { AgentCliIntegrationStatus } from '@shared/integrations/agentCliIntegration';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import ToolIntegrationSettingsTab from './ToolIntegrationSettingsTab';

vi.mock('@/services/i18n', async () => {
  const { translations: dictionary } = await import('@/services/i18n/translations');
  return { i18nService: { t: (key: string) => dictionary.en[key] ?? key } };
});

const text = translations.en;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const command = 'C:\\工具 目录\\assistant-cli.exe';
const status: AgentCliIntegrationStatus = {
  supported: true,
  command,
  launcherReady: true,
  bridgeRunning: true,
  activeTaskCount: 0,
  gatewayPhase: 'stopped',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function setup() {
  const getStatus = vi.fn(async (): Promise<AgentCliIntegrationStatus> => status);
  const getWebSocketStatus = vi.fn(async () => ({ running: true, url: 'ws://127.0.0.1:34567/app-server' }));
  const getConnectionConfig = vi.fn();
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', {
    agentCli: { getStatus },
    appServer: { getStatus: getWebSocketStatus, getConnectionConfig },
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, getWebSocketStatus, getConnectionConfig, writeText };
}
const click = async (element: HTMLElement) => {
  await act(async () => { fireEvent.click(element); });
};

test('groups ACP under CLI and keeps both app-server transports at the same level', async () => {
  const api = setup();
  await act(async () => { render(<ToolIntegrationSettingsTab />); });
  const cliRegion = screen.getByRole('region', { name: text.agentCliTitle });
  const codexRegion = screen.getByRole('region', { name: text.agentProtocolCodexTitle });
  const cli = within(cliRegion);
  const codex = within(codexRegion);
  const summary = codex.getByText(text.applicationConnectionExampleSummary);
  const details = summary.closest('details')!;
  const example = within(details);
  const exampleCopyName = text.applicationConnectionCopyValue.replace('{field}', text.agentCliCommand);
  vi.useFakeTimers();

  expect(api.getStatus).toHaveBeenCalledOnce();
  expect(api.getWebSocketStatus).toHaveBeenCalledOnce();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  const stdio = codex.getByRole('region', { name: text.agentProtocolStdioTitle });
  expect(within(stdio).getByRole('heading', { level: 5, name: text.agentProtocolStdioTitle })).toBeTruthy();
  expect(within(stdio).getByText(text.agentProtocolStdioDescription)).toBeTruthy();
  expect(stdio.contains(details)).toBe(true);
  const webSocket = codex.getByRole('region', { name: text.appServerWebSocketTitle });
  expect(stdio.parentElement).toBe(webSocket.parentElement);
  expect(stdio.contains(webSocket)).toBe(false);
  expect(webSocket.contains(stdio)).toBe(false);
  expect(screen.queryByText(/Chrome/)).toBeNull();
  expect(within(webSocket).queryByText(text.applicationConnectionExampleSummary)).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByRole('region', { name: 'ACP' })).toBeNull();
  expect(cliRegion.parentElement).toBe(codexRegion.parentElement);
  expect(cliRegion.contains(codexRegion)).toBe(false);
  expect(cli.queryByText(text.applicationConnectionExampleSummary)).toBeNull();
  expect(details.open).toBe(false);
  expect(cli.getByText(command)).toBeTruthy();
  expect(cli.getByText('acp')).toBeTruthy();
  expect(codex.queryByRole('button', { name: text.agentCliCopyConfig })).toBeNull();

  await click(cli.getByRole('button', { name: text.agentCliCopyCommand }));
  expect(api.writeText).toHaveBeenLastCalledWith(command);
  await click(cli.getByRole('button', { name: text.agentCliCopyConfig }));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command, args: ['acp'] });
  await click(codex.getByRole('button', { name: text.agentProtocolCodexCopyConfig }));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({
    command, args: ['app-server', '--listen', 'stdio://'],
  });
  await click(summary);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(details.open).toBe(true);
  expect(example.getByText(command)).toBeTruthy();
  await click(example.getByRole('button', { name: exampleCopyName }));
  expect(api.writeText).toHaveBeenLastCalledWith(command);
  expect(cli.getByRole('button', { name: text.agentCliCopyCommand })).toBeTruthy();
  expect(cli.getByRole('button', { name: text.agentCliCopied })).toBeTruthy();
  expect(codex.getByRole('button', { name: text.agentProtocolCodexCopied })).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();

  const nextCommand = 'D:\\其他配置\\assistant-cli.exe';
  api.getStatus.mockResolvedValueOnce({ ...status, command: nextCommand });
  await click(cli.getByRole('button', { name: text.agentCliRefresh }));

  expect(api.getStatus).toHaveBeenCalledTimes(2);
  expect(cli.getByText(nextCommand)).toBeTruthy();
  expect(example.getByText(nextCommand)).toBeTruthy();
  expect(cli.getByRole('button', { name: text.agentCliCopyCommand })).toBeTruthy();
  expect(cli.getByRole('button', { name: text.agentCliCopyConfig })).toBeTruthy();
  expect(codex.getByRole('button', { name: text.agentProtocolCodexCopyConfig })).toBeTruthy();
  expect(example.getByRole('button', { name: exampleCopyName })).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);

  await click(cli.getByRole('button', { name: text.agentCliCopyConfig }));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command: nextCommand, args: ['acp'] });
  await click(codex.getByRole('button', { name: text.agentProtocolCodexCopyConfig }));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({
    command: nextCommand, args: ['app-server', '--listen', 'stdio://'],
  });
});

test('ACP, stdio and the example wait for the shared initial command without their own requests', async () => {
  const api = setup();
  let resolve!: (value: AgentCliIntegrationStatus) => void;
  api.getStatus.mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
  render(<ToolIntegrationSettingsTab />);
  const cli = within(screen.getByRole('region', { name: text.agentCliTitle }));
  const codex = within(screen.getByRole('region', { name: text.agentProtocolCodexTitle }));
  const summary = codex.getByText(text.applicationConnectionExampleSummary);
  await click(summary);
  const example = within(summary.closest('details')!);
  const name = text.applicationConnectionCopyValue.replace('{field}', text.agentCliCommand);

  expect(cli.getByRole<HTMLButtonElement>('button', { name: text.agentCliCopyConfig }).disabled).toBe(true);
  expect(codex.getByRole<HTMLButtonElement>('button', { name: text.agentProtocolCodexCopyConfig }).disabled).toBe(true);
  expect(example.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
  expect(within(screen.getByRole('region', { name: text.agentCliTitle })).getByRole('status').textContent).toBe(text.agentCliLoading);
  expect(api.getStatus).toHaveBeenCalledOnce();
  await act(async () => { resolve(status); });

  expect(example.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false);
  expect(cli.getByRole<HTMLButtonElement>('button', { name: text.agentCliCopyConfig }).disabled).toBe(false);
  expect(codex.getByRole<HTMLButtonElement>('button', { name: text.agentProtocolCodexCopyConfig }).disabled).toBe(false);
  expect(example.getByText(command)).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();
});

test('keeps CLI ACP copy errors isolated from the app-server configuration', async () => {
  const api = setup();
  api.writeText.mockRejectedValueOnce(new Error('ACP clipboard failed'));
  await act(async () => { render(<ToolIntegrationSettingsTab />); });
  const cli = within(screen.getByRole('region', { name: text.agentCliTitle }));
  const codex = within(screen.getByRole('region', { name: text.agentProtocolCodexTitle }));

  await click(cli.getByRole('button', { name: text.agentCliCopyConfig }));
  expect(cli.getByRole('alert').textContent).toBe(text.agentCliCopyFailed);
  expect(codex.queryByRole('alert')).toBeNull();
  await click(codex.getByRole('button', { name: text.agentProtocolCodexCopyConfig }));
  expect(codex.getByRole('button', { name: text.agentProtocolCodexCopied })).toBeTruthy();
  expect(cli.getByRole('alert').textContent).toBe(text.agentCliCopyFailed);
  await click(cli.getByRole('button', { name: text.agentCliCopyCommand }));
  expect(cli.queryByRole('alert')).toBeNull();
  expect(api.writeText).toHaveBeenLastCalledWith(command);
  expect(api.getStatus).toHaveBeenCalledOnce();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
});
