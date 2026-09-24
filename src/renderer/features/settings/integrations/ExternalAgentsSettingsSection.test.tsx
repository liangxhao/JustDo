// @vitest-environment jsdom

import { createDefaultExternalAgentSettings } from '@shared/openclaw/externalAgents';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import ExternalAgentsSettingsSection from './ExternalAgentsSettingsSection';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

const renderSection = (onChange = vi.fn(), settings = createDefaultExternalAgentSettings()) => {
  render(
    <ExternalAgentsSettingsSection
      settings={settings}
      onChange={onChange}
      isLoading={false}
      loadError={null}
      onRetry={vi.fn()}
    />,
  );
  return { onChange, settings };
};

describe('ExternalAgentsSettingsSection', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('edits registered agents without persisting independently', () => {
    const { onChange, settings } = renderSection();

    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('DeepSeek Harness')).toBeTruthy();
    expect(screen.getByText('Hermes')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude enabled' }));

    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      agents: { ...settings.agents, claude: { enabled: true } },
    });
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('tests an Agent without changing or saving its enabled state', async () => {
    const testAgent = vi.fn().mockResolvedValue({
      success: true,
      ready: true,
      message: 'ACP runtime is available.',
    });
    vi.stubGlobal('electron', {
      openclaw: { externalAgents: { test: testAgent } },
    });
    const { onChange } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsTest Hermes' }));

    expect(testAgent).toHaveBeenCalledWith('hermes');
    expect(await screen.findByText(/externalAgentsTestPassed/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('keeps the testing state visibly active while a probe is pending', () => {
    vi.stubGlobal('electron', {
      openclaw: {
        externalAgents: {
          test: vi.fn().mockReturnValue(new Promise(() => undefined)),
        },
      },
    });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsTest Hermes' }));

    expect(screen.getByText('externalAgentsTestingDescription')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('0externalAgentsSeconds');
  });

  test('hides an actionable runtime failure until the user expands it', async () => {
    vi.stubGlobal('electron', {
      openclaw: {
        externalAgents: {
          test: vi.fn().mockResolvedValue({ success: false, error: 'hermes was not found' }),
        },
      },
    });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsTest Hermes' }));

    expect(await screen.findByText('externalAgentsTestFailed')).toBeTruthy();
    expect(screen.queryByText('hermes was not found')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsShowErrorDetails' }));

    expect(screen.getByText('hermes was not found')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'externalAgentsHideErrorDetails' })).toBeTruthy();
  });

  test('shows the diagnostic code and all returned details after expansion', async () => {
    vi.stubGlobal('electron', {
      openclaw: {
        externalAgents: {
          test: vi.fn().mockResolvedValue({
            success: true,
            ready: false,
            code: 'ACP_PROCESS_EXITED',
            message: 'Agent process exited before initialize.',
            details: ['command=dsh --profile acp', 'exitCode=1'],
          }),
        },
      },
    });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsTest DeepSeek Harness' }));
    await screen.findByText('externalAgentsTestFailed');
    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsShowErrorDetails' }));

    const details = screen.getByText(/ACP_PROCESS_EXITED/).textContent;
    expect(details).toContain('Agent process exited before initialize.');
    expect(details).toContain('command=dsh --profile acp');
    expect(details).toContain('exitCode=1');
  });

  test('tests every registered Agent from one action without changing settings', async () => {
    const testAgent = vi.fn().mockResolvedValue({
      success: true,
      ready: true,
      message: 'ACP runtime is available.',
    });
    vi.stubGlobal('electron', {
      openclaw: { externalAgents: { test: testAgent } },
    });
    const { onChange } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'externalAgentsTestAll' }));

    await waitFor(() => expect(testAgent).toHaveBeenCalledTimes(5));
    expect(testAgent.mock.calls.map(([id]) => id)).toEqual([
      'claude',
      'codex',
      'opencode',
      'deepseek-harness',
      'hermes',
    ]);
    expect(await screen.findAllByText('externalAgentsTestPassed')).toHaveLength(5);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('requires confirmation before selecting full access', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 132,
      height: 32,
      left: 20,
      right: 220,
      top: 100,
      width: 200,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    });
    const { onChange } = renderSection();

    const permissionSelect = document.getElementById('external-agent-permission-mode')!;
    fireEvent.click(permissionSelect);
    fireEvent.click(screen.getByRole('option', { name: 'externalAgentsPermissionFullAccess' }));

    expect(confirmSpy).toHaveBeenCalledWith('externalAgentsFullAccessConfirm');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('offers all permission modes and supported runtime controls', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 132,
      height: 32,
      left: 20,
      right: 220,
      top: 100,
      width: 200,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    });
    const { onChange, settings } = renderSection();

    fireEvent.click(document.getElementById('external-agent-permission-mode')!);
    expect(screen.getByRole('option', { name: 'externalAgentsPermissionDenyAll' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'externalAgentsPermissionReadOnly' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'externalAgentsPermissionFullAccess' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'externalAgentsPermissionDenyAll' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, permissionMode: 'deny-all' });

    fireEvent.click(document.getElementById('external-agent-read-only-violation-behavior')!);
    fireEvent.click(
      screen.getByRole('option', { name: 'externalAgentsReadOnlyViolationFailTask' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      readOnlyViolationBehavior: 'fail-task',
    });

    fireEvent.click(document.getElementById('external-agent-operation-timeout')!);
    fireEvent.click(screen.getByRole('option', { name: '300 externalAgentsSecondsLabel' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, operationTimeoutSeconds: 300 });
  });

  test('offers separate MCP tool access controls', () => {
    const { onChange, settings } = renderSection();

    fireEvent.click(screen.getByRole('checkbox', { name: 'externalAgentsPluginToolsBridge' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, pluginToolsMcpBridge: true });

    fireEvent.click(screen.getByRole('checkbox', { name: 'externalAgentsOpenClawToolsBridge' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, openClawToolsMcpBridge: true });

    fireEvent.click(screen.getByRole('checkbox', { name: 'externalAgentsConfiguredMcpServers' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, shareConfiguredMcpServers: true });
  });
});
