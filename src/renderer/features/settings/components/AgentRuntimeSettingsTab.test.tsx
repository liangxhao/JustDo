// @vitest-environment jsdom

import { createDefaultAgentRuntimeSettings } from '@shared/openclaw/agentRuntimeSettings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AgentRuntimeSettingsTab from './AgentRuntimeSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => {
      const values: Record<string, string> = {
        agentRuntimeApprovalTimeoutMinutes: '{minutes} minutes',
        agentRuntimeThinkingOff: 'Off',
        agentRuntimeThinkingMinimal: 'Minimal',
        agentRuntimeThinkingLow: 'Low',
        agentRuntimeThinkingMedium: 'Medium',
        agentRuntimeThinkingHigh: 'High',
        agentRuntimeThinkingXHigh: 'Extra high',
        agentRuntimeThinkingAdaptive: 'Adaptive',
        agentRuntimeThinkingMax: 'Maximum',
        agentRuntimeThinkingUltra: 'Ultra',
        agentRuntimeNestingDepth: 'Depth {depth}',
      };
      return values[key] ?? key;
    },
  },
}));

describe('AgentRuntimeSettingsTab runtime settings', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('shows an unlimited Agent turn default and emits a bounded MCP timeout update', () => {
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

    expect(
      screen.getByRole('combobox', { name: 'agentRuntimeAgentTimeoutTitle' }).textContent,
    ).toContain('agentRuntimeTimeoutUnlimited');

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

  test('shows tree as the default session scope and emits a broader selection', () => {
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
      name: 'agentRuntimeSessionVisibilityTitle',
    });
    expect(select.textContent).toContain('agentRuntimeSessionVisibilityTree');

    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: 'agentRuntimeSessionVisibilityAgent' }));

    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      sessions: { visibility: 'agent' },
    });
  });

  test('uses the WebChat English thinking labels', () => {
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

    render(
      <AgentRuntimeSettingsTab
        settings={createDefaultAgentRuntimeSettings()}
        models={[]}
        isLoading={false}
        loadError={null}
        onChange={vi.fn()}
        onRetry={vi.fn()}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('combobox', { name: 'agentRuntimeDefaultThinking' })[0]!);

    for (const label of [
      'Off',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Adaptive',
      'Maximum',
      'Ultra',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
  });

  test('emits system concurrency, delegation, cleanup, and depth selections', () => {
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
    settings.agent.maxConcurrent = 8;
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

    fireEvent.click(screen.getByRole('combobox', { name: 'agentRuntimeAgentMaxConcurrent' }));
    fireEvent.click(screen.getByRole('option', { name: 'agentRuntimeSystemDefault' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      agent: { ...settings.agent, maxConcurrent: null },
    });

    fireEvent.click(screen.getByRole('button', { name: 'agentRuntimeDelegationPrefer' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      subagents: { ...settings.subagents, delegationMode: 'prefer' },
    });

    fireEvent.click(screen.getByRole('combobox', { name: 'agentRuntimeArchiveTitle' }));
    fireEvent.click(screen.getByRole('option', { name: 'agentRuntimeArchive1d' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      subagents: { ...settings.subagents, archiveAfterMinutes: 1440 },
    });

    fireEvent.click(screen.getByRole('combobox', { name: 'agentRuntimeNestingTitle' }));
    fireEvent.click(screen.getByRole('option', { name: 'Depth 5' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      subagents: { ...settings.subagents, maxSpawnDepth: 5 },
    });
  });
});
