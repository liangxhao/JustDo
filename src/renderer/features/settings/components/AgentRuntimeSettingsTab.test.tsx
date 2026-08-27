// @vitest-environment jsdom

import { createDefaultAgentRuntimeSettings } from '@shared/openclaw/agentRuntimeSettings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AgentRuntimeSettingsTab from './AgentRuntimeSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

describe('AgentRuntimeSettingsTab MCP settings', () => {
  afterEach(cleanup);

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
});
