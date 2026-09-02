// @vitest-environment jsdom

import { createDefaultAgentRuntimeSettings } from '@shared/openclaw/agentRuntimeSettings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AgentRuntimeSettingsTab from './AgentRuntimeSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'agentRuntimeApprovalTimeoutMinutes' ? '{minutes} minutes' : key),
  },
}));

describe('AgentRuntimeSettingsTab runtime settings', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('shows the default timeout and emits a bounded timeout update', () => {
    const settings = createDefaultAgentRuntimeSettings();
    const onChange = vi.fn();

    render(
      <AgentRuntimeSettingsTab
        settings={settings}
        models={[]}
        isLoading={false}
        loadError={null}
        onChange={onChange}
        onRetry={vi.fn()}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );

    const input = screen.getByRole('spinbutton', {
      name: 'agentRuntimeMcpRequestTimeoutTitle',
    }) as HTMLInputElement;
    expect(input.value).toBe('60');

    fireEvent.change(input, { target: { value: '300' } });

    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      mcp: { requestTimeoutSeconds: 300 },
    });

    fireEvent.change(input, { target: { value: '100000' } });
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      mcp: { requestTimeoutSeconds: 86_400 },
    });
  });

  test('offers approval wait presets and emits the selected timeout', () => {
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
    const settings = createDefaultAgentRuntimeSettings();
    const onChange = vi.fn();

    render(
      <AgentRuntimeSettingsTab
        settings={settings}
        models={[]}
        isLoading={false}
        loadError={null}
        onChange={onChange}
        onRetry={vi.fn()}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox', {
      name: 'agentRuntimeApprovalTimeoutTitle',
    });
    expect(select.textContent).toContain('30 minutes');

    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: '20 minutes' }));

    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      approvals: { timeoutMinutes: 20 },
    });
  });
});
