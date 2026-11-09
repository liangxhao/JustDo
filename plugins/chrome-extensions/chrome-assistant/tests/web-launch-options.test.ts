// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebLaunchOptions,
  WebLaunchOptionsMessage as Message,
} from '../conversation-overlay/modules/web-launch-options.js';

const views: ReturnType<typeof createWebLaunchOptions>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  [...document.querySelectorAll('button')].find(node => node.textContent === text)!;
const site = {
  origin: 'https://internal.test:8443',
  enabled: true,
  allowSend: false,
  allowResult: false,
};
type SettingsMessage = { type: string } & Partial<typeof site>;
async function mount(initial: (typeof site)[] = []) {
  document.body.innerHTML = '<section id="webLaunchSites"></section>';
  const policies = initial.map(value => ({ ...value }));
  const permission = vi.fn();
  const sendMessage = vi.fn(async (message: SettingsMessage): Promise<Record<string, unknown>> => {
    if (message.type === Message.List)
      return { ok: true, sitesRevision: 7, policies: [...policies] };
    if (message.type === Message.Observations) return { ok: true, observations: [] };
    if (message.type === Message.Save) {
      const index = policies.findIndex(value => value.origin === message.origin);
      if (index >= 0) policies[index] = { ...policies[index], ...message };
      return { ok: true };
    }
    return { ok: true };
  });
  const confirm = vi.fn(() => true);
  const removePermission = vi.fn();
  const view = createWebLaunchOptions({
    document,
    confirm,
    chrome: {
      runtime: { sendMessage },
      permissions: { request: permission, remove: removePermission },
    },
  });
  views.push(view);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: Message.List }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { view, policies, sendMessage, permission, removePermission, confirm };
}

describe('website launch options', () => {
  it('explains website-initiated connection without a manual address or combined permission grant', async () => {
    const { permission } = await mount();
    expect(document.body.textContent).toContain('No address entry is needed.');
    expect(document.body.textContent).toContain('No connected websites.');
    expect(document.querySelector('input[type="url"]')).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(permission).not.toHaveBeenCalled();
  });

  it('keeps direct sending and result sharing separately opt-in for an already connected website', async () => {
    const { sendMessage, permission } = await mount([site]);
    const send = document.querySelectorAll<HTMLInputElement>('.web-launch-choice input')[0];
    const result = document.querySelectorAll<HTMLInputElement>('.web-launch-choice input')[1];
    expect(send.checked).toBe(false);
    expect(result.checked).toBe(false);
    send.checked = true;
    send.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Save,
        expectedRevision: 7,
        origin: site.origin,
        enabled: true,
        allowSend: true,
        allowResult: false,
      }),
    );
    expect(permission).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Website permissions saved.'),
    );
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('revokes all site permissions without deleting shared Chrome permissions', async () => {
    const { sendMessage, removePermission } = await mount([
      { ...site, allowSend: true, allowResult: true },
    ]);
    button('Revoke website access').click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Save,
        expectedRevision: 7,
        origin: site.origin,
        enabled: false,
        allowSend: false,
        allowResult: false,
      }),
    );
    expect(removePermission).not.toHaveBeenCalled();
  });

  it('allows explicit abandonment of unknown observation without a stop command', async () => {
    const { view, sendMessage, confirm } = await mount();
    sendMessage.mockImplementation(async message =>
      message.type === Message.Observations
        ? {
            ok: true,
            observations: [
              {
                origin: site.origin,
                receipt: { launchId: 'unknown-one', execution: { status: 'unknown' } },
              },
            ],
          }
        : { ok: true, sitesRevision: 7, policies: [] },
    );
    await view.refresh();
    button('Unlink and stop observing').click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Abandon,
        launchId: 'unknown-one',
        confirm: true,
      }),
    );
    expect(confirm).toHaveBeenCalled();
    expect(sendMessage.mock.calls.some(([value]) => value.type.includes(':stop'))).toBe(false);
  });

  it('shows safe errors without retrying a conflicted write or claiming success', async () => {
    const { sendMessage } = await mount([site]);
    sendMessage.mockImplementation(async message =>
      message.type === Message.Save
        ? { ok: false, code: 'POLICY_CONFLICT', error: 'secret=private' }
        : { ok: true, sitesRevision: 8, policies: [site] },
    );
    button('Revoke website access').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Settings changed while you were editing'),
    );
    expect(sendMessage.mock.calls.filter(([value]) => value.type === Message.Save)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('private');
    expect(document.body.textContent).not.toContain('Website permissions saved.');
  });

  it('disables stale site controls while the desktop application is unavailable', async () => {
    const { view, sendMessage } = await mount([site]);
    sendMessage.mockResolvedValue({ ok: false, code: 'APP_NOT_RUNNING' });
    await view.refresh();
    expect(button('Revoke website access').disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('.web-launch-choice input')?.disabled).toBe(
      true,
    );
    expect(document.body.textContent).toContain('Check that the desktop application is running');
  });
});
