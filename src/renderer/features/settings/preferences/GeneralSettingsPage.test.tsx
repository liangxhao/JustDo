// @vitest-environment jsdom
import { defaultCustomProxyConfig, ProxyMode } from '@shared/network/proxy';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { type ComponentProps, createRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { GeneralSettingsPage } from './GeneralSettingsPage';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, setLanguage: vi.fn() },
}));
vi.mock('@/services/config', () => ({
  configService: { getConfig: () => ({ developerMode: false, controlUiEnabled: false }) },
}));
vi.mock('@/features/settings/updates/AppUpdateFrequencySetting', () => ({ default: () => null }));
vi.mock('./ProxySettingsSection', () => ({ ProxySettingsSection: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = ComponentProps<typeof GeneralSettingsPage>;
const defaults: Props = {
  language: 'zh', setLanguage: vi.fn(), autoLaunch: false,
  isUpdatingAutoLaunch: false, setIsUpdatingAutoLaunch: vi.fn(), setAutoLaunchState: vi.fn(),
  setError: vi.fn(), preventSleep: false, isUpdatingPreventSleep: false,
  setIsUpdatingPreventSleep: vi.fn(), setPreventSleepState: vi.fn(),
  developerModeAvailable: true,
  controlUiEnabled: false, setControlUiEnabled: vi.fn(),
  proxyMode: ProxyMode.DIRECT, handleProxyModeChange: vi.fn(), customProxy: defaultCustomProxyConfig,
  handleCustomProxyChange: vi.fn(), isSaving: false,
  openClawGatewayPortInputRef: createRef<HTMLInputElement>(), openClawGatewayPortInput: '18789',
  openClawGatewayPortEditing: false, setOpenClawGatewayPortEditing: vi.fn(),
  setOpenClawGatewayPortError: vi.fn(), setOpenClawGatewayPortInput: vi.fn(),
  openClawGatewayPortValidation: { valid: true, port: 18789, usesEphemeralRange: false },
  handleSaveOpenClawGatewayPort: vi.fn(), cancelOpenClawGatewayPortEditing: vi.fn(),
  openClawGatewayPortValidationError: null, openClawGatewayPortSaving: false,
  handleRestartOpenClawGateway: vi.fn(), isRestartingOpenClawGateway: false,
  openClawGatewayPortError: null, openClawGatewayPortRestartRequired: false,
};

function Draft({ initialEnabled = false, ...props }: Partial<Props> & { initialEnabled?: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  return <GeneralSettingsPage {...defaults} controlUiEnabled={enabled} setControlUiEnabled={setEnabled} {...props} />;
}

test('hides developer settings until revealed', () => {
  render(<Draft developerModeAvailable={false} />);
  expect(screen.queryByRole('region', { name: 'developerMode' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'controlUiTitle' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'outboundHeaderPolicyView' })).toBeNull();
});

test('groups developer controls without a developer mode switch', () => {
  render(<Draft />);
  const developerSettings = within(screen.getByRole('region', { name: 'developerMode' }));
  expect(developerSettings.getByRole('switch', { name: 'controlUiTitle' })).toBeTruthy();
  expect(developerSettings.getByText('openclawGatewayPortTitle')).toBeTruthy();
  expect(developerSettings.queryByRole('switch', { name: 'developerMode' })).toBeNull();
});

test('reads the current outbound header policy each time its developer dialog opens', async () => {
  const getOutboundHeaderPolicy = vi.fn()
    .mockResolvedValueOnce({
      enabled: true,
      targets: [{
        url: 'https://internal.example/v1/',
        headers: [
          { name: 'X-Token', sourceField: null, value: 'fixed-fixture' },
          { name: 'X-Tenant', sourceField: 'tenant$&id', value: 'runtime-fixture' },
          { name: 'X-Empty', sourceField: 'empty', value: '' },
          { name: 'X-Invalid', sourceField: 'invalid', value: null },
        ],
      }],
    })
    .mockResolvedValueOnce({ enabled: false, targets: [] });
  vi.stubGlobal('electron', { api: { getOutboundHeaderPolicy } });
  render(<Draft />);
  const button = screen.getByRole('button', { name: 'outboundHeaderPolicyView' });
  expect(getOutboundHeaderPolicy).not.toHaveBeenCalled();

  fireEvent.click(button);
  const dialog = within(screen.getByRole('dialog', { name: 'outboundHeaderPolicyTitle' }));
  expect(await dialog.findByText('https://internal.example/v1/')).toBeTruthy();
  expect(dialog.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
    'outboundHeaderPolicyHeaderName',
    'outboundHeaderPolicyHeaderValue',
    'outboundHeaderPolicyHeaderSource',
    'outboundHeaderPolicyHeaderState',
  ]);
  expect(dialog.getByText('X-Token')).toBeTruthy();
  expect(dialog.getByText('outboundHeaderPolicyFixedValue')).toBeTruthy();
  expect(dialog.getByText('fixed-fixture')).toBeTruthy();
  expect(dialog.getByText('tenant$&id')).toBeTruthy();
  expect(dialog.getByText('runtime-fixture')).toBeTruthy();
  const emptyRow = within(dialog.getByRole('row', { name: /X-Empty/ }));
  const skippedRow = within(dialog.getByRole('row', { name: /X-Invalid/ }));
  expect(emptyRow.getAllByRole('cell')[0].textContent).toBe('');
  expect(emptyRow.getByRole('img', { name: 'outboundHeaderPolicyInjected' })).toBeTruthy();
  expect(skippedRow.getAllByRole('cell')[0].textContent).toBe('');
  expect(skippedRow.getByRole('img', { name: 'outboundHeaderPolicyNotInjected' })).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: 'close' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(button);
  expect(await screen.findByText('outboundHeaderPolicyDisabled')).toBeTruthy();
  expect(screen.queryByText('https://internal.example/v1/')).toBeNull();
  expect(getOutboundHeaderPolicy).toHaveBeenCalledTimes(2);
});

test('toggles the controlled Control UI preference without saving it', () => {
  render(<Draft />);
  const toggle = screen.getByRole('switch', { name: 'controlUiTitle' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText('controlUiDescription')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'openChatWeb' })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: 'openChatWeb' })).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByRole('button', { name: 'openChatWeb' })).toBeNull();
});

test('disables Control UI changes while settings are saving', () => {
  render(<Draft initialEnabled isSaving />);
  const toggle = screen.getByRole('switch', { name: 'controlUiTitle' }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});

test('preserves the draft when developer mode is hidden and shown again', () => {
  const view = render(<Draft />);
  fireEvent.click(screen.getByRole('switch', { name: 'controlUiTitle' }));
  view.rerender(<Draft developerModeAvailable={false} />);
  expect(screen.queryByRole('switch', { name: 'controlUiTitle' })).toBeNull();
  view.rerender(<Draft developerModeAvailable />);
  expect(screen.getByRole('switch', { name: 'controlUiTitle' }).getAttribute('aria-checked')).toBe('true');
});
