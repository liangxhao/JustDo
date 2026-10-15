// @vitest-environment jsdom

import type { ExtensionMcpSettingsSnapshot } from '@shared/plugins/mcp';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import ExtensionMcpParametersModal from './ExtensionMcpParametersModal';
import { mcpService } from './mcpService';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./mcpService', () => ({ mcpService: { readExtensionSettings: vi.fn() } }));

const fixture = (): ExtensionMcpSettingsSnapshot => ({
  server: {
    id: 'extension:demo:server',
    name: 'server',
    providerId: 'demo',
    providerName: 'Demo',
    providerDescription: '',
    enabled: false,
    supported: true,
    transportType: 'stdio',
    requestTimeoutMs: 60000,
    management: {
      enable: { allowed: true },
      disable: { allowed: true },
      configure: { allowed: true },
      remove: { allowed: false },
      revealInFolder: { allowed: false },
    },
  },
  revision: 'native-revision',
  override: { enabled: false },
  definition: {
    command: 'node',
    args: ['--flag', 'C:/with spaces/server.mjs'],
    cwd: 'C:/with spaces',
    env: { TOKEN: '__OPENCLAW_REDACTED__' },
    toolFilter: { exclude: ['admin_*'] },
    enabled: false,
  },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = async (snapshot = fixture()) => {
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({ success: true, value: snapshot });
  const onClose = vi.fn();
  const onProbe = vi.fn();
  render(
    <ExtensionMcpParametersModal server={snapshot.server} onClose={onClose} onProbe={onProbe} />,
  );
  await screen.findByLabelText('mcpRawParametersJson');
  return { onClose, onProbe };
};

test('all extension connection fields and original JSON are read-only even when native overrides are supported', async () => {
  const { onClose } = await open();
  for (const field of screen.getAllByRole('textbox', { hidden: true })) {
    expect((field as HTMLInputElement).readOnly).toBe(true);
  }
  expect((screen.getByLabelText('mcpArgs') as HTMLTextAreaElement).value).toBe(
    '--flag\nC:/with spaces/server.mjs',
  );
  const original = screen.getByLabelText('mcpRawParametersJson') as HTMLTextAreaElement;
  expect(JSON.parse(original.value)).toEqual(fixture().definition);
  expect(screen.getByRole('heading').textContent).toBe('mcpViewParameters');
  expect(screen.queryByRole('button', { name: 'saveMcpServer' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'mcpRestoreExtensionDefaults' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('testing a disabled connection keeps the original native parameters intact', async () => {
  const { onProbe } = await open();
  const original = screen.getByLabelText('mcpRawParametersJson') as HTMLTextAreaElement;
  const before = original.value;
  fireEvent.click(screen.getByRole('button', { name: 'mcpTestSavedConfiguration' }));
  expect(onProbe).toHaveBeenCalledExactlyOnceWith(fixture().server);
  expect(original.value).toBe(before);
});

test('HTTP parameters retain native authentication metadata in a read-only view', async () => {
  const snapshot = fixture();
  snapshot.server.transportType = 'http';
  snapshot.definition = {
    url: 'https://example.test/mcp',
    headers: { Authorization: '__OPENCLAW_REDACTED__' },
    auth: 'oauth',
  };
  await open(snapshot);
  expect((screen.getByLabelText('mcpUrl') as HTMLInputElement).readOnly).toBe(true);
  expect(
    JSON.parse((screen.getByLabelText('mcpRawParametersJson') as HTMLTextAreaElement).value),
  ).toEqual(snapshot.definition);
});

test('late parameter reads cannot replace a newly selected server', async () => {
  const first = fixture();
  const second = fixture();
  second.server = { ...second.server, id: 'extension:demo:second', name: 'second' };
  second.definition = { command: 'second-command' };
  let finish!: (value: Awaited<ReturnType<typeof mcpService.readExtensionSettings>>) => void;
  vi.mocked(mcpService.readExtensionSettings)
    .mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce({ success: true, value: second });
  const view = render(<ExtensionMcpParametersModal server={first.server} onClose={vi.fn()} />);
  view.rerender(<ExtensionMcpParametersModal server={second.server} onClose={vi.fn()} />);
  await waitFor(() =>
    expect((screen.getByLabelText('mcpCommand') as HTMLInputElement).value).toBe('second-command'),
  );
  await act(async () => finish({ success: true, value: first }));
  expect((screen.getByLabelText('mcpCommand') as HTMLInputElement).value).toBe('second-command');
});

test('unavailable native parameters show the read failure and keep testing disabled', async () => {
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({
    success: false,
    code: 'unavailable',
  });
  render(
    <ExtensionMcpParametersModal server={fixture().server} onClose={vi.fn()} onProbe={vi.fn()} />,
  );
  expect((await screen.findByRole('alert')).textContent).toBe('mcpExtensionMutation.unavailable');
  expect(
    (screen.getByRole('button', { name: 'mcpTestSavedConfiguration' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
