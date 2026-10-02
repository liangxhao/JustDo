// @vitest-environment jsdom

import { createDefaultAgentRuntimeSettings } from '@shared/openclaw/agentRuntimeSettings';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
import { settingsTranslations } from '@/services/i18n/settingsTranslations';

import AgentRuntimeSettingsTab from './AgentRuntimeSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => {
      const values: Record<string, string> = {
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
        agentRuntimeScheduledTaskApprovalTimeoutMinutes: '{minutes} minutes',
      };
      return values[key] ?? key;
    },
  },
}));

describe('AgentRuntimeSettingsTab runtime settings', () => {
  test('shows every settings group immediately without category switches or disclosures', () => {
    render(
      <AgentRuntimeSettingsTab
        settings={createDefaultAgentRuntimeSettings()}
        models={[]}
        isLoading={false}
        loadError={null}
        onChange={vi.fn()}
        onRetry={vi.fn()}
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(7);
    for (const name of [
      'agentRuntimeCodeModeActivation',
      'agentRuntimeSessionVisibilityTitle',
      'agentRuntimeArchiveTitle',
      'agentRuntimeNestingTitle',
    ]) {
      expect(screen.getByRole('combobox', { name })).toBeTruthy();
    }
    for (const name of [
      'displayTabRetentionTitle',
      'agentRuntimeMaxChildren',
      'agentRuntimeSwarmConcurrent',
    ]) {
      expect(screen.getByRole('spinbutton', { name })).toBeTruthy();
    }
    expect(screen.getByRole('switch', { name: 'agentRuntimeSwarmEnabled' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(
      document.querySelector('button[aria-expanded="false"]:not([role="combobox"])'),
    ).toBeNull();
  });

  test.each(['zh', 'en'] as const)(
    'keeps setting scope and explanatory text visible in %s',
    language => {
      const translations = settingsTranslations[language];
      vi.spyOn(i18nService, 't').mockImplementation(
        key => translations[key as keyof typeof translations] ?? key,
      );
      render(
        <AgentRuntimeSettingsTab
          settings={createDefaultAgentRuntimeSettings()}
          models={[]}
          isLoading={false}
          loadError={null}
          onChange={vi.fn()}
          onRetry={vi.fn()}
          maxRetainedDisplayTabs={30}
          onMaxRetainedDisplayTabsChange={vi.fn()}
          maxGoalContinuationTurns={10}
          onMaxGoalContinuationTurnsChange={vi.fn()}
        />,
      );
      const groups = [
        [
          'agentRuntimeAgentSectionTitle',
          'agentRuntimeAgentSectionDescription',
          [
            'agentRuntimeDefaultThinking',
            'agentRuntimeAgentTimeoutTitle',
            'agentRuntimeAgentMaxConcurrent',
            'agentRuntimeDelegationTitle',
            'agentRuntimeSessionVisibilityTitle',
            'agentRuntimeAskUserTimeoutTitle',
            'agentRuntimeScheduledTaskApprovalTimeoutTitle',
          ],
        ],
        [
          'displayTabRetentionSectionTitle',
          'displayTabRetentionSectionDescription',
          ['displayTabRetentionTitle'],
        ],
        [
          'goalContinuationSettingsSectionTitle',
          'goalContinuationSettingsSectionDescription',
          ['goalContinuationMaxTurnsTitle'],
        ],
        [
          'agentRuntimeCodeModeTitle',
          'agentRuntimeCodeModeDescription',
          ['agentRuntimeCodeModeActivation'],
        ],
        [
          'agentRuntimeMcpSectionTitle',
          'agentRuntimeMcpSectionDescription',
          ['agentRuntimeMcpRequestTimeoutTitle'],
        ],
        [
          'agentRuntimeSubagentSectionTitle',
          'agentRuntimeSubagentSectionDescription',
          [
            'agentRuntimeDefaultModel',
            'agentRuntimeDefaultThinking',
            'agentRuntimeMaxConcurrent',
            'agentRuntimeTimeoutTitle',
            'agentRuntimeMaxChildren',
            'agentRuntimeArchiveTitle',
            'agentRuntimeNestingTitle',
          ],
        ],
        [
          'agentRuntimeSwarmTitle',
          'agentRuntimeSwarmDescription',
          [
            'agentRuntimeSwarmEnabled',
            'agentRuntimeSwarmConcurrent',
            'agentRuntimeSwarmChildren',
            'agentRuntimeSwarmTotal',
          ],
        ],
      ] as const;
      for (const [title, description, labels] of groups) {
        const section = within(screen.getByRole('region', { name: translations[title] }));
        expect(section.getByText(translations[description])).toBeTruthy();
        for (const label of labels) {
          expect(section.getByLabelText(translations[label])).toBeTruthy();
        }
      }
      for (const key of [
        'goalContinuationMaxTurnsDescription',
        'agentRuntimeMcpRequestTimeoutDescription',
        'agentRuntimeSessionVisibilityTreeDescription',
        'agentRuntimeDelegationDescription',
        'agentRuntimeMaxChildrenDescription',
        'agentRuntimeArchiveDescription',
        'agentRuntimeThinkingHint',
        'agentRuntimeAgentThinkingHint',
      ] as const) {
        expect(screen.getByText(translations[key])).toBeTruthy();
      }
    },
  );

  test.each([
    ['agentRuntimeCodeModeOff', 'off'],
    ['agentRuntimeCodeModeOn', 'on'],
  ] as const)('selects %s without changing other runtime preferences', (label, mode) => {
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
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox', { name: 'agentRuntimeCodeModeActivation' });
    expect(select.textContent).toContain('agentRuntimeCodeModeOff');
    fireEvent.click(select);
    // Compact triggers must not constrain the menu and hide longer choices.
    expect(screen.getByRole('listbox').parentElement?.style.width).toBe('320px');
    const automatic = screen.getByRole('option', { name: 'agentRuntimeCodeModeAuto' });
    expect(automatic.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(automatic);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: label }));
    expect(onChange).toHaveBeenCalledWith({ ...settings, codeMode: { mode } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('renders sidebar tab retention as a bounded stepper', () => {
    const onMaxRetainedDisplayTabsChange = vi.fn();

    render(
      <AgentRuntimeSettingsTab
        settings={createDefaultAgentRuntimeSettings()}
        models={[]}
        isLoading={false}
        loadError={null}
        onChange={vi.fn()}
        onRetry={vi.fn()}
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={onMaxRetainedDisplayTabsChange}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );

    expect(
      (
        screen.getByRole('spinbutton', {
          name: 'displayTabRetentionTitle',
        }) as HTMLInputElement
      ).value,
    ).toBe('30');

    fireEvent.click(screen.getByRole('button', { name: 'displayTabRetentionTitle +' }));

    expect(onMaxRetainedDisplayTabsChange).toHaveBeenCalledWith(31);
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
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
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
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
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

  test('configures only the scheduled task approval timeout', () => {
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
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
        maxGoalContinuationTurns={10}
        onMaxGoalContinuationTurnsChange={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox', {
      name: 'agentRuntimeScheduledTaskApprovalTimeoutTitle',
    });
    expect(select.textContent).toContain('2 minutes');

    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: '10 minutes' }));

    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      automation: { approvalTimeoutMinutes: 10 },
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
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
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
        maxRetainedDisplayTabs={30}
        onMaxRetainedDisplayTabsChange={vi.fn()}
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

test('changes Swarm independently from ordinary SubAgent capacity', () => {
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
      maxRetainedDisplayTabs={30}
      onMaxRetainedDisplayTabsChange={vi.fn()}
      maxGoalContinuationTurns={10}
      onMaxGoalContinuationTurnsChange={vi.fn()}
    />,
  );

  expect(screen.getByRole('spinbutton', { name: 'agentRuntimeSwarmConcurrent' })).toHaveProperty(
    'value',
    '8',
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'agentRuntimeSwarmConcurrent' }), {
    target: { value: '12' },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...settings,
    swarm: { ...settings.swarm, maxConcurrent: 12 },
  });
  fireEvent.click(screen.getByRole('switch', { name: 'agentRuntimeSwarmEnabled' }));
  expect(onChange).toHaveBeenLastCalledWith({
    ...settings,
    swarm: { ...settings.swarm, enabled: false },
  });
  cleanup();
});
