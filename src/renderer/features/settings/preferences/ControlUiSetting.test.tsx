// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ControlUiSetting } from './ControlUiSetting';

const config = vi.hoisted(() => ({ developerMode: true, controlUiEnabled: true }));
vi.mock('@/services/config', () => ({ configService: { getConfig: () => config } }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const metadata = { success: true, port: 18789, token: 'test-only-token' };
let getPort: ReturnType<typeof vi.fn>;
let getToken: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  config.developerMode = true;
  config.controlUiEnabled = true;
  getPort = vi.fn().mockResolvedValue(metadata);
  getToken = vi.fn().mockResolvedValue(metadata);
  openExternal = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    openclaw: { engine: { getPort, getToken } },
    shell: { openExternal },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Draft({ isSaving = false }: { isSaving?: boolean }) {
  const [enabled, setEnabled] = useState(true);
  return <ControlUiSetting enabled={enabled} onChange={setEnabled} isSaving={isSaving} />;
}
const openButton = () => screen.getByRole('button', { name: 'openChatWeb' }) as HTMLButtonElement;

test.each(['developerMode', 'controlUiEnabled'] as const)(
  'requires saving %s before opening WebChat and responds to saved config changes',
  key => {
    config[key] = false;
    render(<Draft />);
    expect(openButton().disabled).toBe(true);
    expect(screen.getByText('controlUiSaveBeforeOpen')).toBeTruthy();
    fireEvent.click(openButton());
    expect(getPort).not.toHaveBeenCalled();
    config[key] = true;
    fireEvent(window, new Event('config-updated'));
    expect(openButton().disabled).toBe(false);
    expect(screen.queryByText('controlUiSaveBeforeOpen')).toBeNull();
  },
);

test('opens authenticated WebChat from the enabled Control UI setting', async () => {
  render(<Draft />);
  fireEvent.click(openButton());
  expect(openButton().disabled).toBe(true);
  await waitFor(() =>
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:18789/#token=test-only-token'),
  );
  await waitFor(() => expect(openButton().disabled).toBe(false));
});

test('rejects a stale click after the saved preference changes without an event', () => {
  render(<Draft />);
  config.controlUiEnabled = false;
  fireEvent.click(openButton());
  expect(getPort).not.toHaveBeenCalled();
});

test.each(['getPort', 'getToken'] as const)(
  'revokes a pending %s when draft, saved policy, saving state or page ownership changes',
  async pending => {
    for (const revoke of ['draft', 'saved', 'saving', 'unmount'] as const) {
      let finish!: (value: typeof metadata) => void;
      const waiting = new Promise<typeof metadata>(resolve => {
        finish = resolve;
      });
      const pendingCall = pending === 'getPort' ? getPort : getToken;
      pendingCall.mockReturnValueOnce(waiting);
      config.controlUiEnabled = true;
      const view = render(<Draft />);
      fireEvent.click(openButton());
      await waitFor(() => expect(pendingCall).toHaveBeenCalled());
      if (revoke === 'draft') {
        fireEvent.click(screen.getByRole('switch', { name: 'controlUiTitle' }));
        // Re-enabling must not revive an earlier request.
        fireEvent.click(screen.getByRole('switch', { name: 'controlUiTitle' }));
      } else if (revoke === 'saved') {
        config.controlUiEnabled = false;
      } else if (revoke === 'saving') {
        view.rerender(<Draft isSaving />);
      } else {
        view.unmount();
      }
      await act(async () => finish(metadata));
      expect(openExternal).not.toHaveBeenCalled();
      view.unmount();
      getPort.mockClear();
      getToken.mockClear();
    }
  },
);

test.each([
  ['port', 'chatWebPortError'],
  ['token', 'chatWebTokenError'],
  ['engine', 'coworkErrorEngineNotReady'],
  ['open', 'controlUiOpenFailed'],
] as const)('reports a %s failure inline and allows retry', async (failure, message) => {
  if (failure === 'port') getPort.mockResolvedValueOnce({ success: false });
  if (failure === 'token') getToken.mockResolvedValueOnce({ success: false });
  if (failure === 'engine') getPort.mockRejectedValueOnce(new Error('unavailable'));
  if (failure === 'open') openExternal.mockResolvedValueOnce({ success: false });
  render(<Draft />);
  fireEvent.click(openButton());
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(openButton().disabled).toBe(false);
  fireEvent.click(openButton());
  await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(failure === 'open' ? 2 : 1));
  await waitFor(() =>
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:18789/#token=test-only-token'),
  );
  await waitFor(() => expect(openButton().disabled).toBe(false));
  expect(screen.queryByRole('alert')).toBeNull();
});
