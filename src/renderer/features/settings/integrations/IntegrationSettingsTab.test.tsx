// @vitest-environment jsdom

import { createDefaultExternalAgentSettings } from '@shared/openclaw/externalAgents';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import IntegrationSettingsTab, {
  IntegrationSettingsView,
  type IntegrationSettingsViewId,
} from './IntegrationSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

vi.mock('./ToolIntegrationSettingsTab', () => ({
  default: () => <div data-testid="tool-integration-settings-tab" />,
}));

const TestHarness: React.FC = () => {
  const [activeView, setActiveView] = useState<IntegrationSettingsViewId>(
    IntegrationSettingsView.AgentDelegation,
  );
  return (
    <IntegrationSettingsTab
      activeView={activeView}
      onViewChange={setActiveView}
      externalAgentSettings={createDefaultExternalAgentSettings()}
      onExternalAgentSettingsChange={vi.fn()}
      externalAgentSettingsLoading={false}
      externalAgentSettingsLoadError={null}
      onExternalAgentSettingsRetry={vi.fn()}
    />
  );
};

const renderTab = () => render(<TestHarness />);

describe('IntegrationSettingsTab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('shows Agent delegation settings by default', () => {
    renderTab();

    expect(
      screen
        .getByRole('tab', { name: 'integrationAgentDelegationTab' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('externalAgentsSectionTitle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
  });

  test('shows application access integrations in the second view', () => {
    renderTab();

    fireEvent.click(screen.getByRole('tab', { name: 'integrationAppAccessTab' }));

    expect(screen.getByTestId('tool-integration-settings-tab')).toBeTruthy();
    expect(screen.queryByText('externalAgentsSectionTitle')).toBeNull();
  });
});
