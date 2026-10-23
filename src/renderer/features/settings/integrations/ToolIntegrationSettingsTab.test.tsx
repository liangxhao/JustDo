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
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', { agentCli: { getStatus } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, writeText };
}
const click = async (element: HTMLElement) => {
  await act(async () => { fireEvent.click(element); });
};

test('shares one CLI entry between peer protocols and nests the Multica example only under Codex', async () => {
  const api = setup();
  await act(async () => { render(<ToolIntegrationSettingsTab />); });
  const cliRegion = screen.getByRole('region', { name: text.agentCliTitle });
  const acpRegion = screen.getByRole('region', { name: text.agentProtocolAcpTitle });
  const codexRegion = screen.getByRole('region', { name: text.agentProtocolCodexTitle });
  const cli = within(cliRegion);
  const acp = within(acpRegion);
  const codex = within(codexRegion);
  const summary = codex.getByText(text.applicationConnectionExampleSummary);
  const details = summary.closest('details')!;
  const example = within(details);
  const exampleCopyName = text.applicationConnectionCopyValue.replace('{field}', text.agentCliCommand);
  vi.useFakeTimers();

  expect(api.getStatus).toHaveBeenCalledOnce();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(acpRegion.parentElement).toBe(codexRegion.parentElement);
  expect(cliRegion.contains(acpRegion)).toBe(false);
  expect(cliRegion.contains(codexRegion)).toBe(false);
  expect(acp.queryByText(text.applicationConnectionExampleSummary)).toBeNull();
  expect(details.open).toBe(false);
  expect(cli.getByText(command)).toBeTruthy();
  expect(cli.queryByRole('button', { name: text.agentCliCopyConfig })).toBeNull();

  await click(cli.getByRole('button', { name: text.agentCliCopyCommand }));
  expect(api.writeText).toHaveBeenLastCalledWith(command);
  await click(acp.getByRole('button', { name: text.agentCliCopyConfig }));
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
  expect(cli.getByRole('button', { name: text.agentCliCommandCopied })).toBeTruthy();
  expect(acp.getByRole('button', { name: text.agentCliCopied })).toBeTruthy();
  expect(codex.getByRole('button', { name: text.agentProtocolCodexCopied })).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();

  const nextCommand = 'D:\\其他配置\\assistant-cli.exe';
  api.getStatus.mockResolvedValueOnce({ ...status, command: nextCommand });
  await click(cli.getByRole('button', { name: text.agentCliRefresh }));

  expect(api.getStatus).toHaveBeenCalledTimes(2);
  expect(cli.getByText(nextCommand)).toBeTruthy();
  expect(example.getByText(nextCommand)).toBeTruthy();
  expect(cli.getByRole('button', { name: text.agentCliCopyCommand })).toBeTruthy();
  expect(acp.getByRole('button', { name: text.agentCliCopyConfig })).toBeTruthy();
  expect(codex.getByRole('button', { name: text.agentProtocolCodexCopyConfig })).toBeTruthy();
  expect(example.getByRole('button', { name: exampleCopyName })).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);

  await click(acp.getByRole('button', { name: text.agentCliCopyConfig }));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({ command: nextCommand, args: ['acp'] });
  await click(codex.getByRole('button', { name: text.agentProtocolCodexCopyConfig }));
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual({
    command: nextCommand, args: ['app-server', '--listen', 'stdio://'],
  });
});

test('both protocols and the example wait for the shared initial status without their own requests', async () => {
  const api = setup();
  let resolve!: (value: AgentCliIntegrationStatus) => void;
  api.getStatus.mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
  render(<ToolIntegrationSettingsTab />);
  const acp = within(screen.getByRole('region', { name: text.agentProtocolAcpTitle }));
  const codex = within(screen.getByRole('region', { name: text.agentProtocolCodexTitle }));
  const summary = codex.getByText(text.applicationConnectionExampleSummary);
  await click(summary);
  const example = within(summary.closest('details')!);
  const name = text.applicationConnectionCopyValue.replace('{field}', text.agentCliCommand);

  expect(acp.getByRole<HTMLButtonElement>('button', { name: text.agentCliCopyConfig }).disabled).toBe(true);
  expect(codex.getByRole<HTMLButtonElement>('button', { name: text.agentProtocolCodexCopyConfig }).disabled).toBe(true);
  expect(example.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe(text.agentCliLoading);
  expect(api.getStatus).toHaveBeenCalledOnce();
  await act(async () => { resolve(status); });

  expect(example.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false);
  expect(acp.getByRole<HTMLButtonElement>('button', { name: text.agentCliCopyConfig }).disabled).toBe(false);
  expect(codex.getByRole<HTMLButtonElement>('button', { name: text.agentProtocolCodexCopyConfig }).disabled).toBe(false);
  expect(example.getByText(command)).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();
});
